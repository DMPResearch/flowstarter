# Flowstarter MVP launch review

*Reviewed the working tree at `980333148`, the requested decisions and runbooks, and the last 60 commits. This was a read-only code review, not a fresh infrastructure or payment rehearsal. I ran the readiness script and a small booking-rule probe; I did not run the full test suites or verify deployed configuration.*

## 1. Verdict in three sentences

**Flowstarter is not ready to take an unattended first customer through the advertised journey.** The repository proves substantial parts of delivery, including test payments and a real Hetzner site, but the newest post-deposit brief flow is disconnected from build execution, payment updates can be silently lost, and recovery still depends on an operator. A tightly supervised service-site pilot is plausibly **12–20 engineering days plus owner setup and a clean rehearsal** away; an unrestricted self-service launch is further away.

## 2. Client journey

“Proven end to end” below means that particular step was demonstrated in a supplied runbook, sometimes with operator intervention. It does not mean the entire current journey passed.

| Step | Rating | Evidence and limitation |
|---|---|---|
| Answer four intake questions | Implemented but unproven | `apps/flowstarter-main/src/app/(dynamic-pages)/(main-pages)/components/discovery/intake-script.ts:106`. The supplied successful generation run used the older, longer intake. |
| Generate personalized preview | Proven end to end | `artifacts/showcase/darius-portfolio-2026-09-12/README.md:73`: first attempt, approximately 550 seconds, 159,500 reported tokens. |
| Apply two free edits | Proven end to end | Same runbook, generation section: headline and Instagram changes appeared in the preview. No recorded third-edit rejection in that run. |
| Claim workspace and pay deposit | Proven end to end | Portfolio runbook: €159.80 test deposit settled through a signed Stripe webhook. |
| Provision guest account and deliver access | Partial | `lib/flowstarter/guest-deposit.ts:110`: provisioning exists, but failed welcome delivery is not retried by the already-provisioned branch. The portfolio run used a prepared Clerk account and invalid Resend credentials. |
| Complete detailed brief after payment | Partial | `api/client/brief/[workspaceId]/route.ts:270` saves readiness, but does not redispatch. `apps/build-worker/src/job-store.ts:520` reads only readiness flags. |
| Build full site from approved preview | Proven end to end | Portfolio runbook, “Redelivery after fix”: successful build in 12m43s after #98 and operator redispatch. This predates the new mandatory brief gate. |
| Operator QA and approval | Partial | Worker reaches `HUMAN_QA`. The supplied run explicitly stopped short of approving `LIVE_SUBSCRIPTION`; the override API changes state without validating payment or deployment conditions. |
| Pay balance | Proven end to end | Portfolio runbook: €639.20 test invoice paid. It was paid through the hosted invoice URL because the dashboard balance tile was unavailable. |
| Activate care plan | Partial | Test subscription entered its trial through the operator Billing tab. First recurring charge, failed renewal, and recovery were not demonstrated. |
| Publish on platform hostname | Proven end to end | `artifacts/showcase/hetzner-2026-09-12/README.md:708`: deployment version 10, HTTPS, seven working pages, uploaded image hashes preserved. Proven on `.flowstarter.dev`, not a new `.flowstarter.net` production customer. |
| Client dashboard and constrained edits | Proven end to end | Portfolio runbook, “Real project images”: authenticated editing, rights confirmation, image swaps, one charged text edit, rebuild and live output. |
| Quote, pay, and deliver larger change | Partial | Quote and €190 test payment demonstrated. #103 adds `change-request-build.ts` and `CHANGE_REQUEST_BUILD`, so delivery is no longer missing in code; the supplied runbooks do not prove that new implementation fulfilled the request. |
| Cal.com booking and dashboard sync | Implemented but unproven | Signed webhook, connection UI and booking table exist. Runbook left calendar disconnected. Repeat-reschedule handling is incorrect. |
| Capture enquiry from delivered site | Implemented but unproven | `api/leads/capture/route.ts:53` stores and attempts notification. Supplied runbooks do not demonstrate form submission through to the owner’s inbox. |
| Transactional email | Partial | Notices fire, but every recorded Resend attempt failed with 401. No delivered-mail proof. |
| Cancel and refund | Partial | Subscription cancellation exists in `lib/billing/stripe.ts:281`. Product refund processing is missing; manual Stripe refunds remain necessary. |

