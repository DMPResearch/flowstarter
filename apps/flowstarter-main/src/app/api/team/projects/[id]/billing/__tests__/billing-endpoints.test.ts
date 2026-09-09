/**
 * Integration tests for the billing API endpoints.
 *
 * Mocks Stripe SDK + Supabase service-role client so we exercise the full
 * route logic (auth, validation, ensure-customer, persist, error mapping)
 * without hitting Stripe live. Stripe stays in test mode throughout.
 *
 * Tests the 20/80 + subscription flow end-to-end:
 *   1. POST /api/team/projects/[id]/billing/deposit-invoice
 *   2. POST /api/team/projects/[id]/billing/final-invoice
 *   3. POST /api/team/projects/[id]/billing/activate-subscription
 *   4. POST /api/team/projects/[id]/billing/cancel-subscription
 *   5. POST /api/team/projects/[id]/billing/portal-link
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mutable state shared with the hoisted vi.mock factories ────────────────
const state = vi.hoisted(() => ({
  /** Set to make `new Stripe(...)` throw, standing in for a bad API key. */
  stripeCtorError: null as unknown,
  /** Set to make requireTeamAuth refuse; null means an authorized team user. */
  authOverride: null as unknown,
}));

// ─── Stripe SDK mock ────────────────────────────────────────────────────────
const stripeMock = {
  customers: { create: vi.fn() },
  invoices: { create: vi.fn(), finalizeInvoice: vi.fn() },
  invoiceItems: { create: vi.fn() },
  subscriptions: {
    create: vi.fn(),
    update: vi.fn(),
    cancel: vi.fn(),
  },
  billingPortal: { sessions: { create: vi.fn() } },
};

vi.mock('stripe', () => {
  return {
    default: class MockStripe {
      customers = stripeMock.customers;
      invoices = stripeMock.invoices;
      invoiceItems = stripeMock.invoiceItems;
      subscriptions = stripeMock.subscriptions;
      billingPortal = stripeMock.billingPortal;
      constructor() {
        if (state.stripeCtorError) throw state.stripeCtorError;
      }
    },
  };
});

// ─── Supabase mock ──────────────────────────────────────────────────────────
type SbBuilder = {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  insert?: ReturnType<typeof vi.fn>;
  single?: ReturnType<typeof vi.fn>;
};
const supabaseMock = {
  from: vi.fn(),
};

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => supabaseMock,
}));

// ─── Auth mock ──────────────────────────────────────────────────────────────
// Only requireTeamAuth is swapped, and the refusal responses come from the
// real helpers, so the 401/403 bodies asserted below are production output.
vi.mock('@/lib/api-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-auth')>(
    '@/lib/api-auth'
  );
  return {
    ...actual,
    requireTeamAuth: async () =>
      state.authOverride ?? {
        authorized: true as const,
        userId: 'user_team_1',
        role: 'team' as const,
      },
  };
});

// ─── platform-config mock (for portal-link safe-redirect check) ─────────────
vi.mock('@flowstarter/platform-config', () => ({
  getMainUrl: () => 'https://flowstarter.dev',
}));

import { forbiddenResponse, unauthorizedResponse } from '@/lib/api-auth';

// ─── Helpers ────────────────────────────────────────────────────────────────
function setupProjectFetch(project: Record<string, unknown> | null) {
  const builder: SbBuilder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: project, error: null }),
    update: vi.fn(),
  };
  supabaseMock.from.mockReturnValue(builder);
  return builder;
}

function setupProjectFetchAndUpdate(project: Record<string, unknown> | null) {
  const updateChain = {
    eq: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
  const builder: SbBuilder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: project, error: null }),
    update: vi.fn().mockReturnValue(updateChain),
  };
  supabaseMock.from.mockReturnValue(builder);
  return { builder, updateChain };
}

/** The row loads fine but every `update(...).eq(...)` reports a DB failure. */
function setupProjectFetchWithFailingUpdate(
  project: Record<string, unknown> | null,
  message = 'connection reset'
) {
  const updateChain = {
    eq: vi.fn().mockResolvedValue({ data: null, error: { message } }),
  };
  const builder: SbBuilder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: project, error: null }),
    update: vi.fn().mockReturnValue(updateChain),
  };
  supabaseMock.from.mockReturnValue(builder);
  return { builder, updateChain };
}

/** The workspace SELECT itself fails. */
function setupProjectFetchError(message = 'relation does not exist') {
  const builder: SbBuilder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message } }),
    update: vi.fn(),
  };
  supabaseMock.from.mockReturnValue(builder);
  return builder;
}

function makeReq(body: unknown, url = 'https://example.com/test'): NextRequest {
  return {
    json: async () => body,
    url,
    headers: new Headers(),
  } as unknown as NextRequest;
}

/** A request whose body is not JSON, so `req.json()` rejects. */
function makeReqWithBrokenBody(url = 'https://example.com/test'): NextRequest {
  return {
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
    url,
    headers: new Headers(),
  } as unknown as NextRequest;
}

