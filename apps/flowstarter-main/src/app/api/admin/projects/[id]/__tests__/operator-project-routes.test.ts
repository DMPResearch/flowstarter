// @vitest-environment node
/**
 * Every operator route under `/api/admin/projects/[id]`, through the REAL
 * handlers, asked the one question the tree exists to answer: may this caller
 * operate this workspace at all?
 *
 * These routes query with the service role, which bypasses RLS, and they take
 * the workspace id straight from the URL. `requireTeamAuth` running first is
 * therefore the entire boundary, and the interesting caller is not a stranger
 * but a *client*: `user_client_a` is a real, signed-in member of the workspace
 * named in every URL below. Membership opens the client editor. It must not
 * open the operator surface, where the same id also reaches billing, the
 * deploy agent and the job ledger.
 *
 * The cases assert a negative as well as the status: not one table is touched
 * on the way to the refusal. A 403 that had already read the workspace row
 * would be a green test and a live leak.
 *
 * The `/api/admin/*` and `/api/team/*` trees are twins: several route files
 * are byte-identical and the rest re-export the same shared handler, so the
 * same list is run against both, from `../../../../__tests__/operator-route-cases`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
// Static imports: vi.mock is hoisted above them, and the app's tsconfig does
// not allow top-level await in tests. One import per route.ts in this tree,
// so an uncovered route shows up here as a missing line, and
// `src/app/api/__tests__/tenant-route-coverage.test.ts` fails the build if one
// ever is.
import { POST as GENERATE_COPY } from '../ai/generate-copy/route';
import { POST as ACTIVATE_SUBSCRIPTION } from '../billing/activate-subscription/route';
import { POST as CANCEL_SUBSCRIPTION } from '../billing/cancel-subscription/route';
import { POST as DEPOSIT_INVOICE } from '../billing/deposit-invoice/route';
import { POST as FINAL_INVOICE } from '../billing/final-invoice/route';
import { POST as PORTAL_LINK } from '../billing/portal-link/route';
import { GET as LIST_CHANGES } from '../changes/route';
import { POST as QUOTE_CHANGE } from '../changes/[changeId]/quote/route';
import { POST as SET_CHANGE_STATUS } from '../changes/[changeId]/status/route';
import { GET as PIPELINE_DETAIL } from '../pipeline/route';
import { POST as CANCEL_JOB } from '../pipeline/cancel-job/route';
import { GET as JOB_EVENTS } from '../pipeline/jobs/[jobId]/events/route';
import { GET as JOB_LOG } from '../pipeline/jobs/[jobId]/log/route';
import { POST as JOB_NOTE } from '../pipeline/jobs/[jobId]/notes/route';
import { POST as REDISPATCH } from '../pipeline/redispatch/route';
import { POST as OVERRIDE_STATE } from '../pipeline/state/route';
import {
  GET as LIST_PRODUCTS,
  POST as CREATE_PRODUCT,
} from '../products/route';
import {
  PATCH as UPDATE_PRODUCT,
  DELETE as DELETE_PRODUCT,
} from '../products/[productId]/route';
import {
  GET as GET_PROJECT,
  PATCH as UPDATE_PROJECT,
  DELETE as DELETE_PROJECT,
} from '../route';
import { GET as GET_SITE, POST as ALLOCATE_SITE } from '../site/route';
import { POST as DEPLOY_SITE } from '../site/deploy/route';
import {
  POST as ADD_DOMAIN,
  DELETE as REMOVE_DOMAIN,
} from '../site/domains/route';
import { createRecordingSupabase } from '../../../../__tests__/recording-supabase';
import {
  expectRejectsForeignWorkspace,
  expectRejectsSignedOut,
  type RouteCase,
} from '../../../../__tests__/operator-route-cases';

vi.mock('server-only', () => ({}));

const WORKSPACE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const CHANGE_REQUEST = '44444444-4444-4444-8444-444444444444';
const JOB = '55555555-5555-4555-8555-555555555555';
const PRODUCT = '66666666-6666-4666-8666-666666666666';

// ── Clerk ──────────────────────────────────────────────────────────────────
// Mirrors src/lib/__tests__/workspace-access.test.ts: `role` undefined is a
// signed-in client, which is exactly the caller these cases are about.
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

const db = createRecordingSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
  createSupabaseServerClient: () => db.client,
}));

// `../route` builds its own client from the service key rather than going
// through `@/supabase-clients/server`. Same recorder behind it, so "nothing
// was read" still means nothing was read.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => db.client,
}));

function post(url: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        }),
  });
}

function patch(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function del(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: 'DELETE' });
}

function get(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

const project = { params: Promise.resolve({ id: WORKSPACE }) };
const change = {
  params: Promise.resolve({ id: WORKSPACE, changeId: CHANGE_REQUEST }),
};
const job = { params: Promise.resolve({ id: WORKSPACE, jobId: JOB }) };
const product = {
  params: Promise.resolve({ id: WORKSPACE, productId: PRODUCT }),
};

/**
 * One entry per exported handler in this tree. Params are always valid and
 * bodies are always well formed, so a 403 can only have come from the auth
 * check and never from a validator that happened to fire first.
 */
