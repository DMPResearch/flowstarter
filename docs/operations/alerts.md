# Alerting

Before this, three failures were invisible: a build a client paid for
stopping with nobody told, a client email silently swallowed by a down
mailer, and a production outage sitting behind a check that only ever writes
a CI annotation (see `docs/quality/mvp-readiness-2026-09-12.md`,
"Observability", and launch checklist items 3 to 7). This is the fix at the
code level; error tracking (Sentry or equivalent) is a separate, larger
decision that still needs Darius, see the end of this document.

## What alerts, and why it stops repeating

The rules live in one place, `apps/flowstarter-main/src/lib/ops/alerts.ts`.
It is pure: given an event and "now", it decides the severity and how long a
repeat of the same thing stays silent. Nothing in that file touches
Supabase, sends an email, or reads the real clock — every caller passes
those in, which is what makes the rules unit-testable without mocking
anything (`src/lib/ops/__tests__/alerts.test.ts`).

| Event | Severity | Default dedupe window | Env override |
| --- | --- | --- | --- |
| `build_job_failed` | critical | 60 minutes | `OPS_ALERT_BUILD_JOB_FAILED_DEDUPE_MINUTES` |
| `client_email_failed` | warning | 240 minutes | `OPS_ALERT_CLIENT_EMAIL_FAILED_DEDUPE_MINUTES` |
| `health_check_failed` | critical | 30 minutes | `OPS_ALERT_HEALTH_CHECK_FAILED_DEDUPE_MINUTES` |

The non-pure half, `apps/flowstarter-main/src/lib/ops/send-ops-alert.ts`,
does what the rules say: read the last time this exact thing fired from the
`ops_alerts` table (migration `20260912190000_ops_alerts.sql`), send an
email through Resend to `OPERATOR_ALERT_EMAIL` when the dedupe window has
elapsed, and write the row back so the next occurrence can make the same
check. `ops_alerts` is server-only — RLS on, zero policies, every grant to
`anon`/`authenticated` revoked, same pattern as `funnel_previews` and the
other tables `apps/flowstarter-main/scripts/verify-rls-local.mjs` proves —
because an alert about a workspace is something an operator reads, never
something a member of that workspace should see.

`sendOpsAlert` never throws, the same contract `notifyClientOnce` already
has: every caller is inside a build worker's failure path, a client-email
failure branch, or a page render, and none of them may fail because the
alert itself failed to send.

## The three call sites

**(a) A paid build stops.** `apps/flowstarter-main/src/lib/flowstarter/build-failure-notice.ts`'s
`notifyClientBuildNeedsReview` is the existing app-side hook a stopped
build's state already drives (see `apps/build-worker/src/job-store.ts`'s
`markFailed`, and the client dashboard page that calls this function once it
sees the build in a failed state). It already told the client; it now also
raises a `build_job_failed` alert, independent of whether the client email
itself succeeded — a client whose email failed and an operator who was never
told are two different gaps, and this closes both from the one place that
already knows the build stopped.

**(b) A client email fails to send.** `notifyClientOnce`
(`apps/flowstarter-main/src/lib/flowstarter/client-notifications.ts`) is the
single choke point every client-facing email already goes through. Its
failed-send branch now does two things it did not before:

- Records the failed attempt in `project_events`, under a **different**
  kind (`client_email_failed`, exported as `CLIENT_EMAIL_FAILED_EVENT`) from
  the one a successful send uses (`client_email_sent`,
  `CLIENT_EMAIL_EVENT`). The dedupe check that stops a client being emailed
  twice only ever looks at the `client_email_sent` kind, so a workspace whose
  mailer was down for a week now has a week of failure rows to read, and the
  next retry still sends once the mailer is back.
- Raises a `client_email_failed` ops alert.

**(c) A production health check fails.** `.depot/workflows/prod-synthetic.yml`
runs every six hours and, on failure, now opens or updates a GitHub issue
labelled `production-alert` instead of only leaving a `::error` annotation
on the run — the exact gap named in the readiness review ("a production 404
has been invisible for hours because the only witness was a six-hourly CI
job whose output is an annotation"). It follows the same create-or-update
shape as `daily-qa.yml`'s verdict issue: a still-failing run updates the
existing issue and adds a comment rather than filing a second one, and the
issue closes itself automatically the next time the lane passes. This path
does not go through `ops_alerts` or Resend at all — a GitHub issue is
itself the durable, dedup-safe record here, the same way it already is for
daily QA.

## Configuration

| Env var | Where | Meaning |
| --- | --- | --- |
| `OPERATOR_ALERT_EMAIL` | `apps/flowstarter-main` | Where `sendOpsAlert` sends. Unset: alerts are decided and counted (`ops_alerts.occurrence_count` still increments) but nothing is emailed, logged loudly so the gap is easy to close. |
| `OPS_ALERT_BUILD_JOB_FAILED_DEDUPE_MINUTES` | `apps/flowstarter-main` | Overrides the 60-minute default for `build_job_failed`. |
| `OPS_ALERT_CLIENT_EMAIL_FAILED_DEDUPE_MINUTES` | `apps/flowstarter-main` | Overrides the 240-minute default for `client_email_failed`. |
| `OPS_ALERT_HEALTH_CHECK_FAILED_DEDUPE_MINUTES` | `apps/flowstarter-main` | Overrides the 30-minute default for `health_check_failed` (unused today, since prod-synthetic.yml uses the GitHub-issue path instead; kept for a future caller that does route through `ops_alerts`). |
| `RESEND_API_KEY` | `apps/flowstarter-main` | Already required for every client email; `sendOpsAlert` reuses `lib/email.ts`'s `sendEmail`, the same transport. |
| `GH_REVIEW_TOKEN` | Depot | Optional. Files the `production-alert` issue under a stable identity; absent, the workflow token does it, same as `daily-qa.yml`. |

## Reading the ledger

```sql
select event, severity, title, occurrence_count, last_sent_at, workspace_id
from ops_alerts
order by last_sent_at desc
limit 20;
```

Service-role only, so run it from the Supabase SQL editor on the hosted
project, or `supabase db ...` locally. `occurrence_count` keeps incrementing
even while an alert is suppressed inside its dedupe window, so a row with a
high count and an old `last_sent_at` is a real problem happening quietly.

## What still needs Darius

- **Error tracking (Sentry or equivalent).** This document covers "who gets
  told when a specific known thing fails." It does not cover "catch the
  exception nobody anticipated." That is launch checklist item 3, and it is
  explicitly a Darius decision (which vendor, whether a paid plan is
  justified pre-revenue) rather than something to default to silently.
- **External uptime monitoring** (launch checklist item 5) pages Darius
  directly from outside the product's own infrastructure, which is a
  different and complementary layer to the GitHub-issue-based synthetic
  above: `prod-synthetic.yml` cannot alert about GitHub Actions itself being
  down.
- **`OPERATOR_ALERT_EMAIL` and `RESEND_API_KEY`** need to be set in the
  Hetzner host's env files (`/etc/flowstarter/staging.env`,
  `/etc/flowstarter/prod.env`) for the app to actually send anything; see
  `deploy/hetzner-staging/README.md`.

See also `docs/operations/backups.md` and `docs/release-process.md`.
