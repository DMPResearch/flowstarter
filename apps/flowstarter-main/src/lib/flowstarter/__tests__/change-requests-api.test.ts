/**
 * The operator side of change requests: list, quote, decline, mark done.
 *
 * The transitions themselves are proved in change-requests.test.ts. What
 * these endpoints add is who may call them, which workspace's rows they may
 * touch, and what an operator sees when a move is refused — a request that is
 * already paid must not be re-priced, and a request belonging to another
 * tenant must not be readable by guessing its id.
 *
 * Clerk and the service-role client are mocked; the handlers and the whole
 * change-requests module run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { createFakeSupabase } from './fake-supabase';

vi.mock('server-only', () => ({}));

const authState: { userId: string | null; role: string | undefined } = {
  userId: 'user_operator',
  role: 'team',
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

import {
  listChangeRequestsHandler,
  quoteChangeRequestHandler,
  setChangeRequestStatusHandler,
} from '../change-requests-api';
import { type ChangeRequestRow } from '../change-requests';

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const OTHER_WORKSPACE_ID = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';
const CHANGE_ID = '2b6f1d4a-9c3e-4b21-8f77-5a1c2d3e4f61';
const TABLE = 'flowstarter_change_requests';

function seed(overrides: Partial<ChangeRequestRow> = {}) {
  const row = {
    id: CHANGE_ID,
    workspace_id: WORKSPACE_ID,
    message_id: 'msg-1',
    request: 'Add a page for group workshops with its own booking calendar',
    classification: 'structural',
    matched_rules: ['structural:new-thing'],
    status: 'requested',
    quote_minor: null,
    currency: 'eur',
    quote_note: null,
    quoted_by: null,
    quoted_at: null,
    responded_at: null,
    stripe_checkout_session_id: null,
    stripe_payment_intent_id: null,
    paid_at: null,
    completed_at: null,
    created_by: 'user_client',
    created_at: '2026-09-08T09:00:00.000Z',
    updated_at: '2026-09-08T09:00:00.000Z',
    ...overrides,
  };
  db.seed(TABLE, [row]);
  return row;
}

function ctx(id = WORKSPACE_ID) {
  return { params: Promise.resolve({ id }) };
}
function changeCtx(changeId = CHANGE_ID, id = WORKSPACE_ID) {
  return { params: Promise.resolve({ id, changeId }) };
}
function post(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}
const req = {} as NextRequest;

beforeEach(() => {
  db.reset();
  authState.userId = 'user_operator';
  authState.role = 'team';
  vi.restoreAllMocks();
});

describe('who may touch a change request', () => {
  it('refuses a signed-in client who is not an operator', async () => {
    authState.role = 'client';
    seed();

    for (const res of [
      await listChangeRequestsHandler(req, ctx()),
      await quoteChangeRequestHandler(post({ amountMinor: 100 }), changeCtx()),
      await setChangeRequestStatusHandler(
        post({ status: 'done' }),
        changeCtx()
      ),
    ]) {
      expect(res.status).toBe(403);
    }
    // Nothing was priced or moved.
    expect(db.rows(TABLE)[0]!.status).toBe('requested');
  });

  it('refuses nobody at all', async () => {
    authState.userId = null;
    expect((await listChangeRequestsHandler(req, ctx())).status).toBe(401);
  });

  it('rejects ids that are not uuids before reading anything', async () => {
    const badWorkspace = await listChangeRequestsHandler(req, ctx('nope'));
    expect(badWorkspace.status).toBe(400);
    expect((await badWorkspace.json()).error).toBe('Invalid workspace id');

    const badChange = await quoteChangeRequestHandler(
      post({ amountMinor: 100 }),
      changeCtx('nope')
    );
    expect(badChange.status).toBe(400);
    expect((await badChange.json()).error).toBe('Invalid change request id');
  });
});

describe('listing what the client asked for', () => {
  it('returns this workspace only, with the rule table’s opening price', async () => {
    seed();
    db.seed(TABLE, [
      {
        id: 'cr-other',
        workspace_id: OTHER_WORKSPACE_ID,
        request: 'Another tenant',
        status: 'requested',
        matched_rules: [],
        currency: 'eur',
        created_at: '2026-09-08T09:30:00.000Z',
      },
    ]);

    const res = await listChangeRequestsHandler(req, ctx());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].id).toBe(CHANGE_ID);
    // Operator-only: the price the rules would open with.
    expect(body.requests[0].suggestedQuoteMinor).toBe(19_000);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('reports a failed read rather than an empty list', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db.failing.add(TABLE);

    const res = await listChangeRequestsHandler(req, ctx());
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('DB_ERROR');
  });
});

describe('writing the price the client will see', () => {
  it('quotes a request and records who priced it', async () => {
    seed();

    const res = await quoteChangeRequestHandler(
      post({ amountMinor: 24_000, note: '  Two days of work  ' }),
      changeCtx()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.request).toMatchObject({
      status: 'quoted',
      quoteMinor: 24_000,
      quoteNote: 'Two days of work',
    });
    expect(db.rows(TABLE)[0]!.quoted_by).toBe('user_operator');

    const event = db.rows('project_events')[0]!;
    expect(event).toMatchObject({
      workspace_id: WORKSPACE_ID,
      kind: 'change_request_quoted',
      actor: 'user_operator',
    });
    expect(event.payload).toMatchObject({
      changeRequestId: CHANGE_ID,
      amountMinor: 24_000,
      currency: 'eur',
      requoted: false,
    });
  });

  it('marks a second price as a re-quote', async () => {
    seed({ status: 'quoted', quote_minor: 9_000 });

    await quoteChangeRequestHandler(post({ amountMinor: 19_000 }), changeCtx());

    expect(db.rows('project_events')[0]!.payload).toMatchObject({
      requoted: true,
    });
    expect(db.rows(TABLE)[0]!.quote_note).toBeNull();
  });

  it('refuses a body that is not a whole amount in minor units', async () => {
    seed();
    for (const body of [
      null,
      {},
      { amountMinor: -1 },
      { amountMinor: 12.5 },
      { amountMinor: 100_000_01 },
      { amountMinor: '24000' },
    ]) {
      const res = await quoteChangeRequestHandler(post(body), changeCtx());
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('INVALID_BODY');
    }
    expect(db.rows(TABLE)[0]!.status).toBe('requested');
  });

  it('refuses a body that is not JSON at all', async () => {
    seed();
    const broken = {
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    } as unknown as NextRequest;

    expect((await quoteChangeRequestHandler(broken, changeCtx())).status).toBe(
      400
    );
  });

  it('404s a change request this workspace does not own', async () => {
    seed({ workspace_id: OTHER_WORKSPACE_ID });

    const res = await quoteChangeRequestHandler(
      post({ amountMinor: 24_000 }),
      changeCtx()
    );

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
    // And the neighbour's row was not repriced.
    expect(db.rows(TABLE)[0]!.quote_minor).toBeNull();
  });

  it('refuses to reprice a request the client has already paid for', async () => {
    seed({ status: 'paid', quote_minor: 19_000 });

    const res = await quoteChangeRequestHandler(
      post({ amountMinor: 24_000 }),
      changeCtx()
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CHANGE_REQUEST_TRANSITION');
    expect(db.rows(TABLE)[0]!.quote_minor).toBe(19_000);
  });

  it('still returns the quote when only the audit row failed', async () => {
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    seed();
    db.failing.add('project_events');

    const res = await quoteChangeRequestHandler(
      post({ amountMinor: 24_000 }),
      changeCtx()
    );

    expect(res.status).toBe(200);
    expect(db.rows(TABLE)[0]!.quote_minor).toBe(24_000);
    expect(errors).toHaveBeenCalled();
  });
});

describe('closing a change request', () => {
  it('marks a paid request done', async () => {
    seed({ status: 'paid', quote_minor: 19_000 });

    const res = await setChangeRequestStatusHandler(
      post({ status: 'done' }),
      changeCtx()
    );

    expect(res.status).toBe(200);
    expect((await res.json()).request.status).toBe('done');
    expect(db.rows('project_events')[0]).toMatchObject({
      kind: 'change_request_done',
    });
    expect(db.rows('project_events')[0]!.payload).toEqual({
      changeRequestId: CHANGE_ID,
      by: 'operator',
    });
  });

  it('declines a request and keeps the operator’s reason', async () => {
    seed({ status: 'quoted', quote_minor: 19_000 });

    const res = await setChangeRequestStatusHandler(
      post({
        status: 'declined',
        reason: '  Out of scope for the care plan  ',
      }),
      changeCtx()
    );

    expect(res.status).toBe(200);
    expect((await res.json()).request.status).toBe('declined');
    expect(db.rows('project_events')[0]!.payload).toMatchObject({
      by: 'operator',
      reason: 'Out of scope for the care plan',
    });
  });

  it('refuses to mark done work that was never paid for', async () => {
    seed({ status: 'quoted', quote_minor: 19_000 });

    const res = await setChangeRequestStatusHandler(
      post({ status: 'done' }),
      changeCtx()
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CHANGE_REQUEST_TRANSITION');
    expect(db.rows(TABLE)[0]!.status).toBe('quoted');
  });

  it('accepts only the two statuses an operator may set', async () => {
    seed();
    for (const body of [null, {}, { status: 'paid' }, { status: 'quoted' }]) {
      const res = await setChangeRequestStatusHandler(post(body), changeCtx());
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('INVALID_BODY');
    }
  });

  it('404s a change request from another workspace', async () => {
    seed({ workspace_id: OTHER_WORKSPACE_ID, status: 'paid' });

    const res = await setChangeRequestStatusHandler(
      post({ status: 'done' }),
      changeCtx()
    );

    expect(res.status).toBe(404);
    expect(db.rows(TABLE)[0]!.status).toBe('paid');
  });

  it('reports a database failure as a database failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    seed({ status: 'paid' });
    db.failing.add(TABLE);

    const res = await setChangeRequestStatusHandler(
      post({ status: 'done' }),
      changeCtx()
    );

    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('DB_ERROR');
  });
});
