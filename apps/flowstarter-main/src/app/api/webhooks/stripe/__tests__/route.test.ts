/**
 * Behavioural tests for the Stripe webhook route.
 *
 * The route hands signature verification to the Stripe SDK's own
 * `webhooks.constructEvent`, so -- matching this repo's convention in
 * `billing-endpoints.test.ts` -- the SDK is mocked at the module boundary
 * and driven with real `Stripe.Event`-shaped payloads. The deposit / guest
 * / change-request helper modules have their own dedicated test suites, so
 * they're mocked here too; this file is about the route's own branching and
 * the two workspace-scoped handlers (`handleBookingDepositPaid`,
 * `handleInvoicePaymentSucceeded`, etc.) that are only defined in the route.
 *
 * Since the durability rewrite it is also about three properties that used to
 * be untrue, each of which has its own describe block below: a failed database
 * write answers 500 (so Stripe retries) instead of 200, a redelivered event is
 * processed exactly once, and an event delivered out of order cannot overwrite
 * a newer state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type Stripe from 'stripe';

// ─── Stripe SDK mock ────────────────────────────────────────────────────────
const constructEvent = vi.fn();
const retrieveSubscription = vi.fn();
const retrieveInvoice = vi.fn();
vi.mock('stripe', () => ({
  default: class MockStripe {
    webhooks = { constructEvent };
    subscriptions = { retrieve: retrieveSubscription };
    invoices = { retrieve: retrieveInvoice };
  },
}));

// ─── Dependency module mocks (each has its own test suite elsewhere) ───────
const enqueueFullBuildFromDeposit = vi.fn();
const enqueueFullBuildFromDepositInvoice = vi.fn();
vi.mock('@/lib/flowstarter/deposit-workflow', () => ({
  enqueueFullBuildFromDeposit: (...args: unknown[]) =>
    enqueueFullBuildFromDeposit(...args),
  enqueueFullBuildFromDepositInvoice: (...args: unknown[]) =>
    enqueueFullBuildFromDepositInvoice(...args),
}));

const provisionGuestDeposit = vi.fn();
vi.mock('@/lib/flowstarter/guest-deposit', () => ({
  provisionGuestDeposit: (...args: unknown[]) => provisionGuestDeposit(...args),
}));

const settleChangeRequestCheckout = vi.fn();
vi.mock('@/lib/flowstarter/change-request-checkout', () => ({
  CHANGE_REQUEST_CHECKOUT_KIND: 'change_request',
  settleChangeRequestCheckout: (...args: unknown[]) =>
    settleChangeRequestCheckout(...args),
}));

const sendEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

// ─── Supabase mock ──────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
type DbError = { code?: string; message: string } | null;

interface LedgerRow {
  processed_at: string | null;
  outcome: string | null;
  attempts: number;
}

interface ClientScript {
  leadsProjectId?: string | null;
  workspaceInsertResult?: {
    data: { id: string } | null;
    error: { message: string } | null;
  };
  leadsUpdateError?: DbError;
  /** What a `workspaces` money-state read returns. `null` = no such row. */
  workspace?: Row | null;
  workspaceSelectError?: DbError;
  workspaceUpdateError?: DbError;
  /** stripe_events: the row a duplicate insert conflicts with. */
  ledgerExisting?: LedgerRow | null;
  ledgerInsertError?: DbError;
  ledgerUpdateError?: DbError;
  /** The newest already-applied event for this object, as rows. */
  ledgerLatest?: Array<{ created: string }>;
}
const script: ClientScript = {};

const captured: {
  updates: Array<{ table: string; values: Row; eq?: [string, string] }>;
  inserts: Array<{ table: string; values: Row }>;
  ledger: Array<{ mode: 'insert' | 'update'; values: Row }>;
} = { updates: [], inserts: [], ledger: [] };

const DEFAULT_WORKSPACE: Row = {
  deposit_status: null,
  final_status: null,
  subscription_status: null,
  stripe_subscription_id: null,
  subscription_next_billing: null,
};

