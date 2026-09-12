/**
 * The claim gives the client a calendar, and never at the cost of the project.
 *
 * The booking page on a built site used to be the one thing on it that did not
 * work: the client had to go and get a Cal.com account of their own, find
 * their link and paste it in, and almost nobody did. The claim now makes the
 * whole thing for them.
 *
 * That means the claim depends on another service for the first time, so what
 * is pinned here is the blast radius rather than the feature:
 *
 *   - it runs exactly once per claim, with the actor and the intake the rest
 *     of the pipeline uses, and with the email callback attached;
 *   - a Cal that is down, or one that throws on the way to being opened, still
 *     returns a claimed workspace. The client owns their project whatever
 *     happened to the calendar;
 *   - it runs AFTER the `preview_claimed` ledger event, because that row is
 *     what the rest of the funnel reads and a slow Cal must not delay it;
 *   - a re-claim asks again, since provisioning is idempotent and the first
 *     claim may have died before it got there.
 *
 * Static imports: vi.mock is hoisted above them, and the app's tsconfig does
 * not allow top-level await in tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './fake-supabase';

vi.mock('server-only', () => ({}));

const db = createFakeSupabase();

/**
 * Two claims racing, as Postgres reports it.
 *
 * `workspaces.claimed_preview_id` carries a partial unique index, so the loser
 * of a double submit gets a 23505 from its insert and has to adopt the
 * winner's workspace. The fake has no constraints, so `losesTheRace` below
 * makes the next insert answer the way the real one would and writes the
 * winner's row at the same moment, which is exactly the interleaving the
 * branch exists for.
 */
const race = { pending: false, winner: '' };
const RACE_WINNER = 'b7f1c2d3-2222-4222-8222-222222222222';

