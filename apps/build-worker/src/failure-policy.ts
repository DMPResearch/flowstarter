/**
 * Which failures are worth trying again, and which are an answer.
 *
 * Until #120 a failed build was terminal: the claim rule excluded `failed`
 * outright, and an operator re-dispatch was the only way back. #120 made the
 * queue durable and, in doing so, put `failed` on the list of statuses the
 * sweep picks up — so every historically failed job with attempts left was
 * retried by whichever worker booted next.
 *
 * On 2026-09-13 that cost a client three full agent passes over thirty-one
 * minutes on one deterministic refusal (job
 * `b52b241f-686b-4871-bc64-21cf61fb5f79`: the commit-message policy did not
 * know about change requests, and would not have known about them on the third
 * attempt either). It also erased the record: four `PAGE_BUDGET_EXCEEDED` jobs
 * and one `PLACEHOLDER_IMAGE_SHIPPED` now read `CHANGE_REQUEST_BUILD_FAILED`,
 * the reason their *last* retry died, because `markFailed` overwrites
 * `error_code` on every attempt.
 *
 * The rule this module states is the one a person would state:
 *
 * - **A gate or a policy refused the output.** That is a verdict on this
 *   build, reached by a deterministic rule over files that already exist.
 *   Running the same rule over the same build again returns the same verdict,
 *   so it is terminal: the code stands, the job waits for an operator, and no
 *   model time is spent re-proving it.
 * - **The environment got in the way** — a lease lost to a dead worker, a
 *   registry that timed out, a sandbox that would not start. Nothing was
 *   decided about the site, so another attempt is exactly the right answer.
 *
 * Everything here is a pure function of a code and a detail string, so the
 * rule is asserted directly in `test/failure-policy.test.ts`. `leases.ts` is
 * the only caller: `claimVerdict` refuses a terminal `failed` row, which is
 * what keeps both the startup sweep and `readyForClaim` honest without either
 * of them restating the rule.
 *
 * An operator re-dispatch still works and is meant to: it clears `error_code`
 * and sets the row back to `queued`, which is a person deciding to spend the
 * attempt. "Never re-queued automatically" is the claim, not "never again".
 */

import {
  APPROVED_EDIT_DROPPED,
  ASSET_NOT_BINARY,
  BUILD_LEASE_LOST,
  CAL_PREVIEW_IN_PAID_BUILD,
  CHANGE_REQUEST_NOT_APPLIED,
  CHANGE_REQUEST_REPAIR_DAMAGED_SITE,
  EMPTY_IMAGE_SHIPPED,
  GENERATED_HTML_UNSAFE,
  INVENTED_PROJECT,
  OPERATOR_EDIT_INVALID_STATE,
  OPERATOR_EDIT_MANIFEST_MISSING,
  PAGE_BUDGET_EXCEEDED,
  PLACEHOLDER_COPY_SHIPPED,
  PLACEHOLDER_IMAGE_SHIPPED,
  TEASER_IN_PAID_BUILD,
} from '@flowstarter/agentic-codegen';

export type BuildFailureClass = 'transient' | 'terminal';

/** The two ledger columns a retry decision is made from. */
export interface RecordedBuildFailure {
  error_code?: string | null;
  error_detail?: string | null;
}

/**
 * Verdicts. Every one of these is a deterministic rule that read the built
 * site, or the job, and said no — the gates of #97, #100, #110, #119, #128 and
 * #134, plus the two preconditions a change-request build checks before it
 * starts an agent at all.
 *
 * The codes are imported rather than spelled out, so a gate that renames its
 * code renames it here too and this list cannot quietly stop covering it.
 */
export const TERMINAL_BUILD_FAILURE_CODES: ReadonlySet<string> = new Set([
  APPROVED_EDIT_DROPPED,
  ASSET_NOT_BINARY,
  CAL_PREVIEW_IN_PAID_BUILD,
  CHANGE_REQUEST_NOT_APPLIED,
  CHANGE_REQUEST_REPAIR_DAMAGED_SITE,
  EMPTY_IMAGE_SHIPPED,
  GENERATED_HTML_UNSAFE,
  INVENTED_PROJECT,
  PAGE_BUDGET_EXCEEDED,
  PLACEHOLDER_COPY_SHIPPED,
  PLACEHOLDER_IMAGE_SHIPPED,
  TEASER_IN_PAID_BUILD,
  // Preconditions, not gates, but decided the same way: a job whose project is
  // in the wrong state, or which carries no change request to build, will be
  // in exactly that condition on the next attempt too.
  'INVALID_PROJECT_STATE',
  'CHANGE_REQUEST_MISSING',
  // The same two, for an operator's editor session. A job naming a session
  // with no manifest on it will name the same empty row on the next attempt,
  // and the only thing that can produce the missing bytes is the operator
  // pressing Ship again in the editor.
  OPERATOR_EDIT_INVALID_STATE,
  OPERATOR_EDIT_MANIFEST_MISSING,
]);

/**
 * Failures of the machinery rather than of the site.
 *
 * `BUILD_LEASE_EXPIRED` is written by reconciliation (`leases.ts`,
 * `job-store.ts`) when a worker died holding a job. `BUILD_LEASE_LOST` (#136)
 * is the other side of the same coin: an attempt that was overtaken and
 * cancelled at its next phase. Neither decided anything about the site, so
 * both go straight back in the queue — which is the behaviour #120 and #136
 * exist to provide and the one this module must not take away.
 */