const baseProject = {
  id: 'proj_1',
  user_id: 'user_1',
  client_email: 'client@example.com',
  client_name: 'Ana Pop',
  client_business_name: 'Acme Coaching',
  setup_fee: 799,
  monthly_fee: 49,
  billing_interval: 'monthly',
  stripe_customer_id: null,
  stripe_subscription_id: null,
  subscription_status: null,
  subscription_trial_ends: null,
  deposit_status: null,
  deposit_invoice_id: null,
  final_status: null,
  final_invoice_id: null,
};

/** Every endpoint under test, so the auth gate can be proved on all of them. */
const ENDPOINTS: Array<[string, () => Promise<{ POST: RouteHandler }>]> = [
  [
    'deposit-invoice',
    () => import('../../../[id]/billing/deposit-invoice/route'),
  ],
  ['final-invoice', () => import('../../../[id]/billing/final-invoice/route')],
  [
    'activate-subscription',
    () => import('../../../[id]/billing/activate-subscription/route'),
  ],
  [
    'cancel-subscription',
    () => import('../../../[id]/billing/cancel-subscription/route'),
  ],
  ['portal-link', () => import('../../../[id]/billing/portal-link/route')],
];

type RouteHandler = (
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) => Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  Object.values(stripeMock).forEach((group) => {
    if (typeof group === 'object' && group !== null) {
      Object.values(group).forEach((fn) => {
        if (typeof fn === 'function' && 'mockReset' in fn) {
          (fn as ReturnType<typeof vi.fn>).mockReset();
        } else if (typeof fn === 'object' && fn !== null) {
          // sessions.create etc.
          Object.values(fn).forEach((nested) => {
            if (typeof nested === 'function' && 'mockReset' in nested) {
              (nested as ReturnType<typeof vi.fn>).mockReset();
            }
          });
        }
      });
    }
  });
  supabaseMock.from.mockReset();
  state.stripeCtorError = null;
  state.authOverride = null;
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
});