const client = {
  from(table: string) {
    const builder = db.client.from(table) as Record<string, unknown>;
    if (table !== 'workspaces' || !race.pending) return builder;
    return new Proxy(builder, {
      get(target, prop) {
        if (prop === 'insert') {
          return () => {
            race.pending = false;
            db.seed('workspaces', [
              { id: race.winner, claimed_preview_id: PREVIEW_ID },
            ]);
            return {
              select: () => ({
                maybeSingle: async () => ({
                  data: null,
                  error: { code: '23505', message: 'duplicate key' },
                }),
              }),
            };
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  },
};

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => client,
}));

vi.mock('../membership', () => ({
  ensureClientMembership: vi.fn(async () => ({ created: true })),
}));
vi.mock('../messaging', () => ({
  appendClientReplyToCorpus: vi.fn(async () => true),
}));
vi.mock('../intake-submission', () => ({
  recordIntakeSubmission: vi.fn(async () => ({})),
}));
vi.mock('../preview-artifacts', () => ({
  savePreviewArtifacts: vi.fn(async () => ({ advanced: true })),
  PreviewArtifactError: class extends Error {},
}));
// This claim has no stashed preview, which is the guest path and the one that
// isolates the provisioning step from everything the funnel does.
vi.mock('@/lib/hosting/funnel-previews', () => ({
  claimFunnelPreview: vi.fn(async () => null),
  copyFunnelArtifactToTenant: vi.fn(async () => undefined),
  loadFunnelPreview: vi.fn(async () => null),
  saveFunnelPreview: vi.fn(async () => undefined),
}));
vi.mock('../funnel-assets', () => ({
  claimFunnelAssets: vi.fn(async () => ({ carried: [], failed: [] })),
  confirmFetchedPictureRights: vi.fn(async () => undefined),
}));

/** The spy the whole file is about. */
const provisionWorkspaceCalendar = vi.fn();
vi.mock('../cal-provisioning', () => ({
  provisionWorkspaceCalendar: (...args: unknown[]) =>
    provisionWorkspaceCalendar(...args),
}));
const notifyClientBookingPageReady = vi.fn(async (..._args: unknown[]) => ({
  sent: true,
}));
vi.mock('../cal-provisioned-notice', () => ({
  notifyClientBookingPageReady: (...args: unknown[]) =>
    notifyClientBookingPageReady(...args),
}));

import { claimPreview, clearClaimablePreviews } from '../claim';

const PREVIEW_ID = 'a1b2c3d4-1111-4111-8111-111111111111';

function provisioned() {
  return {
    ok: true,
    state: 'provisioned',
    bookingUrl: 'https://cal.flowstarter.dev/calm-path/intro-call',
    username: 'calm-path',
    calUserId: 7,
    calEventTypeId: 11,
    alreadyProvisioned: false,
  };
}

function claim(overrides: Record<string, unknown> = {}) {
  return claimPreview({
    previewId: PREVIEW_ID,
    clerkUserId: 'user_visitor',
    tier: 'pro',
    businessName: 'Calm Path',
    clientEmail: 'ana@example.com',
    ...overrides,
  });
}

beforeEach(() => {
  db.reset();
  clearClaimablePreviews();
  vi.clearAllMocks();
  race.pending = false;
  race.winner = RACE_WINNER;
  provisionWorkspaceCalendar.mockResolvedValue(provisioned());
});

describe('a claim provisions the client a booking page', () => {
  it('asks once, as the claim, with the intake and the email callback', async () => {
    const result = await claim({
      intakeSummary: { timeZone: 'Europe/Bucharest', pageCount: 'Under 5' },
    });

    expect(provisionWorkspaceCalendar).toHaveBeenCalledTimes(1);
    const call = provisionWorkspaceCalendar.mock.calls[0]?.[0] as {
      workspaceId: string;
      actor: string;
      intake: Record<string, unknown> | null;
      notify: (notice: Record<string, unknown>) => Promise<unknown>;
      supabase: unknown;
    };
    expect(call.workspaceId).toBe(result.workspaceId);
    expect(call.actor).toBe('claim');
    expect(call.intake).toMatchObject({ timeZone: 'Europe/Bucharest' });
    expect(call.supabase).toBe(client);

    // The email is the client's only prompt to set a password on the account
    // we just made them, so the callback has to be the real one. Called here
    // rather than compared by identity, because the mock wraps it.
    await call.notify({ workspaceId: result.workspaceId });
    expect(notifyClientBookingPageReady).toHaveBeenCalledTimes(1);
  });

  it('passes a null intake rather than an empty object for a guest claim', async () => {
    await claim({ intakeSummary: undefined });
    expect(provisionWorkspaceCalendar.mock.calls[0]?.[0]).toMatchObject({
      intake: null,
    });
  });

  // The ordering that matters: `preview_claimed` is what the rest of the
  // funnel reads, and a Cal that takes ten seconds must not hold it up.
  it('runs after the preview_claimed ledger event', async () => {
    const order: string[] = [];
    provisionWorkspaceCalendar.mockImplementation(async () => {
      order.push(
        `provision:${db
          .rows('project_events')
          .map((event) => event.kind)
          .join(',')}`
      );
      return provisioned();
    });

    await claim();

    expect(order).toEqual(['provision:preview_claimed']);
  });
});

describe('a booking page that could not be made', () => {
  it('still returns a claimed workspace when provisioning reports a failure', async () => {
    provisionWorkspaceCalendar.mockResolvedValue({
      ok: false,
      state: 'failed',
      reason: 'The booking service could not be reached. We will try again.',
    });

    const result = await claim();

    expect(result.workspaceId).toBeTruthy();
    expect(result.alreadyClaimed).toBe(false);
    expect(result.unlockUrl).toContain(result.workspaceId);
    // The workspace is really there, not just reported.
    expect(
      db.rows('workspaces').some((row) => row.id === result.workspaceId)
    ).toBe(true);
  });

  it('still returns a claimed workspace when provisioning throws', async () => {
    // `provisionWorkspaceCalendar` promises never to throw, but opening the
    // connection to Cal's database happens inside it and a DNS failure is not
    // something the claim gets to find out about the hard way.
    provisionWorkspaceCalendar.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await claim();

    expect(result.workspaceId).toBeTruthy();
    expect(db.rows('project_events').map((event) => event.kind)).toContain(
      'preview_claimed'
    );
  });

  it('does not report a booking failure on the claim result', async () => {
    provisionWorkspaceCalendar.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await claim();
    // The shape the unlock page reads is unchanged: nothing about Cal reaches
    // it, because nothing about Cal should stop a deposit.
    expect(Object.keys(result).sort()).toEqual([
      'alreadyClaimed',
      'intakeChatDocuments',
      'previewReady',
      'quoteMinor',
      'unlockUrl',
      'workspaceId',
    ]);
  });
});

describe('re-claiming the same preview', () => {
  it('asks again, because the first claim may not have got there', async () => {
    const first = await claim();
    expect(provisionWorkspaceCalendar).toHaveBeenCalledTimes(1);

    const second = await claim();

    expect(second.alreadyClaimed).toBe(true);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(provisionWorkspaceCalendar).toHaveBeenCalledTimes(2);
    expect(provisionWorkspaceCalendar.mock.calls[1]?.[0]).toMatchObject({
      workspaceId: first.workspaceId,
      actor: 'claim',
    });
  });

  // The other way a claim ends up adopting a workspace instead of making one:
  // a double submit where Postgres, not a prior read, is what tells us.
  it('asks for the winner of a race, not for the workspace it never made', async () => {
    race.pending = true;

    const result = await claim();

    expect(result.alreadyClaimed).toBe(true);
    expect(result.workspaceId).toBe(RACE_WINNER);
    expect(provisionWorkspaceCalendar).toHaveBeenCalledTimes(1);
    expect(provisionWorkspaceCalendar.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: RACE_WINNER,
      actor: 'claim',
    });
  });

  it('does not mint a second workspace when the calendar is unreachable', async () => {
    const first = await claim();
    provisionWorkspaceCalendar.mockRejectedValue(new Error('ETIMEDOUT'));

    const second = await claim();

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(db.rows('workspaces')).toHaveLength(1);
  });
});
