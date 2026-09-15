import 'server-only';
/**
 * The operator editor, once, for both `/api/admin/*` and `/api/team/*` (the
 * route files re-export these handlers, as every other operator surface does).
 *
 * Three verbs and a read:
 *
 *   GET    /projects/[id]/editor        what is open, and its history
 *   POST   /projects/[id]/editor        open a session, get the hand-over URL
 *   POST   /projects/[id]/editor/ship   commit the worktree and queue the build
 *   DELETE /projects/[id]/editor        close the session without shipping
 *
 * The hand-over deserves its own note, because it is the one place credentials
 * move. `POST` answers with a one-minute Clerk sign-in ticket appended to the
 * editor URL, and that URL is built by
 * `decideOperatorEditorDestination(workspaces.slug)` — from a column this
 * server read, never from anything in the request. The public
 * `/api/auth/transfer-token` route is untouched and still refuses tenant hosts
 * outright, which is correct: a page on a client's site asking for a ticket is
 * the attack that policy exists for. This route is not that caller. It has
 * already run `requireTeamAuth`, it has already decided which workspace, and
 * it proposes the destination itself.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { clerkClient } from '@clerk/nextjs/server';
import { requireTeamAuth } from '@/lib/api-auth';
import type { Json } from '@/lib/database.types';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { loadWorkspaceSite } from './site-editor';
import {
  OperatorEditorError,
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
  shipOperatorEditorSession,
  type OperatorEditorSessionView,
} from './operator-editor';
import {
  EditorHostError,
  forgetEditorSession,
  materializeEditorWorktree,
  shipEditorWorktree,
} from './operator-editor-host';
import { dispatchAgentJob } from './pipeline/dispatch';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** How long the hand-over ticket is good for. Same 60s the transfer routes use. */
const TICKET_LIFETIME_SECONDS = 60;

type Ctx = { params: Promise<{ id: string }> };

function fail(message: string, code: string, status: number) {
  return NextResponse.json({ error: message, code }, { status });
}

/**
 * A response carrying a sign-in ticket is a response carrying a credential.
 * Same seal the transfer routes put on theirs.
 */