// ─── Auth gate, shared by all five endpoints ────────────────────────────────
describe('billing endpoints: who may call them', () => {
  it.each(ENDPOINTS)(
    '%s rejects an unauthenticated caller with 401 and touches nothing',
    async (_name, load) => {
      state.authOverride = {
        authorized: false as const,
        response: unauthorizedResponse(),
      };
      setupProjectFetchAndUpdate({ ...baseProject });
      const { POST } = await load();
      const res = await POST(makeReq({}), {
        params: Promise.resolve({ id: 'proj_1' }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe('UNAUTHORIZED');
      expect(supabaseMock.from).not.toHaveBeenCalled();
      expect(stripeMock.customers.create).not.toHaveBeenCalled();
      expect(stripeMock.invoices.create).not.toHaveBeenCalled();
      expect(stripeMock.subscriptions.create).not.toHaveBeenCalled();
      expect(stripeMock.billingPortal.sessions.create).not.toHaveBeenCalled();
    }
  );

  it.each(ENDPOINTS)(
    '%s rejects a signed-in caller who is not team or admin with 403',
    async (_name, load) => {
      // A workspace client is signed in but has no operator role. Billing is
      // operator-only, so the answer is the same for their own workspace as
      // for anybody else's.
      state.authOverride = {
        authorized: false as const,
        response: forbiddenResponse('Not a team member'),
      };
      setupProjectFetchAndUpdate({ ...baseProject });
      const { POST } = await load();
      const res = await POST(makeReq({}), {
        params: Promise.resolve({ id: 'someone-elses-workspace' }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe('FORBIDDEN');
      expect(supabaseMock.from).not.toHaveBeenCalled();
      expect(stripeMock.invoices.create).not.toHaveBeenCalled();
      expect(stripeMock.subscriptions.create).not.toHaveBeenCalled();
    }
  );

  it.each(ENDPOINTS)(
    '%s returns 500 when STRIPE_SECRET_KEY is absent, before any DB read',
    async (_name, load) => {
      delete process.env.STRIPE_SECRET_KEY;
      setupProjectFetchAndUpdate({ ...baseProject });
      const { POST } = await load();
      const res = await POST(makeReq({}), {
        params: Promise.resolve({ id: 'proj_1' }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/STRIPE_SECRET_KEY/);
      expect(supabaseMock.from).not.toHaveBeenCalled();
    }
  );

  it.each(ENDPOINTS)(
    '%s returns 500 when the Stripe client cannot be constructed',
    async (_name, load) => {
      state.stripeCtorError = new Error(
        'Invalid API Key provided: sk_test_***'
      );
      setupProjectFetchAndUpdate({ ...baseProject });
      const { POST } = await load();
      const res = await POST(makeReq({}), {
        params: Promise.resolve({ id: 'proj_1' }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Stripe init failed');
      expect(supabaseMock.from).not.toHaveBeenCalled();
    }
  );
});

describe('POST /api/team/projects/[id]/billing/deposit-invoice', () => {
  it('creates customer + invoice on first call, persists IDs', async () => {
    setupProjectFetchAndUpdate({ ...baseProject });
    stripeMock.customers.create.mockResolvedValue({ id: 'cus_new' });
    stripeMock.invoices.create.mockResolvedValue({ id: 'in_draft' });
    stripeMock.invoiceItems.create.mockResolvedValue({});
    stripeMock.invoices.finalizeInvoice.mockResolvedValue({
      id: 'in_final',
      hosted_invoice_url: 'https://invoice.stripe.com/abc',
      status: 'open',
    });

    const { POST } = await import(
      '../../../[id]/billing/deposit-invoice/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.invoice.id).toBe('in_final');
    expect(body.invoice.hostedUrl).toBe('https://invoice.stripe.com/abc');
    expect(body.invoice.amountMinor).toBe(15980); // €799 × 0.2 × 100
    expect(stripeMock.customers.create).toHaveBeenCalledOnce();
    expect(stripeMock.invoices.create).toHaveBeenCalledOnce();
    expect(stripeMock.invoiceItems.create).toHaveBeenCalledOnce();
    expect(stripeMock.invoices.finalizeInvoice).toHaveBeenCalledWith(
      'in_draft'
    );
  });

  it('refuses if deposit already paid', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
    });

    const { POST } = await import(
      '../../../[id]/billing/deposit-invoice/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(409);
  });

  it('returns 400 when setup_fee is missing and no amount in body', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      setup_fee: 0,
      stripe_customer_id: 'cus_existing',
    });
    const { POST } = await import(
      '../../../[id]/billing/deposit-invoice/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(400);
    expect(stripeMock.invoices.create).not.toHaveBeenCalled();
  });

  it('returns 400 for an explicit amount of zero', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
    });
    const { POST } = await import(
      '../../../[id]/billing/deposit-invoice/route'
    );
    const res = await POST(makeReq({ amount: 0 }), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Cannot derive amount/);
    expect(stripeMock.invoices.create).not.toHaveBeenCalled();
  });

  it('returns 500 when STRIPE_SECRET_KEY is missing', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const { POST } = await import(
      '../../../[id]/billing/deposit-invoice/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(500);
  });

  it('treats an unparseable body as empty and still bills the default 20%', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
    });
    stripeMock.invoices.create.mockResolvedValue({ id: 'in_draft' });
    stripeMock.invoiceItems.create.mockResolvedValue({});
    stripeMock.invoices.finalizeInvoice.mockResolvedValue({
      id: 'in_final',
      hosted_invoice_url: null,
      status: 'open',
    });
    const { POST } = await import(
      '../../../[id]/billing/deposit-invoice/route'
    );
    const res = await POST(makeReqWithBrokenBody(), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invoice.amountMinor).toBe(15980);
    expect(body.invoice.hostedUrl).toBeNull();
    expect(body.invoice.currency).toBe('eur');
  });

  it('honours an explicit amount and daysUntilDue, clamping out-of-range days', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
    });
    stripeMock.invoices.create.mockResolvedValue({ id: 'in_draft' });
    stripeMock.invoiceItems.create.mockResolvedValue({});
    stripeMock.invoices.finalizeInvoice.mockResolvedValue({
      id: 'in_final',
      hosted_invoice_url: 'https://invoice.stripe.com/abc',
      status: 'open',
    });
    const { POST } = await import(
      '../../../[id]/billing/deposit-invoice/route'
    );
    const res = await POST(makeReq({ amount: 250.5, daysUntilDue: 900 }), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invoice.amountMinor).toBe(25050);
    expect(stripeMock.invoices.create.mock.calls[0]?.[0]).toMatchObject({
      days_until_due: 14, // 900 is out of range, falls back to the default
      collection_method: 'send_invoice',
    });
    expect(stripeMock.invoiceItems.create.mock.calls[0]?.[0]).toMatchObject({
      amount: 25050,
      currency: 'eur',
    });
  });

  it('surfaces a Supabase read failure as 500 db_error', async () => {
    setupProjectFetchError('permission denied for table workspaces');
    const { POST } = await import(
      '../../../[id]/billing/deposit-invoice/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('db_error');
    expect(stripeMock.invoices.create).not.toHaveBeenCalled();
  });

  it('surfaces an unknown workspace without creating anything on Stripe', async () => {
    setupProjectFetch(null);
    const { POST } = await import(
      '../../../[id]/billing/deposit-invoice/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'no-such-workspace' }),
    });
    const body = await res.json();
    // 404, not 500: `ensureBillingCustomer` throws `workspace_not_found` and
    // `mapBillingError` carries that code. It used to map the dead
    // `project_not_found` instead, so this answered 500 and read as our fault.
    expect(res.status).toBe(404);
    expect(body.code).toBe('workspace_not_found');
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
  });

  it('returns 400 when the workspace has no client_email to bill', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      client_email: null,
      stripe_customer_id: null,
    });
    const { POST } = await import(
      '../../../[id]/billing/deposit-invoice/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('missing_client_email');
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
  });

  it('returns 500 when the new Stripe customer cannot be persisted', async () => {
    setupProjectFetchWithFailingUpdate({ ...baseProject }, 'write conflict');
    stripeMock.customers.create.mockResolvedValue({ id: 'cus_new' });
    const { POST } = await import(
      '../../../[id]/billing/deposit-invoice/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('persist_customer_failed');
    expect(stripeMock.invoices.create).not.toHaveBeenCalled();
  });

  it('maps a Stripe invoice failure to 502', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
    });
    // Stripe returns a draft with no id, which the lib treats as a create failure.
    stripeMock.invoices.create.mockResolvedValue({ id: undefined });
    const { POST } = await import(
      '../../../[id]/billing/deposit-invoice/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('invoice_create_failed');
  });

  it('maps a raw Stripe API error to 500 with its message', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
    });
    stripeMock.invoices.create.mockRejectedValue(
      new Error('Request rate limit exceeded')
    );
    const { POST } = await import(
      '../../../[id]/billing/deposit-invoice/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Request rate limit exceeded');
  });

  it('reports the invoice id when Stripe succeeded but the DB write failed', async () => {
    setupProjectFetchWithFailingUpdate(
      { ...baseProject, stripe_customer_id: 'cus_existing' },
      'deadlock detected'
    );
    stripeMock.invoices.create.mockResolvedValue({ id: 'in_draft' });
    stripeMock.invoiceItems.create.mockResolvedValue({});
    stripeMock.invoices.finalizeInvoice.mockResolvedValue({
      id: 'in_final',
      hosted_invoice_url: 'https://invoice.stripe.com/abc',
      status: 'open',
    });
    const { POST } = await import(
      '../../../[id]/billing/deposit-invoice/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/in_final/);
    expect(body.error).toMatch(/deadlock detected/);
    expect(body.invoice.invoiceId).toBe('in_final');
  });
});

