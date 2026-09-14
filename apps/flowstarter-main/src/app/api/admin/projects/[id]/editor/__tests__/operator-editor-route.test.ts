// @vitest-environment node
/**
 * The operator's "Open in editor" and "Ship this" actions, end to end through
 * the real handlers.
 *
 * Three things are asserted here and nowhere else:
 *
 *   - a non-operator gets nothing, on every verb;
 *   - the hand-over URL is built from `workspaces.slug` and carries a ticket,
 *     and the request body cannot influence where it points;
 *   - shipping goes through the gates by construction — it writes a queued
 *     OPERATOR_EDIT_BUILD and publishes nothing itself.
 *
 * The `/team` twin is exercised from the same file, because the two trees are
 * one set of handlers and a test that only covers one is a test that would not
 * notice them drifting apart.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const authState = vi.hoisted(() => ({
  userId: 'user_operator' as string | null,
  role: 'team' as string | undefined,
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({
    userId: authState.userId,
    sessionClaims: authState.role ? { metadata: { role: authState.role } } : {},
    getToken: async () => 'test-token',
  }),
  currentUser: async () => null,
  clerkClient: async () => ({
    signInTokens: {
      createSignInToken: async () => ({ token: 'ticket-abc' }),
    },
  }),
}));

const host = vi.hoisted(() => ({
  materialize: vi.fn(),
  ship: vi.fn(),
  forget: vi.fn(),
}));

vi.mock('@/lib/flowstarter/operator-editor-host', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/flowstarter/operator-editor-host')
  >('@/lib/flowstarter/operator-editor-host');
  return {
    ...actual,
    materializeEditorWorktree: host.materialize,
    shipEditorWorktree: host.ship,
    forgetEditorSession: host.forget,
  };
});

const dispatch = vi.hoisted(() => ({ nudge: vi.fn() }));
vi.mock('@/lib/flowstarter/pipeline/dispatch', () => ({
  dispatchAgentJob: dispatch.nudge,
  DispatchError: class extends Error {},
}));

vi.mock('@/lib/flowstarter/site-editor', () => ({
  loadWorkspaceSite: async () => ({
    files: [{ path: 'src/pages/index.astro', content: '<h1>Acme</h1>' }],
    version: 4,
  }),
}));

import { createFakeSupabase } from '@/lib/flowstarter/__tests__/fake-supabase';

const db = createFakeSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

import {
  DELETE as adminDelete,
  GET as adminGet,
  POST as adminPost,
} from '../route';
import { POST as adminShip } from '../ship/route';
import { POST as teamPost } from '@/app/api/team/projects/[id]/editor/route';

const WORKSPACE = '2f2c9a10-0c4b-4a9e-9b9c-7e9b6f0a1111';
const ctx = { params: Promise.resolve({ id: WORKSPACE }) };
/** The one thing every handler reads off the request: its JSON body. */
const request = (body?: unknown) =>
  ({ json: async () => body ?? {} } as unknown as NextRequest);

function seedLiveProject() {
  db.seed('workspaces', [
    { id: WORKSPACE, slug: 'acme', project_state: 'LIVE_SUBSCRIPTION' },
  ]);
  db.seed('site_versions', [{ workspace_id: WORKSPACE, version: 4 }]);
}

beforeEach(() => {
  db.reset();
  authState.userId = 'user_operator';
  authState.role = 'team';
  host.materialize.mockReset().mockResolvedValue({
    worktreePath: '/workspaces/acme',
    commitSha: 'base123',
    fileCount: 1,
  });
  host.ship.mockReset().mockResolvedValue({
    commitSha: 'ship456',
    changed: true,
    files: [{ path: 'src/pages/index.astro', content: '<h1>Acme</h1>' }],
  });
  host.forget.mockReset().mockResolvedValue(undefined);
  dispatch.nudge.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('PLATFORM_DOMAIN', 'flowstarter.net');
  vi.stubEnv('FLOWSTARTER_ENV', 'production');
});

