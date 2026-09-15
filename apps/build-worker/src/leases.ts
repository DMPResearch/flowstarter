/**
 * The lease rules that make the build queue survive a restart.
 *
 * Before this module the queue lived entirely in one process: an array in
 * `queue.ts` and a `running` row on the ledger that nothing ever revisited. A
 * worker that crashed after claiming left a paid build at `running` forever —
 * a restarted worker would not claim it (`running` was excluded outright) and
 * the operator board refused to re-dispatch it for the same reason. The job
 * was stranded, and the only evidence anybody had was a client's site that
 * never arrived.
 *
 * The fix is a lease, not a longer list of statuses. A claim writes who holds
 * the job and until when; a heartbeat pushes that deadline forward while the
 * build is genuinely running; and the claim rule reads `running` as "somebody
 * holds this" rather than "somebody is doing this". A held lease is refused. An
 * expired one is recoverable by anyone, including the operator board.
 *
 * Everything here is a pure function of a row and a clock, so the rule can be
 * tested without a database and asserted on directly. The Supabase writes that
 * act on these verdicts live in `job-store.ts`; the loop that calls them lives
 * in `durable-queue.ts`.
 *
 * One thing a lease does not decide: whether a *failed* row is worth taking
 * again. Putting `failed` on the sweep's list (#120) meant every historically
 * failed job was retried, including ones a gate had deterministically refused
 * — three agent passes to reach the same verdict, and the first verdict
 * overwritten by the last. `failure-policy.ts` holds that rule and
 * `claimVerdict` asks it, so there is still exactly one place that decides
 * what this worker may pick up.
 */

import {
  deployAttemptBudget,
  planBuildResume,
  readAttemptCounters,
  type BuildResumePlan,
} from '@flowstarter/agentic-codegen';
import { isRetryableBuildFailure } from './failure-policy';

/**
 * Kinds this worker knows how to run. Both halves of the pipeline arrive at
 * the same endpoint, so the ledger row says which one this is.
 */
export const CLAIMABLE_KINDS: ReadonlySet<string> = new Set([
  'FULL_SITE_BUILD',
  'SITE_REBUILD',
  'CHANGE_REQUEST_BUILD',
  // An operator's editor session, shipped. Runs no agent pass of its own --
  // the operator already did the work interactively -- but every output gate,
  // which is what makes it this worker's job rather than a direct publish.
  'OPERATOR_EDIT_BUILD',
]);

/**
 * The status of a FULL_SITE_BUILD parked on its client's brief. Defined here
 * rather than imported from `job-store.ts`, which imports this module.
 */
export const WAITING_BRIEF = 'waiting_brief';

/**
 * States that hold no lease and are waiting for somebody to take them.
 *
 * `waiting_brief` is one of them: a parked job is claimable in the sense this
 * rule means it — nobody is running it and anybody may look at it — and the
 * brief gate in `claim()` is what decides whether it runs or is parked again.
 * Keeping it here rather than in a second set is what stops the two rules from
 * drifting apart; keeping it *out* of the recovery rule below is what stops
 * reconciliation from mistaking a client who has not filled in a form for a
 * worker that died.
 */
export const RESTING_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'failed',
  WAITING_BRIEF,
]);

/** The ledger columns a lease decision is made from. */
export interface LeasedJobRow {
  id: string;
  kind: string;
  status: string;
  attempt_count: number;
  /** The row's own budget, raised by an operator re-dispatch. */
  max_attempts?: number | null;
  /** Backoff: the earliest moment a worker may take this job. */
  run_after?: string | null;
  started_at?: string | null;
  leased_by?: string | null;
  lease_expires_at?: string | null;
  /**
   * The fencing token: which *run* holds this job, as opposed to whether
   * anybody does. Bumped by one on every claim and carried by every write that
   * run makes, so an attempt that was overtaken updates nothing instead of
   * overwriting the attempt that replaced it. A row written before the column
   * existed reads as {@link UNFENCED_TOKEN}.
   */
  lease_fence?: number | null;
  /** What the last attempt failed with, which decides whether to retry it. */
  error_code?: string | null;
  error_detail?: string | null;
  payload?: unknown;
}

/** What a row that has never been claimed carries, and where counting starts. */
export const UNFENCED_TOKEN = 0;

/** The token a claim of this row writes: monotonic, one per claim, per row. */
export function nextFencingToken(row: LeasedJobRow): number {
  const current = row.lease_fence;
  return (
    (typeof current === 'number' && Number.isFinite(current)
      ? Math.trunc(current)
      : UNFENCED_TOKEN) + 1
  );
}

export type ClaimRefusal =
  | 'wrong-kind'
  | 'terminal'
  | 'attempts-exhausted'
  /** Out of *deploy* tries on a site that is built and gated. Needs a person. */
  | 'deploy-attempts-exhausted'
  | 'not-due'
  | 'leased'
  | 'running-without-lease'
  /** A gate or a policy refused this build; another pass would refuse it too. */
  | 'terminal-verdict';

