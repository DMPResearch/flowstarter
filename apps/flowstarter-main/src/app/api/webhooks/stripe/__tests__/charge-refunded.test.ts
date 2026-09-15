/**
 * `charge.refunded`, which the webhook has ingested since the ledger existed
 * and never acted on.
 *
 * Before this the switch fell through to `ignored`, so a refund made by hand
 * from the Stripe dashboard left no trace anywhere this product could read: a
 * workspace could have had every cent back and still show "paid" to an
 * operator and a client. Now both paths land here, the console's refund and a
 * dashboard refund alike, and the tests below are aimed at the three ways
 * that can go wrong.
 *
 * Stripe sends one event per refund, each reporting the charge's RUNNING
 * total. Two refunds on one charge are therefore two events with different
 * totals, and delivered out of order the older one would subtract twice.
 */
import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createFakeSupabase } from '@/lib/flowstarter/__tests__/fake-supabase';
import { processEvent } from '../route';

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

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
      deposit_status: 'paid',
      final_status: 'paid',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_1',
      subscription_next_billing: null,
      deposit_payment_intent_id: 'pi_deposit',
      balance_payment_intent_id: 'pi_balance',
      final_value_minor: 79_900,
      setup_fee: null,
      refunded_amount_minor: 0,
      refund_status: 'none',
      billing_version: 0,
    },
  ]);
  Object.assign(db.rows('workspaces')[0]!, overrides);
}

function refundEvent(input: {
  id?: string;
  created?: number;
  paymentIntent?: string | null;
  amountRefunded: number;
}): Stripe.Event {
  return {
    id: input.id ?? 'evt_refund',
    type: 'charge.refunded',
    created: input.created ?? 2_000_000_000,
    data: {
      object: {
        id: 'ch_1',
        payment_intent:
          input.paymentIntent === undefined
            ? 'pi_balance'
            : input.paymentIntent,
        amount_refunded: input.amountRefunded,
      },
    },
  } as unknown as Stripe.Event;
}

function workspace(db: ReturnType<typeof createFakeSupabase>) {
  return db.rows('workspaces')[0]!;
}

describe('processEvent: charge.refunded', () => {
  it('records a partial refund against the workspace', async () => {
    const db = createFakeSupabase();
    seedWorkspace(db);

    const outcome = await processEvent(
      client(db),
      refundEvent({ amountRefunded: 39_950 })
    );

    expect(outcome).toBe('processed');
    expect(workspace(db).refunded_amount_minor).toBe(39_950);
    expect(workspace(db).refund_status).toBe('partial');
    // Written through the same compare-and-set as every other money column.
    expect(workspace(db).billing_version).toBe(1);
  });

  it('calls it full once the refund reaches the agreed price', async () => {
    const db = createFakeSupabase();
    seedWorkspace(db);

    await processEvent(client(db), refundEvent({ amountRefunded: 79_900 }));

    expect(workspace(db).refund_status).toBe('full');
  });

  it('is partial when the whole deposit went back but the quote did not', async () => {
    const db = createFakeSupabase();
    seedWorkspace(db);

    await processEvent(client(db), refundEvent({ amountRefunded: 15_980 }));

    expect(workspace(db).refund_status).toBe('partial');
  });

  it('applies a second, larger refund total', async () => {
    const db = createFakeSupabase();
    seedWorkspace(db);

    await processEvent(
      client(db),
      refundEvent({
        id: 'evt_1',
        created: 2_000_000_000,
        amountRefunded: 15_980,
      })
    );
    const outcome = await processEvent(
      client(db),
      refundEvent({
        id: 'evt_2',
        created: 2_000_000_100,
        amountRefunded: 79_900,
      })
    );

    expect(outcome).toBe('processed');
    expect(workspace(db).refunded_amount_minor).toBe(79_900);
    expect(workspace(db).refund_status).toBe('full');
  });

  it('refuses an out-of-order delivery rather than subtracting twice', async () => {
    const db = createFakeSupabase();
    seedWorkspace(db, { refunded_amount_minor: 79_900, refund_status: 'full' });

    const outcome = await processEvent(
      client(db),
      refundEvent({ amountRefunded: 15_980 })
    );

    expect(outcome).toBe('superseded');
    expect(workspace(db).refunded_amount_minor).toBe(79_900);
    expect(workspace(db).refund_status).toBe('full');
  });

  it('writes nothing for a redelivery reporting the same total', async () => {
    const db = createFakeSupabase();
    seedWorkspace(db, {
      refunded_amount_minor: 39_950,
      refund_status: 'partial',
    });

    const outcome = await processEvent(
      client(db),
      refundEvent({ amountRefunded: 39_950 })
    );

    expect(outcome).toBe('superseded');
    expect(workspace(db).billing_version).toBe(0);
  });

  it('attributes a refund through the ledger row when one exists', async () => {
    const db = createFakeSupabase();
    seedWorkspace(db, {
      deposit_payment_intent_id: null,
      balance_payment_intent_id: null,
    });
    db.seed('billing_refunds', [
      {
        id: 'led_1',
        workspace_id: WORKSPACE_ID,
        payment_intent_id: 'pi_balance',
        status: 'pending',
      },
    ]);

    const outcome = await processEvent(
      client(db),
      refundEvent({ amountRefunded: 39_950 })
    );

    expect(outcome).toBe('processed');
    expect(workspace(db).refunded_amount_minor).toBe(39_950);
    // And the pending row is closed out, so an operator reading the ledger
    // does not see a refund stuck mid-flight that Stripe has confirmed.
    expect(db.rows('billing_refunds')[0]!.status).toBe('succeeded');
  });

  it('attributes a dashboard refund through the workspace payment intent', async () => {
    const db = createFakeSupabase();
    seedWorkspace(db);

    const outcome = await processEvent(
      client(db),
      refundEvent({ paymentIntent: 'pi_deposit', amountRefunded: 15_980 })
    );

    expect(outcome).toBe('processed');
    expect(workspace(db).refunded_amount_minor).toBe(15_980);
  });

  it('ignores a refund on a charge that is not ours', async () => {
    const db = createFakeSupabase();
    seedWorkspace(db);

    const outcome = await processEvent(
      client(db),
      refundEvent({ paymentIntent: 'pi_somebody_else', amountRefunded: 100 })
    );

    expect(outcome).toBe('ignored');
    expect(workspace(db).refunded_amount_minor).toBe(0);
  });

  it('ignores a charge with no payment intent at all', async () => {
    const db = createFakeSupabase();
    seedWorkspace(db);

    const outcome = await processEvent(
      client(db),
      refundEvent({ paymentIntent: null, amountRefunded: 100 })
    );

    expect(outcome).toBe('ignored');
  });

  it('throws when the ledger cannot be read, so Stripe redelivers', async () => {
    const db = createFakeSupabase();
    seedWorkspace(db);
    db.failing.add('billing_refunds');

    await expect(
      processEvent(client(db), refundEvent({ amountRefunded: 100 }))
    ).rejects.toThrow(/refund ledger/);
  });
});