describe('POST /api/team/projects/[id]/billing/final-invoice', () => {
  it('refuses if deposit not yet paid', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'sent',
    });
    const { POST } = await import('../../../[id]/billing/final-invoice/route');
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.deposit_status).toBe('sent');
  });

  it('creates the remaining 80% when deposit is paid', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
    });
    stripeMock.invoices.create.mockResolvedValue({ id: 'in_draft2' });
    stripeMock.invoiceItems.create.mockResolvedValue({});
    stripeMock.invoices.finalizeInvoice.mockResolvedValue({
      id: 'in_final2',
      hosted_invoice_url: 'https://invoice.stripe.com/def',
      status: 'open',
    });
    const { POST } = await import('../../../[id]/billing/final-invoice/route');
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invoice.amountMinor).toBe(63920); // remaining 80%
    expect(stripeMock.invoices.create).toHaveBeenCalledOnce();
  });

  it('refuses if final already paid', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      final_status: 'paid',
    });
    const { POST } = await import('../../../[id]/billing/final-invoice/route');
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(409);
  });

  it('returns 400 when the workspace is unpriced and no amount is given', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      setup_fee: null,
    });
    const { POST } = await import('../../../[id]/billing/final-invoice/route');
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(400);
    expect(stripeMock.invoices.create).not.toHaveBeenCalled();
  });

  it('honours an explicit amount and a valid daysUntilDue', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
    });
    stripeMock.invoices.create.mockResolvedValue({ id: 'in_draft2' });
    stripeMock.invoiceItems.create.mockResolvedValue({});
    stripeMock.invoices.finalizeInvoice.mockResolvedValue({
      id: 'in_final2',
      hosted_invoice_url: 'https://invoice.stripe.com/def',
      status: 'open',
    });
    const { POST } = await import('../../../[id]/billing/final-invoice/route');
    const res = await POST(makeReq({ amount: 600, daysUntilDue: 7 }), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invoice.amountMinor).toBe(60000);
    expect(stripeMock.invoices.create.mock.calls[0]?.[0]).toMatchObject({
      days_until_due: 7,
      metadata: { workspaceId: 'proj_1', invoiceType: 'final' },
    });
  });

  it('treats an unparseable body as empty', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
    });
    stripeMock.invoices.create.mockResolvedValue({ id: 'in_draft2' });
    stripeMock.invoiceItems.create.mockResolvedValue({});
    stripeMock.invoices.finalizeInvoice.mockResolvedValue({
      id: 'in_final2',
      hosted_invoice_url: 'https://invoice.stripe.com/def',
      status: 'open',
    });
    const { POST } = await import('../../../[id]/billing/final-invoice/route');
    const res = await POST(makeReqWithBrokenBody(), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invoice.amountMinor).toBe(63920);
  });

  it('surfaces a Supabase read failure as 500 db_error', async () => {
    setupProjectFetchError();
    const { POST } = await import('../../../[id]/billing/final-invoice/route');
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('db_error');
  });

  it('maps a Stripe finalize failure to 502', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
    });
    stripeMock.invoices.create.mockResolvedValue({ id: 'in_draft2' });
    stripeMock.invoiceItems.create.mockResolvedValue({});
    stripeMock.invoices.finalizeInvoice.mockResolvedValue({ id: undefined });
    const { POST } = await import('../../../[id]/billing/final-invoice/route');
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('invoice_finalize_failed');
  });

  it('reports the invoice id when Stripe succeeded but the DB write failed', async () => {
    setupProjectFetchWithFailingUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
    });
    stripeMock.invoices.create.mockResolvedValue({ id: 'in_draft2' });
    stripeMock.invoiceItems.create.mockResolvedValue({});
    stripeMock.invoices.finalizeInvoice.mockResolvedValue({
      id: 'in_final2',
      hosted_invoice_url: 'https://invoice.stripe.com/def',
      status: 'open',
    });
    const { POST } = await import('../../../[id]/billing/final-invoice/route');
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/in_final2/);
    expect(body.invoice.invoiceId).toBe('in_final2');
  });
});

