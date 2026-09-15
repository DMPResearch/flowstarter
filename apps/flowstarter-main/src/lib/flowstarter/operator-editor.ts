import 'server-only';
/**
 * The operator's side of the editor: opening a session on a client's site,
 * and shipping what comes out of it.
 *
 * The client's side has been live for a while and is deliberately narrow --
 * Words and Pictures, `EDITOR_POLICY` refusing anything structural, and
 * everything larger escalating into a change request somebody quotes. That is
 * the right shape for a client. It is the wrong shape for us. An operator
 * asked for a new page, an integration or a section that does not exist has,
 * until now, had exactly one route: file a change request against themselves
 * and hope one bounded agent pass gets it.
 *
 * `apps/flowstarter-editor` is a real coding agent with a real filesystem, and
 * it was built for exactly this and wired to nothing. This module is the wire.
 *
 * Four rules live here and nowhere else:
 *
 *   1. **A session is cut from the published manifest, never from live files.**
 *      The worktree the operator opens is materialised from the workspace's
 *      newest `site_versions` manifest -- the same bytes the build worker
 *      seeds from -- and it is a copy. Nothing an operator types reaches
 *      `/var/www/sites` or the client's manifest until a build publishes it.
 *   2. **One open session per workspace.** Two operators in two editors on one
 *      site would each be working against the other's stale base, and whoever
 *      shipped second would quietly undo the first. The database index refuses
 *      the second; this module turns that refusal into "join the open one".
 *   3. **A session whose base has moved may not ship.** The client can publish
 *      an edit of their own while a session is open. Shipping over it would
 *      delete their change with no record that it ever happened, so a stale
 *      session is refused and the operator re-opens against the new version.
 *      This is the one rule that costs an operator work, and it is the one
 *      that keeps a client's own edits from disappearing.
 *   4. **Shipping is a build, not a publish.** The ship step commits the
 *      worktree with the build commit policy and enqueues OPERATOR_EDIT_BUILD.
 *      Every output gate runs, on the bytes that would be deployed, and the
 *      gates decide. The operator's session may do anything a coding agent can
 *      do; it still does not decide what ships.
 */
import {
  buildCommitMessage,
  OPERATOR_EDIT_FILES_MAX,
} from '@flowstarter/agentic-codegen';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { decideOperatorEditorDestination } from '@flowstarter/platform-config';
import type { Json } from '@/lib/database.types';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

type SupabaseServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

export class OperatorEditorError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = 'OperatorEditorError';
  }
}

/**
 * Lifecycle states in which a delivered site exists, and so may be opened in
 * the editor. The same two a rebuild and a change build are valid from, for
 * the same reason: before the deposit build has produced a site there is
 * nothing to open.
 */
export const OPERATOR_EDIT_STATES: readonly string[] = [
  ProjectState.HUMAN_QA,
  ProjectState.LIVE_SUBSCRIPTION,
];

export type OperatorSessionStatus =
  | 'opening'
  | 'ready'
  | 'shipping'
  | 'shipped'
  | 'failed'
  | 'closed';

/** Statuses that mean an operator still has this session; only one may exist. */
export const OPEN_SESSION_STATUSES: readonly OperatorSessionStatus[] = [
  'opening',
  'ready',
  'shipping',
];

export interface OperatorEditorSessionRow {
  id: string;
  workspace_id: string;
  operator_id: string;
  base_version: number;
  worktree_path: string | null;
  container_id: string | null;
  editor_url: string | null;
  base_commit_sha: string | null;
  status: string;
  result_commit_sha: string | null;
  build_job_id: string | null;
  shipped_version: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  shipped_at: string | null;
  closed_at: string | null;
}

/**
 * The session as the admin project page reads it.
 *
 * `result_manifest` is deliberately not on it. It is a whole site's worth of
 * source and the page has no use for it; the one reader that does is the build
 * worker, which reads the row directly.
 */
