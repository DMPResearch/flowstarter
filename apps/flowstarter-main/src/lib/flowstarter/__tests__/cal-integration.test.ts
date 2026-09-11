/**
 * Connecting and disconnecting a workspace's Cal.com calendar.
 *
 * The route tests cover the happy paths through the real handlers. What is
 * left here is the set of failures a route cannot easily stage: a workspace
 * that vanished between the read and the write, an update that was refused,
 * and a ledger insert that failed after the save already succeeded. The last
 * one matters most: losing the audit row must not lose the save.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  calWebhookUrl,
  connectCalCom,
  disconnectCalCom,
  loadCalConnection,
} from '../cal-integration';

const WORKSPACE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

type Reply = { data: unknown; error: unknown };

interface Plan {
  /** The `workspaces` select result, in call order. */
  reads: Reply[];
  /** The `workspaces` update result. */
  update: Reply;
  /** The `project_events` insert result. */
  event: Reply;
}

function fakeSupabase(plan: Partial<Plan> = {}) {
  const reads = [...(plan.reads ?? [{ data: { id: WORKSPACE }, error: null }])];
  const writes: Array<{ table: string; mode: string; values: unknown }> = [];

  const client = {
    from(table: string) {
      let mode = 'select';
      let values: unknown;
      const builder = {
        select: () => builder,
        update(next: unknown) {
          mode = 'update';
          values = next;
          return builder;
        },
        insert(next: unknown) {
          mode = 'insert';
          values = next;
          writes.push({ table, mode, values });
          return Promise.resolve(plan.event ?? { data: null, error: null });
        },
        eq: () => builder,
        maybeSingle: () =>
          Promise.resolve(reads.shift() ?? { data: null, error: null }),
        then(resolve: (value: Reply) => unknown) {
          if (mode === 'update') writes.push({ table, mode, values });
          return Promise.resolve(
            resolve(
              mode === 'update'
                ? plan.update ?? { data: null, error: null }
                : { data: [], error: null }
            )
          );
        },
      };
      return builder;
    },
  };

  return { writes, client: client as unknown as SupabaseClient<Database> };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('calWebhookUrl', () => {
  it('is absolute, because it is pasted into somebody else’s settings screen', () => {
    expect(calWebhookUrl(WORKSPACE)).toBe(
      `https://flowstarter.net/api/integrations/cal/${WORKSPACE}`
    );
  });

  it('follows the configured origin, with no trailing slash left on it', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://staging.flowstarter.dev/');
    expect(calWebhookUrl(WORKSPACE)).toBe(
      `https://staging.flowstarter.dev/api/integrations/cal/${WORKSPACE}`
    );
    vi.unstubAllEnvs();
  });
});

describe('loadCalConnection', () => {
  it('reports a stored link that no longer passes the rules as not connected', async () => {
    // A value seeded before the rules tightened. It is shown back to the
    // client so they can see what is wrong, but nothing treats it as live.
    const db = fakeSupabase({
      reads: [
        {
          data: {
            cal_com_url: 'https://calendly.com/acme',
            cal_com_webhook_secret: null,
          },
          error: null,
        },
      ],
    });
    expect(await loadCalConnection(db.client, WORKSPACE)).toMatchObject({
      connected: false,
      calComUrl: 'https://calendly.com/acme',
      embedSrc: null,
    });
  });

  it('says nothing rather than guessing when the workspace is gone', async () => {
    const db = fakeSupabase({ reads: [{ data: null, error: null }] });
    expect(await loadCalConnection(db.client, WORKSPACE)).toBeNull();
  });

  it('throws on a read failure, so a caller cannot mistake it for "not set"', async () => {
    const db = fakeSupabase({
      reads: [{ data: null, error: { message: 'permission denied' } }],
    });
    await expect(loadCalConnection(db.client, WORKSPACE)).rejects.toBeTruthy();
  });
});

describe('connectCalCom', () => {
  it('refuses the paste before it ever touches the database', async () => {
    const db = fakeSupabase();
    const result = await connectCalCom(db.client, {
      workspaceId: WORKSPACE,
      rawLink: 'https://calendly.com/acme',
      actor: 'user_1',
    });
    expect(result).toMatchObject({ ok: false, reason: 'host' });
    expect(db.writes).toHaveLength(0);
  });

  it('reports a workspace that vanished between the click and the save', async () => {
    const db = fakeSupabase({ reads: [{ data: null, error: null }] });
    const result = await connectCalCom(db.client, {
      workspaceId: WORKSPACE,
      rawLink: 'acme/intro',
      actor: 'user_1',
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
    expect(db.writes).toHaveLength(0);
  });

  it('reports a refused write rather than confirming a save that did not happen', async () => {
    const db = fakeSupabase({
      reads: [
        {
          data: { cal_com_url: null, cal_com_webhook_secret: null },
          error: null,
        },
      ],
      update: { data: null, error: { message: 'permission denied' } },
    });
    const result = await connectCalCom(db.client, {
      workspaceId: WORKSPACE,
      rawLink: 'acme/intro',
      actor: 'user_1',
    });
    expect(result).toMatchObject({ ok: false, reason: 'write_failed' });
    // The ledger row is not written for a save that failed.
    expect(
      db.writes.filter((write) => write.table === 'project_events')
    ).toEqual([]);
  });

  // The save is the thing the client asked for. Losing the audit row is worth
  // a log line, not an error on a screen.
  it('still reports success when the ledger row could not be written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = fakeSupabase({
      reads: [
        {
          data: { cal_com_url: null, cal_com_webhook_secret: null },
          error: null,
        },
      ],
      event: { data: null, error: { message: 'events unavailable' } },
    });
    const result = await connectCalCom(db.client, {
      workspaceId: WORKSPACE,
      rawLink: 'acme/intro',
      actor: 'user_1',
    });
    expect(result.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});

describe('disconnectCalCom', () => {
  it('says nothing rather than clearing a workspace that is not there', async () => {
    const db = fakeSupabase({ reads: [{ data: null, error: null }] });
    expect(
      await disconnectCalCom(db.client, {
        workspaceId: WORKSPACE,
        actor: 'user_1',
      })
    ).toBeNull();
    expect(db.writes).toHaveLength(0);
  });

  it('throws when the clear was refused, so nothing claims it worked', async () => {
    const db = fakeSupabase({
      update: { data: null, error: { message: 'permission denied' } },
    });
    await expect(
      disconnectCalCom(db.client, { workspaceId: WORKSPACE, actor: 'user_1' })
    ).rejects.toBeTruthy();
  });

  it('throws when it could not even find out whether the workspace exists', async () => {
    const db = fakeSupabase({
      reads: [{ data: null, error: { message: 'connection lost' } }],
    });
    await expect(
      disconnectCalCom(db.client, { workspaceId: WORKSPACE, actor: 'user_1' })
    ).rejects.toBeTruthy();
  });
});