Paths abbreviated to `lib/` and `api/` in this table are under `apps/flowstarter-main/src`.

The May master decisions document is materially stale: it describes an older editor, payment milestones and session model. Current code implements 20/80 payments and edit credits. Reconcile the document and customer promises before launch, without reopening those implementation decisions.

## 3. Top ten risks, ranked by launch impact

### 1. The new brief does not start or inform the paid build

**Confirmed code defect.** Deposit dispatch reaches the worker before the brief is ready, so `claim()` returns without running. Saving the brief writes `ready_at` and returns; there is no redispatch there and no durable queue poller in the worker.

Separately, the worker reads only `ready_at, override_at`. Its build input still comes from the original intake and preview artifacts, so the newly supplied offer, projects and photos do not reach generation through this path.

**Fix:** dispatch on readiness transition, add durable queue reconciliation, and construct a versioned build input from the completed brief plus rights-confirmed assets. Test deposit → waiting → brief submission → exactly one build containing the submitted material.

Evidence: [brief save](apps/flowstarter-main/src/app/api/client/brief/[workspaceId]/route.ts:270), [worker brief read](apps/build-worker/src/job-store.ts:520), and the same worker file at lines 603 and 655.

### 2. Stripe can receive success while payment state was not saved

**Confirmed code defect.** Final-invoice and subscription handlers await Supabase updates without inspecting `{ error }`. A failed write can therefore produce HTTP 200, leaving a paying customer marked unpaid or carrying stale subscription access. There is also no ordering protection against an older subscription event overwriting a newer state.

**Fix:** check every money-state write; acknowledge only after durable processing; deduplicate events and reconcile against the current Stripe object when ordering matters. Test database failure, duplicate delivery and reversed event order.

Evidence: [Stripe webhook](apps/flowstarter-main/src/app/api/webhooks/stripe/route.ts:67), particularly lines 130–138 and 392.

### 3. Generated builds execute with host filesystem access by default

**Confirmed unsafe default, not a demonstrated compromise.** Native validation runs generated Astro configuration and build scripts as the worker user. Removing secrets from child environment variables does not prevent that code from reading files accessible to the same user, including neighbouring workspaces or credential files.

**Fix:** require isolated validation in staging and production, with one workspace mount, resource limits, no host credentials or Docker socket, and restricted access to internal services. Add an adversarial build that tries to read another workspace and the worker’s configuration.

Evidence: [validator isolation](apps/build-worker/src/validator.ts:5); `apps/build-worker/src/config.ts:253` defaults to `native`.

### 4. Worker restart can strand paid work

**Confirmed recovery gap.** The queue is process-local. Startup does not recover queued jobs, and the claim rule excludes `running`. A crash after claiming leaves a job that a restarted worker will not claim; ordinary redispatch also refuses running jobs.

**Fix:** persisted leases, heartbeats, expiry-based recovery, bounded retry scheduling and startup reconciliation. Make interrupted publication idempotent. Prove recovery by killing the worker during generation and deployment.

Evidence: [queue](apps/build-worker/src/queue.ts:22), [claimability](apps/build-worker/src/job-store.ts:110), `apps/build-worker/src/index.ts:267`.

### 5. Production identity isolation is unfinished

The preview-environment document explicitly says production shares Clerk’s development instance until launch. In addition, the automatic admin fallback uses the primary email’s domain without checking its verification status, despite its comment promising a verified email.

