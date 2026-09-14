/**
 * POST /api/flowstarter/projects/[id]/deposit-checkout
 *
 * The signed-in half of the 20% build deposit. It used to compute the
 * Stripe success/cancel origin with its own copy of the "where is the app"
 * rule — a `new URL(NEXT_PUBLIC_SITE_URL).protocol !== 'https:'` assertion
 * that only forgave `localhost` / `127.0.0.1` — so a development stack whose
 * `NEXT_PUBLIC_SITE_URL` names a LAN address (`http://192.168.3.119:3000`,
 * the shape a phone or another machine on the network needs to reach a
 * laptop) 500'd every checkout with "NEXT_PUBLIC_SITE_URL must be HTTPS
 * outside local development". The guest deposit route on the same stack
 * worked, because it fell through to the request's own origin instead.
 *
 * The fix reads `publicAppOrigin()` from `@flowstarter/platform-config` —
 * the one rule every other public-origin call site in the app now shares —
 * so the cases below pin exactly the environments that used to disagree: a
 * LAN `NEXT_PUBLIC_SITE_URL` (must not throw), a pinned
 * `FLOWSTARTER_PUBLIC_APP_ORIGIN` (must win outright), and nothing configured
 * at all (must fall back to the request's own origin, same as the guest
 * route).
 *
 * Static imports throughout: vi.mock is hoisted above them, and the app's
 * tsconfig does not allow top-level await.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeSupabase } from '@/lib/flowstarter/__tests__/fake-supabase';

vi.mock('server-only', () => ({}));

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

// ── Clerk ─────────────────────────────────────────────────────────────────
// Same style as claim-route.test.ts.

const authState: { userId: string | null } = { userId: 'user_client' };

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({
    userId: authState.userId,
    sessionClaims: {},
    getToken: async () => 'test-token',
  }),
  clerkClient: async () => ({
    users: { getUser: async () => ({ publicMetadata: {} }) },
  }),
  currentUser: async () => null,
}));

// ── Supabase (service role) ──────────────────────────────────────────────

const db = createFakeSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

// ── Stripe ────────────────────────────────────────────────────────────────

interface CapturedSession {
  customer_email?: string;
  line_items: Array<{ price_data: { unit_amount: number; currency: string } }>;
  success_url: string;
  cancel_url: string;
}

const createSessionSpy = vi.fn(async (_params: CapturedSession) => ({
  id: 'cs_test_1',
  url: 'https://checkout.stripe.com/c/pay/cs_test_1',
}));

vi.mock('stripe', () => ({
  default: class {
    checkout = { sessions: { create: createSessionSpy } };
  },
}));

import { POST } from '../route';

function req(workspaceId = WORKSPACE_ID, origin = 'http://localhost:3000') {
  return new NextRequest(
    `${origin}/api/flowstarter/projects/${workspaceId}/deposit-checkout`,
    { method: 'POST' }
  );
}

const params = (id = WORKSPACE_ID) => ({ params: Promise.resolve({ id }) });

function seedApprovedWorkspace(overrides: Record<string, unknown> = {}) {
  db.seed('workspace_memberships', [
    { workspace_id: WORKSPACE_ID, clerk_user_id: 'user_client' },
  ]);
  db.seed('workspaces', [
    {
      id: WORKSPACE_ID,
      client_email: 'client@example.com',
      client_business_name: 'Acme Bakery',
      project_state: 'PREVIEW_READY',
      final_value_minor: 500_000,
      billing_currency: 'EUR',
      deposit_status: 'unpaid',
      ...overrides,
    },
  ]);
}

const ENV_KEYS = [
  'NEXT_PUBLIC_SITE_URL',
  'FLOWSTARTER_PUBLIC_APP_ORIGIN',
  'FLOWSTARTER_ENV',
] as const;

beforeEach(() => {
  db.reset();
  authState.userId = 'user_client';
  createSessionSpy.mockClear();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake');
  for (const key of ENV_KEYS) vi.stubEnv(key, '');
});

describe('POST /api/flowstarter/projects/[id]/deposit-checkout', () => {
  it('refuses a signed-out caller', async () => {
    authState.userId = null;
    seedApprovedWorkspace();

    const response = await POST(req(), params());

    expect(response.status).toBe(401);
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  it('rejects a workspace id that is not a uuid', async () => {
    const response = await POST(req('not-a-uuid'), params('not-a-uuid'));
    expect(response.status).toBe(400);
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  it('404s when the caller has no membership on the workspace', async () => {
    seedApprovedWorkspace();
    authState.userId = 'user_someone_else';

    const response = await POST(req(), params());

    expect(response.status).toBe(404);
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  it('says so rather than dead-ending when Stripe is not configured', async () => {
    seedApprovedWorkspace();
    vi.stubEnv('STRIPE_SECRET_KEY', '');

    const response = await POST(req(), params());

    expect(response.status).toBe(503);
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  it('refuses a preview that has not been approved', async () => {
    seedApprovedWorkspace({ project_state: 'GENERATING' });

    const response = await POST(req(), params());

    expect(response.status).toBe(409);
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  it('refuses a deposit that is already paid', async () => {
    seedApprovedWorkspace({ deposit_status: 'paid' });

    const response = await POST(req(), params());

    expect(response.status).toBe(409);
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  it('refuses a workspace with no configured quote', async () => {
    seedApprovedWorkspace({ final_value_minor: 0 });

    const response = await POST(req(), params());

    expect(response.status).toBe(409);
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  it('prices the deposit at 20% of the quote and charges the client email', async () => {
    seedApprovedWorkspace();

    const response = await POST(req(), params());
    const body = (await response.json()) as {
      url: string;
      amountMinor: number;
      currency: string;
      depositPercent: number;
    };

    expect(response.status).toBe(200);
    expect(body.amountMinor).toBe(100_000);
    expect(body.currency).toBe('eur');
    expect(body.depositPercent).toBe(20);

    const session = createSessionSpy.mock.calls[0]![0];
    expect(session.customer_email).toBe('client@example.com');
    expect(session.line_items[0]!.price_data.unit_amount).toBe(100_000);
  });

  // ── The bug: a development stack whose NEXT_PUBLIC_SITE_URL is a LAN
  // address ──────────────────────────────────────────────────────────────

  it('does not throw when NEXT_PUBLIC_SITE_URL is a LAN address in development', async () => {
    seedApprovedWorkspace();
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://192.168.3.119:3000');

    const response = await POST(req(), params());
    const body = (await response.json()) as { url: string };

    expect(response.status).toBe(200);
    expect(body.url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');

    const session = createSessionSpy.mock.calls[0]![0];
    expect(session.success_url).toBe(
      `http://192.168.3.119:3000/dashboard/projects/${WORKSPACE_ID}?deposit=paid`
    );
    expect(session.cancel_url).toBe(
      `http://192.168.3.119:3000/dashboard/projects/${WORKSPACE_ID}?deposit=cancelled`
    );
  });

  it('lets FLOWSTARTER_PUBLIC_APP_ORIGIN win outright over NEXT_PUBLIC_SITE_URL', async () => {
    seedApprovedWorkspace();
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://192.168.3.119:3000');
    vi.stubEnv(
      'FLOWSTARTER_PUBLIC_APP_ORIGIN',
      'https://pr-7.staging.flowstarter.dev'
    );

    const response = await POST(req(), params());
    expect(response.status).toBe(200);

    const session = createSessionSpy.mock.calls[0]![0];
    expect(session.success_url).toBe(
      `https://pr-7.staging.flowstarter.dev/dashboard/projects/${WORKSPACE_ID}?deposit=paid`
    );
  });

  it('falls back to the request origin when nothing is configured, same as the guest route', async () => {
    seedApprovedWorkspace();

    const response = await POST(
      req(WORKSPACE_ID, 'http://192.168.9.9:3000'),
      params()
    );
    expect(response.status).toBe(200);

    const session = createSessionSpy.mock.calls[0]![0];
    expect(session.success_url).toBe(
      `http://192.168.9.9:3000/dashboard/projects/${WORKSPACE_ID}?deposit=paid`
    );
  });
});