function builderFor(table: string) {
  const builder = {
    _mode: 'select' as 'select' | 'insert' | 'update',
    _isInsert: false,
    _columns: '',
    select(columns?: string) {
      builder._columns = columns ?? '';
      // `leads` is a single builder instance reused across an
      // update-then-select chain in the route -- reset the mode so `.eq()`
      // continues the select chain instead of resolving as an update. An
      // insert().select().single() chain keeps its insert mode instead.
      if (!builder._isInsert) builder._mode = 'select';
      return builder;
    },
    insert(values: Row) {
      builder._mode = 'insert';
      builder._isInsert = true;
      if (table === 'stripe_events') {
        captured.ledger.push({ mode: 'insert', values });
        return Promise.resolve({
          data: null,
          error: script.ledgerInsertError ?? null,
        });
      }
      captured.inserts.push({ table, values });
      return builder;
    },
    update(values: Row) {
      builder._mode = 'update';
      if (table === 'stripe_events') {
        captured.ledger.push({ mode: 'update', values });
        return {
          eq: () =>
            Promise.resolve({
              data: null,
              error: script.ledgerUpdateError ?? null,
            }),
        };
      }
      if (table === 'discovery_leads' && script.leadsUpdateError) {
        return {
          eq: () =>
            Promise.resolve({ data: null, error: script.leadsUpdateError }),
        };
      }
      captured.updates.push({ table, values });
      return builder;
    },
    eq(column: string, value: string) {
      if (builder._mode === 'update') {
        captured.updates[captured.updates.length - 1].eq = [column, value];
        return Promise.resolve({
          data: null,
          error:
            table === 'workspaces' ? script.workspaceUpdateError ?? null : null,
        });
      }
      return builder;
    },
    neq() {
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      // The only `.limit()` in the route's reach is the ledger's ordering
      // lookup: the newest event already applied to this Stripe object.
      return Promise.resolve({ data: script.ledgerLatest ?? [], error: null });
    },
    in() {
      return Promise.resolve({ data: null, error: null });
    },
    maybeSingle() {
      if (table === 'stripe_events') {
        return Promise.resolve({
          data: script.ledgerExisting ?? null,
          error: null,
        });
      }
      if (table === 'workspaces') {
        if (script.workspaceSelectError) {
          return Promise.resolve({
            data: null,
            error: script.workspaceSelectError,
          });
        }
        return Promise.resolve({
          data:
            script.workspace === undefined
              ? DEFAULT_WORKSPACE
              : script.workspace,
          error: null,
        });
      }
      return Promise.resolve({
        data:
          script.leadsProjectId === undefined
            ? { project_id: null }
            : { project_id: script.leadsProjectId },
        error: null,
      });
    },
    single() {
      return Promise.resolve(
        script.workspaceInsertResult ?? {
          data: { id: 'ws_new_1' },
          error: null,
        }
      );
    },
  };
  return builder;
}

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({ from: builderFor }),
}));