**Fix:** create the separate production Clerk instance; prefer explicitly assigned operator roles. If domain-based elevation remains, require verified ownership and test unverified primary addresses and role removal.

Evidence: [role resolution](apps/flowstarter-main/src/lib/api-auth.ts:185), especially lines 224–227; `docs/preview-environment.md`, Auth.

### 6. Local preview content can execute on the application origin

**Conditional security defect when local-preview mode is enabled.** The frame proxy serves generated HTML from the app origin, while the funnel iframe allows both scripts and same-origin access. The proxy itself does not enforce a development-only environment. This makes generated content dangerous when a signed-in user opens it on that origin.

**Fix:** serve generated previews on a separate origin, or enforce an opaque sandbox with response-level restrictions. Refuse local-preview mode outside explicitly local development. Test that preview JavaScript cannot access the parent document or authenticated app APIs.

Evidence: [frame proxy](apps/flowstarter-main/src/app/api/discovery/preview/live/frame/[demoId]/[[...path]]/route.ts:44); `PreviewStep.tsx:1091`; `src/utils/security-headers.ts:158`.

### 7. Platform deployment does not preserve the previous healthy application

**Confirmed deployment defect.** `docker compose up --force-recreate` replaces the application before its health gate. Keeping the old Caddy snippet does not preserve the old container because it points at the same port. A failed deployment can leave production unavailable.

The runbook also reports that staging DNS still targeted the deleted host; I did not verify whether that has since been corrected.

**Fix:** start a candidate on another port, verify it, switch Caddy, retain the old container for rollback, and validate configuration before replacing snippets. Rehearse failure and rollback on the actual production topology.

Evidence: [platform deployment](deploy/hetzner-staging/scripts/deploy-slot.sh:153), particularly lines 157 and 188.

### 8. Email failure can permanently break onboarding

The recorded key is invalid. More fundamentally, notification failures are merely retryable if some caller invokes them again; there is no general delivery queue. Guest provisioning records completion even when welcome email fails, and subsequent webhook delivery takes a branch that does not resend it. The brief reminder module explicitly has no scheduler.

**Fix:** rotate credentials, verify delivery to a real inbox, implement a durable notification outbox and an operator resend action. Use a fresh access link rather than retaining a plaintext temporary password.

Evidence: [guest provisioning](apps/flowstarter-main/src/lib/flowstarter/guest-deposit.ts:110), lines 175–190; `client-notifications.ts:197`; `brief-reminder.ts:11`.

### 9. QA, payment and public launch are not one enforced transition

The final-invoice route checks deposit payment, not completed QA. `deploySite()` does not read payment or QA state. The local publisher deploys before the worker marks `HUMAN_QA`, and the operator lifecycle override checks adjacency rather than launch conditions.

**Fix:** separate review deployment from public launch. Add one deterministic launch command requiring approved build version, recorded QA, settled balance and valid care-plan state. Keep explicit emergency overrides audited.

Evidence: [final invoice](apps/flowstarter-main/src/app/api/admin/projects/[id]/billing/final-invoice/route.ts:72), [deploy workspace read](apps/flowstarter-main/src/lib/hosting/deploy.ts:275), `packages/agentic-codegen/src/flowstarter/workflows.ts:2416`.

### 10. Booking sync loses legitimate updates and acknowledges storage failures

**Confirmed by code and a direct rule probe.** A second `rescheduled` event is classified as replayed even if its time changed. A late `booked` event after `rescheduled` is accepted. Database failures can also be labelled replayed and acknowledged.

**Fix:** identify deliveries or compare versioned event data, apply updates atomically, and distinguish persistence failure from duplicates. Preserve the documented non-throwing contract by adding durable ingestion or reconciliation; do not silently change the fail-open policy.

Evidence: [booking rule](apps/flowstarter-main/src/lib/flowstarter/cal-webhook.ts:239), `bookings-data.ts:149`, and `api/integrations/cal/[workspaceId]/route.ts:128`.

