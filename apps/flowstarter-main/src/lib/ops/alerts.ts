/**
 * Which operational events alert an operator, at what severity, and how long
 * a repeat of the same event stays silent.
 *
 * Pure decision logic on purpose. Every function here takes its inputs as
 * arguments — including "now" and the environment to read a dedupe window
 * override from — and returns a plain answer. Nothing in this file touches
 * Supabase, sends an email, or reads the system clock itself. The non-pure
 * half — looking up the last time this exact thing fired, sending the email,
 * writing the ledger row — lives in `send-ops-alert.ts`, which calls this
 * module rather than deciding anything on its own. Rules decide, the sender
 * only does what it is told.
 *
 * This is what `apps/build-worker`'s `markFailed` (by way of
 * `build-failure-notice.ts`, the app callback the worker's failed-job state
 * already drives), `notifyClientOnce`'s failed-send branch, and the
 * production synthetic's health check all key off. Three different callers,
 * one place that decides what "alert-worthy" means.
 */

export type AlertEvent =
  | 'build_job_failed'
  | 'client_email_failed'
  | 'health_check_failed'
  | 'scope_classifier_failed'
  | 'acceptable_use_classifier_failed'
  | 'deploy_needs_operator'
  | 'preview_artifact_over_budget';

export type AlertSeverity = 'critical' | 'warning';

interface AlertRule {
  severity: AlertSeverity;
  /**
   * The env var an operator can raise or lower this event's dedupe window
   * with, in minutes. Named per event rather than one shared knob, because a
   * build failure paging every hour and a flaky mailer paging every four are
   * different tolerances an operator may want to tune independently.
   */
  dedupeWindowEnvVar: string;
  /** Used when the env var above is unset or not a positive number. */
  defaultDedupeWindowMinutes: number;
}

const RULES: Record<AlertEvent, AlertRule> = {
  // A paid build stopping is the most expensive failure in the product: a
  // client who paid gets nothing until someone notices. Short window, so a
  // second distinct job failing for the same workspace still pages promptly.
  build_job_failed: {
    severity: 'critical',
    dedupeWindowEnvVar: 'OPS_ALERT_BUILD_JOB_FAILED_DEDUPE_MINUTES',
    defaultDedupeWindowMinutes: 60,
  },
  // A single failed send is often transient (a rate limit, a blip). Longer
  // window: the point is to notice a mailer that stays down, not to page for
  // every retry in between.
  client_email_failed: {
    severity: 'warning',
    dedupeWindowEnvVar: 'OPS_ALERT_CLIENT_EMAIL_FAILED_DEDUPE_MINUTES',
    defaultDedupeWindowMinutes: 240,
  },
  // The production synthetic already runs every six hours
  // (.depot/workflows/prod-synthetic.yml); this window only matters if it is
  // ever run more often than that.
  health_check_failed: {
    severity: 'critical',
    dedupeWindowEnvVar: 'OPS_ALERT_HEALTH_CHECK_FAILED_DEDUPE_MINUTES',
    defaultDedupeWindowMinutes: 30,
  },
  // The scope classifier failing is silent by design: the gate fails closed to
  // `unclear`, every visitor gets one extra question, and the funnel keeps
  // answering 200. It ran that way for a whole evening on 100% of calls and
  // the only trace was a console line nobody was reading. Critical, because
  // while it is down the routing rule is running on no verdict at all; a
  // narrow window, because the thing an operator needs to know is that it is
  // still down, not that it failed once.
  scope_classifier_failed: {
    severity: 'critical',
    dedupeWindowEnvVar: 'OPS_ALERT_SCOPE_CLASSIFIER_FAILED_DEDUPE_MINUTES',
    defaultDedupeWindowMinutes: 60,
  },
  // The acceptable-use classifier is the same shape of silence, one gate
  // along: it fails closed to `review`, every enforcement point keeps
  // answering, and the only visible effect is a review queue quietly filling
  // with businesses nobody needed to look at. Same severity and window as the
  // scope head, because the reasoning is identical -- while it is down, the
  // policy is running on no verdict at all.
  acceptable_use_classifier_failed: {
    severity: 'critical',
    dedupeWindowEnvVar:
      'OPS_ALERT_ACCEPTABLE_USE_CLASSIFIER_FAILED_DEDUPE_MINUTES',
    defaultDedupeWindowMinutes: 60,
  },
  // A finished, gate-passed site that cannot be put anywhere. The deploy asked
  // for a host and there is not one: the workspace is unallocated, or the
  // server it names is gone or inactive, or nobody configured the agent on it.
  // No retry clears any of those, and the build worker knows it — the failure
  // is terminal there on purpose. This alert is the other half of that
  // decision: a job that stops and waits for a person has to *reach* a person.
  // Run 9 spent two of three attempts rediscovering a 409 that an operator
  // could have cleared in a minute, because nothing told anybody.
  //
  // Critical, because the client has paid and the work is done. A short
  // window, because the useful signal is that it is still unallocated.
  deploy_needs_operator: {
    severity: 'critical',
    dedupeWindowEnvVar: 'OPS_ALERT_DEPLOY_NEEDS_OPERATOR_DEDUPE_MINUTES',
    defaultDedupeWindowMinutes: 30,
  },
  // A generated preview that was correct and could not be stored. Nobody has
  // paid, so this is not `build_job_failed`'s severity — but it is not nothing
  // either: the visitor was told "the build stopped" and went away, and a
  // budget that is too small for a whole template family costs every preview
  // built from it, silently, until somebody films one. Warning, because the
  // funnel steps the visitor down to the deterministic demo rather than
  // breaking. A short window, because the useful signal is *which* previews
  // are still over, and previews from the same template family are the same
  // news for an hour.
  preview_artifact_over_budget: {
    severity: 'warning',
    dedupeWindowEnvVar: 'OPS_ALERT_PREVIEW_ARTIFACT_OVER_BUDGET_DEDUPE_MINUTES',
    defaultDedupeWindowMinutes: 60,
  },
};

export function alertSeverity(event: AlertEvent): AlertSeverity {
  return RULES[event].severity;
}

/**
 * How long a second occurrence of the same dedupe key stays silent, in
 * milliseconds. `env` defaults to `process.env` but is a parameter so the
 * rule can be tested without mutating the real environment.
 */
export function dedupeWindowMs(
  event: AlertEvent,
  env: Record<string, string | undefined> = process.env
): number {
  const rule = RULES[event];
  const raw = Number(env[rule.dedupeWindowEnvVar]);
  const minutes =
    Number.isFinite(raw) && raw > 0 ? raw : rule.defaultDedupeWindowMinutes;
  return minutes * 60_000;
}

/**
 * One dedupe key per distinct occurrence of an event. `discriminator` is the
 * caller's own identity for "the same thing happening again": a build job's
 * id, a `workspaceId/notification/dedupeKey` triple for a client email, or a
 * fixed string for a singleton check like the health endpoint.
 */
export function buildDedupeKey(
  event: AlertEvent,
  discriminator: string
): string {
  return `${event}:${discriminator}`;
}

/**
 * True when a fresh alert should be sent for this dedupe key: nothing has
 * been sent for it before, or the last send is older than the event's
 * window. False means "this has already been said recently, stay quiet."
 */
export function shouldSendAlert(
  event: AlertEvent,
  lastSentAt: Date | null,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env
): boolean {
  if (!lastSentAt) return true;
  const elapsedMs = now.getTime() - lastSentAt.getTime();
  return elapsedMs >= dedupeWindowMs(event, env);
}
