/**
 * Whether a build job is still held by a worker.
 *
 * The build worker writes a lease when it claims a job (`leased_by`,
 * `lease_expires_at`) and pushes the expiry forward by heartbeat for as long
 * as the build is genuinely running. That turns `running` from a status into a
 * question: a row that says `running` is either a build in progress or the
 * wreckage of a worker that died, and until leases existed the operator board
 * could not tell the difference. It refused to re-dispatch either one, which
 * is how a paid build ended up stranded with nothing on the system willing to
 * pick it up.
 *
 * This is a deliberate small copy of the claim half of
 * `apps/build-worker/src/leases.ts`, for the same reason `briefAllowsBuild` is
 * copied into that worker: the worker is a separate deployable with its own
 * package.json and no dependency on this Next app, and neither side should
 * drag the other into its build to read two timestamp columns. The rule is
 * `lease_expires_at`, falling back to `started_at + TTL` for a row claimed
 * before leases existed. If a third reader ever appears, move it into
 * `packages/agentic-codegen` rather than copying it again.
 */

/** Matches `FLOWSTARTER_BUILD_LEASE_TTL_MS`' default in the worker's config. */
export const DEFAULT_LEASE_TTL_MS = 120_000;

export interface LeasedJobRow {
  status: string;
  started_at?: string | null;
  leased_by?: string | null;
  lease_expires_at?: string | null;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * When the holder's claim runs out, or null when the row gives no way to know.
 *
 * A `running` row with neither a lease nor a start time is not something this
 * will guess about: leaving it to an operator is better than yanking a live
 * build out from under the worker running it.
 */
export function leaseDeadline(
  job: LeasedJobRow,
  ttlMs: number = DEFAULT_LEASE_TTL_MS
): number | null {
  const explicit = parseTime(job.lease_expires_at);
  if (explicit !== null) return explicit;
  const started = parseTime(job.started_at);
  return started === null ? null : started + ttlMs;
}

/** True when a `running` row's holder has stopped renewing it. */
export function leaseExpired(
  job: LeasedJobRow,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_LEASE_TTL_MS
): boolean {
  const deadline = leaseDeadline(job, ttlMs);
  return deadline !== null && deadline <= now;
}

/**
 * True when a `running` row may be re-queued: it is running, and nobody is
 * holding it any more.
 */
export function abandonedByWorker(
  job: LeasedJobRow,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_LEASE_TTL_MS
): boolean {
  return job.status === 'running' && leaseExpired(job, now, ttlMs);
}