function everyOperatorRoute(): RouteCase[] {
  const base = `/api/admin/projects/${WORKSPACE}`;
  return [
    [
      'ai/generate-copy',
      () =>
        GENERATE_COPY(
          post(`${base}/ai/generate-copy`, { description: 'A consultancy' }),
          project
        ),
    ],
    [
      'billing/activate-subscription',
      () =>
        ACTIVATE_SUBSCRIPTION(
          post(`${base}/billing/activate-subscription`, {}),
          project
        ),
    ],
    [
      'billing/cancel-subscription',
      () =>
        CANCEL_SUBSCRIPTION(
          post(`${base}/billing/cancel-subscription`, {}),
          project
        ),
    ],
    [
      'billing/deposit-invoice',
      () =>
        DEPOSIT_INVOICE(post(`${base}/billing/deposit-invoice`, {}), project),
    ],
    [
      'billing/final-invoice',
      () => FINAL_INVOICE(post(`${base}/billing/final-invoice`, {}), project),
    ],
    [
      'billing/portal-link',
      () => PORTAL_LINK(post(`${base}/billing/portal-link`, {}), project),
    ],
    ['changes', () => LIST_CHANGES(get(`${base}/changes`), project)],
    [
      'changes/[changeId]/quote',
      () =>
        QUOTE_CHANGE(
          post(`${base}/changes/${CHANGE_REQUEST}/quote`, {
            quoteMinor: 12_000,
          }),
          change
        ),
    ],
    [
      'changes/[changeId]/status',
      () =>
        SET_CHANGE_STATUS(
          post(`${base}/changes/${CHANGE_REQUEST}/status`, {
            status: 'declined',
          }),
          change
        ),
    ],
    ['pipeline', () => PIPELINE_DETAIL(get(`${base}/pipeline`), project)],
    [
      'pipeline/cancel-job',
      () =>
        CANCEL_JOB(
          post(`${base}/pipeline/cancel-job`, {
            jobId: JOB,
            reason: 'stuck for an hour',
          }),
          project
        ),
    ],
    [
      'pipeline/jobs/[jobId]/events',
      () => JOB_EVENTS(get(`${base}/pipeline/jobs/${JOB}/events`), job),
    ],
    [
      'pipeline/jobs/[jobId]/log',
      () => JOB_LOG(get(`${base}/pipeline/jobs/${JOB}/log`), job),
    ],
    [
      'pipeline/jobs/[jobId]/notes',
      () =>
        JOB_NOTE(
          post(`${base}/pipeline/jobs/${JOB}/notes`, { note: 'try again' }),
          job
        ),
    ],
    [
      'pipeline/redispatch',
      () => REDISPATCH(post(`${base}/pipeline/redispatch`, {}), project),
    ],
    [
      'pipeline/state',
      () =>
        OVERRIDE_STATE(
          post(`${base}/pipeline/state`, { state: 'building' }),
          project
        ),
    ],
    ['products:list', () => LIST_PRODUCTS(get(`${base}/products`), project)],
    [
      'products:create',
      () =>
        CREATE_PRODUCT(
          post(`${base}/products`, { name: 'A session', price: 100 }),
          project
        ),
    ],
    [
      'products/[productId]:update',
      () =>
        UPDATE_PRODUCT(
          patch(`${base}/products/${PRODUCT}`, { name: 'Renamed' }),
          product
        ),
    ],
    [
      'products/[productId]:delete',
      () => DELETE_PRODUCT(del(`${base}/products/${PRODUCT}`), product),
    ],
    ['project:get', () => GET_PROJECT(get(base), project)],
    [
      'project:update',
      () => UPDATE_PROJECT(patch(base, { name: 'Mine' }), project),
    ],
    ['project:delete', () => DELETE_PROJECT(del(base), project)],
    ['site:get', () => GET_SITE(get(`${base}/site`), project)],
    [
      'site:allocate',
      () =>
        ALLOCATE_SITE(post(`${base}/site`, { server_id: 'host-1' }), project),
    ],
    [
      'site/deploy',
      () =>
        DEPLOY_SITE(
          post(`${base}/site/deploy`, {
            artifact_url: 'https://artifacts.test/site.tar.gz',
          }),
          project
        ),
    ],
    [
      'site/domains:add',
      () =>
        ADD_DOMAIN(
          post(`${base}/site/domains`, { domain: 'example.com' }),
          project
        ),
    ],
    [
      'site/domains:remove',
      () =>
        REMOVE_DOMAIN(del(`${base}/site/domains?domain=example.com`), project),
    ],
  ];
}

beforeEach(() => {
  db.reset();
  authState.userId = 'user_client_a';
  authState.role = undefined;
  // Set so that a route which got past the auth check would fail on something
  // else rather than on a missing key, and the case would still be honest.
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
});

describe('a workspace that is not yours to operate', () => {
  it('is 403 on every /api/admin/projects/[id] route, and nothing of it is read', async () => {
    // The caller below is a member of this very workspace. Membership is the
    // client tier; it is not an operator seat.
    await expectRejectsForeignWorkspace(everyOperatorRoute(), db, authState);
  });

  it('asks a signed-out caller to sign in instead', async () => {
    await expectRejectsSignedOut(everyOperatorRoute(), db, authState);
  });

  it('covers every route.ts in the tree', () => {
    // A guard on the guard: the list above is what the two cases run, so a
    // route added without an entry has to change this number too, and the
    // walker test says which file is missing.
    expect(everyOperatorRoute()).toHaveLength(28);
  });
});