describe('authorization', () => {
  it('refuses anyone who is not on the team, on every verb', async () => {
    authState.role = 'user';
    for (const handler of [adminGet, adminPost, adminDelete, adminShip]) {
      const res = await handler(request(), ctx);
      expect(res.status).toBe(403);
    }
  });

  it('refuses a signed-out caller', async () => {
    authState.userId = null;
    authState.role = undefined;
    expect((await adminGet(request(), ctx)).status).toBe(401);
  });

  it('refuses a workspace id that is not a UUID', async () => {
    const res = await adminGet(request(), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /editor — open', () => {
  it('cuts a session from the published version and hands over with a ticket', async () => {
    seedLiveProject();
    const res = await adminPost(request(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();

    // The destination is derived from the slug, not from anything sent.
    expect(body.url).toBe(
      'https://acme.flowstarter.net/editor/?__clerk_ticket=ticket-abc'
    );
    expect(body.joined).toBe(false);
    expect(body.open.status).toBe('ready');
    expect(body.open.baseVersion).toBe(4);

    // A response carrying a credential is not cacheable.
    expect(res.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');

    // The host was handed the published manifest, never asked to read ours.
    expect(host.materialize).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'acme', baseVersion: 4 })
    );
    expect(host.materialize.mock.calls[0][0].files).toHaveLength(1);
  });

  it('refuses a project with no delivered site', async () => {
    db.seed('workspaces', [
      { id: WORKSPACE, slug: 'acme', project_state: 'DEPOSIT_PAID' },
    ]);
    const res = await adminPost(request(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('INVALID_PROJECT_STATE');
    expect(host.materialize).not.toHaveBeenCalled();
  });

  it('404s a workspace that does not exist', async () => {
    expect((await adminPost(request(), ctx)).status).toBe(404);
  });

  it('closes the session and reports plainly when the editor host fails', async () => {
    seedLiveProject();
    host.materialize.mockRejectedValue(new Error('editor host is down'));
    const res = await adminPost(request(), ctx);
    expect(res.status).toBe(500);
    // The row does not survive as a session nobody can use.
    expect(db.rows('operator_editor_sessions')[0]!.status).toBe('failed');
    // And the next Open is not blocked by it.
    host.materialize.mockResolvedValue({
      worktreePath: '/workspaces/acme',
      commitSha: 'base123',
      fileCount: 1,
    });
    expect((await adminPost(request(), ctx)).status).toBe(200);
  });

  it('joins a colleague’s open session instead of re-cutting the worktree', async () => {
    seedLiveProject();
    await adminPost(request(), ctx);
    host.materialize.mockClear();
    const res = await adminPost(request(), ctx);
    expect((await res.json()).joined).toBe(true);
    expect(host.materialize).not.toHaveBeenCalled();
  });

  it('answers the same way on the /team twin', async () => {
    seedLiveProject();
    const res = await teamPost(request(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).url).toContain('__clerk_ticket=');
  });
});

describe('POST /editor/ship', () => {
  async function open() {
    seedLiveProject();
    await adminPost(request(), ctx);
  }

  it('commits through the build policy and queues the build, publishing nothing itself', async () => {
    await open();
    const res = await adminShip(
      request({ note: 'added the pricing page' }),
      ctx
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dispatched).toBe(true);
    expect(body.files).toBe(1);

    // The commit subject is the policy's, not free text.
    expect(host.ship).toHaveBeenCalledWith({
      sessionId: expect.any(String),
      message: `build: ship operator editor session to site ${WORKSPACE}`,
    });

    const job = db.rows('flowstarter_agent_jobs')[0]!;
    expect(job.kind).toBe('OPERATOR_EDIT_BUILD');
    expect(job.status).toBe('queued');
    expect(dispatch.nudge).toHaveBeenCalledWith(job.id);

    // Nothing was published here: no version was written, and the site the
    // client is looking at is untouched until the worker's gates pass.
    expect(db.rows('site_versions')).toHaveLength(1);
    expect(db.rows('operator_editor_sessions')[0]!.status).toBe('shipping');
  });

  it('still queues when the worker cannot be nudged', async () => {
    await open();
    dispatch.nudge.mockRejectedValue(new Error('worker unreachable'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = await (await adminShip(request(), ctx)).json();
    expect(body.dispatched).toBe(false);
    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(1);
  });

  it('refuses when the client published while the session was open', async () => {
    await open();
    db.rows('site_versions').push({ workspace_id: WORKSPACE, version: 5 });
    const res = await adminShip(request(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SESSION_BASE_STALE');
    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(0);
  });

  it('refuses with no open session', async () => {
    seedLiveProject();
    const res = await adminShip(request(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NO_OPEN_SESSION');
  });

  it('refuses a note longer than the record should carry', async () => {
    await open();
    const res = await adminShip(request({ note: 'x'.repeat(501) }), ctx);
    expect(res.status).toBe(400);
  });

  it('404s a workspace that does not exist', async () => {
    expect((await adminShip(request(), ctx)).status).toBe(404);
  });
});

describe('GET and DELETE /editor', () => {
  it('reports the open session and its history', async () => {
    seedLiveProject();
    await adminPost(request(), ctx);
    const body = await (await adminGet(request(), ctx)).json();
    expect(body.canOpen).toBe(true);
    expect(body.currentVersion).toBe(4);
    expect(body.open.status).toBe('ready');
    expect(body.history).toHaveLength(0);
  });

  it('closes the session and tells the host to drop it', async () => {
    seedLiveProject();
    await adminPost(request(), ctx);
    const res = await adminDelete(request(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).open).toBeNull();
    expect(host.forget).toHaveBeenCalled();
    expect(db.rows('operator_editor_sessions')[0]!.status).toBe('closed');
  });

  it('refuses to close when there is nothing open', async () => {
    seedLiveProject();
    expect((await adminDelete(request(), ctx)).status).toBe(409);
  });
});