beforeEach(() => {
  constructEvent.mockReset();
  retrieveSubscription.mockReset();
  retrieveInvoice.mockReset();
  enqueueFullBuildFromDeposit.mockReset().mockResolvedValue(null);
  enqueueFullBuildFromDepositInvoice.mockReset().mockResolvedValue(null);
  provisionGuestDeposit.mockReset().mockResolvedValue(null);
  settleChangeRequestCheckout.mockReset();
  sendEmail.mockReset().mockResolvedValue({ success: true, id: 'email_1' });

  for (const key of Object.keys(script)) {
    delete (script as Record<string, unknown>)[key];
  }
  captured.updates = [];
  captured.inserts = [];
  captured.ledger = [];

  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.STRIPE_SECRET_KEY = 'sk_test_123';

  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function post(body: string, signature = 't=123,v1=abc') {
  return new NextRequest('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    body,
  });
}

/** Unix seconds. Every event carries one: it is the ordering key. */
const CREATED = 1_700_000_000;

function stripeEvent(
  type: string,
  object: Row,
  overrides: Partial<{ id: string; created: number }> = {}
): Stripe.Event {
  return {
    id: overrides.id ?? 'evt_1',
    type,
    created: overrides.created ?? CREATED,
    data: { object },
  } as unknown as Stripe.Event;
}

/** The outcome the route stamped on the ledger row. */
function ledgerOutcome(): string | undefined {
  const stamp = [...captured.ledger]
    .reverse()
    .find((entry) => entry.mode === 'update' && 'outcome' in entry.values);
  return stamp?.values.outcome as string | undefined;
}

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

describe('POST /api/webhooks/stripe', () => {
  it('returns 500 when the webhook secret is not configured', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { POST } = await import('../route');
    const res = await POST(post('{}'));
    expect(res.status).toBe(500);
  });

  it('returns 401 when signature verification throws, and writes no ledger row', async () => {
    constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature');
    });
    const { POST } = await import('../route');
    const res = await POST(post('{}', 'bad-signature'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid signature');
    // A forged event must not even consume an event id.
    expect(captured.ledger).toHaveLength(0);
  });

  it('acknowledges an event type with no handler (default branch)', async () => {
    constructEvent.mockReturnValue(stripeEvent('charge.refunded', {}));
    const { POST } = await import('../route');
    const res = await POST(post('{}'));
    expect(res.status).toBe(200);
    expect(ledgerOutcome()).toBe('ignored');
  });

  it('returns 500 when a handler throws', async () => {
    constructEvent.mockReturnValue(
      stripeEvent('payment_intent.succeeded', { id: 'pi_1', metadata: {} })
    );
    enqueueFullBuildFromDeposit.mockRejectedValue(new Error('boom'));
    const { POST } = await import('../route');
    const res = await POST(post('{}'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Handler failed');
    expect(ledgerOutcome()).toBe('failed');
  });

  describe('payment_intent.succeeded', () => {
    it('runs both the signed-in deposit and guest deposit handlers', async () => {
      const pi = { id: 'pi_1', metadata: { kind: 'flowstarter_deposit' } };
      constructEvent.mockReturnValue(
        stripeEvent('payment_intent.succeeded', pi)
      );
      provisionGuestDeposit.mockResolvedValue({
        workspaceId: WORKSPACE_ID,
        clerkUserId: 'user_1',
        accountKind: 'new',
        jobId: 'job_1',
        alreadyProvisioned: false,
        emailed: true,
      });
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(enqueueFullBuildFromDeposit).toHaveBeenCalledTimes(1);
      expect(provisionGuestDeposit).toHaveBeenCalledTimes(1);
      expect(ledgerOutcome()).toBe('processed');
    });

    it('logs a warning when the welcome email failed for a new guest account', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('payment_intent.succeeded', { id: 'pi_1', metadata: {} })
      );
      provisionGuestDeposit.mockResolvedValue({
        workspaceId: WORKSPACE_ID,
        clerkUserId: 'user_1',
        accountKind: 'new',
        jobId: 'job_1',
        alreadyProvisioned: false,
        emailed: false,
      });
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
    });

    it('handles a redelivery (alreadyProvisioned) without warning', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('payment_intent.succeeded', { id: 'pi_1', metadata: {} })
      );
      provisionGuestDeposit.mockResolvedValue({
        workspaceId: WORKSPACE_ID,
        clerkUserId: 'user_1',
        accountKind: 'existing',
        jobId: 'job_1',
        alreadyProvisioned: true,
        emailed: false,
      });
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
    });

    it('records a payment intent that belonged to neither deposit shape as ignored', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('payment_intent.succeeded', { id: 'pi_2', metadata: {} })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(ledgerOutcome()).toBe('ignored');
    });
  });

  describe('invoice.payment_succeeded', () => {
    it('marks a deposit invoice paid and enqueues the full build', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('invoice.payment_succeeded', {
          id: 'in_1',
          metadata: { invoiceType: 'deposit', workspaceId: WORKSPACE_ID },
        })
      );
      enqueueFullBuildFromDepositInvoice.mockResolvedValue({
        jobId: 'job_2',
        duplicate: false,
      });
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toContainEqual({
        table: 'workspaces',
        values: {
          deposit_status: 'paid',
          deposit_paid_at: expect.any(String),
          outstanding_payment: false,
        },
        eq: ['id', WORKSPACE_ID],
      });
      expect(enqueueFullBuildFromDepositInvoice).toHaveBeenCalledTimes(1);
      expect(ledgerOutcome()).toBe('processed');
    });

    it('marks a final invoice paid without enqueueing a build', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('invoice.payment_succeeded', {
          id: 'in_2',
          metadata: { invoiceType: 'final', workspaceId: WORKSPACE_ID },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toContainEqual({
        table: 'workspaces',
        values: {
          final_status: 'paid',
          final_paid_at: expect.any(String),
          outstanding_payment: false,
        },
        eq: ['id', WORKSPACE_ID],
      });
      expect(enqueueFullBuildFromDepositInvoice).not.toHaveBeenCalled();
    });

    it('falls back to legacy projectId metadata when workspaceId is absent', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('invoice.payment_succeeded', {
          id: 'in_3',
          metadata: { invoiceType: 'final', projectId: WORKSPACE_ID },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates.at(-1)?.eq).toEqual(['id', WORKSPACE_ID]);
    });

    it('no-ops when metadata has no workspace id or invoice type', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('invoice.payment_succeeded', { id: 'in_4', metadata: {} })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toHaveLength(0);
      expect(ledgerOutcome()).toBe('ignored');
    });

    it('ignores a payment for a workspace that does not exist', async () => {
      script.workspace = null;
      constructEvent.mockReturnValue(
        stripeEvent('invoice.payment_succeeded', {
          id: 'in_4b',
          metadata: { invoiceType: 'final', workspaceId: WORKSPACE_ID },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toHaveLength(0);
      expect(ledgerOutcome()).toBe('ignored');
    });

    it('does not rewrite the paid-at stamp of an already paid deposit, but still enqueues', async () => {
      script.workspace = { ...DEFAULT_WORKSPACE, deposit_status: 'paid' };
      enqueueFullBuildFromDepositInvoice.mockResolvedValue({
        jobId: 'job_2',
        duplicate: true,
      });
      constructEvent.mockReturnValue(
        stripeEvent('invoice.payment_succeeded', {
          id: 'in_4c',
          metadata: { invoiceType: 'deposit', workspaceId: WORKSPACE_ID },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toHaveLength(0);
      expect(enqueueFullBuildFromDepositInvoice).toHaveBeenCalledTimes(1);
    });
  });

  it('invoice.payment_failed marks the workspace outstanding', async () => {
    constructEvent.mockReturnValue(
      stripeEvent('invoice.payment_failed', {
        id: 'in_5',
        metadata: { workspaceId: WORKSPACE_ID },
      })
    );
    const { POST } = await import('../route');
    const res = await POST(post('{}'));
    expect(res.status).toBe(200);
    expect(captured.updates).toContainEqual({
      table: 'workspaces',
      values: { outstanding_payment: true },
      eq: ['id', WORKSPACE_ID],
    });
  });

  it('invoice.payment_failed no-ops with no workspace id', async () => {
    constructEvent.mockReturnValue(
      stripeEvent('invoice.payment_failed', { id: 'in_6', metadata: {} })
    );
    const { POST } = await import('../route');
    const res = await POST(post('{}'));
    expect(res.status).toBe(200);
    expect(captured.updates).toHaveLength(0);
  });

  it('invoice.payment_failed does not reopen an invoice that has since settled', async () => {
    script.workspace = { ...DEFAULT_WORKSPACE, final_status: 'paid' };
    constructEvent.mockReturnValue(
      stripeEvent('invoice.payment_failed', {
        id: 'in_6b',
        metadata: { invoiceType: 'final', workspaceId: WORKSPACE_ID },
      })
    );
    const { POST } = await import('../route');
    const res = await POST(post('{}'));
    expect(res.status).toBe(200);
    expect(captured.updates).toHaveLength(0);
    expect(ledgerOutcome()).toBe('superseded');
  });

  it('invoice.payment_failed ignores an unknown workspace', async () => {
    script.workspace = null;
    constructEvent.mockReturnValue(
      stripeEvent('invoice.payment_failed', {
        id: 'in_6c',
        metadata: { workspaceId: WORKSPACE_ID },
      })
    );
    const { POST } = await import('../route');
    const res = await POST(post('{}'));
    expect(res.status).toBe(200);
    expect(ledgerOutcome()).toBe('ignored');
  });

  describe('invoice.overdue', () => {
    it('marks a deposit invoice overdue', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('invoice.overdue', {
          id: 'in_7',
          metadata: { invoiceType: 'deposit', workspaceId: WORKSPACE_ID },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toContainEqual({
        table: 'workspaces',
        values: { deposit_status: 'overdue', outstanding_payment: true },
        eq: ['id', WORKSPACE_ID],
      });
    });

    it('marks a final invoice overdue', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('invoice.overdue', {
          id: 'in_8',
          metadata: { invoiceType: 'final', workspaceId: WORKSPACE_ID },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toContainEqual({
        table: 'workspaces',
        values: { final_status: 'overdue', outstanding_payment: true },
        eq: ['id', WORKSPACE_ID],
      });
    });

    it('no-ops with no workspace id or invoice type', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('invoice.overdue', { id: 'in_9', metadata: {} })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toHaveLength(0);
    });

    it('ignores an overdue for a workspace that does not exist', async () => {
      script.workspace = null;
      constructEvent.mockReturnValue(
        stripeEvent('invoice.overdue', {
          id: 'in_9b',
          metadata: { invoiceType: 'final', workspaceId: WORKSPACE_ID },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(ledgerOutcome()).toBe('ignored');
    });

    it('refuses to mark a paid deposit overdue (deposit paid is monotonic)', async () => {
      script.workspace = { ...DEFAULT_WORKSPACE, deposit_status: 'paid' };
      constructEvent.mockReturnValue(
        stripeEvent('invoice.overdue', {
          id: 'in_10',
          metadata: { invoiceType: 'deposit', workspaceId: WORKSPACE_ID },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toHaveLength(0);
      expect(ledgerOutcome()).toBe('superseded');
    });

    it('refuses to mark a paid balance overdue (final paid is monotonic)', async () => {
      script.workspace = { ...DEFAULT_WORKSPACE, final_status: 'paid' };
      constructEvent.mockReturnValue(
        stripeEvent('invoice.overdue', {
          id: 'in_11',
          metadata: { invoiceType: 'final', workspaceId: WORKSPACE_ID },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toHaveLength(0);
    });
  });

  describe('customer.subscription.*', () => {
    it('maps trialing/active/past_due/canceled statuses and computes next billing date', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('customer.subscription.updated', {
          id: 'sub_1',
          status: 'past_due',
          metadata: { workspaceId: WORKSPACE_ID },
          items: { data: [{ current_period_end: 1_700_000_000 }] },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toContainEqual({
        table: 'workspaces',
        values: {
          subscription_status: 'past_due',
          stripe_subscription_id: 'sub_1',
          subscription_next_billing: new Date(
            1_700_000_000 * 1000
          ).toISOString(),
          outstanding_payment: true,
        },
        eq: ['id', WORKSPACE_ID],
      });
    });

    it('falls back to the raw Stripe status for an unmapped status, and null billing date with no items', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('customer.subscription.created', {
          id: 'sub_2',
          status: 'incomplete',
          metadata: { workspaceId: WORKSPACE_ID },
          items: { data: [] },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toContainEqual({
        table: 'workspaces',
        values: {
          subscription_status: 'incomplete',
          stripe_subscription_id: 'sub_2',
          subscription_next_billing: null,
          outstanding_payment: false,
        },
        eq: ['id', WORKSPACE_ID],
      });
    });

    it('no-ops for customer.subscription.deleted with no workspace id', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('customer.subscription.deleted', {
          id: 'sub_3',
          status: 'canceled',
          metadata: {},
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toHaveLength(0);
    });

    it('ignores a subscription for a workspace that does not exist', async () => {
      script.workspace = null;
      constructEvent.mockReturnValue(
        stripeEvent('customer.subscription.updated', {
          id: 'sub_3b',
          status: 'active',
          metadata: { workspaceId: WORKSPACE_ID },
          items: { data: [] },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(ledgerOutcome()).toBe('ignored');
    });

    it('refuses to revive a cancelled care plan', async () => {
      script.workspace = {
        ...DEFAULT_WORKSPACE,
        subscription_status: 'cancelled',
        stripe_subscription_id: 'sub_4',
      };
      constructEvent.mockReturnValue(
        stripeEvent('customer.subscription.updated', {
          id: 'sub_4',
          status: 'active',
          metadata: { workspaceId: WORKSPACE_ID },
          items: { data: [{ current_period_end: 1_700_000_000 }] },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toHaveLength(0);
      expect(ledgerOutcome()).toBe('superseded');
    });

    it('accepts a brand new subscription even when the old one was cancelled', async () => {
      script.workspace = {
        ...DEFAULT_WORKSPACE,
        subscription_status: 'cancelled',
        stripe_subscription_id: 'sub_old',
      };
      constructEvent.mockReturnValue(
        stripeEvent('customer.subscription.created', {
          id: 'sub_new',
          status: 'trialing',
          metadata: { workspaceId: WORKSPACE_ID },
          items: { data: [] },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates.at(-1)?.values).toMatchObject({
        subscription_status: 'trial',
        stripe_subscription_id: 'sub_new',
      });
    });

    it('refuses a payload whose billing period is behind the one already stored', async () => {
      script.workspace = {
        ...DEFAULT_WORKSPACE,
        subscription_status: 'active',
        stripe_subscription_id: 'sub_5',
        subscription_next_billing: new Date(1_800_000_000 * 1000).toISOString(),
      };
      constructEvent.mockReturnValue(
        stripeEvent('customer.subscription.updated', {
          id: 'sub_5',
          status: 'active',
          metadata: { workspaceId: WORKSPACE_ID },
          items: { data: [{ current_period_end: 1_700_000_000 }] },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toHaveLength(0);
      expect(ledgerOutcome()).toBe('superseded');
    });
  });

  describe('checkout.session.completed', () => {
    it('routes a change-request checkout to settleChangeRequestCheckout', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('checkout.session.completed', {
          id: 'cs_1',
          metadata: { kind: 'change_request' },
        })
      );
      settleChangeRequestCheckout.mockResolvedValue({
        changeRequestId: 'cr_1',
        outcome: 'paid',
      });
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(settleChangeRequestCheckout).toHaveBeenCalledTimes(1);
      expect(sendEmail).not.toHaveBeenCalled();
      expect(ledgerOutcome()).toBe('processed');
    });

    it('records a change request that was already paid as ignored, not processed', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('checkout.session.completed', {
          id: 'cs_1b',
          metadata: { kind: 'change_request' },
        })
      );
      settleChangeRequestCheckout.mockResolvedValue({
        changeRequestId: 'cr_1',
        outcome: 'already_paid',
      });
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(ledgerOutcome()).toBe('ignored');
    });

    it('routes a non-change-request checkout to the booking deposit handler and notifies the team', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('checkout.session.completed', {
          id: 'cs_2',
          amount_total: 15000,
          metadata: {
            kind: 'booking_deposit',
            leadId: 'lead_1',
            name: 'Jane Doe',
            email: 'jane@example.com',
            businessName: 'Jane Co',
            tier: 'starter',
          },
        })
      );
      script.leadsProjectId = null;
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);

      // Lead marked paid.
      expect(captured.updates[0]).toMatchObject({
        table: 'discovery_leads',
        values: { deposit_status: 'paid', deposit_amount_eur: 150 },
        eq: ['id', 'lead_1'],
      });
      // No existing project -> auto-creates a workspace at intake.
      expect(captured.inserts).toContainEqual({
        table: 'workspaces',
        values: expect.objectContaining({
          name: 'Jane Co',
          site_kind: 'astro',
          client_email: 'jane@example.com',
          concierge_stage: 'intake',
        }),
      });
      // Lead re-linked to the new workspace.
      expect(captured.updates.at(-1)).toMatchObject({
        table: 'discovery_leads',
        values: { project_id: 'ws_new_1' },
        eq: ['id', 'lead_1'],
      });
      expect(sendEmail).toHaveBeenCalledTimes(1);
      const emailArgs = sendEmail.mock.calls[0][0];
      expect(emailArgs.to).toBe('hello@flowstarter.net');
      expect(emailArgs.subject).toContain('Jane Doe');
    });

    it('uses the commerce site kind for the commerce tier', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('checkout.session.completed', {
          id: 'cs_3',
          metadata: {
            kind: 'booking_deposit',
            leadId: 'lead_2',
            tier: 'commerce',
          },
        })
      );
      script.leadsProjectId = null;
      const { POST } = await import('../route');
      await POST(post('{}'));
      expect(captured.inserts[0]).toMatchObject({
        table: 'workspaces',
        values: expect.objectContaining({ site_kind: 'shopify_liquid' }),
      });
    });

    it('skips workspace auto-create when the lead already has a linked project', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('checkout.session.completed', {
          id: 'cs_4',
          metadata: { kind: 'booking_deposit', leadId: 'lead_3' },
        })
      );
      script.leadsProjectId = 'ws_existing';
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.inserts).toHaveLength(0);
    });

    it('returns 500 when the workspace auto-create insert fails, so Stripe retries', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('checkout.session.completed', {
          id: 'cs_5',
          metadata: { kind: 'booking_deposit', leadId: 'lead_4' },
        })
      );
      script.leadsProjectId = null;
      script.workspaceInsertResult = {
        data: null,
        error: { message: 'unique violation on slug' },
      };
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(500);
      // The team is not told a prospect is booked until the row exists.
      expect(sendEmail).not.toHaveBeenCalled();
      expect(ledgerOutcome()).toBe('failed');
    });

    it('skips the lead-paid block entirely when no leadId is present', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('checkout.session.completed', {
          id: 'cs_6',
          metadata: { kind: 'booking_deposit', email: 'noone@example.com' },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toHaveLength(0);
      expect(captured.inserts).toHaveLength(0);
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    it('is a no-op for a checkout session with an unrelated metadata kind', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('checkout.session.completed', {
          id: 'cs_7',
          metadata: { kind: 'something_else' },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(sendEmail).not.toHaveBeenCalled();
      expect(ledgerOutcome()).toBe('ignored');
    });

    it('falls back to the metadata amountEur and unknown amount when amount_total is absent', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('checkout.session.completed', {
          id: 'cs_8',
          metadata: { kind: 'booking_deposit', amountEur: '99' },
        })
      );
      const { POST } = await import('../route');
      await POST(post('{}'));
      const emailArgs = sendEmail.mock.calls[0][0];
      expect(emailArgs.subject).toContain('€99');
    });

    it('returns 500 when the lead could not be marked paid', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('checkout.session.completed', {
          id: 'cs_9',
          metadata: { kind: 'booking_deposit', leadId: 'lead_5' },
        })
      );
      script.leadsUpdateError = { message: 'connection reset' };
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(500);
      expect(sendEmail).not.toHaveBeenCalled();
      expect(ledgerOutcome()).toBe('failed');
    });

    it('swallows a sendEmail failure without failing the webhook', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('checkout.session.completed', {
          id: 'cs_10',
          metadata: { kind: 'booking_deposit' },
        })
      );
      sendEmail.mockRejectedValue(new Error('resend down'));
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
    });
  });

  // ─── Durability: a 200 means the state is in the database ────────────────

  describe('durable processing', () => {
    it('answers 500 and leaves no partial state when the money write fails', async () => {
      script.workspaceUpdateError = { message: 'deadlock detected' };
      constructEvent.mockReturnValue(
        stripeEvent('invoice.payment_succeeded', {
          id: 'in_20',
          metadata: { invoiceType: 'final', workspaceId: WORKSPACE_ID },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(500);
      // The event is recorded but NOT stamped processed, so Stripe's retry
      // finds work rather than an acknowledgement.
      expect(ledgerOutcome()).toBe('failed');
      const stamp = captured.ledger.find(
        (entry) => entry.mode === 'update' && 'processed_at' in entry.values
      );
      expect(stamp?.values.processed_at).toBeNull();
    });

    it('answers 500 when the workspace state cannot even be read', async () => {
      script.workspaceSelectError = { message: 'connection reset' };
      constructEvent.mockReturnValue(
        stripeEvent('invoice.payment_succeeded', {
          id: 'in_21',
          metadata: { invoiceType: 'deposit', workspaceId: WORKSPACE_ID },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(500);
      expect(captured.updates).toHaveLength(0);
    });

    it('answers 500 without processing anything when the ledger is unreachable', async () => {
      script.ledgerInsertError = { code: '08006', message: 'no connection' };
      constructEvent.mockReturnValue(
        stripeEvent('invoice.payment_succeeded', {
          id: 'in_22',
          metadata: { invoiceType: 'final', workspaceId: WORKSPACE_ID },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Event ledger unavailable');
      expect(captured.updates).toHaveLength(0);
    });

    it('answers 500 when the state landed but the acknowledgement did not', async () => {
      script.ledgerUpdateError = { message: 'ledger write failed' };
      constructEvent.mockReturnValue(
        stripeEvent('invoice.payment_succeeded', {
          id: 'in_23',
          metadata: { invoiceType: 'final', workspaceId: WORKSPACE_ID },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Event ledger unavailable');
      // The money did land; only the stamp failed.
      expect(captured.updates).toHaveLength(1);
    });
  });

  describe('idempotency', () => {
    it('processes a redelivered event exactly once', async () => {
      script.ledgerInsertError = { code: '23505', message: 'duplicate key' };
      script.ledgerExisting = {
        processed_at: '2026-09-12T10:00:00.000Z',
        outcome: 'processed',
        attempts: 1,
      };
      constructEvent.mockReturnValue(
        stripeEvent('invoice.payment_succeeded', {
          id: 'in_30',
          metadata: { invoiceType: 'final', workspaceId: WORKSPACE_ID },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ received: true, duplicate: true });
      expect(captured.updates).toHaveLength(0);
      expect(enqueueFullBuildFromDepositInvoice).not.toHaveBeenCalled();
    });

    it('re-processes an event whose previous attempt never finished', async () => {
      script.ledgerInsertError = { code: '23505', message: 'duplicate key' };
      script.ledgerExisting = {
        processed_at: null,
        outcome: 'failed',
        attempts: 1,
      };
      constructEvent.mockReturnValue(
        stripeEvent('invoice.payment_succeeded', {
          id: 'in_31',
          metadata: { invoiceType: 'final', workspaceId: WORKSPACE_ID },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toHaveLength(1);
    });
  });

  describe('ordering', () => {
    it('refuses an event older than the state already applied to the object', async () => {
      script.ledgerLatest = [
        { created: new Date((CREATED + 60) * 1000).toISOString() },
      ];
      script.workspace = {
        ...DEFAULT_WORKSPACE,
        subscription_status: 'cancelled',
        stripe_subscription_id: 'sub_9',
      };
      constructEvent.mockReturnValue(
        stripeEvent('customer.subscription.updated', {
          id: 'sub_9',
          status: 'active',
          metadata: { workspaceId: WORKSPACE_ID },
          items: { data: [{ current_period_end: CREATED }] },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates).toHaveLength(0);
      expect(ledgerOutcome()).toBe('superseded');
      expect(retrieveSubscription).not.toHaveBeenCalled();
    });

    it('applies an event newer than the state already applied', async () => {
      script.ledgerLatest = [
        { created: new Date((CREATED - 60) * 1000).toISOString() },
      ];
      constructEvent.mockReturnValue(
        stripeEvent('customer.subscription.updated', {
          id: 'sub_10',
          status: 'active',
          metadata: { workspaceId: WORKSPACE_ID },
          items: { data: [] },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(captured.updates.at(-1)?.values).toMatchObject({
        subscription_status: 'active',
      });
      expect(retrieveSubscription).not.toHaveBeenCalled();
    });

    it('re-fetches from Stripe when two events share a created second', async () => {
      script.ledgerLatest = [
        { created: new Date(CREATED * 1000).toISOString() },
      ];
      retrieveSubscription.mockResolvedValue({
        id: 'sub_11',
        status: 'canceled',
        metadata: { workspaceId: WORKSPACE_ID },
        items: { data: [{ current_period_end: CREATED }] },
      });
      // The payload in hand says active; Stripe says the subscription is gone.
      constructEvent.mockReturnValue(
        stripeEvent('customer.subscription.updated', {
          id: 'sub_11',
          status: 'active',
          metadata: { workspaceId: WORKSPACE_ID },
          items: { data: [{ current_period_end: CREATED }] },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(retrieveSubscription).toHaveBeenCalledWith('sub_11');
      expect(captured.updates.at(-1)?.values).toMatchObject({
        subscription_status: 'cancelled',
      });
    });

    it('re-fetches an invoice the same way, and answers 500 if Stripe cannot be reached', async () => {
      script.ledgerLatest = [
        { created: new Date(CREATED * 1000).toISOString() },
      ];
      retrieveInvoice.mockRejectedValue(new Error('stripe unreachable'));
      constructEvent.mockReturnValue(
        stripeEvent('invoice.payment_succeeded', {
          id: 'in_40',
          metadata: { invoiceType: 'final', workspaceId: WORKSPACE_ID },
        })
      );
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(500);
      expect(captured.updates).toHaveLength(0);
    });
  });
});

describe('GET /api/webhooks/stripe', () => {
  it('rejects with 405 method not allowed', async () => {
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(405);
  });
});
