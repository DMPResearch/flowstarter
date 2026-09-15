/**
 * Refunding the setup fee, with Stripe mocked and the database faked.
 *
 * The behaviours worth proving are the ones that cost money when they are
 * wrong: the ledger row is claimed BEFORE Stripe is called, so a second
 * request loses on the unique index rather than sending a second refund; the
 * guarantee is drained balance-first so half the setup fee is actually
 * payable; a refund already made by hand in the Stripe dashboard is
 * subtracted rather than doubled; and the launch date comes from the FIRST
 * live deployment, not the latest, so a rebuild does not hand a client a
 * fresh thirty days.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

const emailMock = vi.hoisted(() => ({ notifyRefundIssued: vi.fn() }));
vi.mock('../refund-email', () => ({
  notifyRefundIssued: emailMock.notifyRefundIssued,
}));

import { StripeBillingError } from '../stripe';
import {
  firstLaunchedAt,
  planRefundLegs,
  refundSetupFee,
  type RefundSource,
} from '../refund';

// ─── A Stripe billing double ────────────────────────────────────────────────

/** Only the four methods `refund.ts` reaches for, so a typo cannot pass. */
function fakeBilling(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    currency: 'eur',
    paymentIntentForInvoice: vi.fn(
      async (_invoiceId: string | null): Promise<string | null> => null
    ),
    refundableMinor: vi.fn(async (_paymentIntentId: string) => ({
      receivedMinor: 0,
      refundedMinor: 0,
      remainingMinor: 0,
      currency: 'eur',
    })),
    refundPaymentIntent: vi.fn(async (opts: { amountMinor: number }) => ({
      refundId: 're_test',
      status: 'succeeded',
      amountMinor: opts.amountMinor,
      currency: 'eur',
    })),
    ...overrides,
  };
}

// ─── A Supabase double ──────────────────────────────────────────────────────

interface FakeDb {
  workspace: Record<string, unknown> | null;
  workspaceError: { message: string; code?: string } | null;
  deployments: Array<{ finished_at: string | null }>;
  deploymentsError: { message: string } | null;
  /** payment_intent_id values already on the ledger. */
  claimed: Set<string>;
  insertError: { message: string; code?: string } | null;
  updateError: { message: string } | null;
  inserts: Array<Record<string, unknown>>;
  workspaceUpdates: Array<Record<string, unknown>>;
  ledgerUpdates: Array<Record<string, unknown>>;
}

function freshDb(partial: Partial<FakeDb> = {}): FakeDb {
  return {
    workspace: null,
    workspaceError: null,
    deployments: [],
    deploymentsError: null,
    claimed: new Set(),
    insertError: null,
    updateError: null,
    inserts: [],
    workspaceUpdates: [],
    ledgerUpdates: [],
    ...partial,
  };
}