function sealed(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

async function operator(ctx: Ctx) {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return { ok: false as const, response: auth.response };
  const params = await ctx.params;
  if (!UUID.test(params.id)) {
    return {
      ok: false as const,
      response: fail('Invalid workspace id', 'BAD_REQUEST', 400),
    };
  }
  return {
    ok: true as const,
    userId: auth.userId,
    workspaceId: params.id,
    db: createSupabaseServiceRoleClient(),
  };
}

function handle(error: unknown): NextResponse {
  if (
    error instanceof OperatorEditorError ||
    error instanceof EditorHostError
  ) {
    return fail(error.message, error.code, error.status);
  }
  console.error('[operator-editor] request failed:', error);
  return fail('Could not reach the editor for this project', 'DB_ERROR', 500);
}

async function recordEvent(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  row: { workspaceId: string; kind: string; actor: string; payload: Json }
) {
  const { error } = await db.from('project_events').insert({
    workspace_id: row.workspaceId,
    kind: row.kind,
    actor: row.actor,
    payload: row.payload,
  });
  if (error)
    console.error(`[operator-editor] could not write ${row.kind}:`, error);
}

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

async function workspaceRow(db: Db, workspaceId: string) {
  const { data, error } = await db
    .from('workspaces')
    .select('id, slug, project_state')
    .eq('id', workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export interface OperatorEditorState {
  open: OperatorEditorSessionView | null;
  history: OperatorEditorSessionView[];
  currentVersion: number;
  /** True when the project state allows opening one at all. */
  canOpen: boolean;
}

async function readState(
  db: Db,
  workspaceId: string
): Promise<OperatorEditorState> {
  const [rows, currentVersion, workspace] = await Promise.all([
    listOperatorSessions(db, workspaceId),
    currentSiteVersion(db, workspaceId),
    workspaceRow(db, workspaceId),
  ]);
  const views = rows.map((row) => operatorSessionView(row, currentVersion));
  const open =
    views.find((view) =>
      ['opening', 'ready', 'shipping'].includes(view.status)
    ) ?? null;
  return {
    open,
    history: views.filter((view) => view.id !== open?.id),
    currentVersion,
    canOpen:
      workspace !== null &&
      ['HUMAN_QA', 'LIVE_SUBSCRIPTION'].includes(workspace.project_state),
  };
}

// ─── GET /projects/[id]/editor ──────────────────────────────────────────────

export async function operatorEditorStateHandler(
  _req: NextRequest,
  ctx: Ctx
): Promise<NextResponse> {
  const op = await operator(ctx);
  if (!op.ok) return op.response;
  try {
    return NextResponse.json(await readState(op.db, op.workspaceId));
  } catch (error) {
    return handle(error);
  }
}

// ─── POST /projects/[id]/editor — open ──────────────────────────────────────

/**
 * Opens the workspace's site in the editor and hands the operator over.
 *
 * Order matters and is the whole of the error handling:
 *
 *   1. Write the session row, in `opening`. A host call that fails after this
 *      leaves a row saying so; the other order leaves a worktree on a box that
 *      nothing in the database knows about.
 *   2. Read the published manifest — the same bytes the build worker seeds
 *      from, through the same loader the client's own editor reads.
 *   3. Ask the host to materialise it. This is a copy, always: nothing the
 *      operator types touches the client's live files or their manifest.
 *   4. Mint the ticket last, so a credential is never issued for a session
 *      that does not exist.
 */
export async function openOperatorEditorHandler(
  _req: NextRequest,
  ctx: Ctx
): Promise<NextResponse> {
  const op = await operator(ctx);
  if (!op.ok) return op.response;
  try {
    const workspace = await workspaceRow(op.db, op.workspaceId);
    if (!workspace) return fail('Project not found', 'NOT_FOUND', 404);

    const opened = await openOperatorEditorSession({
      supabase: op.db,
      workspaceId: op.workspaceId,
      operatorId: op.userId,
      projectState: workspace.project_state,
      slug: workspace.slug,
    });
    const session = opened.session;

    // An existing `ready` session already has its worktree; re-materialising
    // it would throw away whatever the operator (or a colleague) has done in
    // it since. Joining means joining.
    if (opened.created || session.status === 'opening') {
      try {
        const site = await loadWorkspaceSite(op.workspaceId);
        const materialized = await materializeEditorWorktree({
          sessionId: session.id,
          slug: workspace.slug,
          baseVersion: session.base_version,
          files: site.files,
        });
        await markSessionReady({
          supabase: op.db,
          sessionId: session.id,
          worktreePath: materialized.worktreePath,
          baseCommitSha: materialized.commitSha,
          containerId: null,
        });
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : 'Unknown editor host failure';
        await markSessionOpenFailed({
          supabase: op.db,
          sessionId: session.id,
          detail,
        });
        return handle(error);
      }
    }

    const url = await handOverUrl(session.editor_url, op.userId);

    await recordEvent(op.db, {
      workspaceId: op.workspaceId,
      kind: 'operator_editor_opened',
      actor: op.userId,
      payload: {
        sessionId: session.id,
        baseVersion: session.base_version,
        joined: !opened.created,
      },
    });

    const state = await readState(op.db, op.workspaceId);
    return sealed({ ...state, url, joined: !opened.created });
  } catch (error) {
    return handle(error);
  }
}

/**
 * The editor URL with a one-minute Clerk sign-in ticket on it.
 *
 * The ticket is minted here rather than through `/api/auth/transfer-token`
 * because that route's job is to vet a URL a browser proposed, and this URL
 * was not proposed by anyone: it was derived from the workspace row. A ticket
 * that cannot be minted is not fatal — the operator can still sign in at the
 * editor normally — so the bare URL is returned rather than an error.
 */
async function handOverUrl(
  editorUrl: string | null,
  userId: string
): Promise<string | null> {
  if (!editorUrl) return null;
  try {
    const clerk = await clerkClient();
    const ticket = await clerk.signInTokens.createSignInToken({
      userId,
      expiresInSeconds: TICKET_LIFETIME_SECONDS,
    });
    const url = new URL(editorUrl);
    url.searchParams.set('__clerk_ticket', ticket.token);
    return url.toString();
  } catch (error) {
    console.warn(
      '[operator-editor] could not mint a hand-over ticket; sending the ' +
        'plain editor URL instead:',
      error instanceof Error ? error.message : error
    );
    return editorUrl;
  }
}

// ─── POST /projects/[id]/editor/ship ────────────────────────────────────────

const shipSchema = z.object({
  /** One line for the build conversation. Never part of the commit subject. */
  note: z.string().trim().max(500).optional().default(''),
});

/**
 * Ships the open session: commit, store, enqueue, nudge.
 *
 * Nothing here decides whether the work is good. The commit message comes from
 * the build commit policy, the manifest goes on the session row, and
 * OPERATOR_EDIT_BUILD runs every output gate over the bytes that would be
 * deployed. A gate that refuses fails the job, writes its plain words onto the
 * session, and leaves the site exactly as the client last saw it — the
 * operator fixes it in the editor they are still sitting in and ships again.
 */
export async function shipOperatorEditorHandler(
  req: NextRequest,
  ctx: Ctx
): Promise<NextResponse> {
  const op = await operator(ctx);
  if (!op.ok) return op.response;
  const parsed = shipSchema.safeParse(
    (await req.json().catch(() => ({}))) ?? {}
  );
  if (!parsed.success) {
    return fail('Send an optional one-line note.', 'INVALID_BODY', 400);
  }
  try {
    const workspace = await workspaceRow(op.db, op.workspaceId);
    if (!workspace) return fail('Project not found', 'NOT_FOUND', 404);

    const session = await openSessionFor(op.db, op.workspaceId);
    if (!session) {
      return fail(
        'There is no open editor session on this project to ship.',
        'NO_OPEN_SESSION',
        409
      );
    }
    const version = await currentSiteVersion(op.db, op.workspaceId);
    assertSessionShippable({
      session,
      projectState: workspace.project_state,
      currentVersion: version,
    });

    const shipped = await shipEditorWorktree({
      sessionId: session.id,
      message: operatorSessionCommitMessage(op.workspaceId),
    });
    const queued = await shipOperatorEditorSession({
      supabase: op.db,
      workspaceId: op.workspaceId,
      session,
      files: shipped.files,
      commitSha: shipped.commitSha,
      note: parsed.data.note || null,
    });

    // The ledger row is the commitment; this is a nudge. An unreachable worker
    // leaves a queued job an operator can re-dispatch, which is far better
    // than failing a ship that is already recorded.
    let dispatched = false;
    try {
      await dispatchAgentJob(queued.jobId);
      dispatched = true;
    } catch (error) {
      console.warn(
        '[operator-editor] could not nudge the build worker:',
        error instanceof Error ? error.message : error
      );
    }

    await recordEvent(op.db, {
      workspaceId: op.workspaceId,
      kind: 'operator_editor_shipped',
      actor: op.userId,
      payload: {
        sessionId: session.id,
        jobId: queued.jobId,
        baseVersion: session.base_version,
        files: shipped.files.length,
        commitSha: shipped.commitSha,
        dispatched,
      },
    });

    const state = await readState(op.db, op.workspaceId);
    return NextResponse.json({
      ...state,
      jobId: queued.jobId,
      dispatched,
      files: shipped.files.length,
    });
  } catch (error) {
    return handle(error);
  }
}

// ─── DELETE /projects/[id]/editor — close ───────────────────────────────────

export async function closeOperatorEditorHandler(
  _req: NextRequest,
  ctx: Ctx
): Promise<NextResponse> {
  const op = await operator(ctx);
  if (!op.ok) return op.response;
  try {
    const session = await openSessionFor(op.db, op.workspaceId);
    if (!session) {
      return fail(
        'There is no open editor session on this project to close.',
        'NO_OPEN_SESSION',
        409
      );
    }
    await closeOperatorEditorSession({
      supabase: op.db,
      workspaceId: op.workspaceId,
      sessionId: session.id,
    });
    // Best effort, and after the row is closed: a host that cannot be reached
    // must not stop the next Open, and the next materialise overwrites the
    // stale worktree anyway.
    await forgetEditorSession(session.id);
    await recordEvent(op.db, {
      workspaceId: op.workspaceId,
      kind: 'operator_editor_closed',
      actor: op.userId,
      payload: { sessionId: session.id },
    });
    return NextResponse.json(await readState(op.db, op.workspaceId));
  } catch (error) {
    return handle(error);
  }
}