export interface OperatorEditorSessionView {
  id: string;
  operatorId: string;
  status: OperatorSessionStatus;
  baseVersion: number;
  editorUrl: string | null;
  worktreePath: string | null;
  buildJobId: string | null;
  shippedVersion: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  shippedAt: string | null;
  /** True when the client has published since this session was cut. See rule 3. */
  stale: boolean;
  /** One plain line for the page, derived from status + staleness. */
  headline: string;
}

const SESSION_COLUMNS =
  'id, workspace_id, operator_id, base_version, worktree_path, container_id, ' +
  'editor_url, base_commit_sha, status, result_commit_sha, build_job_id, ' +
  'shipped_version, last_error, created_at, updated_at, shipped_at, closed_at';

function asStatus(value: string): OperatorSessionStatus {
  return (
    ['opening', 'ready', 'shipping', 'shipped', 'failed', 'closed'].includes(
      value
    )
      ? value
      : 'closed'
  ) as OperatorSessionStatus;
}

/**
 * What a session is doing, in one sentence an operator can act on.
 *
 * A rule rather than a phrase a component assembles: the same words appear on
 * the project page and in the API response, and a status that reads one way in
 * one place and another way elsewhere is how an operator ends up shipping a
 * session they thought was already live.
 */
export function sessionHeadline(input: {
  status: OperatorSessionStatus;
  stale: boolean;
  baseVersion: number;
  currentVersion: number;
  shippedVersion: number | null;
  lastError: string | null;
}): string {
  if (input.status === 'shipped') {
    return input.shippedVersion
      ? `Shipped. Live in version ${input.shippedVersion}.`
      : 'Shipped.';
  }
  if (input.status === 'shipping') {
    return 'Shipping. The build is running every gate before this goes live.';
  }
  if (input.status === 'closed') return 'Closed without shipping.';
  if (input.status === 'failed') {
    return input.lastError
      ? `The last attempt to ship did not pass: ${input.lastError}`
      : 'The last attempt to ship did not pass.';
  }
  if (input.stale) {
    return (
      `The client published version ${input.currentVersion} while this ` +
      `session was open, and it was cut from version ${input.baseVersion}. ` +
      'Shipping it now would delete their change. Close this session and ' +
      'open a new one.'
    );
  }
  if (input.lastError) {
    return `The last attempt to ship did not pass: ${input.lastError}`;
  }
  if (input.status === 'opening') {
    return 'Setting the worktree up on the editor host.';
  }
  return `Open, cut from ${
    input.baseVersion > 0
      ? `version ${input.baseVersion}`
      : 'the site as delivered'
  }.`;
}

export function operatorSessionView(
  row: OperatorEditorSessionRow,
  currentVersion: number
): OperatorEditorSessionView {
  const status = asStatus(row.status);
  // Only a session somebody still holds can be stale. A shipped one recorded
  // its base at the time and re-reading it against today's version would make
  // history look wrong the moment the client edits anything.
  const stale =
    OPEN_SESSION_STATUSES.includes(status) && currentVersion > row.base_version;
  return {
    id: row.id,
    operatorId: row.operator_id,
    status,
    baseVersion: row.base_version,
    editorUrl: row.editor_url,
    worktreePath: row.worktree_path,
    buildJobId: row.build_job_id,
    shippedVersion: row.shipped_version,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    shippedAt: row.shipped_at,
    stale,
    headline: sessionHeadline({
      status,
      stale,
      baseVersion: row.base_version,
      currentVersion,
      shippedVersion: row.shipped_version,
      lastError: row.last_error,
    }),
  };
}

