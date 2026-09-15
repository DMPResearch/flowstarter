# Next steps

**Date:** 2026-09-15

This file used to describe a Convex schema refactor and a LangGraph orchestration rewrite that were never built. It now lists the actual open items from the two 2026-09-13 security audits' own prioritised fix lists (`docs/security/audit-2026-09-13-claude.md`, `docs/security/audit-2026-09-13-codex.md`) and from the 2026-09-12 MVP readiness checklist (`docs/quality/mvp-readiness-2026-09-12.md`), minus everything a merged PR already closed. Where an item is already partly addressed, the PR that did it is named. See `docs/FLOWSTARTER_MASTER_DECISIONS.md` for what the product is; this file is only what is left to do on it.

Owner is "code" where an agent or Darius can do it in the repository, "Darius" where it needs an account, a signature, a decision, or a box only he can reach.

---

## Security: still open after PRs #133 to #146

Both 2026-09-13 audits found real problems, and a run of follow-up PRs closed most of the Critical and High findings (see `docs/FLOWSTARTER_MASTER_DECISIONS.md`, "Security Posture", for the summary of what closed). These did not:

| # | Item | Source | Owner |
|---|---|---|---|
| 1 | Rotate the credentials in `infra/authentik/.env` (live-format Resend key, Postgres password, Authentik signing key) and purge the file from git history | Claude audit, C1 | Darius |
| 2 | Remove `E2E_SECRET` from `prod.env` | Claude audit, L8 | Darius |
| 3 | Separate staging and production secrets, starting with the deploy-agent bearer token; stop the staging slot auto-deploying unreviewed PR code with production-shaped credentials | Claude audit, C3; Codex audit, F08 | Darius + code |
| 4 | Move tenant sites to a separate registrable domain from the platform and Cal.com | Claude audit, H1 | Darius, infra decision measured in weeks |
| 5 | Create the Clerk production instance; stop sharing the development instance between production and previews | Claude audit, H5; `docs/preview-environment.md`, "Auth" | Darius + code |
| 6 | Restrict client-site container network egress at runtime (the build step is isolated; the running container is not) | Claude audit, H6 | code |
| 7 | Hash-based CSP for the platform app itself (client sites got a real one in #134; the platform app's own CSP still allows `'unsafe-inline'` for scripts and computes a nonce it never uses) | Claude audit, M3 | code |
| 8 | Take the two Next.js slots off host networking and root, add resource limits; move the Caddy admin API to a unix socket | Claude audit, M5 | code |
| 9 | Add a destination allowlist to the deploy-agent's artifact fetch (timeouts and decompression bounds were fixed by #139; the allowlist was not) | Claude audit, M6 | code |
| 10 | HMAC-sign the generated-markup managed-block marker (`data-flowstarter-*`) so generated code cannot forge it; named as a known residual in #134's own description | Claude audit, M7 | code |
| 11 | Digest-pin and `cosign`-verify container images instead of pulling by mutable tag | Claude audit, M8; Codex audit, F16 | code + CI |
| 12 | Split the AI review workflow so it does not run untrusted PR code and hold credentials in the same job | Claude audit, M9 | CI |
| 13 | Recipient-scoped email limits (the funnel will currently email any address an anonymous caller names) | Claude audit, M10 | code |
| 14 | Separate SMTP credential for Cal.com; commit an SPF/DKIM/DMARC record for the sending domain | Claude audit, M11 | Darius + infra |

---

## Launch readiness: still open from the 2026-09-12 checklist

Most of the 19 "must do before taking money from a stranger" items and the 11 "should do before the second customer" items are closed; the ones below are not, as of this revision.

| # | Item | Source | Owner |
|---|---|---|---|
| 1 | Add error tracking (Sentry or equivalent) to `flowstarter-main` and `build-worker`, with a real alert destination | Readiness checklist #3; `docs/operations/alerts.md`, "What still needs Darius" | Darius (vendor + account) + code |
| 2 | External uptime monitoring on `flowstarter.net` and deployed client sites, paging Darius | Readiness checklist #5; `docs/operations/alerts.md` | Darius |
| 3 | Actually rehearse the backup restore drill once, on a disposable host, before the first paying customer (the backup and restore scripts exist and are tested; the drill itself has not been run for real) | Readiness checklist #6; `docs/operations/backups.md`, "The drill" | Darius |
| 4 | ~~Build the refund path, or soften the 50% refund promise on the terms page and the landing page until it exists~~ **Done, PR #170.** "Refund setup fee" on the operator billing tab refunds through Stripe, writes a `billing_refunds` ledger row, and emails the client. Left for Darius: confirm 30 days / 50% are still the numbers he wants now that keeping the promise is one button. | Readiness checklist #10; `docs/FLOWSTARTER_MASTER_DECISIONS.md`, "Refund Policy" | Darius (confirm the window) |
| 5 | Verify inbound mail to `hello@`, `legal@`, and `privacy@` actually arrives | Readiness checklist #12 | Darius |
| 6 | Legal pass. **Code complete as of PR #170**: the subprocessor table names Cal.com and drops Plausible/Calendly, the DPA sentence now states where each vendor publishes its terms instead of claiming eight signatures, and both the terms and privacy pages show "Operator identity pending registration" until all six `FLOWSTARTER_LEGAL_*` values are set. What is left is not code: supply the six values and confirm the entity structure with counsel. | Readiness checklist #14; `docs/FLOWSTARTER_MASTER_DECISIONS.md`, "Open Decision Points" #3 | Darius + counsel |
| 7 | ~~Enforce the five data-retention periods the privacy page describes, or restate them as intentions rather than facts~~ **Done, PR #170.** The privacy page now publishes only the two windows a reaper actually enforces, read from the same env vars the reapers read; every other retention claim was restated as "until you ask." | Readiness checklist #15 | -- |
| 8 | Provision a real `ARCJET_KEY` value in the production and staging environments (the code now refuses to boot on the unprotected rate-limit tier in staging/production; the key itself still needs to exist) | Readiness checklist #16; fixed in code by #141 (H2) | Darius |
| 9 | Raise `DISCOVERY_FUNNEL_BUDGET_EUR` to a number that will not block a real customer (the cap now fails closed on accounting errors instead of open; the number itself is still the placeholder) | Readiness checklist #17; fixed in code by #141 (H4) | Darius |
| 10 | Write the first-customer runbook: what an operator does at each build state, what human QA is, what to do when a build fails | Readiness checklist #19 | Darius, transcribed by code |
| 11 | Confirm a real paid change request delivers to the client end to end (the `PAGE_BUDGET_EXCEEDED` false positive that blocked every recorded attempt is fixed by #132 and #146). Two fresh recorded runs exist since, both reaching delivery with defects that are now fixed rather than being blocked outright: job `7508bf52` (an `INVENTED_PROJECT` false positive on a real section heading, plus a corrupted lead-capture class fed back from a stale approved phrase) closed by PR #173 and PR #169; job `c8f48c1e` on workspace `c009105e` (a paid change placed on the wrong case study because its uploaded screenshots carried no caption) closed by PR #164's caption-on-the-way-in gate. Still open: no run since these fixes has been recorded end to end with zero defects. | Readiness checklist #20 | code / QA run |
| 12 | Confirm whether a decommission endpoint exists for a Hetzner hosting server; the readiness review found none | Readiness checklist #22 | code |
| 13 | Let the client's own balance-payment CTA appear once a project has passed QA (as of the 2026-09-12 review it was gated on `HUMAN_QA` in a way that only the operator's invoicing flow could reach) | Readiness checklist #26 | code |
| 14 | Repoint or retire the dangling `staging.*` DNS records and the `local-dev` leftover host allocation | Readiness checklist #27 | Darius |
| 15 | Re-check the specific content defects the 2026-09-12 run shipped ("0Minutes", an empty testimonials section, a footer link to an absent `Services` page) against current output; #97 gates several defect classes but predates this run | Readiness checklist #30 | code / QA |

---

## Contradictions found while reconciling this document

1. ~~**The unlock page still quotes a 10% "holds the slot" deposit next to a 20% checkout.**~~ **Done.** The copy went in PR #156; PR #162 removed the model behind it -- `BOOKING_DEPOSIT_PERCENT`, `CUSTOM_BOOKING_DEPOSIT_EUR`, `bookingDepositAmount`, `bookingDepositFor`, the `/api/discovery/deposit` route and its two Arcjet limiter definitions, and the `kind=booking_deposit` Stripe handler. Nothing in the funnel had ever called that route. The custom-work discovery call the question asked about is free and is booked on the self-hosted Cal.com through `/discovery-call`; it never wanted a deposit.
2. **Add-on edit packs are sold in the FAQ and the terms page with no purchase path.** See `docs/FLOWSTARTER_MASTER_DECISIONS.md`, "Editor and Constrained Edits."

---

## Not doing

| Item | Reasoning |
|---|---|
| **The gretly engine**, integrated into Flowstarter | Not implemented inside Flowstarter. Its orchestration shape (planner, dispatcher, worker waves, validator) was already ported into `packages/build-orchestrator` and `packages/agentic-codegen`, which run in production today; both packages say so in their own `package.json` descriptions. A separate gretly integration would duplicate a working system for no new capability. |
| **FlowOps**, integrated into Flowstarter | Same reasoning as gretly: not implemented inside Flowstarter, folded into the same ported orchestration packages. Revisit only if DMPResearch's custom-work delivery (the discovery-call routing in progress) turns out to need external agents that FlowOps would broker; nothing in the shipped self-serve funnel needs it. |
| **Convex schema refactor** | The shipped product's conversation and project state already lives in Supabase (`workspaces`, `flowstarter_agent_jobs`, `funnel_previews`, and related tables), with row-level security that both 2026-09-13 audits rated as the strongest part of the system. Migrating that to Convex would trade a proven, tenant-isolated store for an unproven one, with no product requirement driving the move. |
| **Daytona previews** | Dropped by PR #132 after Daytona's API key was revoked on 2026-09-12 and took down every preview in production. Previews now publish on Flowstarter's own platform by default; Daytona remains available only as an operator-named fallback (`FLOWSTARTER_PREVIEW_PUBLISHER=daytona`), not the default path. |
