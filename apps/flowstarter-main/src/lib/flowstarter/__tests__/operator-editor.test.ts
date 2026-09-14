/**
 * The session rules: who may open one, who may ship one, and the one refusal
 * that costs an operator work — a base the client has published past.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createFakeSupabase, type FakeDb } from './fake-supabase';
import {
  OPEN_SESSION_STATUSES,
  OperatorEditorError,
  assertOperatorEditorAllowed,
  assertSessionShippable,
  closeOperatorEditorSession,
  currentSiteVersion,
  listOperatorSessions,
  markSessionOpenFailed,
  markSessionReady,
  openOperatorEditorSession,
  openSessionFor,
  operatorSessionCommitMessage,
  operatorSessionView,
  sessionHeadline,
  shipOperatorEditorSession,
  type OperatorEditorSessionRow,
} from '../operator-editor';

const WORKSPACE = '2f2c9a10-0c4b-4a9e-9b9c-7e9b6f0a1111';
const OPERATOR = 'user_operator';

let db: FakeDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = () => db.client as any;

function sessionRow(
  overrides: Partial<OperatorEditorSessionRow> = {}
): OperatorEditorSessionRow {
  return {
    id: 'bb0ce0b6-2f22-4c2c-9a5a-1111aaaa2222',
    workspace_id: WORKSPACE,
    operator_id: OPERATOR,
    base_version: 4,
    worktree_path: '/workspaces/acme',
    container_id: null,
    editor_url: 'https://acme.flowstarter.net/editor/',
    base_commit_sha: 'abc1234',
    status: 'ready',
    result_commit_sha: null,
    build_job_id: null,
    shipped_version: null,
    last_error: null,
    created_at: '2026-09-14T10:00:00.000Z',
    updated_at: '2026-09-14T10:00:00.000Z',
    shipped_at: null,
    closed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  db = createFakeSupabase();
  vi.stubEnv('PLATFORM_DOMAIN', 'flowstarter.net');
  vi.stubEnv('FLOWSTARTER_ENV', 'production');
});

describe('assertOperatorEditorAllowed', () => {
  it('refuses a project with no delivered site', () => {
    expect(() =>
      assertOperatorEditorAllowed({
        projectState: 'DEPOSIT_PAID',
        slug: 'acme',
      })
    ).toThrow(OperatorEditorError);
    try {
      assertOperatorEditorAllowed({ projectState: 'INTAKE', slug: 'acme' });
    } catch (error) {
      expect((error as OperatorEditorError).code).toBe('INVALID_PROJECT_STATE');
      expect((error as OperatorEditorError).status).toBe(409);
    }
  });

  it('builds the editor URL from the workspace slug and nothing else', () => {
    expect(
      assertOperatorEditorAllowed({ projectState: 'HUMAN_QA', slug: 'acme' })
        .editorUrl
    ).toBe('https://acme.flowstarter.net/editor/');
    expect(
      assertOperatorEditorAllowed({
        projectState: 'LIVE_SUBSCRIPTION',
        slug: 'acme',
      }).editorUrl
    ).toBe('https://acme.flowstarter.net/editor/');
  });

  it('refuses a workspace with no usable slug', () => {
    for (const slug of [null, '', 'Not A Slug', '../etc']) {
      expect(() =>
        assertOperatorEditorAllowed({ projectState: 'HUMAN_QA', slug })
      ).toThrow(/no editor address/i);
    }
  });
});

describe('assertSessionShippable', () => {
  const ok = {
    session: { status: 'ready', base_version: 4 },
    projectState: 'LIVE_SUBSCRIPTION',
    currentVersion: 4,
  };

  it('allows a ready session on a live project at its own base', () => {
    expect(() => assertSessionShippable(ok)).not.toThrow();
  });

  it('refuses when the client has published past the session base', () => {
    try {
      assertSessionShippable({ ...ok, currentVersion: 5 });
      throw new Error('should have refused');
    } catch (error) {
      expect((error as OperatorEditorError).code).toBe('SESSION_BASE_STALE');
      // The message has to say what happened and what to do, because the
      // operator is about to lose work if they force it.
      expect((error as OperatorEditorError).message).toContain('version 4');
      expect((error as OperatorEditorError).message).toContain('version 5');
      expect((error as OperatorEditorError).message).toMatch(/would delete it/);
    }
  });

  it('refuses a second ship while one is already running', () => {
    try {
      assertSessionShippable({
        ...ok,
        session: { status: 'shipping', base_version: 4 },
      });
      throw new Error('should have refused');
    } catch (error) {
      expect((error as OperatorEditorError).code).toBe('ALREADY_SHIPPING');
    }
  });

  it('refuses a session that is not open', () => {
    for (const status of ['opening', 'shipped', 'closed', 'failed']) {
      expect(() =>
        assertSessionShippable({ ...ok, session: { status, base_version: 4 } })
      ).toThrow(/can be shipped/);
    }
  });

  it('refuses when the project has left the states a site can be published in', () => {
    try {
      assertSessionShippable({ ...ok, projectState: 'AGENTS_WORKING' });
      throw new Error('should have refused');
    } catch (error) {
      expect((error as OperatorEditorError).code).toBe('INVALID_PROJECT_STATE');
    }
  });
});

describe('sessionHeadline / operatorSessionView', () => {
  it('leads with the stale warning over everything else an open session says', () => {
    const view = operatorSessionView(sessionRow({ base_version: 2 }), 7);
    expect(view.stale).toBe(true);
    expect(view.headline).toContain('published version 7');
    expect(view.headline).toContain('cut from version 2');
  });

  it('does not call a shipped session stale, however far the site has moved', () => {
    const view = operatorSessionView(
      sessionRow({ status: 'shipped', base_version: 2, shipped_version: 3 }),
      9
    );
    expect(view.stale).toBe(false);
    expect(view.headline).toBe('Shipped. Live in version 3.');
  });

  it('repeats the gate’s own words when the last ship did not pass', () => {
    const view = operatorSessionView(
      sessionRow({ last_error: 'The build left an image element empty.' }),
      4
    );
    expect(view.headline).toContain('The build left an image element empty.');
  });

  it('says where an unshipped session came from', () => {
    expect(
      operatorSessionView(sessionRow({ base_version: 0 }), 0).headline
    ).toContain('the site as delivered');
    expect(
      operatorSessionView(sessionRow({ base_version: 3 }), 3).headline
    ).toContain('version 3');
    expect(
      operatorSessionView(sessionRow({ status: 'opening' }), 4).headline
    ).toMatch(/Setting the worktree up/);
    expect(
      operatorSessionView(sessionRow({ status: 'shipping' }), 4).headline
    ).toMatch(/every gate/);
    expect(
      operatorSessionView(sessionRow({ status: 'closed' }), 4).headline
    ).toBe('Closed without shipping.');
    expect(
      operatorSessionView(sessionRow({ status: 'failed' }), 4).headline
    ).toMatch(/did not pass/);
  });

  it('falls back to a closed reading for a status nobody has defined', () => {
    expect(operatorSessionView(sessionRow({ status: 'wat' }), 4).status).toBe(
      'closed'
    );
    expect(
      sessionHeadline({
        status: 'shipped',
        stale: false,
        baseVersion: 1,
        currentVersion: 1,
        shippedVersion: null,
        lastError: null,
      })
    ).toBe('Shipped.');
    expect(
      sessionHeadline({
        status: 'failed',
        stale: false,
        baseVersion: 1,
        currentVersion: 1,
        shippedVersion: null,
        lastError: null,
      })
    ).toBe('The last attempt to ship did not pass.');
  });
});

describe('operatorSessionCommitMessage', () => {
  it('goes through the build commit policy, so the worker cannot refuse it later', () => {
    expect(operatorSessionCommitMessage(WORKSPACE)).toBe(
      `build: ship operator editor session to site ${WORKSPACE}`
    );
  });

  it('refuses a project id that is not a UUID rather than writing it', () => {
    expect(() => operatorSessionCommitMessage('not-a-uuid')).toThrow();
  });
});

describe('openOperatorEditorSession', () => {
  it('records the session in `opening` against the current version', async () => {
    db.seed('site_versions', [{ workspace_id: WORKSPACE, version: 6 }]);
    const result = await openOperatorEditorSession({
      supabase: supabase(),
      workspaceId: WORKSPACE,
      operatorId: OPERATOR,
      projectState: 'HUMAN_QA',
      slug: 'acme',
    });
    expect(result.created).toBe(true);
    expect(result.session.status).toBe('opening');
    expect(result.session.base_version).toBe(6);
    expect(result.session.editor_url).toBe(
      'https://acme.flowstarter.net/editor/'
    );
  });

  it('joins the session a colleague already has open rather than cutting a second worktree', async () => {
    db.seed('operator_editor_sessions', [
      sessionRow({ operator_id: 'user_someone_else' }) as unknown as Record<
        string,
        unknown
      >,
    ]);
    const result = await openOperatorEditorSession({
      supabase: supabase(),
      workspaceId: WORKSPACE,
      operatorId: OPERATOR,
      projectState: 'HUMAN_QA',
      slug: 'acme',
    });
    expect(result.created).toBe(false);
    expect(result.session.operator_id).toBe('user_someone_else');
    expect(db.rows('operator_editor_sessions')).toHaveLength(1);
  });

  it('treats a workspace with no versions yet as base 0', async () => {
    expect(await currentSiteVersion(supabase(), WORKSPACE)).toBe(0);
  });
});

describe('markSessionReady / markSessionOpenFailed', () => {
  it('moves an opening session to ready with what the host answered', async () => {
    db.seed('operator_editor_sessions', [
      sessionRow({ status: 'opening', worktree_path: null }) as never,
    ]);
    await markSessionReady({
      supabase: supabase(),
      sessionId: sessionRow().id,
      worktreePath: '/workspaces/acme',
      baseCommitSha: 'deadbee',
      containerId: 'editor',
    });
    const row = db.rows('operator_editor_sessions')[0]!;
    expect(row.status).toBe('ready');
    expect(row.worktree_path).toBe('/workspaces/acme');
    expect(row.base_commit_sha).toBe('deadbee');
  });

  it('closes a session the host could never give a worktree to', async () => {
    db.seed('operator_editor_sessions', [
      sessionRow({ status: 'opening' }) as never,
    ]);
    await markSessionOpenFailed({
      supabase: supabase(),
      sessionId: sessionRow().id,
      detail: 'the editor host did not answer',
    });
    const row = db.rows('operator_editor_sessions')[0]!;
    expect(row.status).toBe('failed');
    expect(row.closed_at).toBeTruthy();
    // Closed, not left at `opening`: the index would otherwise refuse the
    // next Open and an operator would be stuck with a session that will never
    // become ready.
    expect(OPEN_SESSION_STATUSES).not.toContain(row.status as never);
  });
});

describe('shipOperatorEditorSession', () => {
  const files = [{ path: 'src/pages/index.astro', content: '<h1>Hi</h1>' }];

  beforeEach(() => {
    db.seed('operator_editor_sessions', [sessionRow() as never]);
  });

  it('stores the manifest on the session, not in the job payload', async () => {
    const result = await shipOperatorEditorSession({
      supabase: supabase(),
      workspaceId: WORKSPACE,
      session: sessionRow(),
      files,
      commitSha: 'cafe123',
      note: 'added the pricing page',
    });
    expect(result.created).toBe(true);

    const session = db.rows('operator_editor_sessions')[0]!;
    expect(session.status).toBe('shipping');
    expect(session.result_manifest).toEqual({ files });
    expect(session.result_commit_sha).toBe('cafe123');
    expect(session.build_job_id).toBe(result.jobId);

    const job = db.rows('flowstarter_agent_jobs')[0]!;
    expect(job.kind).toBe('OPERATOR_EDIT_BUILD');
    expect(job.status).toBe('queued');
    const payload = job.payload as { operatorEdit: Record<string, unknown> };
    expect(payload.operatorEdit.sessionId).toBe(sessionRow().id);
    expect(payload.operatorEdit.baseVersion).toBe(4);
    expect(payload.operatorEdit.note).toBe('added the pricing page');
    // The bytes are not on the job.
    expect(JSON.stringify(job.payload)).not.toContain('<h1>Hi</h1>');
  });

  it('refuses an empty worktree rather than publishing nothing over a live site', async () => {
    await expect(
      shipOperatorEditorSession({
        supabase: supabase(),
        workspaceId: WORKSPACE,
        session: sessionRow(),
        files: [],
        commitSha: null,
        note: null,
      })
    ).rejects.toThrow(/nothing to ship/i);
  });

  it('refuses a worktree far larger than a site', async () => {
    const many = Array.from({ length: 3_001 }, (_, index) => ({
      path: `src/pages/p${index}.astro`,
      content: 'x',
    }));
    await expect(
      shipOperatorEditorSession({
        supabase: supabase(),
        workspaceId: WORKSPACE,
        session: sessionRow(),
        files: many,
        commitSha: null,
        note: null,
      })
    ).rejects.toThrow(/not site source/i);
  });

  it('refuses when the session is no longer ready, so two operators make one build', async () => {
    db.reset();
    db.seed('operator_editor_sessions', [
      sessionRow({ status: 'shipping' }) as never,
    ]);
    await expect(
      shipOperatorEditorSession({
        supabase: supabase(),
        workspaceId: WORKSPACE,
        session: sessionRow(),
        files,
        commitSha: null,
        note: null,
      })
    ).rejects.toThrow(/no longer ready/i);
    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(0);
  });
});

describe('closeOperatorEditorSession', () => {
  it('closes an open session', async () => {
    db.seed('operator_editor_sessions', [sessionRow() as never]);
    await closeOperatorEditorSession({
      supabase: supabase(),
      workspaceId: WORKSPACE,
      sessionId: sessionRow().id,
    });
    expect(db.rows('operator_editor_sessions')[0]!.status).toBe('closed');
  });

  it('refuses to close one a build is running against', async () => {
    db.seed('operator_editor_sessions', [
      sessionRow({ status: 'shipping' }) as never,
    ]);
    await expect(
      closeOperatorEditorSession({
        supabase: supabase(),
        workspaceId: WORKSPACE,
        sessionId: sessionRow().id,
      })
    ).rejects.toThrow(/build is running/i);
  });
});

describe('reads', () => {
  it('finds only open sessions, newest first, and lists the rest as history', async () => {
    db.seed('operator_editor_sessions', [
      sessionRow({
        id: 'a',
        status: 'shipped',
        created_at: '2026-09-01',
      }) as never,
      sessionRow({
        id: 'b',
        status: 'ready',
        created_at: '2026-09-10',
      }) as never,
    ]);
    const open = await openSessionFor(supabase(), WORKSPACE);
    expect(open?.id).toBe('b');
    const all = await listOperatorSessions(supabase(), WORKSPACE);
    expect(all.map((row) => row.id)).toEqual(['b', 'a']);
  });

  it('returns null when nothing is open', async () => {
    db.seed('operator_editor_sessions', [
      sessionRow({ status: 'closed' }) as never,
    ]);
    expect(await openSessionFor(supabase(), WORKSPACE)).toBeNull();
  });
});