## 4. Security review

**Database tenant isolation has meaningful safeguards.** `requireWorkspaceAccess()` verifies membership before service-role access, and `withTenant()` attaches workspace filters and rejects writes naming another workspace. The hardening migration revokes client write privileges on workspaces and memberships, while bookings and briefs have member-read/server-write models.

Evidence: [workspace authorization](apps/flowstarter-main/src/lib/api-auth.ts:287), [tenant query wrapper](apps/flowstarter-main/src/lib/tenancy.ts:134), [privilege hardening](supabase/migrations/20260909143500_tenant_isolation_hardening.sql:109).

I did not establish an ordinary client-to-client database disclosure in the paths inspected. That is narrower than certifying every route: many app queries use service-role clients, so authorization mistakes bypass RLS completely. Operator access is intentionally cross-tenant, making the role-resolution defect especially consequential.

| Surface | Assessment |
|---|---|
| Lead capture | Public insertion is intentional and does not return stored leads. However, arbitrary workspace IDs, reflected CORS, optional contact fields, unbounded extra fields and a process-local IP limiter make spam, tenant inbox pollution and resource abuse practical concerns. Add body limits, bounded schema, trusted-proxy IP handling, per-workspace limits and bot controls. `api/leads/capture/route.ts:13–38, 53–58, 106`. |
| Lead reading | The shared workspace authorization addresses the earlier cross-tenant list vulnerability. Keep the negative HTTP tests; public form submission is not authorization to read leads. `api-auth.ts:271`. |
| Cal.com webhook | HMAC verifies exact body bytes with a per-workspace secret and constant-time comparison. A signature for tenant A does not authorize tenant B. But any supplied signature header reaches a workspace lookup, yielding different unknown/existing responses before successful verification. Avoid treating header presence as authentication. `cal-webhook.ts:83`; webhook route lines 67–106. |
| Preview frame | The same-origin execution risk above is the important browser boundary. The authenticated editor is better isolated with `sandbox="allow-scripts"` at `components/flowstarter/editor/SiteEditor.tsx:251`. |
| Deploy agent | Bearer authentication, slug validation, per-slug mutation locks and rejection of archive traversal/link entries are good controls. The token authorizes the whole host, not one tenant, so compromise has fleet-level impact. |
| Artifact fetching | The agent fetches URLs with default redirect behaviour, no explicit timeout and whole-response buffering. HTTPS-only validation upstream is not a destination allowlist. Bound download and decompression sizes, require checksums, restrict destinations and validate redirects. `apps/deploy-agent/src/index.ts:336`; `tar-safety.ts:16`. |
| Uploaded assets | The brief route checks every referenced asset against the authorized workspace before saving. Preserve this when wiring assets into full builds. `api/client/brief/[workspaceId]/route.ts:194`. |

**Secrets:** positive patterns include server-side credentials, mode-0600 host files, bounded agent file tools and scrubbed build environments. Remaining problems are filesystem access during native builds and capability URLs entering logs: `local-publisher.ts:88` logs the complete artifact URL, whose random path token is its access credential. Log an artifact identifier and hash instead, expire URLs, and redact signed query strings from errors.

The supplied host run documents separate preview/site secrets and loopback-bound agents behind TLS. Those are recorded deployment facts, not configuration I independently checked today.

## 5. Reliability

**Generation works, but its success rate is unknown.** One approximately nine-minute preview and one repaired approximately thirteen-minute paid build are evidence of feasibility, not a reliable completion percentage or latency distribution. The preview path has deadlines, fallback models and a watchdog; the full-build workflow has bounded repair passes. A three-attempt budget is not an automatic retry scheduler.

**The build gates now catch several expensive defects.** Current code validates compilation, binary assets, teaser removal, approved edits, page budget and placeholder copy. The false `.astro` phrase rejection and rebuild-validation bypass are fixed in current history, so they should not be reported as still-open bugs.