describe('POST /api/team/projects/[id]/billing/activate-subscription', () => {
  beforeEach(() => {
    process.env.STRIPE_CONCIERGE_PRODUCT_ID = 'prod_test_concierge';
  });

  it('refuses when both invoices not yet paid', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      final_status: 'sent', // not paid
    });
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(409);
    expect(stripeMock.subscriptions.create).not.toHaveBeenCalled();
  });

  it('creates subscription with 30-day trial when both invoices paid', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      final_status: 'paid',
    });
    stripeMock.subscriptions.create.mockResolvedValue({
      id: 'sub_1',
      status: 'trialing',
      trial_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      items: {
        data: [
          { current_period_end: Math.floor(Date.now() / 1000) + 60 * 86400 },
        ],
      },
    });
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    const arg = stripeMock.subscriptions.create.mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      customer: 'cus_existing',
      trial_period_days: 30,
      metadata: { workspaceId: 'proj_1' },
    });
    expect(arg?.items[0].price_data.unit_amount).toBe(4900); // €49 × 100
    expect(arg?.items[0].price_data.product).toBe('prod_test_concierge');
  });

  it('honours ?force=true even with unpaid invoices', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: null,
      final_status: null,
    });
    stripeMock.subscriptions.create.mockResolvedValue({
      id: 'sub_force',
      status: 'trialing',
      trial_end: null,
      items: { data: [{ current_period_end: null }] },
    });
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReq({}, 'https://example.com/?force=true'), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    expect(stripeMock.subscriptions.create).toHaveBeenCalledOnce();
  });

  it('refuses when the workspace already has a subscription', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      stripe_subscription_id: 'sub_already_running',
      deposit_status: 'paid',
      final_status: 'paid',
    });
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/sub_already_running/);
    expect(stripeMock.subscriptions.create).not.toHaveBeenCalled();
  });

  it('bills twelve months up front on the yearly cadence', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      final_status: 'paid',
      billing_interval: 'yearly',
    });
    stripeMock.subscriptions.create.mockResolvedValue({
      id: 'sub_year',
      status: 'active',
      trial_end: null,
      items: { data: [{ current_period_end: 1893456000 }] },
    });
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    const arg = stripeMock.subscriptions.create.mock.calls[0]?.[0];
    expect(arg?.items[0].price_data.unit_amount).toBe(58800); // €49 × 12 × 100
    expect(arg?.items[0].price_data.recurring.interval).toBe('year');
    expect(arg?.metadata.cadence).toBe('yearly');
    const body = await res.json();
    expect(body.subscription.status).toBe('active');
    expect(body.subscription.trialEnd).toBeNull();
    expect(body.subscription.currentPeriodEnd).toBe(
      new Date(1893456000 * 1000).toISOString()
    );
  });

  it('lets the body cadence override the stored billing_interval', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      final_status: 'paid',
      billing_interval: 'yearly',
    });
    stripeMock.subscriptions.create.mockResolvedValue({
      id: 'sub_month',
      status: 'trialing',
      trial_end: null,
      items: { data: [] },
    });
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReq({ cadence: 'monthly' }), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    const arg = stripeMock.subscriptions.create.mock.calls[0]?.[0];
    expect(arg?.items[0].price_data.unit_amount).toBe(4900);
    expect(arg?.items[0].price_data.recurring.interval).toBe('month');
  });

  it('falls back to monthly when billing_interval is unset', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      final_status: 'paid',
      billing_interval: null,
    });
    stripeMock.subscriptions.create.mockResolvedValue({
      id: 'sub_default',
      status: 'trialing',
      trial_end: null,
      items: { data: [{ current_period_end: null }] },
    });
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    const arg = stripeMock.subscriptions.create.mock.calls[0]?.[0];
    expect(arg?.metadata.cadence).toBe('monthly');
  });

  it('rejects a cadence that is neither monthly nor yearly', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      final_status: 'paid',
    });
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReq({ cadence: 'weekly' }), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/monthly or yearly/);
    expect(stripeMock.subscriptions.create).not.toHaveBeenCalled();
  });

  it('accepts the legacy monthlyAmount body field', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      final_status: 'paid',
    });
    stripeMock.subscriptions.create.mockResolvedValue({
      id: 'sub_legacy',
      status: 'active',
      trial_end: null,
      items: { data: [{ current_period_end: null }] },
    });
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReq({ monthlyAmount: 79 }), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    const arg = stripeMock.subscriptions.create.mock.calls[0]?.[0];
    expect(arg?.items[0].price_data.unit_amount).toBe(7900);
  });

  it('rejects a non-positive explicit recurring amount', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      final_status: 'paid',
    });
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReq({ recurringAmount: -12 }), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Cannot derive recurring amount/);
    expect(stripeMock.subscriptions.create).not.toHaveBeenCalled();
  });

  it('rejects when monthly_fee is unset and no amount is given', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      final_status: 'paid',
      monthly_fee: null,
    });
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(400);
    expect(stripeMock.subscriptions.create).not.toHaveBeenCalled();
  });

  it('honours an explicit trial length and clamps an absurd one', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      final_status: 'paid',
    });
    stripeMock.subscriptions.create.mockResolvedValue({
      id: 'sub_trial',
      status: 'trialing',
      trial_end: null,
      items: { data: [{ current_period_end: null }] },
    });
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );

    const res = await POST(makeReq({ trialPeriodDays: 0 }), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    expect(
      stripeMock.subscriptions.create.mock.calls[0]?.[0]?.trial_period_days
    ).toBe(0);

    await POST(makeReq({ trialPeriodDays: 5000 }), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(
      stripeMock.subscriptions.create.mock.calls[1]?.[0]?.trial_period_days
    ).toBe(30);

    await POST(makeReq({ trialPeriodDays: 'soon' }), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(
      stripeMock.subscriptions.create.mock.calls[2]?.[0]?.trial_period_days
    ).toBe(30);

    await POST(makeReq({ trialPeriodDays: 14.8 }), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(
      stripeMock.subscriptions.create.mock.calls[3]?.[0]?.trial_period_days
    ).toBe(14);
  });

  it('returns 500 when the concierge product is not configured', async () => {
    delete process.env.STRIPE_CONCIERGE_PRODUCT_ID;
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      final_status: 'paid',
    });
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('missing_product_id');
    expect(stripeMock.subscriptions.create).not.toHaveBeenCalled();
  });

  it('surfaces a Stripe API failure as 500', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      final_status: 'paid',
    });
    stripeMock.subscriptions.create.mockRejectedValue(
      new Error('card_declined')
    );
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('card_declined');
  });

  it('surfaces a Supabase read failure as 500 db_error', async () => {
    setupProjectFetchError();
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('db_error');
  });

  it('reports the subscription id when Stripe succeeded but the DB write failed', async () => {
    setupProjectFetchWithFailingUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      final_status: 'paid',
    });
    stripeMock.subscriptions.create.mockResolvedValue({
      id: 'sub_orphan',
      status: 'trialing',
      trial_end: 1893456000,
      items: { data: [{ current_period_end: 1893456000 }] },
    });
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/sub_orphan/);
    expect(body.subscription.subscriptionId).toBe('sub_orphan');
  });

  it('stores a canceled Stripe status as "cancelled" and a trial as "trial"', async () => {
    const { updateChain } = setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      final_status: 'paid',
    });
    stripeMock.subscriptions.create.mockResolvedValue({
      id: 'sub_c',
      status: 'canceled',
      trial_end: null,
      items: { data: [{ current_period_end: null }] },
    });
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    expect(updateChain.eq).toHaveBeenCalledWith('id', 'proj_1');
    const persisted = supabaseMock.from.mock.results
      .map((r) => r.value.update.mock.calls)
      .flat()
      .flat()
      .filter(Boolean) as Array<Record<string, unknown>>;
    expect(persisted.some((u) => u.subscription_status === 'cancelled')).toBe(
      true
    );
  });

  it('treats an unparseable body as empty', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      deposit_status: 'paid',
      final_status: 'paid',
    });
    stripeMock.subscriptions.create.mockResolvedValue({
      id: 'sub_nobody',
      status: 'trialing',
      trial_end: null,
      items: { data: [{ current_period_end: null }] },
    });
    const { POST } = await import(
      '../../../[id]/billing/activate-subscription/route'
    );
    const res = await POST(makeReqWithBrokenBody(), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    expect(
      stripeMock.subscriptions.create.mock.calls[0]?.[0]?.trial_period_days
    ).toBe(30);
  });
});

