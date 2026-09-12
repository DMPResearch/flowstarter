// @vitest-environment node
/**
 * POST /api/client/booking/[workspaceId], through the REAL route handler.
 *
 * This is the button that makes a client a calendar. It is the same call the
 * claim makes, so the two things it has to get right are the two the claim
 * already got right somewhere else:
 *
 *  1. TENANCY. The handler provisions with the service role, so
 *     `requireWorkspaceAccess` running first is the entire boundary. The
 *     cross-tenant case asserts the 404 *and* that nothing was provisioned for
 *     the other workspace: a 404 that still made somebody a calendar on our
 *     instance would be a green test and a live side effect.
 *  2. A FAILURE IS NOT AN ERROR. A client whose booking page could not be made
 *     is being told why, in a sentence, with a retry. Answering 500 would hand
 *     the browser's error path a body it throws away, and the client would get
 *     "something went wrong" for a thing they can act on.
 *
 * Provisioning itself is mocked: it is covered against a fake Cal client in
 * lib/flowstarter/__tests__, and what is under test here is the route's own
 * three decisions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../route';
import { createFakeSupabase } from '@/lib/flowstarter/__tests__/fake-supabase';

vi.mock('server-only', () => ({}));

const WORKSPACE_A = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const WORKSPACE_B = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';

const authState: { userId: string | null; role: string | undefined } = {
  userId: 'user_client_a',
  role: undefined,
};

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({
    userId: authState.userId,
    sessionClaims: { metadata: { role: authState.role } },
    getToken: async () => 'test-token',
  }),
  clerkClient: async () => ({
    users: {
      getUser: async () => ({
        publicMetadata: { role: authState.role },
        emailAddresses: [],
        primaryEmailAddressId: null,
      }),
    },
  }),
  currentUser: async () => null,
}));

const db = createFakeSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

const provisionWorkspaceCalendar = vi.fn();
vi.mock('@/lib/flowstarter/cal-provisioning', () => ({
  provisionWorkspaceCalendar: (...args: unknown[]) =>
    provisionWorkspaceCalendar(...args),
}));
const notifyClientBookingPageReady = vi.fn(async (..._args: unknown[]) => ({
  sent: true,
}));
vi.mock('@/lib/flowstarter/cal-provisioned-notice', () => ({
  notifyClientBookingPageReady: (...args: unknown[]) =>
    notifyClientBookingPageReady(...args),
}));

const PROVISIONED = {
  ok: true,
  state: 'provisioned',
  bookingUrl: 'https://cal.flowstarter.dev/halden-roe/intro-call',
  username: 'halden-roe',
  calUserId: 42,
  calEventTypeId: 108,
  alreadyProvisioned: false,
};

function params(workspaceId: string) {
  return { params: Promise.resolve({ workspaceId }) };
}

function post(workspaceId: string): NextRequest {
  return new NextRequest(`http://localhost/api/client/booking/${workspaceId}`, {
    method: 'POST',
  });
}

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  provisionWorkspaceCalendar.mockResolvedValue(PROVISIONED);
  authState.userId = 'user_client_a';
  authState.role = undefined;
  db.seed('workspaces', [
    { id: WORKSPACE_A, name: 'Halden & Roe', slug: 'halden-roe' },
    { id: WORKSPACE_B, name: 'Someone Else', slug: 'someone-else' },
  ]);
  db.seed('workspace_memberships', [
    { workspace_id: WORKSPACE_A, clerk_user_id: 'user_client_a' },
  ]);
});

describe('a booking page that is not yours', () => {
  it('is 404, and nothing is provisioned for the other workspace', async () => {
    const response = await POST(post(WORKSPACE_B), params(WORKSPACE_B));
    expect(response.status).toBe(404);
    expect(provisionWorkspaceCalendar).not.toHaveBeenCalled();
  });

  it('asks a signed-out caller to sign in rather than pretending it is missing', async () => {
    authState.userId = null;
    const response = await POST(post(WORKSPACE_A), params(WORKSPACE_A));
    expect(response.status).toBe(401);
    expect(provisionWorkspaceCalendar).not.toHaveBeenCalled();
  });

  it('refuses a workspace id that is not one', async () => {
    const response = await POST(post('not-a-uuid'), params('not-a-uuid'));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('BAD_REQUEST');
  });
});

describe('setting up a booking page', () => {
  it('returns the whole result, and asks as the signed-in client', async () => {
    const response = await POST(post(WORKSPACE_A), params(WORKSPACE_A));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PROVISIONED);

    expect(provisionWorkspaceCalendar).toHaveBeenCalledTimes(1);
    const call = provisionWorkspaceCalendar.mock.calls[0]?.[0] as {
      workspaceId: string;
      actor: string;
      supabase: unknown;
      notify: (notice: Record<string, unknown>) => Promise<unknown>;
    };
    // The id the access check authorized, not the raw path segment.
    expect(call.workspaceId).toBe(WORKSPACE_A);
    // From the session, never from the body: it goes on the ledger.
    expect(call.actor).toBe('user_client_a');
    expect(call.supabase).toBe(db.client);

    // The client is being handed an account, so the email that tells them to
    // put a password on it has to be attached here too. Called rather than
    // compared by identity, because the mock wraps it.
    await call.notify({ workspaceId: WORKSPACE_A });
    expect(notifyClientBookingPageReady).toHaveBeenCalledTimes(1);
  });

  it('is happy to be pressed twice, and says the page was already there', async () => {
    provisionWorkspaceCalendar.mockResolvedValue({
      ...PROVISIONED,
      alreadyProvisioned: true,
    });
    const response = await POST(post(WORKSPACE_A), params(WORKSPACE_A));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      alreadyProvisioned: true,
    });
  });
});

describe('a booking page that could not be made', () => {
  it('answers 200 with the reason, because the client can retry it', async () => {
    provisionWorkspaceCalendar.mockResolvedValue({
      ok: false,
      state: 'failed',
      reason: 'The booking service could not be reached. We will try again.',
    });

    const response = await POST(post(WORKSPACE_A), params(WORKSPACE_A));

    // The whole point: the sentence reaches the client instead of being
    // swallowed by the browser's error path.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      state: 'failed',
      reason: 'The booking service could not be reached. We will try again.',
    });
  });

  it('says an environment that cannot provision has not failed', async () => {
    provisionWorkspaceCalendar.mockResolvedValue({
      ok: false,
      state: 'not_yet',
      reason: 'Booking pages are not set up in this environment yet.',
    });

    const response = await POST(post(WORKSPACE_A), params(WORKSPACE_A));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'not_yet' });
  });

  it('is a 500 only when there is no sentence to give the client', async () => {
    // `provisionWorkspaceCalendar` promises never to throw. If it does, the
    // failure is ours and we have nothing to tell them about theirs.
    provisionWorkspaceCalendar.mockRejectedValue(new Error('boom'));

    const response = await POST(post(WORKSPACE_A), params(WORKSPACE_A));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe(
      'Could not set up your booking page.'
    );
  });
});
