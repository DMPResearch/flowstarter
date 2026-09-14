# Next steps

**Date:** 2026-09-14

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
| 4 | Build the refund path, or soften the 50% refund promise on the terms page and the landing page until it exists | Readiness checklist #10; `docs/FLOWSTARTER_MASTER_DECISIONS.md`, "Refund Policy" | code + Darius decides which |
| 5 | Verify inbound mail to `hello@`, `legal@`, and `privacy@` actually arrives | Readiness checklist #12 | Darius |
| 6 | Legal pass: entity name, registration number, and address on the terms page; remove the Plausible mention if unused; name Cal.com, remove any leftover Calendly reference; confirm or remove the DPA claim | Readiness checklist #14 | Darius + counsel |
| 7 | Enforce the five data-retention periods the privacy page describes, or restate them as intentions rather than facts | Readiness checklist #15 | code or Darius |
| 8 | Provision a real `ARCJET_KEY` value in the production and staging environments (the code now refuses to boot on the unprotected rate-limit tier in staging/production; the key itself still needs to exist) | Readiness checklist #16; fixed in code by #141 (H2) | Darius |
| 9 | Raise `DISCOVERY_FUNNEL_BUDGET_EUR` to a number that will not block a real customer (the cap now fails closed on accounting errors instead of open; the number itself is still the placeholder) | Readiness checklist #17; fixed in code by #141 (H4) | Darius |
| 10 | Write the first-customer runbook: what an operator does at each build state, what human QA is, what to do when a build fails | Readiness checklist #19 | Darius, transcribed by code |
| 11 | Confirm a real paid change request delivers to the client end to end (the `PAGE_BUDGET_EXCEEDED` false positive that blocked every recorded attempt is fixed by #132 and #146; no fresh recorded run has proven delivery since) | Readiness checklist #20 | code / QA run |
| 12 | Confirm whether a decommission endpoint exists for a Hetzner hosting server; the readiness review found none | Readiness checklist #22 | code |
| 13 | Let the client's own balance-payment CTA appear once a project has passed QA (as of the 2026-09-12 review it was gated on `HUMAN_QA` in a way that only the operator's invoicing flow could reach) | Readiness checklist #26 | code |
| 14 | Repoint or retire the dangling `staging.*` DNS records and the `local-dev` leftover host allocation | Readiness checklist #27 | Darius |
| 15 | Re-check the specific content defects the 2026-09-12 run shipped ("0Minutes", an empty testimonials section, a footer link to an absent `Services` page) against current output; #97 gates several defect classes but predates this run | Readiness checklist #30 | code / QA |

---

## Contradictions found while reconciling this document

1. **The unlock page still quotes a 10% "holds the slot" deposit next to a 20% checkout.** `apps/flowstarter-main/src/app/(dynamic-pages)/(main-pages)/unlock/[workspaceId]/page.tsx` imports `BOOKING_DEPOSIT_PERCENT` (10) from `discovery.logic.ts` and prints it in one sentence, while the page's actual Checkout button charges 20% (`depositAmountMinor`), and a second sentence a few lines down correctly says 20%. Leftover from the pre-call booking-deposit model that was never shipped; needs a code fix to remove the 10% sentence and the now-unused `BOOKING_DEPOSIT_PERCENT` / `bookingDepositFor` / `/api/discovery/deposit` code path, or to explain what that path is actually for if it is being kept for the custom-work discovery call.
2. **Add-on edit packs are sold in the FAQ and the terms page with no purchase path.** See `docs/FLOWSTARTER_MASTER_DECISIONS.md`, "Editor and Constrained Edits."

---

## Not doing

| Item | Reasoning |
|---|---|
| **The gretly engine**, integrated into Flowstarter | Not implemented inside Flowstarter. Its orchestration shape (planner, dispatcher, worker waves, validator) was already ported into `packages/build-orchestrator` and `packages/agentic-codegen`, which run in production today; both packages say so in their own `package.json` descriptions. A separate gretly integration would duplicate a working system for no new capability. |
| **FlowOps**, integrated into Flowstarter | Same reasoning as gretly: not implemented inside Flowstarter, folded into the same ported orchestration packages. Revisit only if DMPResearch's custom-work delivery (the discovery-call routing in progress) turns out to need external agents that FlowOps would broker; nothing in the shipped self-serve funnel needs it. |
| **Convex schema refactor** | The shipped product's conversation and project state already lives in Supabase (`workspaces`, `flowstarter_agent_jobs`, `funnel_previews`, and related tables), with row-level security that both 2026-09-13 audits rated as the strongest part of the system. Migrating that to Convex would trade a proven, tenant-isolated store for an unproven one, with no product requirement driving the move. |
| **Daytona previews** | Dropped by PR #132 after Daytona's API key was revoked on 2026-09-12 and took down every preview in production. Previews now publish on Flowstarter's own platform by default; Daytona remains available only as an operator-named fallback (`FLOWSTARTER_PREVIEW_PUBLISHER=daytona`), not the default path. |
