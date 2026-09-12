/**
 * The nudge, and every reason not to send it.
 *
 * A build now waits on a form the client fills in after paying, which creates
 * a state the product never had before: everything is working, nothing is
 * wrong, and nothing is happening. The email that breaks that deadlock is also
 * the easiest one in the system to get wrong, because it is the only one that
 * asks for something. Sent too early it is nagging somebody who is mid-form;
 * sent to a client who has finished it is an accusation; sent twice it is the
 * reason they stop reading our mail. So the cases below are mostly about
 * silence.
 *
 * Everything is driven off an injected clock and an in-memory Supabase double,
 * following `fake-supabase.ts` next door. Nothing here may touch the real
 * clock: a reminder rule tested against `Date.now()` passes in the morning and
 * fails in the afternoon.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { BRIEF_REMINDER_AFTER_MS } from '../brief-readiness';
import {
  remindAllIncompleteBriefs,
  remindIfBriefIncomplete,
} from '../brief-reminder';

const WORKSPACE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const OTHER_WORKSPACE = '9d2c0d4b-6a3e-4a19-8b7a-2f3c5d6e7a81';
const PAID_AT = '2026-09-10T09:00:00.000Z';
/** Two days after the deposit, so the reminder window is well open. */
const NOW = new Date('2026-09-12T09:00:00.000Z');

/** Long enough to satisfy `MIN_OFFER_CHARS`, which is the point of it. */
const REAL_OFFER =
  'We fit and maintain commercial kitchens for independent restaurants in ' +
  'Cluj, from the first drawing to the final gas certificate.';

const sendEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

// Injected in every test below, but the module imports it at load time.
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => {
    throw new Error('no test may reach the real service-role client');
  },
}));

// ───────────────────────────────────────────────────────────────────────────
// The double
// ───────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/**
 * A small in-memory Postgrest, in the style of `fake-supabase.ts`: enough
 * builder surface for the queries this module actually makes (`eq`, `not`,
 * `order`, `limit`, `maybeSingle`, and an awaitable builder), plus per-table
 * error injection, which is how the "the database is down" case is told apart
 * from "the client has not answered".
 */
function createDb() {
  const tables: Record<string, Row[]> = {};
  const failing = new Set<string>();
  let sequence = 0;

  const rows = (table: string): Row[] => (tables[table] ??= []);

  function builder(table: string) {
    let mode: 'select' | 'insert' | 'update' = 'select';
    const filters: Array<[string, unknown]> = [];
    const notNull: string[] = [];
    let payload: Row[] = [];
    let orderColumn: string | undefined;
    let ascending = true;
    let limit: number | undefined;

    function selected(): Row[] {
      let out = rows(table).filter(
        (row) =>
          filters.every(([column, value]) => row[column] === value) &&
          notNull.every((column) => row[column] != null)
      );
      if (orderColumn) {
        const column = orderColumn;
        out = [...out].sort((a, b) => {
          const left = String(a[column] ?? '');
          const right = String(b[column] ?? '');
          return (
            (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1)
          );
        });
      }
      if (limit !== undefined) out = out.slice(0, limit);
      return out;
    }

    const detach = (out: Row[]): Row[] => out.map((row) => ({ ...row }));

    function resolve(): { data: Row[] | null; error: unknown } {
      if (failing.has(table)) {
        return { data: null, error: { message: `fake: ${table} unavailable` } };
      }
      if (mode === 'insert') {
        sequence += 1;
        const inserted = payload.map((values, index) => ({
          id: `row-${sequence}-${index}`,
          created_at: new Date(
            1_700_000_000_000 + sequence * 1_000
          ).toISOString(),
          ...values,
        }));
        rows(table).push(...inserted);
        return { data: detach(inserted), error: null };
      }
      if (mode === 'update') {
        const target = selected();
        for (const row of target) Object.assign(row, payload[0]);
        return { data: detach(target), error: null };
      }
      return { data: detach(selected()), error: null };
    }

    const self = {
      select() {
        return self;
      },
      insert(values: Row | Row[]) {
        mode = 'insert';
        payload = Array.isArray(values) ? values : [values];
        return self;
      },
      update(values: Row) {
        mode = 'update';
        payload = [values];
        return self;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return self;
      },
      not(column: string, operator: string, value: unknown) {
        // Only `.not(col, 'is', null)` is used, and pretending to support more
        // would make a future query silently unfiltered here.
        if (operator !== 'is' || value !== null) {
          throw new Error(`fake: unsupported .not(${column}, ${operator})`);
        }
        notNull.push(column);
        return self;
      },
      order(column: string, options?: { ascending?: boolean }) {
        orderColumn = column;
        ascending = options?.ascending !== false;
        return self;
      },
      limit(count: number) {
        limit = count;
        return self;
      },
      maybeSingle() {
        const { data, error } = resolve();
        return Promise.resolve({ data: data?.[0] ?? null, error });
      },
      single() {
        return self.maybeSingle();
      },
      then(
        onFulfilled: (value: { data: Row[] | null; error: unknown }) => unknown,
        onRejected?: (reason: unknown) => unknown
      ) {
        return Promise.resolve(resolve()).then(onFulfilled, onRejected);
      },
    };
    return self;
  }

  return {
    tables,
    failing,
    rows,
    seed(table: string, seedRows: Row[]) {
      rows(table).push(...seedRows);
    },
    client: { from: builder } as unknown as SupabaseClient<Database>,
  };
}