/** The version the site is at right now, or 0 before any edit was ever saved. */
export async function currentSiteVersion(
  supabase: SupabaseServiceClient,
  workspaceId: string
): Promise<number> {
  const { data, error } = await supabase
    .from('site_versions')
    .select('version')
    .eq('workspace_id', workspaceId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.version ?? 0;
}

/**
 * The open session for this workspace, or null.
 *
 * Never filtered by operator: a session is the workspace's, not the person's.
 * Two of us should be able to hand one over, and the alternative -- an
 * operator finding "no open session" and opening a second worktree over a
 * colleague's unfinished work -- is exactly what rule 2 forbids.
 */
export async function openSessionFor(
  supabase: SupabaseServiceClient,
  workspaceId: string
): Promise<OperatorEditorSessionRow | null> {
  const { data, error } = await supabase
    .from('operator_editor_sessions')
    .select(SESSION_COLUMNS)
    .eq('workspace_id', workspaceId)
    .in('status', OPEN_SESSION_STATUSES as unknown as string[])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<OperatorEditorSessionRow>();
  if (error) throw error;
  return data ?? null;
}

export async function listOperatorSessions(
  supabase: SupabaseServiceClient,
  workspaceId: string,
  limit = 10
): Promise<OperatorEditorSessionRow[]> {
  const { data, error } = await supabase
    .from('operator_editor_sessions')
    .select(SESSION_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as OperatorEditorSessionRow[];
}

/**
 * Whether this workspace may be opened in the editor at all, and where.
 *
 * Both halves are checked against the server's own rows: the project state,
 * and the slug the editor URL is built from. Nothing a browser sent gets near
 * either, which is what lets `decideOperatorEditorDestination` be the simple
 * rule it is.
 */
export function assertOperatorEditorAllowed(input: {
  projectState: string;
  slug: string | null;
}): { editorUrl: string } {
  if (!OPERATOR_EDIT_STATES.includes(input.projectState)) {
    throw new OperatorEditorError(
      'This project has no delivered site to open yet. The editor can be ' +
        'opened once the site is in human QA or live.',
      'INVALID_PROJECT_STATE',
      409
    );
  }
  const destination = decideOperatorEditorDestination(input.slug);
  if (!destination.allowed) {
    throw new OperatorEditorError(
      'This workspace has no editor address. Its slug is missing or is not ' +
        'one an editor can be served on, so there is nowhere to send you.',
      'NO_EDITOR_ORIGIN',
      409
    );
  }
  return { editorUrl: destination.url };
}

export interface OpenSessionResult {
  session: OperatorEditorSessionRow;
  /** False when an open session already existed and this call joined it. */
  created: boolean;
}

/**
 * Records a new session, or hands back the one that is already open.
 *
 * The row is written *before* the editor host is asked to do anything, in
 * `opening`. A host call that fails then leaves a row saying so, which an
 * operator can see and close; the other order leaves a worktree on a box that
 * nothing in the database knows about.
 */
export async function openOperatorEditorSession(input: {
  supabase: SupabaseServiceClient;
  workspaceId: string;
  operatorId: string;
  projectState: string;
  slug: string | null;
}): Promise<OpenSessionResult> {
  const { supabase, workspaceId } = input;
  const { editorUrl } = assertOperatorEditorAllowed({
    projectState: input.projectState,
    slug: input.slug,
  });

  const existing = await openSessionFor(supabase, workspaceId);
  if (existing) return { session: existing, created: false };

  const baseVersion = await currentSiteVersion(supabase, workspaceId);
  const now = new Date().toISOString();
  const insert = await supabase
    .from('operator_editor_sessions')
    .insert({
      workspace_id: workspaceId,
      operator_id: input.operatorId,
      base_version: baseVersion,
      editor_url: editorUrl,
      status: 'opening',
      updated_at: now,
    })
    .select(SESSION_COLUMNS)
    .single();

  if (insert.error?.code === '23505') {
    // The one-open-session index refused: a colleague pressed Open a moment
    // ago. Joining theirs is the right answer, not an error about a race
    // nobody can see.
    const live = await openSessionFor(supabase, workspaceId);
    if (!live) {
      throw new OperatorEditorError(
        'An editor session is already open for this project but could not be ' +
          'read back. Reload and try again.',
        'SESSION_RACE',
        409
      );
    }
    return { session: live, created: false };
  }
  if (insert.error || !insert.data) {
    throw insert.error ?? new Error('Could not open an editor session');
  }
  return {
    session: insert.data as unknown as OperatorEditorSessionRow,
    created: true,
  };
}

/** Records what the editor host did with the worktree it was handed. */
export async function markSessionReady(input: {
  supabase: SupabaseServiceClient;
  sessionId: string;
  worktreePath: string;
  baseCommitSha: string | null;
  containerId: string | null;
}): Promise<void> {
  const { error } = await input.supabase
    .from('operator_editor_sessions')
    .update({
      status: 'ready',
      worktree_path: input.worktreePath,
      base_commit_sha: input.baseCommitSha,
      container_id: input.containerId,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.sessionId)
    .eq('status', 'opening');
  if (error) throw error;
}

/**
 * Records that the editor host could not give us a worktree.
 *
 * The session is closed rather than left at `opening`: there is nothing on the
 * box to go back to, the index would refuse the next Open, and an operator
 * staring at a session that will never become ready is worse than one who can
 * simply press the button again.
 */
export async function markSessionOpenFailed(input: {
  supabase: SupabaseServiceClient;
  sessionId: string;
  detail: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await input.supabase
    .from('operator_editor_sessions')
    .update({
      status: 'failed',
      last_error: input.detail.slice(0, 2_000),
      closed_at: now,
      updated_at: now,
    })
    .eq('id', input.sessionId)
    .eq('status', 'opening');
}

/**
 * Whether this session may be shipped, and why not when it may not.
 *
 * Pure, so the rule is asserted directly in tests rather than inferred from a
 * route's status codes.
 */
export function assertSessionShippable(input: {
  session: Pick<OperatorEditorSessionRow, 'status' | 'base_version'>;
  projectState: string;
  currentVersion: number;
}): void {
  if (!OPERATOR_EDIT_STATES.includes(input.projectState)) {
    throw new OperatorEditorError(
      'This project is no longer in a state where a site can be published. ' +
        'Nothing was shipped.',
      'INVALID_PROJECT_STATE',
      409
    );
  }
  if (input.session.status === 'shipping') {
    throw new OperatorEditorError(
      'This session is already being shipped. Watch the build on the ' +
        'pipeline tab rather than starting a second one.',
      'ALREADY_SHIPPING',
      409
    );
  }
  if (input.session.status !== 'ready') {
    throw new OperatorEditorError(
      `Only an open, ready session can be shipped; this one is ${input.session.status}.`,
      'SESSION_NOT_READY',
      409
    );
  }
  // Rule 3. The one refusal that costs an operator work, and the one that
  // stops a client's own published edit being deleted by ours.
  if (input.currentVersion > input.session.base_version) {
    throw new OperatorEditorError(
      `This session was cut from version ${input.session.base_version} and ` +
        `the site is now at version ${input.currentVersion}: the client ` +
        'published a change of their own while you were working. Shipping ' +
        'now would delete it. Close this session and open a new one, which ' +
        'will start from their change.',
      'SESSION_BASE_STALE',
      409
    );
  }
}

/** The commit subject the editor host writes when an operator presses Ship. */
export function operatorSessionCommitMessage(projectId: string): string {
  // Through the build commit policy, not beside it. A message the policy would
  // refuse is a message this repository's own commit step would refuse later,
  // and finding that out on the editor host is finding it out in the one place
  // nobody is watching.
  return buildCommitMessage('OPERATOR_EDIT_BUILD', projectId);
}

export interface ShipSessionResult {
  jobId: string;
  /** False when a ship for this workspace was already in flight. */
  created: boolean;
}

/**
 * Stores what the operator shipped and queues exactly one OPERATOR_EDIT_BUILD.
 *
 * The manifest goes on the session row rather than into the job payload. It is
 * a whole site's worth of source; a payload is a jsonb column an operator can
 * edit by hand and that every board query reads back; and the session row is
 * already the thing that has to survive the worktree being idle-reaped, which
 * is the only way a failed build stays diagnosable.
 */
export async function shipOperatorEditorSession(input: {
  supabase: SupabaseServiceClient;
  workspaceId: string;
  session: OperatorEditorSessionRow;
  files: { path: string; content: string; encoding?: 'base64' }[];
  commitSha: string | null;
  note: string | null;
}): Promise<ShipSessionResult> {
  const { supabase, workspaceId, session } = input;
  if (input.files.length === 0) {
    throw new OperatorEditorError(
      'The editor host handed back no files, so there is nothing to ship. ' +
        'The session is left open.',
      'EMPTY_WORKTREE',
      502
    );
  }
  if (input.files.length > OPERATOR_EDIT_FILES_MAX) {
    throw new OperatorEditorError(
      `The worktree holds ${input.files.length} files, more than the ` +
        `${OPERATOR_EDIT_FILES_MAX} a site may ship. Something under the ` +
        'worktree is not site source; remove it and ship again.',
      'WORKTREE_TOO_LARGE',
      409
    );
  }

  const now = new Date().toISOString();
  // The manifest and the status move together, guarded on `ready`, so two
  // operators pressing Ship in the same second produce one shipping session
  // and one plain refusal rather than two builds.
  const claimed = await supabase
    .from('operator_editor_sessions')
    .update({
      status: 'shipping',
      result_manifest: { files: input.files } as unknown as Json,
      result_commit_sha: input.commitSha,
      last_error: null,
      updated_at: now,
    })
    .eq('id', session.id)
    .eq('status', 'ready')
    .select('id');
  if (claimed.error) throw claimed.error;
  if (!claimed.data || claimed.data.length === 0) {
    throw new OperatorEditorError(
      'This session is no longer ready to ship — somebody else shipped or ' +
        'closed it a moment ago. Reload the project page.',
      'SESSION_NOT_READY',
      409
    );
  }

  const insert = await supabase
    .from('flowstarter_agent_jobs')
    .insert({
      workspace_id: workspaceId,
      kind: 'OPERATOR_EDIT_BUILD',
      status: 'queued',
      payload: {
        trigger: 'operator_editor_ship',
        operatorEdit: {
          sessionId: session.id,
          operatorId: session.operator_id,
          baseVersion: session.base_version,
          commitSha: input.commitSha,
          note: input.note,
        },
      } as unknown as Json,
      updated_at: now,
    })
    .select('id')
    .single();

  if (insert.error?.code === '23505') {
    const live = await findLiveOperatorBuild(supabase, workspaceId);
    if (!live) {
      throw new OperatorEditorError(
        'A build from the editor is already running for this project but ' +
          'could not be read back. Reload and try again.',
        'SHIP_RACE',
        409
      );
    }
    return { jobId: live, created: false };
  }
  if (insert.error || !insert.data) {
    throw insert.error ?? new Error('Could not enqueue the operator build');
  }

  const { error: linkError } = await supabase
    .from('operator_editor_sessions')
    .update({ build_job_id: insert.data.id, updated_at: now })
    .eq('id', session.id)
    .eq('workspace_id', workspaceId);
  if (linkError) throw linkError;

  return { jobId: insert.data.id, created: true };
}

async function findLiveOperatorBuild(
  supabase: SupabaseServiceClient,
  workspaceId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('flowstarter_agent_jobs')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'OPERATOR_EDIT_BUILD')
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/**
 * Closes a session an operator is done with, shipped or not.
 *
 * A `shipping` session is deliberately not closable: a build is running
 * against its manifest, and closing it would let a second Open cut a worktree
 * from a version the running build is about to replace.
 */
export async function closeOperatorEditorSession(input: {
  supabase: SupabaseServiceClient;
  workspaceId: string;
  sessionId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await input.supabase
    .from('operator_editor_sessions')
    .update({ status: 'closed', closed_at: now, updated_at: now })
    .eq('id', input.sessionId)
    .eq('workspace_id', input.workspaceId)
    .in('status', ['opening', 'ready'])
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new OperatorEditorError(
      'That session is not one that can be closed: it has already shipped, ' +
        'already closed, or a build is running against it right now.',
      'SESSION_NOT_CLOSABLE',
      409
    );
  }
}
