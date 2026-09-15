/**
 * Noticing that a classifier has stopped answering.
 *
 * A classifier that fails closed is a good design and a terrible thing to run
 * blind. The scope gate's failure branch returns `unclear`, which costs the
 * visitor one clarifying question and costs the funnel nothing visible: the
 * route keeps answering 200, no error rate moves, no alert fires. On
 * 2026-09-15 that state held for a whole evening on 100% of calls, and the
 * only trace anywhere was a `console.warn` in a terminal nobody was reading.
 *
 * So the failure branch counts. Consecutive failures, because one is a blip
 * and a run of them is an outage, and a count that a single success resets is
 * the cheapest honest signal there is.
 *
 * ── The rule and the counter are separate on purpose ──────────────────────
 * `shouldRaiseClassifierAlert` is pure: a count and an environment in, a
 * yes/no out, testable without a clock or a database. The counter below holds
 * the per-process state and nothing else. Whether an alert is actually sent,
 * and how often the same one may be sent, is `@/lib/ops/alerts`' decision,
 * which this module does not duplicate.
 */

/**
 * How many classifications in a row must fail before an operator is told.
 *
 * Three, not one: a provider blip, a rate limit and a cancelled request all
 * produce a single failure, and paging on each of those teaches an operator
 * to ignore the alert. Three consecutive failures is not a blip, and at the
 * funnel's traffic it is reached within a minute of a real outage.
 */
export const CLASSIFIER_FAILURE_ALERT_THRESHOLD = 3;

/** The variable an operator can retune the threshold with, without a deploy. */
export const CLASSIFIER_FAILURE_ALERT_THRESHOLD_ENV =
  'CLASSIFIER_FAILURE_ALERT_THRESHOLD';

/** The threshold in force. A value that is not a positive integer is ignored. */
export function classifierFailureAlertThreshold(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = Number(env[CLASSIFIER_FAILURE_ALERT_THRESHOLD_ENV]);
  return Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : CLASSIFIER_FAILURE_ALERT_THRESHOLD;
}

/**
 * True at exactly the run length that crosses the threshold, and at every
 * failure after it.
 *
 * Not "only on the crossing": an outage that lasts longer than the alert's
 * dedupe window should page again, and deciding when that is belongs to
 * `shouldSendAlert`, which reads the last send time. This rule only answers
 * "is this run long enough to be worth telling somebody about".
 */
export function shouldRaiseClassifierAlert(
  consecutiveFailures: number,
  env: Record<string, string | undefined> = process.env
): boolean {
  return consecutiveFailures >= classifierFailureAlertThreshold(env);
}

// ---------------------------------------------------------------------------
// The counter
// ---------------------------------------------------------------------------

const runs = new Map<string, number>();

/**
 * Record that a classification failed. Returns the run length so far and
 * whether it is long enough to raise an alert.
 *
 * `key` names the classifier, so the scope head going down does not silence
 * the acceptable-use head's own count.
 */
export function noteClassifierFailure(
  key: string,
  env: Record<string, string | undefined> = process.env
): { consecutiveFailures: number; shouldAlert: boolean } {
  const consecutiveFailures = (runs.get(key) ?? 0) + 1;
  runs.set(key, consecutiveFailures);
  return {
    consecutiveFailures,
    shouldAlert: shouldRaiseClassifierAlert(consecutiveFailures, env),
  };
}

/** Record that a classification succeeded. The run is over. */
export function noteClassifierSuccess(key: string): void {
  runs.delete(key);
}

/** How long the current run of failures is. Zero when the last call worked. */
export function classifierFailureRun(key: string): number {
  return runs.get(key) ?? 0;
}

/** Test seam. Nothing in `src/` outside a test may call this. */
export function resetClassifierHealth(): void {
  runs.clear();
}
