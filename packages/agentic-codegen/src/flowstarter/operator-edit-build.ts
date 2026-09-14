/**
 * An operator's editor session as something a build can be held to.
 *
 * The client's editor is deliberately small: Words and Pictures, and
 * `EDITOR_POLICY` refuses anything structural. That is the right shape for a
 * client and the wrong shape for us. When a client needs a whole new page, a
 * booking integration or a section that does not exist yet, somebody on our
 * side has to be able to open the site in a real coding agent and build it.
 *
 * `apps/flowstarter-editor` is that coding agent. This module is the contract
 * between what an operator produced in it and what may be published.
 *
 * The rule the whole path turns on, and the reason this file is short:
 *
 *   The session may do anything a coding agent can do. The gates still decide
 *   what ships.
 *
 * So there is deliberately no policy here about what an operator is allowed to
 * write -- no page budget, no "did you do what you said you would", no
 * applied-change check. Those gates exist on the change-request path because a
 * client paid for a specific sentence and somebody has to speak for them. An
 * operator's session has no such promise attached; holding it to one would
 * only ever fail a build that did exactly what we intended. What a session IS
 * held to is everything that is true of any site we publish: it compiles, it
 * carries no placeholder copy, no placeholder pictures, no empty image
 * elements, and nothing in its markup asks a visitor's browser to do something
 * we did not allow. Those are the gates, and they run on the bytes that would
 * have been deployed.
 *
 * The second rule: the bytes are the session's own, handed over explicitly.
 * The worker never reads the editor host's filesystem. What it builds is the
 * manifest the ship step captured, stored on the session row, which is also
 * what makes a failed build diagnosable after the editor host has idle-stopped
 * and reaped the worktree.
 */

/** Longest worktree path any single manifest entry may have. */
export const OPERATOR_EDIT_PATH_MAX = 400;
/** Most files one operator session may ship. A site is hundreds, not thousands. */
export const OPERATOR_EDIT_FILES_MAX = 3_000;

/**
 * The job failed because the session it names carries no readable manifest.
 *
 * Terminal, not transient: a retry would read the same empty row. The session
 * is left as it was and the operator is told to ship again from the editor,
 * which is the only thing that can produce the missing bytes.
 */
export const OPERATOR_EDIT_MANIFEST_MISSING = 'OPERATOR_EDIT_MANIFEST_MISSING';

/**
 * The job failed because the site the operator shipped is not one this build
 * is allowed to publish over -- the workspace has no delivered site yet.
 */
export const OPERATOR_EDIT_INVALID_STATE = 'OPERATOR_EDIT_INVALID_STATE';

/** Everything one OPERATOR_EDIT_BUILD is being asked to publish. */
export interface OperatorEditIntent {
  /** `operator_editor_sessions.id`, the row that owns the bytes. */
  sessionId: string;
  /** Clerk user id of the operator whose session this is. */
  operatorId: string;
  /** The `site_versions.version` the worktree was cut from. 0 before any. */
  baseVersion: number;
  /** The commit the editor host made when the operator pressed Ship. */
  commitSha: string | null;
  /** The operator's own one-line description of the work, or null. */
  note: string | null;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A git object name and nothing else. Never rendered as a link, only recorded. */
const SHA = /^[0-9a-f]{7,64}$/i;
/** Longest operator note carried out of an untrusted jsonb payload. */
export const OPERATOR_EDIT_NOTE_MAX = 500;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max).trim() : '';
}

/**
 * The intent off an untrusted job payload.
 *
 * `payload` is a jsonb column an operator can edit by hand, so the session id
 * is re-checked here rather than trusted: a payload naming no session returns
 * null and the worker fails the job loudly, because the alternative is a build
 * that publishes whatever manifest it happens to find.
 */
export function parseOperatorEditIntent(
  payload: unknown,
): OperatorEditIntent | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const raw = (payload as Record<string, unknown>)['operatorEdit'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const sessionId = record['sessionId'];
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return null;
  const operatorId = text(record['operatorId'], 200);
  if (operatorId.length === 0) return null;

  const commit = text(record['commitSha'], 64);
  const note = text(record['note'], OPERATOR_EDIT_NOTE_MAX);
  const baseVersion = record['baseVersion'];

  return {
    sessionId,
    operatorId,
    baseVersion:
      typeof baseVersion === 'number' && Number.isInteger(baseVersion) && baseVersion >= 0
        ? baseVersion
        : 0,
    commitSha: SHA.test(commit) ? commit.toLowerCase() : null,
    note: note.length > 0 ? note : null,
  };
}

/**
 * The line the operator board and the build conversation open with.
 *
 * Names the session, the base version and the commit and nothing else. The
 * operator's note is printed separately by the caller so that an operator who
 * typed something unfortunate has not put it inside a sentence the product
 * speaks in its own voice.
 */
export function operatorEditSummary(intent: OperatorEditIntent): string {
  const base =
    intent.baseVersion > 0
      ? `version ${intent.baseVersion} of the site`
      : 'the site as it was delivered';
  const commit = intent.commitSha
    ? ` The editor host committed it as ${intent.commitSha.slice(0, 12)}.`
    : '';
  return (
    `Publishing the work from editor session ${intent.sessionId}, made ` +
    `against ${base}.${commit} No agent runs here: the operator's session ` +
    'already did the work, and this build exists to put it through every ' +
    'gate a paid build passes before it reaches the client.'
  );
}

/**
 * What a client is told this version was.
 *
 * Written here, next to the rule, rather than in the worker: the same sentence
 * has to appear in `site_versions.summary` (which the client's own history
 * panel prints) and nowhere is it allowed to differ. It names no operator --
 * a client bought a service, not a person, and the name of whoever happened to
 * be on shift is not theirs to have.
 */
export const OPERATOR_EDIT_VERSION_SUMMARY = 'Change made by the Flowstarter team';

/**
 * `site_versions.created_by` for a version this kind of build saved.
 *
 * Same `system:<what>:<job>` shape `saveChangeRequestVersion` already writes,
 * because `discardChangeRequestVersion`'s guard proved the shape's worth: a
 * rollback that names the job that wrote the row can only ever reach its own.
 */
export function operatorEditCreatedBy(jobId: string): string {
  return `system:operator_edit_build:${jobId}`;
}
