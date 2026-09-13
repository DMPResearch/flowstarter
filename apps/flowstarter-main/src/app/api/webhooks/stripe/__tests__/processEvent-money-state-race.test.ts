/**
 * Codex audit F12: the Stripe event ledger (`stripe-events.ts`) is
 * deliberately not a lease — two genuinely concurrent deliveries of
 * *different* events for the same Stripe object are both allowed to run.
 * `route.test.ts`'s `ordering` block proves the ledger's own
 * `latestAppliedCreated` pre-check refuses an event that arrives after a
 * *later* one has already been marked processed. That check cannot help
 * here: it only sees events that have already finished, and two truly
 * concurrent deliveries both read it before either one has.
 *
 * This file drives `processEvent` — the same dispatcher `POST` calls after
 * signature verification and the ledger claim — directly against a
 * stateful fake `workspaces` table, so both "events" really do read the
 * same pre-write row before either writes, and their writes can be made to
 * land in either order. That is what `casUpdateWorkspaceMoneyState`'s
 * `billing_version` compare-and-set exists for.
 */
import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createFakeSupabase } from '@/lib/flowstarter/__tests__/fake-supabase';
import { processEvent } from '../route';

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

/** The fake's `client` is loosely typed for its usual `vi.mock` callers;
 * these tests call `processEvent` directly, which wants the real
 * service-client type. */
function client(
  db: ReturnType<typeof createFakeSupabase>
): SupabaseClient<Database> {
  return db.client as unknown as SupabaseClient<Database>;
}

function seedWorkspace(
  db: ReturnType<typeof createFakeSupabase>,
  overrides: Record<string, unknown> = {}
) {
  db.seed('workspaces', [
    {
      id: WORKSPACE_ID,
      deposit_status: 'unpaid',
      final_status: 'unpaid',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_1',
      subscription_next_billing: '2026-09-01T00:00:00.000Z',
      billing_version: 0,
    },
  ]);
  Object.assign(db.rows('workspaces')[0]!, overrides);
}

function subscriptionEvent(input: {
  id: string;
  created: number;
  periodEnd: number;
}): Stripe.Event {
  return {
    id: input.id,
    type: 'customer.subscription.updated',
    created: input.created,
    data: {
      object: {
        id: 'sub_1',
        status: 'active',
        metadata: { workspaceId: WORKSPACE_ID },
        items: { data: [{ current_period_end: input.periodEnd }] },
      },
    },
  } as unknown as Stripe.Event;
}

// Distinct from the money-state row's starting `created` so neither event
// collides with it; the ledger has no rows at all in these tests, so
// `resolveOrdered`'s ledger pre-check always returns 'apply' for both — the
// billing-period regression check inside `casUpdateWorkspaceMoneyState`'s
// `decide` callback is the only thing left to arbitrate the race.
const OLDER_PERIOD_END = Date.parse('2026-10-01T00:00:00.000Z') / 1000;
const NEWER_PERIOD_END = Date.parse('2026-11-01T00:00:00.000Z') / 1000;

describe('processEvent: two subscription events racing the same workspace', () => {
  it('refuses the older event once the newer one has already completed', async () => {
    const db = createFakeSupabase();
    seedWorkspace(db);

    const newer = subscriptionEvent({
      id: 'evt_newer',
      created: 2_000_000_100,
      periodEnd: NEWER_PERIOD_END,
    });
    const older = subscriptionEvent({
      id: 'evt_older',
      created: 2_000_000_000,
      periodEnd: OLDER_PERIOD_END,
    });

    // The newer event's write reaches the database first.
    await expect(processEvent(client(db), newer)).resolves.toBe('processed');
    expect(db.rows('workspaces')[0]?.subscription_next_billing).toBe(
      new Date(NEWER_PERIOD_END * 1000).toISOString()
    );

    // The older event's write arrives second and must not regress the
    // billing period the newer event already applied.
    await expect(processEvent(client(db), older)).resolves.toBe('superseded');
    expect(db.rows('workspaces')[0]?.subscription_next_billing).toBe(
      new Date(NEWER_PERIOD_END * 1000).toISOString()
    );
    expect(db.rows('workspaces')[0]?.billing_version).toBe(1);
  });

  it('still applies the newer event when it completes second', async () => {
    const db = createFakeSupabase();
    seedWorkspace(db);

    const older = subscriptionEvent({
      id: 'evt_older',
      created: 2_000_000_000,
      periodEnd: OLDER_PERIOD_END,
    });
    const newer = subscriptionEvent({
      id: 'evt_newer',
      created: 2_000_000_100,
      periodEnd: NEWER_PERIOD_END,
    });

    await expect(processEvent(client(db), older)).resolves.toBe('processed');
    await expect(processEvent(client(db), newer)).resolves.toBe('processed');

    expect(db.rows('workspaces')[0]?.subscription_next_billing).toBe(
      new Date(NEWER_PERIOD_END * 1000).toISOString()
    );
    expect(db.rows('workspaces')[0]?.billing_version).toBe(2);
  });
});
