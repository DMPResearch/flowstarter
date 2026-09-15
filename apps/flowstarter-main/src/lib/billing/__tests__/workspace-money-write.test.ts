/**
 * The atomic write the Stripe webhook route was missing (Codex audit F12):
 * subscription and invoice handlers used to read a workspace's money state,
 * decide a transition against it, and write through an update filtered only
 * by workspace id. Two genuinely concurrent events for the same object both
 * read the same pre-write state and both write, and whichever write reached
 * Postgres last won — even the chronologically OLDER event.
 *
 * `casUpdateWorkspaceMoneyState` closes that with a compare-and-set on
 * `billing_version`. These tests exercise it directly, including the
 * scenario the audit named explicitly: two events, decided against the same
 * stale snapshot, completing in reversed order.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createFakeSupabase } from '@/lib/flowstarter/__tests__/fake-supabase';
import {
  casUpdateWorkspaceMoneyState,
  loadWorkspaceMoneyState,
  type WorkspaceMoneyState,
} from '../workspace-money-write';

vi.mock('server-only', () => ({}));

const WORKSPACE = 'ws_1';

/** The fake's `client` is loosely typed for its usual `vi.mock` callers;
 * these tests call the money-write functions directly, which want the real
 * service-client type. */
function client(
  db: ReturnType<typeof createFakeSupabase>
): SupabaseClient<Database> {
  return db.client as unknown as SupabaseClient<Database>;
}

function seed(
  db: ReturnType<typeof createFakeSupabase>,
  overrides: Record<string, unknown> = {}
) {
  db.seed('workspaces', [
    {
      id: WORKSPACE,
      deposit_status: 'unpaid',
      final_status: 'unpaid',
      subscription_status: null,
      stripe_subscription_id: null,
      subscription_next_billing: null,
      billing_version: 0,
      ...overrides,
    },
  ]);
}

async function readState(
  db: ReturnType<typeof createFakeSupabase>
): Promise<WorkspaceMoneyState> {
  const state = await loadWorkspaceMoneyState(client(db), WORKSPACE);
  if (!state) throw new Error('workspace not seeded');
  return state;
}

describe('loadWorkspaceMoneyState', () => {
  it('returns null for a workspace that does not exist', async () => {
    const db = createFakeSupabase();
    await expect(
      loadWorkspaceMoneyState(client(db), WORKSPACE)
    ).resolves.toBeNull();
  });

  it('throws on a read failure rather than returning a flag', async () => {
    const db = createFakeSupabase();
    seed(db);
    db.failing.add('workspaces');
    await expect(
      loadWorkspaceMoneyState(client(db), WORKSPACE)
    ).rejects.toThrow(/could not read workspace/);
  });
});