export type ClaimVerdict =
  | {
      claimable: true;
      recovered: boolean;
      /**
       * What the claimer is being given the job *for*. The budget this claim
       * was measured against and the work the attempt will do are the same
       * decision, so they are made once, here, and the store bumps whichever
       * counter this names.
       */
      plan: BuildResumePlan;
    }
  | { claimable: false; reason: ClaimRefusal };

export interface ClaimRules {
  now: number;
  /** Fallback budget when the row carries none. */
  maxAttempts: number;
  /**
   * How many times a built, gated site may be handed to the deploy side.
   *
   * Its own budget, because a deploy costs a request and a generation costs a
   * client's model spend, and letting the cheap one consume the expensive
   * one's allowance is precisely what ended run 9 with a finished site nobody
   * could ship. Named and configured (`FLOWSTARTER_BUILD_MAX_DEPLOY_ATTEMPTS`)
   * rather than derived from `maxAttempts`, so the two can be tuned for the
   * different things they are.
   */
  maxDeployAttempts: number;
  /** How long a claim is good for without a heartbeat. */
  leaseTtlMs: number;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * The attempt budget for this row. The operator board raises `max_attempts`
 * when it re-dispatches a job that spent its retries, and that decision has to
 * beat the worker's own default or the re-dispatch does nothing.
 */
export function attemptBudget(row: LeasedJobRow, configured: number): number {
  return typeof row.max_attempts === 'number' && row.max_attempts > 0
    ? row.max_attempts
    : configured;
}

/**
 * What this attempt would be for, and whether its budget is spent.
 *
 * One function so the claim rule and startup reconciliation cannot disagree
 * about whether a job has anything left. The plan decides which budget is
 * consulted: a job with a gate-passed artifact that failed on the deploy side
 * is measured against the deploy budget and nothing else, which is the literal
 * statement of "a deploy failure does not consume a generation attempt".
 */
export function attemptVerdict(
  row: LeasedJobRow,
  rules: ClaimRules,
): { plan: BuildResumePlan } | { exhausted: ClaimRefusal } {
  const plan = planBuildResume({ kind: row.kind, payload: row.payload });
  const counters = readAttemptCounters(row.payload, row.attempt_count);
  if (plan.resume === 'deploy') {
    return counters.deploy >=
      deployAttemptBudget(row.payload, rules.maxDeployAttempts)
      ? { exhausted: 'deploy-attempts-exhausted' }
      : { plan };
  }
  return counters.generation >= attemptBudget(row, rules.maxAttempts)
    ? { exhausted: 'attempts-exhausted' }
    : { plan };
}

/** Backoff, in the one place that decides it. */
export function isDue(row: LeasedJobRow, now: number): boolean {
  const at = parseTime(row.run_after);
  return at === null || at <= now;
}

/**
 * When the current holder's claim runs out.
 *
 * The lease column is the answer whenever there is one. A `running` row with
 * no lease is a job claimed by a worker built before leases existed, so its
 * start time plus one TTL stands in: old enough to be recovered, recent enough
 * that a build still finishing is left alone. A row with neither is not
 * something this rule will guess about — it returns null and the job waits for
 * an operator, which is the honest outcome for a row nobody can date.
 */
export function leaseDeadline(
  row: LeasedJobRow,
  leaseTtlMs: number,
): number | null {
  const explicit = parseTime(row.lease_expires_at);
  if (explicit !== null) return explicit;
  const started = parseTime(row.started_at);
  return started === null ? null : started + leaseTtlMs;
}

/** True while somebody still holds this job. */
export function leaseHeld(
  row: LeasedJobRow,
  rules: Pick<ClaimRules, 'now' | 'leaseTtlMs'>,
): boolean {
  const deadline = leaseDeadline(row, rules.leaseTtlMs);
  return deadline !== null && deadline > rules.now;
}

/**
 * Whether this worker may take the job, and why not when it may not.
 *
 * `running` is no longer excluded outright: it is excluded *while its lease
 * holds*. That single change is what lets a restarted worker pick up the build
 * its predecessor died in the middle of.
 */
export function claimVerdict(
  row: LeasedJobRow,
  rules: ClaimRules,
): ClaimVerdict {
  if (!CLAIMABLE_KINDS.has(row.kind)) {
    return { claimable: false, reason: 'wrong-kind' };
  }
  const attempts = attemptVerdict(row, rules);
  if ('exhausted' in attempts) {
    return { claimable: false, reason: attempts.exhausted };
  }
  const { plan } = attempts;

  if (RESTING_STATUSES.has(row.status)) {
    // A resting row should carry no lease. If one is somehow still live, the
    // holder wins: two workers on one worktree is the failure this prevents.
    if (parseTime(row.lease_expires_at) !== null && leaseHeld(row, rules)) {
      return { claimable: false, reason: 'leased' };
    }
    // A failed row is retried only when what failed was the machinery. A gate
    // verdict is not flaky, and re-running it spends a model pass to reach the
    // same answer while overwriting the code that said it. An operator
    // re-dispatch clears `error_code` and sets `queued`, so a person can still
    // decide to spend the attempt.
    if (row.status === 'failed' && !isRetryableBuildFailure(row)) {
      return { claimable: false, reason: 'terminal-verdict' };
    }
    return isDue(row, rules.now)
      ? { claimable: true, recovered: false, plan }
      : { claimable: false, reason: 'not-due' };
  }

  if (row.status === 'running') {
    const deadline = leaseDeadline(row, rules.leaseTtlMs);
    if (deadline === null) {
      return { claimable: false, reason: 'running-without-lease' };
    }
    if (deadline > rules.now) return { claimable: false, reason: 'leased' };
    // Recovery deliberately ignores `run_after`: this build is already in
    // flight and its backoff was spent before it ever started.
    return { claimable: true, recovered: true, plan };
  }

  return { claimable: false, reason: 'terminal' };
}

/** Exponential backoff, capped. No jitter: one worker, one deterministic rule. */
export interface BackoffRules {
  baseMs: number;
  maxMs: number;
}

export function backoffMs(attempt: number, rules: BackoffRules): number {
  const steps = Math.max(0, Math.trunc(attempt) - 1);
  // 2**steps overflows into Infinity long before it overflows the cap, and
  // Math.min keeps Infinity out of the result either way.
  return Math.min(rules.maxMs, rules.baseMs * 2 ** Math.min(steps, 30));
}

/** The ISO instant a failed attempt may next be taken. */
export function nextRunAfter(
  now: number,
  attempt: number,
  rules: BackoffRules,
): string {
  return new Date(now + backoffMs(attempt, rules)).toISOString();
}

/**
 * What a finished build published, read back off the job's own payload.
 *
 * This is the idempotency key of the last step. `markHumanQa`,`markRebuilt`
 * and `markChangeRequestBuilt` all write the commit, the PR url and the
 * staging url onto the payload in the same statement that sets `succeeded` —
 * but publication happens *before* that statement. A worker killed in the
 * window between them leaves a row that says `running` and a payload that says
 * the site shipped. Rebuilding it would publish the same site twice.
 */
export interface PublishedResult {
  commitSha: string;
  pullRequestUrl: string;
  stagingUrl: string;
}

export function publishedResult(payload: unknown): PublishedResult | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const text = (key: string): string =>
    typeof record[key] === 'string' ? (record[key] as string).trim() : '';
  const commitSha = text('commitSha');
  const pullRequestUrl = text('pullRequestUrl');
  // Both, not either: a commit with no PR is an unfinished publish, and a PR
  // url with no commit is a payload somebody edited.
  if (!commitSha || !pullRequestUrl) return null;
  return { commitSha, pullRequestUrl, stagingUrl: text('stagingUrl') };
}