type Db = ReturnType<typeof createDb>;

function workspaceRow(overrides: Row = {}): Row {
  return {
    id: WORKSPACE,
    project_state: ProjectState.DEPOSIT_PAID,
    deposit_paid_at: PAID_AT,
    client_email: 'client@example.com',
    client_name: 'Darius',
    client_business_name: 'Acme Kitchens',
    name: 'Acme workspace',
    ...overrides,
  };
}

/** A brief with nothing in it: the client has opened the page and left. */
function emptyBrief(overrides: Row = {}): Row {
  return {
    workspace_id: WORKSPACE,
    offer: '',
    projects: [],
    no_projects: false,
    design_reference_asset_ids: [],
    photo_asset_ids: [],
    ready_at: null,
    override_at: null,
    ...overrides,
  };
}

/** A brief with both blocking things answered. */
function completeBrief(overrides: Row = {}): Row {
  return emptyBrief({
    offer: REAL_OFFER,
    projects: [{ name: 'Bistro Mara', line: 'Full kitchen fit-out' }],
    ready_at: '2026-09-11T09:00:00.000Z',
    ...overrides,
  });
}

function seedWorkspace(db: Db, overrides: Row = {}) {
  db.seed('workspaces', [workspaceRow(overrides)]);
}

function mail(): { to: string; subject: string; html: string } {
  return sendEmail.mock.calls[0]![0] as {
    to: string;
    subject: string;
    html: string;
  };
}

beforeEach(() => {
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ success: true, id: 'em_1' });
});

// ───────────────────────────────────────────────────────────────────────────