describe('POST /api/team/projects/[id]/billing/cancel-subscription', () => {
  it('cancels at period end by default', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      stripe_subscription_id: 'sub_active',
    });
    stripeMock.subscriptions.update.mockResolvedValue({
      id: 'sub_active',
      status: 'active',
      cancel_at_period_end: true,
    });
    const { POST } = await import(
      '../../../[id]/billing/cancel-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subscription.cancelAtPeriodEnd).toBe(true);
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_active', {
      cancel_at_period_end: true,
    });
    expect(stripeMock.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('keeps the subscription id on the row when cancelling at period end', async () => {
    const { builder } = setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      stripe_subscription_id: 'sub_active',
    });
    stripeMock.subscriptions.update.mockResolvedValue({
      id: 'sub_active',
      status: 'trialing',
      cancel_at_period_end: true,
    });
    const { POST } = await import(
      '../../../[id]/billing/cancel-subscription/route'
    );
    await POST(makeReq({}), { params: Promise.resolve({ id: 'proj_1' }) });
    expect(builder.update).toHaveBeenCalledWith({
      subscription_status: 'trial',
    });
  });

  it('cancels immediately with ?immediate=true', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      stripe_subscription_id: 'sub_active',
    });
    stripeMock.subscriptions.cancel.mockResolvedValue({
      id: 'sub_active',
      status: 'canceled',
      cancel_at_period_end: false,
    });
    const { POST } = await import(
      '../../../[id]/billing/cancel-subscription/route'
    );
    const res = await POST(makeReq({}, 'https://example.com/?immediate=true'), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    expect(stripeMock.subscriptions.cancel).toHaveBeenCalledWith('sub_active');
  });

  it('clears the subscription columns on an immediate cancel', async () => {
    const { builder } = setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      stripe_subscription_id: 'sub_active',
    });
    stripeMock.subscriptions.cancel.mockResolvedValue({
      id: 'sub_active',
      status: 'canceled',
      // Stripe omits the flag on an immediate cancel; the route defaults it.
      cancel_at_period_end: undefined,
    });
    const { POST } = await import(
      '../../../[id]/billing/cancel-subscription/route'
    );
    const res = await POST(makeReq({}, 'https://example.com/?immediate=true'), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    const body = await res.json();
    expect(body.subscription.cancelAtPeriodEnd).toBe(false);
    expect(builder.update).toHaveBeenCalledWith({
      subscription_status: 'cancelled',
      stripe_subscription_id: null,
      subscription_next_billing: null,
      subscription_trial_ends: null,
    });
  });

  it('returns 404 when project has no subscription', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      stripe_subscription_id: null,
    });
    const { POST } = await import(
      '../../../[id]/billing/cancel-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a workspace that does not exist', async () => {
    setupProjectFetch(null);
    const { POST } = await import(
      '../../../[id]/billing/cancel-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'no-such-workspace' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Workspace not found');
    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();
  });

  it('returns 500 when the workspace read fails', async () => {
    setupProjectFetchError('statement timeout');
    const { POST } = await import(
      '../../../[id]/billing/cancel-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('statement timeout');
  });

  it('maps a Stripe cancel failure through the billing error mapper', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
      stripe_subscription_id: 'sub_active',
    });
    stripeMock.subscriptions.update.mockRejectedValue(
      new Error('No such subscription: sub_active')
    );
    const { POST } = await import(
      '../../../[id]/billing/cancel-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('No such subscription: sub_active');
  });

  it('reports the cancellation when Stripe succeeded but the DB write failed', async () => {
    setupProjectFetchWithFailingUpdate(
      {
        ...baseProject,
        stripe_customer_id: 'cus_existing',
        stripe_subscription_id: 'sub_active',
      },
      'could not serialize access'
    );
    stripeMock.subscriptions.update.mockResolvedValue({
      id: 'sub_active',
      status: 'active',
      cancel_at_period_end: true,
    });
    const { POST } = await import(
      '../../../[id]/billing/cancel-subscription/route'
    );
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/could not serialize access/);
    expect(body.subscription.subscriptionId).toBe('sub_active');
  });
});