export const TRANSIENT_BUILD_FAILURE_CODES: ReadonlySet<string> = new Set([
  'BUILD_LEASE_EXPIRED',
  BUILD_LEASE_LOST,
]);

/**
 * The codes a build wraps an error it did not recognise in.
 *
 * These say "something threw", not what. A network blip, a registry 503, a
 * container that would not start and a bug in our own code all arrive wearing
 * the same one, so the code alone cannot classify them and the detail — the
 * error's own message, as recorded — is the only evidence there is.
 */
export const UNCLASSIFIED_BUILD_FAILURE_CODES: ReadonlySet<string> = new Set([
  'FULL_SITE_BUILD_FAILED',
  'CHANGE_REQUEST_BUILD_FAILED',
  'SITE_REBUILD_FAILED',
  'OPERATOR_EDIT_BUILD_FAILED',
  'BUILD_JOB_UNCLAIMABLE',
]);

/**
 * What a transient cause looks like in a recorded error message: the four
 * families named in the rule — network, lease loss, sandbox start, timeouts.
 *
 * Consulted **only** for the unclassified codes above. A gate's message can
 * say whatever it likes; its code has already decided.
 */
const TRANSIENT_CAUSE_MARKERS: readonly RegExp[] = [
  // Node and libuv network errno codes, plus the two phrasings the runtime
  // uses when a socket dies mid-request.
  /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|ENOTFOUND)\b/i,
  /socket hang up|fetch failed|network (?:error|is unreachable)/i,
  // Upstreams that asked us to come back later.
  /\b(429|502|503|504)\b/,
  // Timeouts, however the thrower spelled it.
  /\btimed out\b|\btimeout\b/i,
  // The lease this build was holding, and the container it was to run in.
  /\blease\b/i,
  /\b(docker|container|sandbox)\b/i,
];

/**
 * Transient or terminal, for one recorded failure.
 *
 * The default is terminal, and deliberately so: a failure is retryable *only*
 * when its cause is known to be transient. Spending a paying client's build
 * budget on a guess is the behaviour being removed, and a job that stops on
 * the operator board with its original code on it is the honest outcome for
 * anything this rule cannot name.
 */
export function classifyBuildFailure(
  failure: RecordedBuildFailure,
): BuildFailureClass {
  const code = (failure.error_code ?? '').trim().toUpperCase();
  if (TRANSIENT_BUILD_FAILURE_CODES.has(code)) return 'transient';
  if (TERMINAL_BUILD_FAILURE_CODES.has(code)) return 'terminal';
  if (UNCLASSIFIED_BUILD_FAILURE_CODES.has(code)) {
    const detail = failure.error_detail ?? '';
    return TRANSIENT_CAUSE_MARKERS.some((marker) => marker.test(detail))
      ? 'transient'
      : 'terminal';
  }
  return 'terminal';
}

/** True when this worker may take a failed job again without being asked. */
export function isRetryableBuildFailure(
  failure: RecordedBuildFailure,
): boolean {
  return classifyBuildFailure(failure) === 'transient';
}

/** One attempt's failure, as it goes onto the job's own ledger. */
export interface FailureLedgerEntry {
  attempt: number;
  code: string;
  detail: string;
  at: string;
}

/** How many attempts are kept. A build's budget is three; this is generous. */
export const FAILURE_LEDGER_MAX = 10;

/**
 * The job payload's failure ledger, with this attempt appended.
 *
 * `markFailed` overwrites `error_code` every time, which is correct for "what
 * is wrong with this job right now" and is how the first recorded verdict for
 * five of this workspace's jobs was lost. The ledger is the other half: every
 * attempt's own code, in order, so the first one is still readable after the
 * third. `error_code_first` on the row is the same fact in a column, for an
 * operator with a `psql` prompt and no appetite for JSON.
 */
export function appendFailureToLedger(
  payload: unknown,
  entry: FailureLedgerEntry,
): FailureLedgerEntry[] {
  const existing = readFailureLedger(payload);
  return [...existing, entry].slice(-FAILURE_LEDGER_MAX);
}

/** The failure ledger already on a payload, or an empty one. */
export function readFailureLedger(payload: unknown): FailureLedgerEntry[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }
  const raw = (payload as Record<string, unknown>)['failures'];
  if (!Array.isArray(raw)) return [];
  const entries: FailureLedgerEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const code = typeof record['code'] === 'string' ? record['code'] : '';
    if (!code) continue;
    entries.push({
      attempt:
        typeof record['attempt'] === 'number' && record['attempt'] > 0
          ? record['attempt']
          : entries.length + 1,
      code,
      detail: typeof record['detail'] === 'string' ? record['detail'] : '',
      at: typeof record['at'] === 'string' ? record['at'] : '',
    });
  }
  return entries;
}

/**
 * The code this job failed with the *first* time, which is the one that says
 * what actually went wrong. Falls back to the code being recorded now, which
 * is the first one when there is no ledger yet.
 */
export function firstRecordedFailureCode(
  payload: unknown,
  currentCode: string,
): string {
  const ledger = readFailureLedger(payload);
  return ledger[0]?.code ?? currentCode;
}
