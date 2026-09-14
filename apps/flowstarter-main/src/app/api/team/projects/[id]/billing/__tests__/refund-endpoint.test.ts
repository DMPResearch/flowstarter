/**
 * The refund endpoint, on both trees.
 *
 * `/api/admin/projects/[id]/billing/refund` and
 * `/api/team/projects/[id]/billing/refund` are two files calling one handler,
 * which is a deliberate departure from the other four billing endpoints (two
 * copies of the same file that now differ only in a doc comment). A refund is
 * the one operation here that moves money the wrong way, so both are asserted
 * to behave identically rather than trusted to.
 *
 * Stripe stays mocked. The refund lib is mocked too: what it decides is
 * covered exhaustively in `src/lib/billing/__tests__/refund.test.ts`, and
 * what matters here is the wiring around it — auth, body validation, the
 * operator id that reaches the ledger, and how a refusal becomes a status.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  authOverride: null as unknown,
  stripeCtorError: null as unknown,
}));

vi.mock('stripe', () => ({
  default: class MockStripe {
    constructor() {
      if (state.stripeCtorError) throw state.stripeCtorError;
    }
  },
}));

const refundMock = vi.hoisted(() => ({ refundSetupFee: vi.fn() }));
vi.mock('@/lib/billing/refund', () => ({
  refundSetupFee: refundMock.refundSetupFee,
}));

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({ from: vi.fn() }),
}));

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

import { unauthorizedResponse } from '@/lib/api-auth';
import { POST as teamRefund } from '../refund/route';
import { POST as adminRefund } from '@/app/api/admin/projects/[id]/billing/refund/route';

const ROUTES: Array<[string, typeof teamRefund]> = [
  ['team', teamRefund],
  ['admin', adminRefund],
];

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const PARAMS = { params: Promise.resolve({ id: 'ws_1' }) };
const REASON = 'Client invoked the guarantee on the call today.';

beforeEach(() => {
  vi.clearAllMocks();
  state.authOverride = null;
  state.stripeCtorError = null;
  process.env.STRIPE_SECRET_KEY = 'sk_test_refund';
  refundMock.refundSetupFee.mockResolvedValue({
    ok: true,
    legs: [
      {
        milestone: 'final',
        paymentIntentId: 'pi_balance',
        amountMinor: 39_950,
        currency: 'eur',
      },
    ],
    totalMinor: 39_950,
    currency: 'eur',
    basis: 'guarantee',
    duplicate: false,
    clientEmailed: true,
  });
});

describe.each(ROUTES)(
  'POST /api/%s/projects/[id]/billing/refund',
  (_, POST) => {
    it('refuses an unauthenticated caller before anything else happens', async () => {
      state.authOverride = {
        authorized: false,
        response: unauthorizedResponse(),
      };
      const res = await POST(request({ reason: REASON }), PARAMS);
      expect(res.status).toBe(401);
      expect(refundMock.refundSetupFee).not.toHaveBeenCalled();
    });

    it('refuses a body with no reason, with a 400 and no Stripe call', async () => {
      const res = await POST(request({}), PARAMS);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringMatching(/reason/i),
      });
      expect(refundMock.refundSetupFee).not.toHaveBeenCalled();
    });

    it('survives a body that is not JSON at all', async () => {
      const res = await POST(
        {
          json: async () => {
            throw new Error('not json');
          },
        } as unknown as NextRequest,
        PARAMS
      );
      expect(res.status).toBe(400);
    });

    it('answers 500 when Stripe is not configured', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      const res = await POST(request({ reason: REASON }), PARAMS);
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringContaining('STRIPE_SECRET_KEY'),
      });
    });

    it('answers 500 when the Stripe client will not construct', async () => {
      state.stripeCtorError = new Error('bad key');
      const res = await POST(request({ reason: REASON }), PARAMS);
      expect(res.status).toBe(500);
    });

    it('passes the reason and the operator id through to the ledger', async () => {
      const res = await POST(request({ reason: REASON }), PARAMS);
      expect(res.status).toBe(200);
      expect(refundMock.refundSetupFee).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws_1',
          reason: REASON,
          requestedBy: 'user_team_1',
          overrideReason: null,
          requestedAmountMinor: null,
        })
      );
      await expect(res.json()).resolves.toMatchObject({
        refund: { totalMinor: 39_950, basis: 'guarantee', duplicate: false },
      });
    });

    it('converts a euro amount to minor units on the way through', async () => {
      await POST(
        request({
          reason: REASON,
          overrideReason: 'Build never delivered.',
          amount: 399.5,
        }),
        PARAMS
      );
      expect(refundMock.refundSetupFee).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedAmountMinor: 39_950,
          overrideReason: 'Build never delivered.',
        })
      );
    });

    it('turns a rule refusal into its own status and message', async () => {
      refundMock.refundSetupFee.mockResolvedValue({
        ok: false,
        code: 'window_closed',
        message:
          'The guarantee window is 30 days and this site launched 40 days ago.',
        status: 409,
      });
      const res = await POST(request({ reason: REASON }), PARAMS);
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        code: 'window_closed',
      });
    });

    it('reports a repeat press as a duplicate rather than a second refund', async () => {
      refundMock.refundSetupFee.mockResolvedValue({
        ok: true,
        legs: [],
        totalMinor: 0,
        currency: 'eur',
        basis: 'guarantee',
        duplicate: true,
        clientEmailed: false,
      });
      const res = await POST(request({ reason: REASON }), PARAMS);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        refund: { duplicate: true, totalMinor: 0 },
      });
    });

    it('maps a Stripe refusal thrown out of the lib to 502', async () => {
      const { StripeBillingError } = await vi.importActual<
        typeof import('@/lib/billing/stripe')
      >('@/lib/billing/stripe');
      refundMock.refundSetupFee.mockRejectedValue(
        new StripeBillingError('refund_failed', 'charge already refunded')
      );
      const res = await POST(request({ reason: REASON }), PARAMS);
      expect(res.status).toBe(502);
    });

    it('maps a missing workspace thrown out of the lib to 404', async () => {
      const { StripeBillingError } = await vi.importActual<
        typeof import('@/lib/billing/stripe')
      >('@/lib/billing/stripe');
      refundMock.refundSetupFee.mockRejectedValue(
        new StripeBillingError('workspace_not_found', 'no such workspace')
      );
      const res = await POST(request({ reason: REASON }), PARAMS);
      expect(res.status).toBe(404);
    });
  }
);