describe('POST /api/team/projects/[id]/billing/portal-link', () => {
  it('creates portal session and returns URL', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
    });
    stripeMock.billingPortal.sessions.create.mockResolvedValue({
      url: 'https://billing.stripe.com/p/session/xyz',
    });
    const { POST } = await import('../../../[id]/billing/portal-link/route');
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe('https://billing.stripe.com/p/session/xyz');
  });

  it('defaults the return URL to the workspace dashboard', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
    });
    stripeMock.billingPortal.sessions.create.mockResolvedValue({
      url: 'https://billing.stripe.com/p/session/xyz',
    });
    const { POST } = await import('../../../[id]/billing/portal-link/route');
    await POST(makeReq({}), { params: Promise.resolve({ id: 'proj_1' }) });
    expect(stripeMock.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_existing',
      return_url: 'https://flowstarter.dev/team/dashboard/projects/proj_1',
    });
  });

  it('rejects unsafe returnUrl (open redirect)', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
    });
    stripeMock.billingPortal.sessions.create.mockResolvedValue({
      url: 'https://billing.stripe.com/p/session/xyz',
    });
    const { POST } = await import('../../../[id]/billing/portal-link/route');
    await POST(makeReq({ returnUrl: 'https://attacker.com/evil' }), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    const arg = stripeMock.billingPortal.sessions.create.mock.calls[0]?.[0];
    // returnUrl should fall back to platform URL, not the attacker URL
    const returnHost = new URL(arg?.return_url).hostname;
    expect(
      returnHost === 'flowstarter.dev' ||
        returnHost.endsWith('.flowstarter.dev')
    ).toBe(true);
  });

  it('accepts a returnUrl on a platform subdomain', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
    });
    stripeMock.billingPortal.sessions.create.mockResolvedValue({
      url: 'https://billing.stripe.com/p/session/xyz',
    });
    const { POST } = await import('../../../[id]/billing/portal-link/route');
    await POST(makeReq({ returnUrl: '  https://app.flowstarter.dev/back  ' }), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    const arg = stripeMock.billingPortal.sessions.create.mock.calls[0]?.[0];
    expect(arg?.return_url).toBe('https://app.flowstarter.dev/back');
  });

  it.each([
    ['a non-http scheme', 'javascript:alert(1)'],
    ['a bare string', 'not-a-url'],
    ['an empty string', '   '],
    ['a lookalike domain', 'https://flowstarter.dev.evil.com/steal'],
  ])('falls back to the dashboard for %s', async (_label, returnUrl) => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
    });
    stripeMock.billingPortal.sessions.create.mockResolvedValue({
      url: 'https://billing.stripe.com/p/session/xyz',
    });
    const { POST } = await import('../../../[id]/billing/portal-link/route');
    await POST(makeReq({ returnUrl }), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    const arg = stripeMock.billingPortal.sessions.create.mock.calls[0]?.[0];
    expect(arg?.return_url).toBe(
      'https://flowstarter.dev/team/dashboard/projects/proj_1'
    );
  });

  it('ignores a non-string returnUrl', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
    });
    stripeMock.billingPortal.sessions.create.mockResolvedValue({
      url: 'https://billing.stripe.com/p/session/xyz',
    });
    const { POST } = await import('../../../[id]/billing/portal-link/route');
    await POST(makeReq({ returnUrl: 42 }), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    const arg = stripeMock.billingPortal.sessions.create.mock.calls[0]?.[0];
    expect(arg?.return_url).toBe(
      'https://flowstarter.dev/team/dashboard/projects/proj_1'
    );
  });

  it('creates the Stripe customer first when the workspace has none', async () => {
    setupProjectFetchAndUpdate({ ...baseProject });
    stripeMock.customers.create.mockResolvedValue({ id: 'cus_fresh' });
    stripeMock.billingPortal.sessions.create.mockResolvedValue({
      url: 'https://billing.stripe.com/p/session/new',
    });
    const { POST } = await import('../../../[id]/billing/portal-link/route');
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    expect(stripeMock.customers.create).toHaveBeenCalledOnce();
    expect(
      stripeMock.billingPortal.sessions.create.mock.calls[0]?.[0]?.customer
    ).toBe('cus_fresh');
  });

  it('returns 400 when there is no client email to open a portal for', async () => {
    setupProjectFetchAndUpdate({ ...baseProject, client_email: null });
    const { POST } = await import('../../../[id]/billing/portal-link/route');
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('missing_client_email');
    expect(stripeMock.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('returns 500 when the workspace read fails', async () => {
    setupProjectFetchError();
    const { POST } = await import('../../../[id]/billing/portal-link/route');
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('db_error');
  });

  it('returns 502 when Stripe refuses to open a portal session', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
    });
    stripeMock.billingPortal.sessions.create.mockRejectedValue(
      new Error('No configuration provided for the customer portal')
    );
    const { POST } = await import('../../../[id]/billing/portal-link/route');
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe(
      'No configuration provided for the customer portal'
    );
  });

  it('returns a generic 502 when Stripe throws a non-Error', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
    });
    stripeMock.billingPortal.sessions.create.mockRejectedValue(
      'socket hang up'
    );
    const { POST } = await import('../../../[id]/billing/portal-link/route');
    const res = await POST(makeReq({}), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('Portal link failed');
  });

  it('treats an unparseable body as empty', async () => {
    setupProjectFetchAndUpdate({
      ...baseProject,
      stripe_customer_id: 'cus_existing',
    });
    stripeMock.billingPortal.sessions.create.mockResolvedValue({
      url: 'https://billing.stripe.com/p/session/xyz',
    });
    const { POST } = await import('../../../[id]/billing/portal-link/route');
    const res = await POST(makeReqWithBrokenBody(), {
      params: Promise.resolve({ id: 'proj_1' }),
    });
    expect(res.status).toBe(200);
    const arg = stripeMock.billingPortal.sessions.create.mock.calls[0]?.[0];
    expect(arg?.return_url).toBe(
      'https://flowstarter.dev/team/dashboard/projects/proj_1'
    );
  });
});