describe('remindIfBriefIncomplete', () => {
  it('says nothing about a brief that is already complete', async () => {
    const db = createDb();
    seedWorkspace(db);
    db.seed('workspace_briefs', [completeBrief()]);

    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: NOW,
        supabase: db.client,
      })
    ).resolves.toEqual({ sent: false, reason: 'brief_ready' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('leaves a client who paid an hour ago alone', async () => {
    const db = createDb();
    seedWorkspace(db, {
      deposit_paid_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    });
    db.seed('workspace_briefs', [emptyBrief()]);

    // Mid-form is not a silence, and the difference between the two is the
    // only thing standing between this feature and an annoying product.
    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: NOW,
        supabase: db.client,
      })
    ).resolves.toEqual({ sent: false, reason: 'too_soon' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('says nothing once an operator has overridden the gate', async () => {
    const db = createDb();
    seedWorkspace(db);
    db.seed('workspace_briefs', [
      emptyBrief({ override_at: '2026-09-11T12:00:00.000Z' }),
    ]);

    // The build is already allowed to start, so asking for the brief would be
    // asking for something nobody is waiting on.
    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: NOW,
        supabase: db.client,
      })
    ).resolves.toEqual({ sent: false, reason: 'overridden' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('emails a client whose brief has been empty since the deposit', async () => {
    const db = createDb();
    seedWorkspace(db);
    db.seed('workspace_briefs', [emptyBrief()]);

    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: NOW,
        supabase: db.client,
      })
    ).resolves.toEqual({ sent: true });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(mail().to).toBe('client@example.com');
    expect(mail().subject).toBe('We are waiting on a few things for your site');
    expect(mail().html).toContain(`/dashboard/projects/${WORKSPACE}/brief`);
    // The blocking asks, in the rule's own words.
    expect(mail().html).toContain('what you sell');
    expect(mail().html).toContain('Your products or projects');
    // And not the nice-to-haves, which would make the job look longer.
    expect(mail().html).not.toContain('One portrait of you');
  });

  it('emails a client who has written a line and stopped', async () => {
    const db = createDb();
    seedWorkspace(db);
    db.seed('workspace_briefs', [
      emptyBrief({ offer: 'We fit kitchens.', no_projects: true }),
    ]);

    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: NOW,
        supabase: db.client,
      })
    ).resolves.toEqual({ sent: true });
    // "A little more on what you offer", not "you have written nothing".
    expect(mail().html).toContain('A little more on what you offer');
  });

  it('treats a client with no brief row at all as not started', async () => {
    const db = createDb();
    seedWorkspace(db);

    // The most important case in this file: never having opened the page is
    // not a row, so a query that only looked at `workspace_briefs` would miss
    // exactly the client who most needs the email.
    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: NOW,
        supabase: db.client,
      })
    ).resolves.toEqual({ sent: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('judges photographs the way the client dashboard does', async () => {
    const db = createDb();
    seedWorkspace(db);
    db.seed('workspace_briefs', [
      completeBrief({ photo_asset_ids: ['asset-1'] }),
    ]);
    db.seed('assets', [
      {
        workspace_id: WORKSPACE,
        id: 'asset-1',
        kind: 'portrait',
        width: 2400,
        height: 1600,
        rights_confirmed_at: '2026-09-11T10:00:00.000Z',
      },
    ]);

    // A photograph is a `degrades`, never a blocker, so this brief is ready
    // and the assets read exists only so the two views agree about it.
    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: NOW,
        supabase: db.client,
      })
    ).resolves.toEqual({ sent: false, reason: 'brief_ready' });
  });

  it('says nothing exactly on the reminder boundary and something one tick later', async () => {
    const boundary = new Date(Date.parse(PAID_AT) + BRIEF_REMINDER_AFTER_MS);
    const early = createDb();
    seedWorkspace(early);
    early.seed('workspace_briefs', [emptyBrief()]);
    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: new Date(boundary.getTime() - 1),
        supabase: early.client,
      })
    ).resolves.toEqual({ sent: false, reason: 'too_soon' });

    const late = createDb();
    seedWorkspace(late);
    late.seed('workspace_briefs', [emptyBrief()]);
    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: boundary,
        supabase: late.client,
      })
    ).resolves.toEqual({ sent: true });
  });

  it('does not nudge a project whose build is already running', async () => {
    const db = createDb();
    seedWorkspace(db, { project_state: ProjectState.AGENTS_WORKING });
    db.seed('workspace_briefs', [emptyBrief()]);

    // Past the gate one way or another. Asking for the brief now would be a
    // lie about what is holding the site up.
    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: NOW,
        supabase: db.client,
      })
    ).resolves.toEqual({ sent: false, reason: 'not_waiting' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('reports a workspace that no longer exists rather than throwing', async () => {
    const db = createDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: NOW,
        supabase: db.client,
      })
    ).resolves.toEqual({ sent: false, reason: 'workspace_missing' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never throws when the brief table cannot be read', async () => {
    const db = createDb();
    seedWorkspace(db);
    db.failing.add('workspace_briefs');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: NOW,
        supabase: db.client,
      })
    ).resolves.toEqual({ sent: false, reason: 'lookup_failed' });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('never throws when the files cannot be read', async () => {
    const db = createDb();
    seedWorkspace(db);
    db.seed('workspace_briefs', [emptyBrief()]);
    db.failing.add('assets');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: NOW,
        supabase: db.client,
      })
    ).resolves.toEqual({ sent: false, reason: 'lookup_failed' });
    errors.mockRestore();
  });

  it('reports a failed send without recording it, so it can be retried', async () => {
    const db = createDb();
    seedWorkspace(db);
    db.seed('workspace_briefs', [emptyBrief()]);
    sendEmail.mockResolvedValue({ success: false, error: 'mailer down' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: NOW,
        supabase: db.client,
      })
    ).resolves.toEqual({ sent: false, reason: 'send_failed' });
    // Nothing under the "sent" kind: an unconfigured mailer must not be able
    // to permanently consume the one email this client is owed. (It IS
    // recorded under the separate `client_email_failed` kind, so the
    // workspace still has history; see client-notifications.test.ts.)
    expect(
      db
        .rows('project_events')
        .filter((row) => row.kind === 'client_email_sent')
    ).toHaveLength(0);
    errors.mockRestore();
  });

  it('says it once, however often it is called', async () => {
    const db = createDb();
    seedWorkspace(db);
    db.seed('workspace_briefs', [emptyBrief()]);

    await remindIfBriefIncomplete({
      workspaceId: WORKSPACE,
      now: NOW,
      supabase: db.client,
    });
    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: new Date(NOW.getTime() + BRIEF_REMINDER_AFTER_MS),
        supabase: db.client,
      })
    ).resolves.toEqual({ sent: false, reason: 'already_sent' });
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const ledger = db.rows('project_events')[0];
    expect(ledger).toMatchObject({
      workspace_id: WORKSPACE,
      kind: 'client_email_sent',
    });
    expect(ledger?.payload).toMatchObject({
      notification: 'brief_incomplete',
      missing: ['brief_offer_missing', 'brief_projects_unanswered'],
    });
  });

  /**
   * `projects` is a jsonb column, so what comes back is whatever went in: a
   * row written by an earlier shape, or by an operator with psql. A sweep that
   * threw on one of those would stop dead and every client behind it in the
   * list would hear nothing.
   */
  it('reads a malformed brief row without throwing, and judges what it can', async () => {
    const db = createDb();
    seedWorkspace(db);
    db.seed('workspace_briefs', [
      emptyBrief({
        offer: null,
        // Not an array, entries that are not objects, a project with no name
        // and screenshot ids that are not strings.
        projects: [
          'nonsense',
          null,
          {
            line: 'A project with no name',
            screenshotAssetIds: [1, 'asset-9'],
          },
          { name: 'Bistro Mara' },
        ],
        design_reference_asset_ids: null,
        photo_asset_ids: null,
      }),
    ]);

    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: NOW,
        supabase: db.client,
      })
    ).resolves.toEqual({ sent: true });
    // The offer is empty and one of the two projects has no name, so both
    // blocking codes are asked for and the junk is simply not counted.
    expect(mail().html).toContain('what you sell');
    expect(mail().html).toContain('A name for every project');
  });

  it('ignores a photo id whose file is gone', async () => {
    const db = createDb();
    seedWorkspace(db);
    db.seed('workspace_briefs', [
      completeBrief({ photo_asset_ids: ['asset-1', 'deleted-asset'] }),
    ]);
    db.seed('assets', [
      {
        workspace_id: WORKSPACE,
        id: 'asset-1',
        kind: null,
        width: 800,
        height: 600,
        rights_confirmed_at: null,
      },
    ]);

    // A dangling id is a file that was deleted after the brief named it. It is
    // not a photograph and it is not an error.
    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: NOW,
        supabase: db.client,
      })
    ).resolves.toEqual({ sent: false, reason: 'brief_ready' });
  });

  it('never throws when there is no client to build at all', async () => {
    // No `supabase` and no `now`: the production call shape. The mock of
    // `@/supabase-clients/server` throws, which is the closest thing to an
    // environment with no service key, and the contract says the caller still
    // gets an answer.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      remindIfBriefIncomplete({ workspaceId: WORKSPACE })
    ).resolves.toEqual({ sent: false, reason: 'lookup_failed' });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('sends nothing when the workspace has no client address', async () => {
    const db = createDb();
    seedWorkspace(db, { client_email: null });
    db.seed('workspace_briefs', [emptyBrief()]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      remindIfBriefIncomplete({
        workspaceId: WORKSPACE,
        now: NOW,
        supabase: db.client,
      })
    ).resolves.toEqual({ sent: false, reason: 'no_recipient' });
    warn.mockRestore();
  });
});

