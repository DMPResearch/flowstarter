# Flowstarter: Master Decision Document

*Consolidated snapshot of strategic, technical, and pricing decisions, reconciled against shipped code.*

**Date:** 2026-09-15 (reconciled against PRs #158, #160, #162 through #174, merged overnight 2026-09-14/15)
**Status:** Describes the live product. Superseded the May 2026 concierge draft, which described a discovery-call deposit, 50/50 founding milestones, and a Max tier that were never shipped in this form.
**Authority:** This document is the **source of truth** for code agents. If a request contradicts a decision here, flag the contradiction rather than silently overriding it. Section 10 lists the contradictions this revision itself found and did not resolve in code.

---

## Table of Contents

1. [About Flowstarter](#about-flowstarter)
2. [The Self-Serve Funnel](#the-self-serve-funnel)
3. [Technical Stack](#technical-stack)
4. [Editor and Constrained Edits](#editor-and-constrained-edits)
5. [Pricing](#pricing)
6. [Hosting, Previews, and Cal.com](#hosting-previews-and-calcom)
7. [Backups and Alerting](#backups-and-alerting)
8. [Security Posture](#security-posture)
9. [Open Decision Points](#open-decision-points)
10. [Contradictions Flagged by This Revision](#contradictions-flagged-by-this-revision)

---

## About Flowstarter

Flowstarter builds and maintains websites for businesses that need a professional online presence without hiring a developer. The product is **self-serve with operator supervision**: a prospect answers four questions and gets a generated preview with no human in the loop; a human (Darius, and Dorin for design and client relationships) reviews the build before it goes live and handles anything outside the client editor's scope.

Work that does not fit the self-serve funnel (bespoke integrations, scope a template cannot express) routes to a **DMPResearch custom-work discovery call**. The routing half of that shipped in PR #162: after the four quick questions and before any generation, `classifyScope` reads the answers and the title of the linked page, `decideRoute` turns that verdict into `self-serve`, `discovery-call` or one clarifying question, and a `custom` brief is offered a free call on the self-hosted Cal.com instead of a build it would spend a generation run getting wrong. The acceptable-use guardrail merged as PR #158 and is wired into `decideRoute`: a `refuse` verdict falls through to the funnel's own refusal copy rather than a sales call, and a `review` verdict routes to the call so a person reads it. Both heads can run on `@flowstarter/sigma-core` / `@flowstarter/sigma-flowstarter` (PR #160), with built output and retrained centroids from PR #167 and the encoder model baked into the Hetzner slot image by PR #172. Staging runs both flags on (`ACCEPTABLE_USE_SIGMA=true`, `SCOPE_SIGMA=1`); production gets them at the same infrastructure cutover that moves Clerk, Stripe and Cloudflare to their production settings (see Open Decision Points).

### Two Market Segments

- **Service businesses** (coaches, consultants, photographers, freelance creatives) on Astro-based sites.
- **E-commerce merchants**, sized by the Ecommerce/Commerce tier below.

### Pricing and Invoicing

**All prices are displayed in EUR** on the marketing site, one set of prices for every market. For Romanian clients, invoicing is done in RON at the BNR (National Bank of Romania) exchange rate on the invoice date, a Romanian legal requirement handled in back-office accounting software only; it does not change what a client sees on the site.

---

## The Self-Serve Funnel

This is what a client actually walks through today, in order:

1. **Four quick questions.** The intake wizard (`apps/flowstarter-main/src/app/(dynamic-pages)/(main-pages)/components/discovery`) collects business name, what the business sells, tone, and optional public profile links.
2. **A generated preview**, built by the agentic codegen pipeline and published on Flowstarter's own platform (see [Hosting, Previews, and Cal.com](#hosting-previews-and-calcom)). No payment happens before this.
3. **Two free edits** on the preview, server-enforced (`LIVE_EDIT_CAP = 2`), before any money changes hands.
4. **A 20% deposit** to start the full build. There is no pre-call booking deposit, in this flow or anywhere else: the discovery call is free, and the route, constants and Stripe handler that once implemented one were removed in PR #162.
5. **A brief**, filled in by the client after the deposit: the offer, real projects, photographs, and design references. The build worker will not run the paid build until the brief is ready or an operator waives it (`waiting_brief` job state, `docs/preview-environment.md`, "Deposit to build").
6. **The build**, with gates: compilation, binary-asset checks, teaser removal, approved-edit conformance, page-budget rules derived from the brief, placeholder-copy detection, an invented-project gate, and (since PR #134) a markup-safety gate over the generated HTML.
7. **An 80% balance**, due after human QA and the client's approval, before launch.
8. **A care plan** (the post-launch subscription): hosting, domain renewal, maintenance, support, and a monthly editor allowance. See [Pricing](#pricing).
9. **Cal.com bookings**, self-hosted by the platform, for the client's own site.
10. **Lead capture** on every delivered site, into that client's own workspace.
11. **Custom-work routing** to the DMPResearch discovery call, for anything outside what the self-serve funnel can build (PR #162), gated by the acceptable-use guardrail beside it (PR #158, sigma-wired via PR #160/#167/#172); see "About Flowstarter" above.

### Technical Defaults

- **Astro** is the default and the only path the self-serve funnel generates today.
- **Shopify Liquid** remains an option an operator can pick when creating a project by hand (`apps/flowstarter-main/src/app/(dynamic-pages)/admin/dashboard/new`), for a client who already runs Shopify and does not want to migrate. It is not part of the self-serve funnel's generation pipeline.

---

## Technical Stack

- **Generation:** `packages/agentic-codegen`, described in its own `package.json` as "a gretly-light orchestrator (Sonnet brain plans and critiques, an implementation model builds) over OpenRouter, in a bounded sandboxed ephemeral workspace." Reused by the free preview and the paid build.
- **Orchestration:** `packages/build-orchestrator` is the newer, general task-graph engine (planner, dispatcher, worker waves, validator), with ideas explicitly ported from `gretly` and `ask-sage` per its own `package.json` description. See section 9 for what is and is not built on top of it.
- **Auth:** Clerk. Production currently shares Clerk's **development** instance with every preview environment; moving production to its own Clerk production instance is an open, explicitly flagged launch blocker (`docs/preview-environment.md`, "Auth").
- **Database:** Supabase Postgres with row-level security. Production uses the **hosted** Supabase project. Staging, every PR preview slot, and local development use a Supabase CLI stack, either on a developer's own machine or running on the Hetzner box itself over loopback; production never runs the CLI stack and the CLI stack is never pointed at from outside the host it runs on (`docs/preview-environment.md`, "Database").
- **Payments:** Stripe. Test mode only, everywhere, until an operator deliberately switches production to live mode; see the project's security constraints.
- **Hosting:** see [Hosting, Previews, and Cal.com](#hosting-previews-and-calcom).

---

## Editor and Constrained Edits

After delivery, a client edits their own site through a constrained AI editor. What they can change and how much of it is metered is enforced by `apps/flowstarter-main/src/lib/flowstarter/edit-credits.ts`, not by this document:

- **Starter:** 50 edits included per UTC calendar month.
- **Pro, Max, Ecommerce:** 150 edits included per UTC calendar month. No separate published number exists for Max or Ecommerce, so both sit at the Pro figure by design (giving a more expensive plan fewer edits than Pro would be the wrong failure mode).
- **Admin** (internal, unmetered): no cap.
- An unrecognised or cleared `tier_name` resolves to the Starter allowance, never to unlimited.
- The allowance resets on the first of the UTC month. A daily burst cap in `site-editor.ts` is separate and unrelated to what a client bought.

**Add-on packs are marketing copy only; there is no purchase path.** The FAQ and the terms page both describe "EUR 15 a month for another 25 edits, up to EUR 45 a month for 100 more." `edit-credits.ts` accepts an `addOnCredits` parameter for exactly this, but its own comment states the fact plainly: "nothing sells them yet and no column holds them, so this is a number a caller may pass and every caller currently passes 0." The exhausted-credits message deliberately does not link anywhere, because there is nowhere to send a client to buy more. **Flagged for Darius:** either build the add-on purchase path, or remove the add-on copy from the FAQ and the terms page until it exists.

### Operator Editor

As of PR #171, the team has a second, larger surface the client-facing editor above does not: **the team builds whole features in the editor; clients make small changes with escalation to the team for anything larger.** An operator opens a project into a full coding-agent session (`apps/flowstarter-editor`) with a real filesystem, no page budget and no repair pass, because a person is at the keyboard rather than an unattended agent. Shipping a session's changes still runs the same build gates every other path runs (#110, #128, #134, #142, #165), and a session cut from a version the client has since published past is refused outright rather than merged. See `docs/operations/operator-editor.md` for the runbook and what remains to deploy it (the editor image, the host env file, the control-plane secret).

---

## Pricing

Prices below are read from `landing-copy.ts`, `LandingPricing.tsx`, `discovery.logic.ts`, `edit-credits.ts`, and the terms page, all in `apps/flowstarter-main/src`. This section mirrors the code; do not change the code by editing this table.

### Setup Fees: one-time build package

| Build package | From | Notes |
|---------------|------|-------|
| Starter (service site) | €799 | Astro service site |
| Pro | €1,199 | More pages, integrations |
| Commerce / Ecommerce | €1,499 | Store build, open to everyone |
| Custom | €2,499 (from) | Scoped on the DMPResearch discovery call |

### Milestone Split: one scheme, not two

**20% to start the build, 80% on approval and launch.** This is the only milestone scheme in the shipped product. There is no 50/50 founding-client split and no 4x25% standard split; that language in the May 2026 draft never shipped and should not be reintroduced without an explicit new decision. Source: the pricing section's payment-terms copy, the terms page ("Setup fees are split: 20% to start, 80% on launch"), and `depositAmountMinor`/`balanceAmountMinor` in `packages/agentic-codegen/src/flowstarter/state-machine.ts`, which both the deposit Checkout and the unlock page compute against.

### Care Plan: the monthly subscription, chosen separately from the build

| Plan | Price | Edit allowance | Store ops |
|------|-------|-----------------|-----------|
| Starter care | from €49/mo | 50/mo | none |
| Pro care | €99/mo (most chosen) | 150/mo | none |
| Store care (Ecommerce) | €129/mo | 150/mo | Products + collections |
| Custom software | custom quote | n/a | Scoped per client |

**Max is not a tier a client can buy.** It exists in code (`SubscriptionTier` in `discovery.logic.ts`, `EditTierKey` in `edit-credits.ts`) as an internal key that resolves to the same 150-edit allowance as Pro, but it is not shown on the pricing page and there is no published price for it. Treat it as reserved, not as a sellable tier, until a decision says otherwise.

First month of the care plan is free.

### Refund Policy: built, and now stated in one place

**50% of the setup fee, within 30 days of launch, no questions asked.** Both numbers live in `apps/flowstarter-main/src/lib/billing/refund-policy.ts` and nowhere else: the landing hero and the terms page generate their sentence from it, and the operator's refund action reads the same values to decide what it may send. Changing the promise means changing `FLOWSTARTER_REFUND_WINDOW_DAYS` / `FLOWSTARTER_REFUND_PERCENT` (and their `NEXT_PUBLIC_` twins, which is all the browser bundle can read), not editing prose.

The path exists as of this revision. "Refund setup fee" on the operator console's billing tab takes a required reason, refunds through Stripe against the balance payment intent first and the deposit second, writes a `billing_refunds` ledger row per payment intent, emails the client, and is idempotent per payment intent by a unique index. A refund outside the guarantee (before launch, after the window, or for a different amount) is allowed only with a written override reason, which is stored. The webhook's `charge.refunded` handler now writes `workspaces.refunded_amount_minor` and `refund_status`, so a refund made by hand in the Stripe dashboard is also visible in the product.

**Still for Darius:** confirm that 30 days and 50% are the promise you want to keep now that keeping it is one button. They are the published defaults and nothing has changed them.

### Billing Rules

- All prices in EUR, one set for all markets; RON invoicing for Romanian clients is back-office only.
- The one-time build is billed 20% to start, 80% on approval and launch (see above); this is the admin-side deposit/final-invoice flow in `src/lib/billing/stripe.ts`.
- The care plan is a separate Stripe subscription, first month free, chosen independently of the build package.
- Cancellation: 30 days notice by email; the site stays live through the end of the paid period.

---

## Hosting, Previews, and Cal.com

**Hosting runs on Hetzner, not Netlify, not a hosted-Vercel-style platform.** One Hetzner box (`fs-sites-01`) runs production, staging, every open PR's preview slot, and every deployed client site, each as a Docker container behind Caddy. See `docs/release-process.md` and `docs/preview-environment.md` for the full topology; do not restate the details here, only the shape:

- **Production:** slot `prod`, `flowstarter.net` and `www.flowstarter.net`, container `flowstarter-prod`, the **hosted** Supabase project, behind Cloudflare (proxied).
- **Staging:** slot `main`, `staging.flowstarter.dev`, redeployed on every merge to `main`, backed by the Supabase CLI stack running on the box itself.
- **Per-PR previews:** slot `pr-<n>`, `pr-<n>.staging.flowstarter.dev`, destroyed when the PR closes, same staging database.
- **Client sites:** `{slug}.flowstarter.net` in production (or a custom domain later), deployed through the per-host deploy-agent, which extracts the built artifact, writes the Caddy snippet, and claims the site's DNS record.
- **Funnel previews:** `{slug}.preview.flowstarter.dev` in staging, `.net` in production, published by the same deploy-agent and hosting client the post-claim deploy uses, with teaser blur, `noindex`, and a 14-day expiry.

**Previews publish on the platform, not Daytona.** Before PR #132, "publishing your live preview" depended on a Daytona sandbox; when its key was revoked on 2026-09-12, every preview in the funnel failed. Previews now build statically (the same `astro build` the paid build worker runs) and publish through the platform's own deploy-agent by default. Which publisher runs is a rule (`preview-publisher-rule.ts`): `platform` by default, `daytona` only if an operator explicitly sets `FLOWSTARTER_PREVIEW_PUBLISHER=daytona`, `local-static` on a developer machine with no previews host configured. Daytona is not a flat prerequisite for generation any more.

**Cal.com is self-hosted by the platform** (PR #127): every client workspace gets a provisioned booking page, with a signed webhook and event-order handling (a later reschedule cannot be undone by a stale, out-of-order webhook delivery, fixed under Codex finding F11).

---

## Backups and Alerting

Both were entirely missing before the work described here; the terms page promised "automated backups" while none existed anywhere.

**Backups** (`docs/operations/backups.md`): nightly, encrypted (`age` or `gpg`), checksummed. Two separate paths because there are two separate databases:

1. The box's own Supabase CLI stack (staging's database, and the box's own, if ever used), plus `/var/www/sites/` and `/etc/flowstarter/`, backed up by a systemd timer on the Hetzner host.
2. The hosted production Supabase project, backed up by a manual, occasional logical dump (`scripts/supabase-prod-backup.mjs`) run from an operator's own machine, never from CI.

**Still needs Darius:** turn on the hosted project's own dashboard backup/PITR setting, choose where the encrypted dumps live long-term (no off-box bucket is provisioned yet), distribute the encryption key somewhere that is not the box being backed up, and actually rehearse the restore drill once on a disposable host before the first paying customer.

**Alerting** (`docs/operations/alerts.md`): a paid build that stops, a client email that fails to send, and a failed production health check all now reach someone, through `ops_alerts` + Resend email for the first two and a GitHub issue for the third. **Still needs Darius:** real error tracking (Sentry or equivalent, for exceptions nobody anticipated) and external uptime monitoring; neither exists yet.

---

## Security Posture

Two independent audits ran on 2026-09-13: `docs/security/audit-2026-09-13-claude.md` (verdict: conditional fail) and `docs/security/audit-2026-09-13-codex.md` (verdict: not ready for the first paying customer). Both rated tenant isolation in Postgres (RLS everywhere, a hardening migration, a CI-enforced tenant-table guard) and build isolation (Docker, `--network none`, read-only root, non-root user, lease fencing) as the strongest parts of the system.

Both also found real gaps, and a run of follow-up PRs (#133 through #146) closed most of the Critical and High findings: the auth-transfer ticket is now scoped to origins the platform runs, generated HTML is gated and every client site now serves a real Content-Security-Policy, outbound fetches (profile images, brand signals, deploy artifacts) go through one SSRF-safe adapter with request and image size caps enforced before allocation, the build worker's output directory and package-manager configuration are now contained against symlink and hook escapes, worker leases are fenced so an overtaken build cannot publish stale output, client IP is read from a single trusted-proxy-aware module instead of sixteen spoofable copies, database backups are encrypted, the tenant-table guard now covers every column shape, and the funnel spend cap is a real database-side reservation instead of a racy, truncated sum.

**What is still open** (do not treat this list as closed just because most findings are): production still shares Clerk's development instance with previews; a live-format credential (`infra/authentik/.env`) is still in the repository's git history and needs rotation plus a history purge; staging and production still share one deploy-agent bearer token; tenant sites, the platform, and Cal.com still share one registrable domain; client-site containers still get default network egress at runtime (only the build step is network-isolated); container images are pulled by mutable tag with no provenance check; and refund processing, which was open at the last revision, is now built (see [Pricing](#pricing)). The full, current list lives in `docs/next-steps.md`, sourced from both audits' own prioritised fix lists; do not duplicate it here as it will drift.

---

## Open Decision Points

1. **Payments and RON conversion.** Invoicing software (SmartBill / FacturaPlus / Oblio); Stripe remains primary for card payments.
2. **VAT and cross-border invoicing.** Needs a cross-border B2B fiscal consultant before the first EU client outside Romania.
3. **Operator identity.** The code half is done: the terms and privacy pages read the entity name, registration number, VAT number, address, governing law and court from six `FLOWSTARTER_LEGAL_*` environment variables (`apps/flowstarter-main/src/lib/legal/company.ts`), and while any of the six is unset both pages say "Operator identity pending registration" rather than asserting a Romanian company and Cluj courts, and the draft notice stays up on all three legal pages. **What is left is not code:** decide the company structure and supply the six values. The rest of the legal copy pass is closed — Plausible and Calendly are gone, Cal.com, Arcjet, OpenRouter, GitHub and Depot are disclosed, the DPA claim is now a statement of where each vendor's terms are rather than a claim of eight signatures, the retention section publishes only the two windows a job actually enforces, and the `NEXT_PUBLIC_GA_MEASUREMENT_ID` half-wiring was removed so "we run no analytics" is true of the build.
4. ~~**Acceptable-use guardrail.** In progress on a separate branch as of this revision; reconcile this document again once it merges.~~ **Resolved in code.** Merged as PR #158, with the taxonomy-agnostic classifier and Flowstarter's two guardrail heads from PR #160, built `dist/` output and retrained acceptable-use centroids from PR #167, and the encoder model plus its runtime baked into the Hetzner slot image from PR #172. Staging runs it live (`ACCEPTABLE_USE_SIGMA=true`, `SCOPE_SIGMA=1`); production is switched on at the same infrastructure cutover as the other Darius-only launch items in `docs/next-steps.md`. The custom-work discovery call it sits beside merged in PR #162.
5. **Registrable domain separation** for tenant sites versus the platform (security audit finding H1); an infrastructure decision measured in weeks, not a code change.

---

## Contradictions Flagged by This Revision

Per this document's own instruction to flag rather than silently override:

1. ~~**The unlock page still quotes a 10% "holds the slot" booking deposit next to a 20% checkout button that actually charges 20%.**~~ **Resolved.** The copy was fixed in PR #156, and PR #162 removed the model behind it: `BOOKING_DEPOSIT_PERCENT`, `CUSTOM_BOOKING_DEPOSIT_EUR`, `bookingDepositAmount`, the `/api/discovery/deposit` Checkout route and the `kind=booking_deposit` Stripe handler are all gone. Nothing in the funnel had ever called that route. The only deposit in the product is the 20% build deposit, computed by `depositAmountMinor`.
2. **Add-on packs are sold in copy with no purchase path**, described above under [Editor and Constrained Edits](#editor-and-constrained-edits).

---

## Notes for AI Agents Using This Document

- Pricing, milestone split, and edit allowances in sections 4 and 5 are firm and match shipped code as of 2026-09-14; do not change the numbers here without changing the code they describe, or vice versa.
- If a request contradicts a decision here, flag the contradiction rather than silently overriding it, the same way section 10 does.
- This document describes the shipped self-serve funnel. It does not describe work that is not built; see `docs/next-steps.md` for open items and for what is deliberately not being pursued.

*Document maintained by Darius. Reconcile against code again the next time a review finds drift.*
