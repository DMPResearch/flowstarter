/**
 * Publishing an edit does not deploy, it asks for a build.
 *
 * The worker freezes the manifest it will build at claim time, so a publish
 * may only join a *queued* job. Joining a running one would silently drop the
 * edit the client just paid attention to, so the rule is: join queued,
 * otherwise start a new job even when one is already running.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueSiteRebuild } from '../site-rebuild';

interface Script {
  queued: Array<{ id: string }>;
  queuedError?: { message: string };
  insert?: { data: { id: string } | null; error: { code?: string } | null };
}

const script: Script = { queued: [] };
const captured: { inserts: Array<Record<string, unknown>>; filters: string[] } =
  { inserts: [], filters: [] };

function builderFor(table: string) {
  let mode: 'select' | 'insert' = 'select';
  const builder = {
    select() {
      return builder;
    },
    insert(values: Record<string, unknown>) {
      mode = 'insert';
      captured.inserts.push({ table, ...values });
      return builder;
    },
    eq(column: string, value: unknown) {
      captured.filters.push(`${column}=${String(value)}`);
      return builder;
    },
    in(column: string, values: string[]) {
      captured.filters.push(`${column} in ${values.join('|')}`);
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    single() {
      return Promise.resolve(
        script.insert ?? { data: { id: 'job-new' }, error: null }
      );
    },
    maybeSingle() {
      if (mode === 'insert') return builder.single();
      if (script.queuedError) {
        return Promise.resolve({ data: null, error: script.queuedError });
      }
      return Promise.resolve({ data: script.queued[0] ?? null, error: null });
    },
  };
  return builder;
}

const supabase = { from: builderFor } as never;

function enqueue() {
  return enqueueSiteRebuild({
    supabase,
    workspaceId: 'ws-1',
    version: 7,
    publishedBy: 'user_client',
  });
}

beforeEach(() => {
  script.queued = [];
  delete script.queuedError;
  delete script.insert;
  captured.inserts = [];
  captured.filters = [];
});

describe('enqueueSiteRebuild', () => {
  it('starts a build and says what asked for it', async () => {
    expect(await enqueue()).toEqual({ jobId: 'job-new', created: true });

    expect(captured.inserts[0]).toMatchObject({
      table: 'flowstarter_agent_jobs',
      workspace_id: 'ws-1',
      kind: 'SITE_REBUILD',
      status: 'queued',
    });
    expect(captured.inserts[0]!.payload).toEqual({
      trigger: 'client_publish',
      version: 7,
      publishedBy: 'user_client',
    });
  });

  it('joins the rebuild that is already queued instead of spending an insert', async () => {
    script.queued = [{ id: 'job-queued' }];

    expect(await enqueue()).toEqual({ jobId: 'job-queued', created: false });
    expect(captured.inserts).toEqual([]);
    // Only a queued job is joinable: a running one has already frozen its
    // manifest and would lose this edit.
    expect(captured.filters).toContain('status in queued');
    expect(captured.filters).toContain('workspace_id=ws-1');
    expect(captured.filters).toContain('kind=SITE_REBUILD');
  });

  it('joins the winner when two publishes race the unique index', async () => {
    script.insert = { data: null, error: { code: '23505' } };
    let reads = 0;
    const racing = {
      from(table: string) {
        const builder = builderFor(table);
        const inner = builder.maybeSingle.bind(builder);
        builder.maybeSingle = () => {
          reads += 1;
          // The first read saw nothing queued; by the time the index refused,
          // the other publish's row is there.
          script.queued = reads > 1 ? [{ id: 'job-winner' }] : [];
          return inner();
        };
        return builder;
      },
    } as never;

    const result = await enqueueSiteRebuild({
      supabase: racing,
      workspaceId: 'ws-1',
      version: 7,
      publishedBy: 'user_client',
    });

    expect(result).toEqual({ jobId: 'job-winner', created: false });
  });

  it('does not pretend to have queued a build it cannot find', async () => {
    script.insert = { data: null, error: { code: '23505' } };
    script.queued = [];

    await expect(enqueue()).rejects.toThrow(/could not be read back/);
  });

  it('surfaces an insert that failed for any other reason', async () => {
    script.insert = { data: null, error: { code: '42501' } };
    await expect(enqueue()).rejects.toMatchObject({ code: '42501' });

    script.insert = { data: null, error: null };
    await expect(enqueue()).rejects.toThrow(/Could not enqueue/);
  });

  it('surfaces a failed read rather than starting a duplicate build', async () => {
    script.queuedError = { message: 'connection reset' };
    await expect(enqueue()).rejects.toMatchObject({
      message: 'connection reset',
    });
    expect(captured.inserts).toEqual([]);
  });
});