The factual-content gate remains incomplete: it runs only when `job.intake.projects` contains names, while the new brief projects never reach that input. The no-projects case also needs explicit omission behaviour. The supplied site still demonstrated invented work, an empty testimonial section, “0Minutes”, and a footer link to an absent page. Human QA must inspect actual rendered output and truthfulness, not merely accept compilation.

Evidence: [project-content gate](packages/agentic-codegen/src/flowstarter/workflows.ts:2385).

**Customer-site deployment is stronger than platform deployment.** Site containers use readiness checks, staged replacement, rollback, read-only filesystems, dropped capabilities, memory/PID limits and restart policies. The Hetzner run actually exercised readiness failure and rollback before the successful redeploy.

**The permanent publishing path still needs proof.** The demonstrated build ran on a laptop and supplied artifacts through a temporary reverse tunnel. The GitHub publisher opens a draft PR and returns a templated staging URL; that alone does not prove the artifact is deployed. Rehearse with the permanent worker, reachable artifact storage and production domain configuration.

**On reboot:**

- Completed site containers should restart through `unless-stopped`; Caddy and deploy agents have enabled service/restart configuration.
- In-flight and waiting worker jobs need the recovery work described above.
- Live-preview job state disappears because it is stored in a process-local map. Durable preview manifests do not restore the interactive session automatically.
- Temporary tunnels disappear. A completed deployment does not need the tunnel, but the next laptop-originated deployment does.
- I found no demonstrated full-host restore or database-and-assets recovery exercise.

One host is workable for the first supervised customer, but it is one failure domain. The runbook records a **40 GB disk**, and the platform Compose file has no explicit memory limit despite the capacity plan calling for limits. Add resource budgets, disk alerts, image/artifact retention and off-host backups before adding database and booking workloads.

## 6. Test and CI assessment

**What the configured quality gate establishes when green:**

- Main-app typechecking.
- Unit suites and coverage enforcement for main, codegen and worker.
- Coverage ratchet enforcement.
- Local Postgres/PostgREST tenant tests with migrations and storage checks.
- Worker query-filter regression checks.

The recorded line-coverage floors are **47.61% main, 71.47% codegen and 90.29% worker**. These are floors, not fresh measurements from this review. Sensitive glob thresholds are stronger, but aggregate coverage cannot prove that two individually tested modules are connected.

Evidence: [quality workflow](.depot/workflows/quality-gate.yml:75), [coverage floors](coverage-floors.json).

**Important limits:**

- Lint is advisory.
- The displayed workflow does not separately typecheck worker/codegen or run deploy-agent tests.
- RLS verification mints local Clerk-shaped JWTs. It does not prove production Clerk configuration.
- Smoke and authenticated checks can skip when infrastructure or credentials are absent.
- Daily QA checks useful surfaces, but its intake canary checks generation starts, not full delivery.
- The supplied showcase drivers include untracked files in this working tree. They are valuable evidence, but not automatically reproducible CI coverage.
- Neither coverage nor a homepage 200 proves paid delivery, recurring billing, email receipt, reboot recovery or restoration.

I ran `node scripts/mvp-readiness.mjs`: it reported **0 of 16 journeys ready, 0 of 5 money journeys ready** using existing local coverage files and no supplied Playwright report. That is a proof-coverage result, not “the product is 0% implemented.”

The score has weaknesses: merely existing specs can count green, production evidence is inferred from source-text route mentions, and the journey manifest predates the brief flow, bookings and completed change builds. Missing-route validation also returns early when no coverage summary exists.

Evidence: [readiness scoring](scripts/mvp-readiness.mjs:171), lines 266–285 and 298–323.

## 7. Launch checklist

### Code and verification work

Estimates are focused engineer-days, including targeted tests. Some work overlaps.