describe('remindAllIncompleteBriefs', () => {
  it('sweeps the deposits that are waiting and skips the ones that are not', async () => {
    const db = createDb();
    db.seed('workspaces', [
      workspaceRow(),
      workspaceRow({
        id: OTHER_WORKSPACE,
        deposit_paid_at: '2026-09-09T09:00:00.000Z',
        client_email: 'other@example.com',
      }),
      // Live, so not a candidate at all.
      workspaceRow({
        id: '5b8f7c1e-1d2a-4c3b-9e4f-6a7b8c9d0e1f',
        project_state: ProjectState.LIVE_SUBSCRIPTION,
      }),
      // Never paid.
      workspaceRow({
        id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        deposit_paid_at: null,
      }),
    ]);
    db.seed('workspace_briefs', [
      emptyBrief(),
      emptyBrief({ workspace_id: OTHER_WORKSPACE }),
    ]);

    const result = await remindAllIncompleteBriefs({
      now: NOW,
      supabase: db.client,
    });

    expect(result).toEqual({ considered: 2, sent: 2 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('counts a workspace it looked at and did not write to', async () => {
    const db = createDb();
    seedWorkspace(db);
    db.seed('workspace_briefs', [completeBrief()]);

    await expect(
      remindAllIncompleteBriefs({ now: NOW, supabase: db.client })
    ).resolves.toEqual({ considered: 1, sent: 0 });
  });

  it('honours a smaller limit', async () => {
    const db = createDb();
    db.seed('workspaces', [
      workspaceRow(),
      workspaceRow({ id: OTHER_WORKSPACE, client_email: 'other@example.com' }),
    ]);

    await expect(
      remindAllIncompleteBriefs({ now: NOW, limit: 1, supabase: db.client })
    ).resolves.toEqual({ considered: 1, sent: 1 });
  });

  it('never throws when the sweep has no client either', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(remindAllIncompleteBriefs()).resolves.toEqual({
      considered: 0,
      sent: 0,
    });
    errors.mockRestore();
  });

  it('caps a limit somebody asked too much of', async () => {
    const db = createDb();
    seedWorkspace(db);
    db.seed('workspace_briefs', [completeBrief()]);

    // A sweep is a background job with no deadline, not a way to mail the
    // entire book at once.
    await expect(
      remindAllIncompleteBriefs({
        now: NOW,
        limit: 10_000,
        supabase: db.client,
      })
    ).resolves.toEqual({ considered: 1, sent: 0 });
    await expect(
      remindAllIncompleteBriefs({ now: NOW, limit: 0, supabase: db.client })
    ).resolves.toEqual({ considered: 1, sent: 0 });
  });

  it('returns zeroes rather than throwing when the sweep query fails', async () => {
    const db = createDb();
    db.failing.add('workspaces');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      remindAllIncompleteBriefs({ now: NOW, supabase: db.client })
    ).resolves.toEqual({ considered: 0, sent: 0 });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