describe('casUpdateWorkspaceMoneyState', () => {
  it('writes the decided values and bumps billing_version', async () => {
    const db = createFakeSupabase();
    seed(db);
    const initial = await readState(db);

    const wrote = await casUpdateWorkspaceMoneyState(
      client(db),
      WORKSPACE,
      'deposit paid',
      initial,
      () => ({ deposit_status: 'paid' })
    );

    expect(wrote).toBe(true);
    const row = db.rows('workspaces')[0];
    expect(row?.deposit_status).toBe('paid');
    expect(row?.billing_version).toBe(1);
  });

  it('writes nothing and resolves false when decide refuses the transition', async () => {
    const db = createFakeSupabase();
    seed(db, { deposit_status: 'paid' });
    const initial = await readState(db);

    const wrote = await casUpdateWorkspaceMoneyState(
      client(db),
      WORKSPACE,
      'deposit paid',
      initial,
      (state) =>
        state.deposit_status === 'paid' ? null : { deposit_status: 'paid' }
    );

    expect(wrote).toBe(false);
    expect(db.rows('workspaces')[0]?.billing_version).toBe(0);
  });

  it('rereads and re-decides once when a concurrent write already advanced the version', async () => {
    const db = createFakeSupabase();
    seed(db);
    const stale = await readState(db);

    // A concurrent write lands between the read above and the call below.
    await casUpdateWorkspaceMoneyState(
      client(db),
      WORKSPACE,
      'a concurrent write',
      stale,
      () => ({
        deposit_status: 'overdue',
      })
    );
    expect(db.rows('workspaces')[0]?.billing_version).toBe(1);

    const decideCalls: WorkspaceMoneyState[] = [];
    const wrote = await casUpdateWorkspaceMoneyState(
      client(db),
      WORKSPACE,
      'this call',
      stale, // the same stale snapshot the concurrent write also started from
      (state) => {
        decideCalls.push(state);
        return { deposit_status: 'paid' };
      }
    );

    expect(wrote).toBe(true);
    // Once against the stale snapshot (version 0, which loses the CAS), once
    // against the fresh reread (version 1) — not blindly against the first.
    expect(decideCalls).toHaveLength(2);
    expect(decideCalls[0]?.billing_version).toBe(0);
    expect(decideCalls[1]?.billing_version).toBe(1);
    expect(db.rows('workspaces')[0]?.billing_version).toBe(2);
  });

  it('throws rather than looping forever when it still cannot converge after one retry', async () => {
    // A hand-rolled client whose update() never matches, however state is
    // reread — sustained contention this function is documented not to
    // absorb indefinitely.
    let updateAttempts = 0;
    const client = {
      from(table: string) {
        expect(table).toBe('workspaces');
        const builder = {
          select() {
            return builder;
          },
          update() {
            updateAttempts += 1;
            return builder;
          },
          eq() {
            return builder;
          },
          match() {
            return builder;
          },
          maybeSingle() {
            return Promise.resolve({
              data: { ...seedRow, billing_version: updateAttempts },
              error: null,
            });
          },
          then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
            // Every update matches zero rows, whatever version it used.
            return Promise.resolve(resolve({ data: [], error: null }));
          },
        };
        return builder;
      },
    };
    const seedRow = {
      deposit_status: 'unpaid',
      final_status: 'unpaid',
      subscription_status: null,
      stripe_subscription_id: null,
      subscription_next_billing: null,
      refunded_amount_minor: 0,
      final_value_minor: null,
      setup_fee: null,
      billing_version: 0,
    };

    await expect(
      casUpdateWorkspaceMoneyState(
        client as unknown as Parameters<typeof casUpdateWorkspaceMoneyState>[0],
        WORKSPACE,
        'stuck write',
        { ...seedRow },
        () => ({ deposit_status: 'paid' })
      )
    ).rejects.toThrow(/could not converge/);
    expect(updateAttempts).toBe(2);
  });

  // F12, stated directly: two events for the same object, decided against
  // the identical pre-write state, complete in reversed order. The older
  // one's write must not survive over the newer one's, whichever finishes
  // last.
  describe('two events completing in reversed order', () => {
    function periodDecider(candidatePeriodEnd: string) {
      return (state: WorkspaceMoneyState) => {
        const stored = state.subscription_next_billing
          ? Date.parse(state.subscription_next_billing)
          : null;
        const candidate = Date.parse(candidatePeriodEnd);
        if (stored !== null && candidate < stored) return null; // a real regression check
        return {
          subscription_status: 'active',
          stripe_subscription_id: 'sub_1',
          subscription_next_billing: candidatePeriodEnd,
        };
      };
    }

    it('refuses the older event when its write reaches the database after the newer one already landed', async () => {
      const db = createFakeSupabase();
      seed(db, {
        subscription_status: 'active',
        stripe_subscription_id: 'sub_1',
      });
      // Both events read this same state before either decided to write —
      // the concurrency the ledger's "not a lease" design explicitly allows.
      const initial = await readState(db);

      const newerCompletesFirst = await casUpdateWorkspaceMoneyState(
        client(db),
        WORKSPACE,
        'newer event',
        initial,
        periodDecider('2026-11-01T00:00:00.000Z')
      );
      expect(newerCompletesFirst).toBe(true);

      const olderCompletesSecond = await casUpdateWorkspaceMoneyState(
        client(db),
        WORKSPACE,
        'older event',
        initial, // the identical stale snapshot, not a fresh read
        periodDecider('2026-10-01T00:00:00.000Z')
      );
      expect(olderCompletesSecond).toBe(false);

      const row = db.rows('workspaces')[0];
      expect(row?.subscription_next_billing).toBe('2026-11-01T00:00:00.000Z');
    });

    it('still applies the newer event when it completes second, after the older one won the race to write first', async () => {
      const db = createFakeSupabase();
      seed(db, {
        subscription_status: 'active',
        stripe_subscription_id: 'sub_1',
      });
      const initial = await readState(db);

      const olderCompletesFirst = await casUpdateWorkspaceMoneyState(
        client(db),
        WORKSPACE,
        'older event',
        initial,
        periodDecider('2026-10-01T00:00:00.000Z')
      );
      expect(olderCompletesFirst).toBe(true);

      const newerCompletesSecond = await casUpdateWorkspaceMoneyState(
        client(db),
        WORKSPACE,
        'newer event',
        initial,
        periodDecider('2026-11-01T00:00:00.000Z')
      );
      expect(newerCompletesSecond).toBe(true);

      const row = db.rows('workspaces')[0];
      expect(row?.subscription_next_billing).toBe('2026-11-01T00:00:00.000Z');
    });
  });
});