| Work | Estimate | Exit condition |
|---|---:|---|
| Connect brief submission, build input and rights-cleared assets | 2–3 days | New customer completes brief and exactly one build uses its actual contents. |
| Durable worker dispatch, leases and restart recovery | 2–3 days | Queued and interrupted jobs recover without SQL repair. |
| Stripe persistence, replay/order handling and invoice safeguards | 2–3 days | Failed writes retry; stale events cannot regress payment/access state; invoices are not duplicated. |
| Isolated builds, explicit admin roles and preview-origin boundary | 2–3 days | Adversarial tests cannot read another workspace, host secrets or parent app state. |
| Durable email delivery, resend and brief reminders | 1–2 days | Guest receives access; failed notices retry visibly. |
| Review-versus-launch gate and safe platform rollback | 2–3 days | Unapproved/unpaid output cannot become the normal public launch; bad release leaves old app working. |
| Cal.com correctness, if retained | 1–2 days | Create, two reschedules, cancel, duplicates and storage failure reconcile correctly. |
| Generated-site QA and current full-journey rehearsal | 2–3 days | Real form submission, honest content, correct links, edit/rebuild, payment and inbox evidence on one pinned commit. |

For a reduced pilot, overlap the recovery and brief work, defer Cal.com, and handle refunds manually with an explicit runbook. That is the basis for the **12–20 day** estimate.

The final rehearsal should use two independent clients, with one deliberately attempting cross-workspace reads and asset references. Complete at least two clean journeys without hidden SQL changes, including a worker restart and a failed deployment.

### Owner actions for Darius

- **Clerk:** create and configure the production instance, verified domains, explicit operator accounts, webhook and production JWT integration. Keep preview identities separate.
- **Stripe:** complete business/account setup, create the production configuration outside the repository, configure webhook delivery, and authorize a small real charge/refund rehearsal when code is ready. Keep development and CI in test mode.
- **Resend:** rotate the invalid key, verify the sender domain and prove receipt in external inboxes, including welcome/access mail.
- **Database:** decide whether production remains managed or moves to self-hosting. Require off-host backups and a tested restore of both database and uploaded assets; do not put the only backup on the application host.
- **DNS and hosting:** confirm staging points to the surviving host, update Depot SSH configuration, prepare the production slot and `.flowstarter.net` customer hostname path, and resolve the 40 GB disk decision.
- **Operations:** confirm permanent worker supervision, artifact reachability, alerts, recovery ownership and a way to migrate a site between hosts. The current allocation error tells operators to decommission, but the product lacks that endpoint.
- **Commercial/legal copy:** approve one consistent offer, deposit/balance schedule, care-plan allowance, cancellation/refund terms, privacy and retention policy, asset-rights statement and support commitment. Have the accountant/legal adviser resolve jurisdiction-specific invoicing requirements.
- **Pilot contract:** choose a service-site customer with a fixed scope and a named human reviewer. Promise only features demonstrated in the final rehearsal.

## 8. Three things to cut to launch sooner

1. **Commerce, Shopify and broad custom builds.** Sell one constrained Astro service-site package first. The strongest evidence is for that delivery path; the broader master-document offer expands obligations beyond what these runs prove.

2. **Automated quoting and checkout for structural changes.** Hide the paid larger-change purchase path initially. Accept a request for human review and quote only work you can deliver under the pilot process. #103 is implemented, but the recorded €190 journey still lacks delivery proof.

3. **Cal.com synchronization and self-hosting.** Offer a verified external booking link for the pilot, or omit bookings for the first customer. Defer webhook-derived dashboard counts and another stateful application until repeat rescheduling, reconciliation and operations are proven.
---

Produced 2026-09-12 by OpenAI Codex CLI 0.154.0 with the gpt-6-astra model in a read-only sandbox, on request from Darius, against main at 98033314. Findings are being worked as PRs; see the follow-up PRs referencing this file.
