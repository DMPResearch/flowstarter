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

/** The nudge to the build worker: a transport, proved in its own suite. */
const dispatchAgentJob = vi.fn(async (_jobId: string) => undefined);
vi.mock('../pipeline/dispatch', () => ({
  dispatchAgentJob: (jobId: string) => dispatchAgentJob(jobId),
  DispatchError: class DispatchError extends Error {},
}));

/**
 * The rights-filtered reader, and the only one a build may take assets from.
 * Stubbed to one confirmed picture so the payload has something to carry.
 */
vi.mock('../generation-assets', () => ({
  loadUsableAssets: async () => [
    {
      id: 'b104b1e0-6d4c-4a3e-9230-13cc17b426a0',
      storagePath: 'tenant/0f4e1088-8d8f-4f18-83b1-406cc292b23c/assets/a.jpg',
      mime: 'image/jpeg',
      width: 1200,
      height: 750,
      usableFor: ['section'],
      caption: 'The workshops room',
    },
  ],
}));

import {
  buildChangeRequestHandler,
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
    build_job_id: null,
    built_version: null,
    completed_via: null,
    completion_note: null,
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
  dispatchAgentJob.mockReset();
  dispatchAgentJob.mockResolvedValue(undefined);
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
  const REASON = 'Handled on a call; the client no longer wants it built.';

  it('marks a paid request done when the operator says how', async () => {
    seed({ status: 'paid', quote_minor: 19_000 });

    const res = await setChangeRequestStatusHandler(
      post({ status: 'done', reason: REASON }),
      changeCtx()
    );

    expect(res.status).toBe(200);
    const view = (await res.json()).request;
    expect(view.status).toBe('done');
    // A manual close is recorded as one, forever after, so the difference
    // between "a build shipped this" and "a person says this is handled"
    // stays legible to whoever reads the row next.
    expect(view.completedVia).toBe('manual');
    expect(db.rows(TABLE)[0]!.completion_note).toBe(REASON);
    expect(db.rows('project_events')[0]).toMatchObject({
      kind: 'change_request_done',
    });
    expect(db.rows('project_events')[0]!.payload).toEqual({
      changeRequestId: CHANGE_ID,
      by: 'operator',
      reason: REASON,
    });
  });

  it('refuses a hand-marked done with no reason on it', async () => {
    // This button used to be the whole of what the product could do with a
    // paid change request, which is how EUR 190 was taken for work that never
    // shipped. It survives as an override, and an override costs a sentence.
    seed({ status: 'paid', quote_minor: 19_000 });

    for (const body of [
      { status: 'done' },
      { status: 'done', reason: '   ' },
      { status: 'done', reason: 'done' },
    ]) {
      const res = await setChangeRequestStatusHandler(post(body), changeCtx());
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('CHANGE_REQUEST_REASON_REQUIRED');
    }
    expect(db.rows(TABLE)[0]!.status).toBe('paid');
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
      post({ status: 'done', reason: REASON }),
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
      post({ status: 'done', reason: REASON }),
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
      post({ status: 'done', reason: REASON }),
      changeCtx()
    );

    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('DB_ERROR');
  });
});

describe('"Build this change": the button that does the work', () => {
  const WORKSPACE_ROW = {
    id: WORKSPACE_ID,
    project_state: 'LIVE_SUBSCRIPTION',
  };

  function seedWorkspace(projectState = 'LIVE_SUBSCRIPTION') {
    db.seed('workspaces', [{ ...WORKSPACE_ROW, project_state: projectState }]);
  }

  it('queues a build and leaves the request at paid', async () => {
    // The request must not be moved here. It is moved to done by the worker,
    // in the same step that records the version it went live in, so a crash
    // anywhere in between leaves the row saying the true thing.
    seedWorkspace();
    seed({ status: 'paid', quote_minor: 19_000 });

    const res = await buildChangeRequestHandler(
      post({ note: 'Three across on desktop' }),
      changeCtx()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.request.status).toBe('paid');

    const jobs = db.rows('flowstarter_agent_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe('CHANGE_REQUEST_BUILD');
    const payload = jobs[0]!.payload as {
      changeRequest: { request: string; operatorNote: string };
    };
    // The client's own words, unedited, and the operator's note beside them.
    expect(payload.changeRequest.request).toBe(
      'Add a page for group workshops with its own booking calendar'
    );
    expect(payload.changeRequest.operatorNote).toBe('Three across on desktop');

    expect(db.rows(TABLE)[0]!.status).toBe('paid');
    expect(db.rows(TABLE)[0]!.build_job_id).toBe(jobs[0]!.id);
    expect(db.rows('project_events')[0]).toMatchObject({
      kind: 'change_request_build_queued',
    });
  });

  it('refuses a request nobody has paid for', async () => {
    seedWorkspace();
    seed({ status: 'quoted', quote_minor: 19_000 });

    const res = await buildChangeRequestHandler(post({}), changeCtx());

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CHANGE_REQUEST_NOT_PAID');
    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(0);
  });

  it('refuses a project with no delivered site to change', async () => {
    seedWorkspace('DEPOSIT_PAID');
    seed({ status: 'paid', quote_minor: 19_000 });

    const res = await buildChangeRequestHandler(post({}), changeCtx());

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('INVALID_PROJECT_STATE');
    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(0);
  });

  it('refuses a client who is not an operator', async () => {
    authState.role = 'client';
    seedWorkspace();
    seed({ status: 'paid' });

    expect(
      (await buildChangeRequestHandler(post({}), changeCtx())).status
    ).toBe(403);
    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(0);
  });

  it('404s a change request from another workspace', async () => {
    seedWorkspace();
    seed({ workspace_id: OTHER_WORKSPACE_ID, status: 'paid' });

    const res = await buildChangeRequestHandler(post({}), changeCtx());

    expect(res.status).toBe(404);
    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(0);
  });

  it('reports an unreachable worker without failing the request', async () => {
    // The ledger row is the commitment; the dispatch is only a nudge. An
    // operator can re-dispatch a queued job; they cannot un-lose a refusal.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dispatchAgentJob.mockRejectedValueOnce(new Error('worker not configured'));
    seedWorkspace();
    seed({ status: 'paid', quote_minor: 19_000 });

    const res = await buildChangeRequestHandler(post({}), changeCtx());

    expect(res.status).toBe(200);
    expect((await res.json()).dispatched).toBe(false);
    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(1);
  });
});