export type StaleLeaseAction =
  /** The site shipped; finish the ledger row without building anything. */
  | { action: 'complete'; published: PublishedResult }
  /** Nothing shipped; put it back in the queue for another attempt. */
  | { action: 'requeue' }
  /** Out of attempts: fail it so an operator sees it rather than looping. */
  | { action: 'abandon' }
  /** Still held, or not a row this worker may touch. */
  | { action: 'leave'; reason: ClaimRefusal | 'not-running' };

/**
 * What startup reconciliation should do with a `running` row.
 *
 * Publication is checked before re-queueing, never after: the expensive,
 * irreversible half of a build is the one that already happened.
 */
export function staleLeaseAction(
  row: LeasedJobRow,
  rules: ClaimRules,
): StaleLeaseAction {
  if (row.status !== 'running')
    return { action: 'leave', reason: 'not-running' };
  if (!CLAIMABLE_KINDS.has(row.kind)) {
    return { action: 'leave', reason: 'wrong-kind' };
  }
  const deadline = leaseDeadline(row, rules.leaseTtlMs);
  if (deadline === null) {
    return { action: 'leave', reason: 'running-without-lease' };
  }
  if (deadline > rules.now) return { action: 'leave', reason: 'leased' };

  const published = publishedResult(row.payload);
  if (published) return { action: 'complete', published };
  // The same budget question the claim rule asks, asked the same way. A job
  // whose worker died holding a gate-passed artifact has deploy tries left
  // even when its generation budget is spent, and abandoning it here would
  // strand exactly the site this change exists to rescue.
  if ('exhausted' in attemptVerdict(row, rules)) return { action: 'abandon' };
  return { action: 'requeue' };
}

/** Longest lease owner the ledger column will be asked to hold. */
const OWNER_MAX = 200;

/**
 * Who holds a lease. Identifies a process, not a person: the host and pid make
 * it readable in an incident, and the nonce keeps two workers on the same host
 * from looking like one across a restart that reused a pid.
 */
export function leaseOwner(input: {
  hostname: string;
  pid: number;
  nonce: string;
}): string {
  return `${input.hostname}:${input.pid}:${input.nonce}`.slice(0, OWNER_MAX);
}
