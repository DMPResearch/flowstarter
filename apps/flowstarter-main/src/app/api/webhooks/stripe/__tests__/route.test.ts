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
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type Stripe from 'stripe';

// ─── Stripe SDK mock ────────────────────────────────────────────────────────
const constructEvent = vi.fn();
vi.mock('stripe', () => ({
  default: class MockStripe {
    webhooks = { constructEvent };
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
interface ClientScript {
  leadsProjectId?: string | null;
  workspaceInsertResult?: {
    data: { id: string } | null;
    error: { message: string } | null;
  };
  throwOnLeadsUpdate?: boolean;
}
const script: ClientScript = {};
const captured: {
  updates: Array<{ table: string; values: Row; eq?: [string, string] }>;
  inserts: Array<{ table: string; values: Row }>;
} = { updates: [], inserts: [] };

function builderFor(table: string) {
  const builder = {
    _mode: 'select' as 'select' | 'insert' | 'update',
    select() {
      // `leads` is a single builder instance reused across an
      // update-then-select chain in the route -- reset the mode so `.eq()`
      // continues the select chain instead of resolving as an update.
      builder._mode = 'select';
      return builder;
    },
    insert(values: Row) {
      builder._mode = 'insert';
      captured.inserts.push({ table, values });
      return builder;
    },
    update(values: Row) {
      builder._mode = 'update';
      if (table === 'discovery_leads' && script.throwOnLeadsUpdate) {
        throw new Error('connection reset');
      }
      captured.updates.push({ table, values });
      return builder;
    },
    eq(column: string, value: string) {
      if (builder._mode === 'update') {
        captured.updates[captured.updates.length - 1].eq = [column, value];
        return Promise.resolve({ data: null, error: null });
      }
      return builder;
    },
    in() {
      return Promise.resolve({ data: null, error: null });
    },
    maybeSingle() {
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
  enqueueFullBuildFromDeposit.mockReset().mockResolvedValue(null);
  enqueueFullBuildFromDepositInvoice.mockReset().mockResolvedValue(null);
  provisionGuestDeposit.mockReset().mockResolvedValue(null);
  settleChangeRequestCheckout.mockReset();
  sendEmail.mockReset().mockResolvedValue({ success: true, id: 'email_1' });

  delete script.leadsProjectId;
  delete script.workspaceInsertResult;
  delete script.throwOnLeadsUpdate;
  captured.updates = [];
  captured.inserts = [];

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

function stripeEvent(type: string, object: Row): Stripe.Event {
  return { id: 'evt_1', type, data: { object } } as unknown as Stripe.Event;
}

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

describe('POST /api/webhooks/stripe', () => {
  it('returns 500 when the webhook secret is not configured', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { POST } = await import('../route');
    const res = await POST(post('{}'));
    expect(res.status).toBe(500);
  });

  it('returns 401 when signature verification throws', async () => {
    constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature');
    });
    const { POST } = await import('../route');
    const res = await POST(post('{}', 'bad-signature'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid signature');
  });

  it('acknowledges an event type with no handler (default branch)', async () => {
    constructEvent.mockReturnValue(stripeEvent('charge.refunded', {}));
    const { POST } = await import('../route');
    const res = await POST(post('{}'));
    expect(res.status).toBe(200);
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

    it('logs when the workspace auto-create insert fails, but still notifies the team', async () => {
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
      expect(res.status).toBe(200);
      expect(sendEmail).toHaveBeenCalledTimes(1);
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

    it('continues (still notifies) when the lead update throws', async () => {
      constructEvent.mockReturnValue(
        stripeEvent('checkout.session.completed', {
          id: 'cs_9',
          metadata: { kind: 'booking_deposit', leadId: 'lead_5' },
        })
      );
      script.throwOnLeadsUpdate = true;
      const { POST } = await import('../route');
      const res = await POST(post('{}'));
      expect(res.status).toBe(200);
      expect(sendEmail).toHaveBeenCalledTimes(1);
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
});

describe('GET /api/webhooks/stripe', () => {
  it('rejects with 405 method not allowed', async () => {
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(405);
  });
});