function fakeSupabase(db: FakeDb) {
  const client = {
    from(table: string) {
      if (table === 'workspaces') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: db.workspace,
                error: db.workspaceError,
              }),
            }),
          }),
          update: (values: Record<string, unknown>) => ({
            eq: async () => {
              db.workspaceUpdates.push(values);
              return { data: null, error: db.updateError };
            },
          }),
        };
      }
      if (table === 'deployments') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                not: () => ({
                  order: () => ({
                    limit: async () => ({
                      data: db.deployments,
                      error: db.deploymentsError,
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'billing_refunds') {
        return {
          insert: (values: Record<string, unknown>) => ({
            select: () => ({
              maybeSingle: async () => {
                if (db.insertError)
                  return { data: null, error: db.insertError };
                const intent = values['payment_intent_id'] as string;
                if (db.claimed.has(intent)) {
                  return {
                    data: null,
                    error: { code: '23505', message: 'duplicate key' },
                  };
                }
                db.claimed.add(intent);
                db.inserts.push(values);
                return { data: { id: `led_${intent}` }, error: null };
              },
            }),
          }),
          update: (values: Record<string, unknown>) => ({
            eq: async () => {
              db.ledgerUpdates.push(values);
              return { data: null, error: null };
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return client as unknown as SupabaseClient<Database>;
}

/** A EUR 799 project whose deposit and balance both settled. */
const WORKSPACE = {
  id: 'ws_1',
  client_email: 'client@example.test',
  client_name: 'Ana',
  client_business_name: 'Ana Studio',
  setup_fee: null,
  final_value_minor: 79_900,
  deposit_status: 'paid',
  deposit_invoice_id: 'in_deposit',
  deposit_payment_intent_id: 'pi_deposit',
  final_status: 'paid',
  final_invoice_id: 'in_final',
  balance_payment_intent_id: 'pi_balance',
};

const REASON = 'Client invoked the guarantee on the call today.';
const NOW = new Date('2026-09-15T12:00:00.000Z');
const LIVE_TODAY = '2026-09-15T08:00:00.000Z';

function bothMilestonesSettled() {
  return fakeBilling({
    refundableMinor: vi.fn(async (id: string) => ({
      receivedMinor: id === 'pi_balance' ? 63_920 : 15_980,
      refundedMinor: 0,
      remainingMinor: id === 'pi_balance' ? 63_920 : 15_980,
      currency: 'eur',
    })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  emailMock.notifyRefundIssued.mockResolvedValue(true);
});

describe('planRefundLegs', () => {
  const sources: RefundSource[] = [
    {
      milestone: 'final',
      paymentIntentId: 'pi_balance',
      remainingMinor: 63_920,
      currency: 'eur',
    },
    {
      milestone: 'deposit',
      paymentIntentId: 'pi_deposit',
      remainingMinor: 15_980,
      currency: 'eur',
    },
  ];

  it('takes it all from the balance when the balance can cover it', () => {
    expect(planRefundLegs(sources, 39_950)).toEqual([
      {
        milestone: 'final',
        paymentIntentId: 'pi_balance',
        amountMinor: 39_950,
        currency: 'eur',
      },
    ]);
  });

  it('spills onto the deposit when the balance cannot', () => {
    expect(planRefundLegs(sources, 70_000)).toEqual([
      {
        milestone: 'final',
        paymentIntentId: 'pi_balance',
        amountMinor: 63_920,
        currency: 'eur',
      },
      {
        milestone: 'deposit',
        paymentIntentId: 'pi_deposit',
        amountMinor: 6_080,
        currency: 'eur',
      },
    ]);
  });

  it('stops at what is available rather than inventing a leg', () => {
    const legs = planRefundLegs(sources, 1_000_000);
    expect(legs.reduce((n, leg) => n + leg.amountMinor, 0)).toBe(79_900);
  });

  it('returns nothing when there is nothing to take', () => {
    expect(planRefundLegs([], 1_000)).toEqual([]);
    expect(
      planRefundLegs(
        [{ ...sources[0]!, remainingMinor: 0 }, sources[1]!],
        5_000
      )
    ).toEqual([
      {
        milestone: 'deposit',
        paymentIntentId: 'pi_deposit',
        amountMinor: 5_000,
        currency: 'eur',
      },
    ]);
  });
});

describe('firstLaunchedAt', () => {
  it('returns the first live deployment, not the latest', async () => {
    const db = freshDb({
      deployments: [{ finished_at: '2026-08-01T00:00:00Z' }],
    });
    await expect(firstLaunchedAt(fakeSupabase(db), 'ws_1')).resolves.toBe(
      '2026-08-01T00:00:00Z'
    );
  });

  it('is null when the site has never gone live', async () => {
    await expect(
      firstLaunchedAt(fakeSupabase(freshDb()), 'ws_1')
    ).resolves.toBeNull();
  });

  it('throws on a read failure rather than pretending nothing launched', async () => {
    const db = freshDb({ deploymentsError: { message: 'connection lost' } });
    await expect(firstLaunchedAt(fakeSupabase(db), 'ws_1')).rejects.toThrow(
      /deployment history/
    );
  });
});

describe('refundSetupFee', () => {
  it('refunds the guaranteed half off the balance, and emails the client', async () => {
    const db = freshDb({
      workspace: { ...WORKSPACE },
      deployments: [{ finished_at: LIVE_TODAY }],
    });
    const billing = bothMilestonesSettled();

    const outcome = await refundSetupFee({
      supabase: fakeSupabase(db),
      billing: billing as never,
      workspaceId: 'ws_1',
      reason: REASON,
      requestedBy: 'user_op_1',
      now: NOW,
    });

    expect(outcome).toMatchObject({
      ok: true,
      totalMinor: 39_950,
      basis: 'guarantee',
      duplicate: false,
      clientEmailed: true,
    });
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.legs).toHaveLength(1);
    expect(outcome.legs[0]?.paymentIntentId).toBe('pi_balance');
    expect(billing.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(emailMock.notifyRefundIssued).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: 39_950, basis: 'guarantee' })
    );
  });

  it('claims the ledger row before it calls Stripe', async () => {
    const order: string[] = [];
    const db = freshDb({
      workspace: { ...WORKSPACE },
      deployments: [{ finished_at: LIVE_TODAY }],
    });
    const supabase = fakeSupabase(db);
    const billing = bothMilestonesSettled();
    billing.refundPaymentIntent = vi.fn(
      async (opts: { amountMinor: number }) => {
        order.push('stripe');
        return {
          refundId: 're_1',
          status: 'succeeded',
          amountMinor: opts.amountMinor,
          currency: 'eur',
        };
      }
    );
    const originalFrom = supabase.from.bind(supabase);
    (supabase as unknown as { from: (t: string) => unknown }).from = (
      table: string
    ) => {
      if (table === 'billing_refunds') order.push('ledger');
      return originalFrom(table as never);
    };

    await refundSetupFee({
      supabase,
      billing: billing as never,
      workspaceId: 'ws_1',
      reason: REASON,
      requestedBy: 'user_op_1',
      now: NOW,
    });

    expect(order[0]).toBe('ledger');
    expect(order).toContain('stripe');
    expect(order.indexOf('ledger')).toBeLessThan(order.indexOf('stripe'));
  });

  it('stamps the ledger row with Stripe’s refund id', async () => {
    const db = freshDb({
      workspace: { ...WORKSPACE },
      deployments: [{ finished_at: LIVE_TODAY }],
    });
    await refundSetupFee({
      supabase: fakeSupabase(db),
      billing: bothMilestonesSettled() as never,
      workspaceId: 'ws_1',
      reason: REASON,
      requestedBy: 'user_op_1',
      now: NOW,
    });
    expect(db.ledgerUpdates[0]).toMatchObject({
      status: 'succeeded',
      stripe_refund_id: 're_test',
    });
    expect(db.inserts[0]).toMatchObject({
      workspace_id: 'ws_1',
      milestone: 'final',
      basis: 'guarantee',
      requested_by: 'user_op_1',
      status: 'pending',
    });
  });

  it('sends the money once when the same request arrives twice', async () => {
    const db = freshDb({
      workspace: { ...WORKSPACE },
      deployments: [{ finished_at: LIVE_TODAY }],
    });
    const supabase = fakeSupabase(db);
    const billing = bothMilestonesSettled();
    const args = {
      supabase,
      billing: billing as never,
      workspaceId: 'ws_1',
      reason: REASON,
      requestedBy: 'user_op_1',
      now: NOW,
    };

    await refundSetupFee(args);
    const second = await refundSetupFee(args);

    expect(billing.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ ok: true, duplicate: true, totalMinor: 0 });
    expect(emailMock.notifyRefundIssued).toHaveBeenCalledTimes(1);
  });

  it('spans both milestones when the balance cannot cover the guarantee', async () => {
    const db = freshDb({
      workspace: { ...WORKSPACE },
      deployments: [{ finished_at: LIVE_TODAY }],
    });
    const billing = fakeBilling({
      refundableMinor: vi.fn(async (id: string) => ({
        receivedMinor: id === 'pi_balance' ? 20_000 : 15_980,
        refundedMinor: 0,
        remainingMinor: id === 'pi_balance' ? 20_000 : 15_980,
        currency: 'eur',
      })),
    });

    const outcome = await refundSetupFee({
      supabase: fakeSupabase(db),
      billing: billing as never,
      workspaceId: 'ws_1',
      reason: REASON,
      requestedBy: 'user_op_1',
      now: NOW,
    });

    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.totalMinor).toBe(35_980);
    expect(outcome.legs.map((leg) => leg.milestone)).toEqual([
      'final',
      'deposit',
    ]);
  });

  it('subtracts a refund already made by hand in the Stripe dashboard', async () => {
    const db = freshDb({
      workspace: { ...WORKSPACE },
      deployments: [{ finished_at: LIVE_TODAY }],
    });
    const billing = fakeBilling({
      refundableMinor: vi.fn(async (id: string) =>
        id === 'pi_balance'
          ? {
              receivedMinor: 63_920,
              refundedMinor: 63_920,
              remainingMinor: 0,
              currency: 'eur',
            }
          : {
              receivedMinor: 15_980,
              refundedMinor: 0,
              remainingMinor: 15_980,
              currency: 'eur',
            }
      ),
    });

    const outcome = await refundSetupFee({
      supabase: fakeSupabase(db),
      billing: billing as never,
      workspaceId: 'ws_1',
      reason: REASON,
      requestedBy: 'user_op_1',
      now: NOW,
    });

    if (!outcome.ok) throw new Error('unreachable');
    // The guaranteed 39950 is capped by the 15980 still on the deposit.
    expect(outcome.totalMinor).toBe(15_980);
    expect(outcome.legs[0]?.milestone).toBe('deposit');
  });

  it('resolves a missing balance payment intent from the invoice, and stores it', async () => {
    const db = freshDb({
      workspace: { ...WORKSPACE, balance_payment_intent_id: null },
      deployments: [{ finished_at: LIVE_TODAY }],
    });
    const billing = bothMilestonesSettled();
    billing.paymentIntentForInvoice = vi.fn(async (invoiceId: string) =>
      invoiceId === 'in_final' ? 'pi_balance' : null
    );

    const outcome = await refundSetupFee({
      supabase: fakeSupabase(db),
      billing: billing as never,
      workspaceId: 'ws_1',
      reason: REASON,
      requestedBy: 'user_op_1',
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    expect(db.workspaceUpdates).toContainEqual({
      balance_payment_intent_id: 'pi_balance',
    });
  });

  it('refuses outside the window, and names the override as the way through', async () => {
    const db = freshDb({
      workspace: { ...WORKSPACE },
      deployments: [{ finished_at: '2026-07-01T00:00:00Z' }],
    });
    const outcome = await refundSetupFee({
      supabase: fakeSupabase(db),
      billing: bothMilestonesSettled() as never,
      workspaceId: 'ws_1',
      reason: REASON,
      requestedBy: 'user_op_1',
      now: NOW,
    });
    expect(outcome).toMatchObject({
      ok: false,
      code: 'window_closed',
      status: 409,
    });
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.message).toMatch(/override reason/i);
  });

  it('lets an override refund everything, before launch', async () => {
    const db = freshDb({ workspace: { ...WORKSPACE } });
    const outcome = await refundSetupFee({
      supabase: fakeSupabase(db),
      billing: bothMilestonesSettled() as never,
      workspaceId: 'ws_1',
      reason: REASON,
      overrideReason: 'Build never delivered.',
      requestedBy: 'user_op_1',
      now: NOW,
    });
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.basis).toBe('override');
    expect(outcome.totalMinor).toBe(79_900);
    expect(db.inserts[0]).toMatchObject({
      override_reason: 'Build never delivered.',
      basis: 'override',
    });
  });

  it('refuses a workspace that does not exist', async () => {
    const outcome = await refundSetupFee({
      supabase: fakeSupabase(freshDb()),
      billing: fakeBilling() as never,
      workspaceId: 'ws_missing',
      reason: REASON,
      requestedBy: 'user_op_1',
      now: NOW,
    });
    expect(outcome).toMatchObject({
      ok: false,
      code: 'workspace_not_found',
      status: 404,
    });
  });

  it('refuses when no payment has settled', async () => {
    const db = freshDb({
      workspace: {
        ...WORKSPACE,
        deposit_payment_intent_id: null,
        balance_payment_intent_id: null,
        deposit_invoice_id: null,
        final_invoice_id: null,
      },
      deployments: [{ finished_at: LIVE_TODAY }],
    });
    const outcome = await refundSetupFee({
      supabase: fakeSupabase(db),
      billing: fakeBilling() as never,
      workspaceId: 'ws_1',
      reason: REASON,
      requestedBy: 'user_op_1',
      now: NOW,
    });
    expect(outcome).toMatchObject({ ok: false, code: 'nothing_refundable' });
  });

  it('marks the ledger row failed when Stripe refuses, and rethrows', async () => {
    const db = freshDb({
      workspace: { ...WORKSPACE },
      deployments: [{ finished_at: LIVE_TODAY }],
    });
    const billing = bothMilestonesSettled();
    billing.refundPaymentIntent = vi.fn(async () => {
      throw new StripeBillingError('refund_failed', 'charge already refunded');
    });

    await expect(
      refundSetupFee({
        supabase: fakeSupabase(db),
        billing: billing as never,
        workspaceId: 'ws_1',
        reason: REASON,
        requestedBy: 'user_op_1',
        now: NOW,
      })
    ).rejects.toThrow(/charge already refunded/);

    expect(db.ledgerUpdates[0]).toMatchObject({
      status: 'failed',
      failure_reason: 'charge already refunded',
    });
    expect(emailMock.notifyRefundIssued).not.toHaveBeenCalled();
  });

  it('throws on a workspace read failure rather than refunding blind', async () => {
    const db = freshDb({ workspaceError: { message: 'connection lost' } });
    await expect(
      refundSetupFee({
        supabase: fakeSupabase(db),
        billing: fakeBilling() as never,
        workspaceId: 'ws_1',
        reason: REASON,
        requestedBy: 'user_op_1',
        now: NOW,
      })
    ).rejects.toThrow(/connection lost/);
  });

  it('throws when the ledger cannot be written for a reason other than a duplicate', async () => {
    const db = freshDb({
      workspace: { ...WORKSPACE },
      deployments: [{ finished_at: LIVE_TODAY }],
      insertError: { message: 'permission denied' },
    });
    await expect(
      refundSetupFee({
        supabase: fakeSupabase(db),
        billing: bothMilestonesSettled() as never,
        workspaceId: 'ws_1',
        reason: REASON,
        requestedBy: 'user_op_1',
        now: NOW,
      })
    ).rejects.toThrow(/permission denied/);
  });

  it('still reports success when the client email could not be sent', async () => {
    emailMock.notifyRefundIssued.mockResolvedValue(false);
    const db = freshDb({
      workspace: { ...WORKSPACE },
      deployments: [{ finished_at: LIVE_TODAY }],
    });
    const outcome = await refundSetupFee({
      supabase: fakeSupabase(db),
      billing: bothMilestonesSettled() as never,
      workspaceId: 'ws_1',
      reason: REASON,
      requestedBy: 'user_op_1',
      now: NOW,
    });
    expect(outcome).toMatchObject({ ok: true, clientEmailed: false });
  });

  it('refuses a reason too short to be one', async () => {
    const db = freshDb({
      workspace: { ...WORKSPACE },
      deployments: [{ finished_at: LIVE_TODAY }],
    });
    const outcome = await refundSetupFee({
      supabase: fakeSupabase(db),
      billing: bothMilestonesSettled() as never,
      workspaceId: 'ws_1',
      reason: 'nope',
      requestedBy: 'user_op_1',
      now: NOW,
    });
    expect(outcome).toMatchObject({ ok: false, code: 'reason_required' });
  });
});
