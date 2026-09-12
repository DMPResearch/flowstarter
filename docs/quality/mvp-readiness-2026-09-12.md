# MVP readiness review, 2026-09-12

An independent review of how close Flowstarter is to a first paying customer,
plus a hands-on test of the product. Written for Darius. Nothing here is
copied from a status doc without being checked against code, a recorded run,
or the running app.

## What I did

- Read `readiness/README.md`, `readiness/journeys.json`, `scripts/mvp-readiness.mjs`,
  `docs/FLOWSTARTER_MASTER_DECISIONS.md`, `docs/quality/improvement-plan.md`,
  `docs/next-steps.md`, `docs/release-process.md`, `docs/preview-environment.md`,
  and the three showcase run READMEs (`clip-2026-09-11-glass`,
  `darius-portfolio-2026-09-12`, `hetzner-2026-09-12`).
- Ran `pnpm --dir apps/flowstarter-main test:coverage` and then
  `node scripts/mvp-readiness.mjs`. Output reproduced verbatim below.
- Audited observability, tenant isolation, rate limiting, backups, legal copy,
  refunds, auth and CI lanes directly in the source.
- Built a fresh worktree of `origin/main` (at `980333148`, PR #108), installed
  it, copied the two env files from the main checkout, ran `next dev` on port
  3063 against the local Supabase stack, and drove it with Playwright using
  system Chrome. Killed the server and removed the worktree afterwards.
- Checked production and staging over the public internet.

## What I did not do

- **No signed-in admin or client session.** The operator credentials exist only
  as Depot secrets, and Depot secrets are write-only (`depot ci secrets` has
  `add`, `set` and `bulk`, no `get`). There is no `E2E_CLERK_*` value in either
  env file. `public.profiles` in the local stack is empty, so even a seeded
  tenant would not link to a Clerk user. I verified the unauthenticated guards
  instead, which all behave correctly. I also rendered the admin shell through
  the development-only `E2E_SECRET` middleware bypass, but every data call
  still returned 401, so there is nothing to report from it.
- **No builds, deposits or service restarts on the 3005/8787 stack**, which
  another agent is using. I did not touch ports 3000 or 3051.
- **No generation run.** The intake stopped at the preview stage by design,
  and as it turns out generation would not have started anyway (see the
  regression below).

## The headline

Flowstarter is closer than the readiness score suggests and further than the
demo reels suggest. The chain from a visitor's first sentence to a paid,
built, deployed, TLS-terminated site on a real Hetzner box has genuinely been
walked end to end, twice, with real Stripe test payments settled by real
signed webhooks. That is a serious achievement and it happened in the last
48 hours.

But **the product on `main` right now cannot generate a preview at all**, the
production domain is serving a 404, nothing tells anyone when either of those
things happens, there are no database backups, and the marketing site makes
several promises the code cannot keep. None of those is a week of work on its
own. Together they are the gap between "it worked when I drove it" and
"a stranger can pay us money".

My estimate: **three to four weeks of focused work to a defensible first
paying customer**, of which roughly one week is code Darius has to write or
supervise and the rest is operational and legal work only Darius can do.

## The score the repository gives itself

`node scripts/mvp-readiness.mjs`, run after a full coverage pass on
`apps/flowstarter-main`, at commit `980333148`:

```
MVP readiness: 0%  (0 of 21 weighted points)
0 of 16 journeys ready; 0 of 5 money-path journeys ready.

journey                      money  tier  api lines  page lines  bar  e2e   prod  verdict
---------------------------  -----  ----  ---------  ----------  ---  ----  ----  ---------
intake-conversation                 1     63.3%      0%          80%  weak  no    not ready
info-agent-followup                 1     78.2%      0%          80%  no    no    not ready
preview-generation                  2     32.6%      0%          80%  no    no    not ready
two-free-edits                      2     39.5%      0%          80%  no    no    not ready
deposit-checkout             yes    3     76.6%      0%          90%  weak  yes   not ready
account-by-email             yes    2     89.4%      0%          90%  no    no    not ready
workspace-claim                     2     88.9%      0%          80%  no    no    not ready
build-board-team-note               2     97.1%      40%         80%  weak  no    not ready
site-published                      4     92.7%      0%          80%  weak  no    not ready
balance-payment              yes    3     100%       80%         90%  no    yes   not ready
client-dashboard                    2     46.8%      100%        80%  weak  no    not ready
editor-small-change-rebuild         2     97.6%      0%          80%  no    no    not ready
change-request-quoted-paid   yes    3     97.4%      100%        90%  no    no    not ready
custom-domain                       4     100%       0%          80%  weak  no    not ready
operator-invite-roles               2     0%         0%          80%  weak  no    not ready
cancellation-and-refunds     yes    3     100%       0%          90%  no    no    not ready

No Playwright JSON report was given, so a named spec counts as weak evidence. Pass --playwright-report <file> to check it passed.
```

Whole-suite coverage for `apps/flowstarter-main`: statements 54.03%, branches
49.89%, functions 48.14%, lines 54.36%.

The 0% is honest but it is not a measure of how much of the product exists.
It measures how much of the product is *proved by automation*, and it is
dominated by one input: the production check. Fourteen of sixteen journeys are
never checked against the deployed site, so they can never go green. The score
will stay near zero until there is a staging full-journey tier, no matter how
much of the product works.

Read it as a test-coverage score, not a product score. The rating below is my
product score.

## Journey by journey

"Proven" means a recorded run walked it with real money, a real webhook and
real output. "Tested" means the unit suite covers the handlers at or above the
journey's own bar.

| journey | implemented | proven end to end | covered by tests | my verdict |
| --- | --- | --- | --- | --- |
| intake-conversation | yes | yes, all three runs and my own today | no, 63.3% against an 80% bar | works, under-tested |
| info-agent-followup | yes | yes, `darius-portfolio-2026-09-12` (three questions, satisfied on the third) | close, 78.2% | works |
| preview-generation | yes, but **broken on `main` today** | yes on 2026-09-11 (first attempt, 550s, 159,500 tokens) | no, 32.6% | **regressed, see below** |
| two-free-edits | yes, `LIVE_EDIT_CAP = 2` server-enforced | yes, both 2026-09-11 runs | no, 39.5% | unreachable today, collateral of the above |
| deposit-checkout | yes | yes, EUR 159.80 twice, real signed webhook, forged event rejected on camera | no, 76.6% against a 90% bar | works |
| account-by-email | yes | partly, guest provisioning and forced password change proven in `clip-2026-09-11-glass` | just under, 89.4% against 90% | works |
| workspace-claim | yes | yes, claim returned 201 with `quoteMinor 79900` | 88.9% | works |
| build-board-team-note | yes | yes, though the job events and log routes 404'd once with no explanation and needed a dev-server restart | yes, 97.1% | works, one unexplained flake |
| site-published | yes | **yes, on a real host, 2026-09-12**: `darius-mihai-popescu-enxxz0.flowstarter.dev`, DNS claimed by the product, real ZeroSSL cert, pushed through `POST /api/team/projects/{id}/site/deploy` | yes, 92.7% | biggest advance of the week |
| balance-payment | yes | yes, EUR 639.20 paid, but **not the way a client would pay it**: the dashboard CTA is gated on `HUMAN_QA` and the run used the hosted Stripe invoice URL | yes, 100% | works for the operator, not proven for the client |
| client-dashboard | yes | visually, unauthenticated only in CI | no, 46.8% | works, unproven signed in |
| editor-small-change-rebuild | yes | yes, `SITE_REBUILD` in 9.7s and 8.8s, deployed | yes, 97.6% | works |
| change-request-quoted-paid | **half**: quote, accept, pay all work; **fulfilment does not exist** | the money half is proven, EUR 190.00 paid | yes, 97.4% | **takes money and ships nothing** |
| custom-domain | partly: the platform writes its own Cloudflare records and that is proven; a client's own domain is not | no | yes, 100% | not proven |
| operator-invite-roles | yes | no | **no, 0% line coverage** | untested and unproven |
| cancellation-and-refunds | **half**: cancel exists, refunds do not exist anywhere in `flowstarter-main` | no | 100% of what exists | **refunds are not built** |

## The MVP definition in the master decisions doc

`docs/FLOWSTARTER_MASTER_DECISIONS.md` declares itself the source of truth and
instructs agents to flag contradictions rather than override them. So, flagged:
**the document no longer describes the product.** It is dated May 2026 and
describes a concierge service sold on a discovery call, with a pre-call booking
deposit of 10 percent, a build billed 50/50 for founding clients and 4 x 25%
afterwards, a plan ladder including a Max tier at EUR 249, and an execution
pipeline measured in weeks 1 to 8.

What actually shipped is a self-serve funnel: four questions, a generated
preview, two free edits, a 20 percent deposit, a build, an 80 percent balance,
and a care plan. The pricing page and the FAQ both state 20/80. There is no
booking deposit in the funnel. There is no Max tier on the pricing page.

This matters beyond tidiness. Three specific contradictions are live:

1. **The milestone split.** Doc says 50/50 for founding clients. Product
   charges 20/80. The product is right; the doc should be amended.
2. **Editor allowances.** The doc's amendment says Flowstarter "no longer
   enforces custom token/session/cost limits in the editor; Claude Code owns
   token management". The FAQ sells "Starter includes 50 edits and Pro includes
   150" and `src/lib/flowstarter/edit-credits.ts` enforces exactly that. The
   code is right; the doc is stale.
3. **Add-on packs.** The FAQ sells "EUR 15 a month for another 25 edits, up to
   EUR 45 a month for 100 more". The code that would have to honour it says, in
   its own comment: "The copy sells add-on packs but nothing sells them yet and
   no column holds them, so this is a number a caller may pass and every caller
   currently passes 0." The exhausted-credits message deliberately avoids
   linking anywhere "because there is no add-on purchase path to send anyone
   to yet". **We are selling something that cannot be bought.**

`docs/next-steps.md` and `docs/quality/improvement-plan.md` are also stale.
Next-steps talks about a Convex schema refactor and a LangGraph orchestration
rewrite. The improvement plan scores a branch called `feature/concierge-pivot`
and lists work on Convex codegen and Daytona sandbox isolation. Neither
reflects where the code is. Anyone reading the repository for direction will be
misled by all three. Half a day to reconcile them is half a day well spent.

## Dimension by dimension

### Intake and preview reliability

The intake itself is the strongest part of the product. I walked it today on a
fresh checkout of `main`. Four questions (name, email, what you do, one link),
a well-written conversational agent, in-place editing of previous answers, a
live "what we know so far" panel, and honest failure copy. When I gave it an
Instagram URL it came back with "Instagram shows nothing to anyone who is not
signed in, so I could not see it", which is exactly the right register. Zero
console errors, zero failed requests, no layout break at 390px. The recorded
runs measured 138 seconds and 182 seconds to the end of the conversation.

Generation, when it has run, has been reliable lately. The 2026-09-11 glass run
succeeded "on the first attempt of the four budgeted"; the portfolio run the
same day also succeeded on the first of four, in 550 seconds with 159,500
tokens across twelve phases. That is a meaningful improvement on the 2026-09-09
state, where four attempts in a row died.

**But generation cannot run at all on `main` as of today.** This is the single
most important finding of the hands-on test.

PR #108 moved the `businessName` question out of the four-question quick phase
into the post-deposit `brief` phase
(`components/discovery/intake-script.ts`, `phase: 'brief'`). The live
generation route was not changed to match. Its first guard is:

```js
const parsed = SpecSchema.safeParse(body);
if (!parsed.success || !parsed.data.businessName.trim()) {
  return NextResponse.json({ skip: true }, { status: 200 });
}
```

I captured the wire traffic. The browser posts
`{"businessName":"","fullName":"Ana Ionescu", ...}` to
`/api/discovery/preview/live` and receives `{"skip":true}` with HTTP 200. The
visitor then sees an amber note reading "The live build was not available just
now, so this is the simpler preview, written from your answers. It is a real
draft, but it is not the generated site."

So every visitor, on every run, gets the deterministic fallback. Two knock-on
effects:

- The two-free-edits gate never fires. The fallback path uses
  `MAX_DEMO_EDITS = 20`, not `LIVE_EDIT_CAP = 2`, so the preview pane offered
  me "20/20 edits left" and revealed the deposit CTA immediately rather than
  after two spent changes. The rule you asked for on 2026-08-31 is bypassed.
- The preview the client approves, and which the paid build is seeded from, is
  a template fill rather than a generated site. Every downstream gate that was
  built to protect the approved-edit carry (#95, #98) is operating on different
  input than it was designed against.

This is a one-line fix at the route (derive a business name from the
description or accept an empty one) or a one-line fix at the script (put
`businessName` back in the quick phase). It is not a hard problem. It is a
problem that shipped to `main` today and that nothing caught, which is the more
interesting fact: there is no test at any level that asserts a completed intake
produces a generation attempt.

Screenshots: `/tmp/fs-review/intake-preview-stage.png` shows the amber fallback
note and the "20/20 edits left" counter side by side.

### Payment

Stripe test mode throughout, by design, and refused live keys everywhere.
`e2e/support/clerk-env.ts` throws on a `pk_live_`/`sk_live_` pair, and daily QA
journey `qa-05` actively asserts production is on `pk_test_`. That is a good
rail while it lasts, but note the consequence: **the day you correctly switch
production to live keys, the daily QA lane goes red.** That inversion belongs
in the launch runbook.

What is proven: the deposit (EUR 159.80, twice, real signed webhook, with
idempotency and forged-event rejection filmed), the balance (EUR 639.20 via a
hosted Stripe invoice), the care plan subscription (EUR 49/month, trialing),
and the change-request checkout (EUR 190.00). Four distinct money paths, all
settled by real webhooks. This is more than most pre-launch products can say.

What is not: **refunds do not exist.** There is no Stripe refund call anywhere
in `flowstarter-main`. `src/lib/billing/stripe.ts` says only "refunds handled
separately by the team via Stripe dashboard". The operator UI confirm dialog
says "Refunds handled separately." Meanwhile `terms/page.tsx` publicly commits
to "If you are not happy with the result within 30 days of launch, we refund
50% of the setup fee, no questions asked", and the landing hero repeats it.
The webhook *ingests* `charge.refunded` but never initiates one. Honouring the
published guarantee is a fully manual dashboard operation with no in-app audit
trail.

Also unresolved from the doc: the open decision on VAT and cross-border B2B
invoicing. Nothing in the product issues a compliant invoice, and there is no
RON conversion or accounting integration.

### Build and delivery

The gates added on 2026-09-11 and 2026-09-12 are real and they work. PR #97's
page-set rule cut a delivered site from seven pages to four. PR #100 removed
the blurred fake Cal.com widget that a client who had paid EUR 799 in full was
being shown on his own contact page. PR #95 seeds the build from the approved
preview. PR #98 fixed the `APPROVED_EDIT_DROPPED` gate, which had failed a
paid build against a list of phrases that turned out to be an Astro dev
server's process id, port and start time.

That last one is worth dwelling on, because it is the shape of the risk here.
The gate was correct in intent, wrong in implementation, and the failure mode
was that a customer who had paid in full got nothing and was told, in the
words of the run README, "your build is booked and about to start" for
fourteen minutes after the failure "and forever after". The dashboard had no
failed state. There was no client notice for a failed build. Both were fixed in
#98. But the class of bug is: a gate fires wrongly, a paid build stops, and
nobody finds out.

Still open on delivery:

- **A paid change request cannot be fulfilled.** This is the most serious
  product gap in the repository, and it is not a bug, it is a missing feature.
  From the run README: "Money taken for this section: EUR 190.00 ... Nothing
  was delivered for it. That is not a scripting shortcut, it is the product."
  No operator route writes the manifest. The agent pass that could add a
  section runs only in `FULL_SITE_BUILD`, which the worker refuses unless the
  project is `DEPOSIT_PAID`. `SITE_REBUILD` runs no agents, so an operator note
  on it reaches nobody. `loadUsableAssets` is imported by its own test and by
  nothing else, so no build payload carries a client's uploaded files. The
  operator's Changes tab offers one button for a paid request: Mark done. It
  moves a status and ships nothing.
- **The `dev:local` build worker script hardcodes the stub agent.** It swaps
  the real validator for a no-op globally, not just for the Pi session, so a
  publish packages the raw Astro source tree. This has now bitten two separate
  runs (2026-09-11 and 2026-09-12) and cost five failed deploy attempts on the
  Hetzner run. Both times it was worked around operationally. The script is
  still unfixed.
- **`FLOWSTARTER_MAIN_URL` defaults to port 3000.** Unset, the worker posts its
  deploy callback to a port nothing is listening on. This killed a build in two
  separate runs.
- **Two cosmetic defects on delivered output**: a statistic tile reading
  "0Minutes", and a "What clients say" section rendering with nothing under
  its heading.
- **A footer `Services` link on delivered sites points at a page the build does
  not have**; the container's `try_files` serves the home page instead of a 404.

### Hosting

The best news in the review. On 2026-09-12 a real Hetzner box, `fs-sites-01`
(cx43, 8 vCPU / 16 GB, Falkenstein, EUR 16.49/month gross), was provisioned,
firewalled to 22/80/443, given both deploy agents, connected through the
product's own `POST /api/admin/hosting/servers/connect`, and served a real paid
client site at `darius-mihai-popescu-enxxz0.flowstarter.dev` with a real
ZeroSSL certificate, over a DNS record the product created itself via
`claimRecord`. The Docker site runtime from PR #78 had never run on a real host
before that day.

Against that:

- **Production is down.** `https://flowstarter.net/` returns HTTP 404 with
  `cache-status: "Netlify Edge"` and an `x-nf-request-id` header.
  `https://flowstarter.net/api/health` returns 404 the same way. The apex and
  `www` resolve to Cloudflare proxy IPs, and Cloudflare is still forwarding to
  Netlify. PR #104 moved production to the Hetzner `prod` slot in code and
  `docs/release-process.md` says Netlify is gone, but the DNS was never
  repointed and the Netlify site no longer serves anything. Staging is fine:
  `https://staging.flowstarter.dev/api/health` returns
  `{"ok":true,"supabase":{"env":"staging","target":"local","host":"127.0.0.1"}}`.
  As far as the public internet is concerned, Flowstarter does not currently
  have a website.
- **cloud-init lies.** On the new host `cloud-init status` reported `done` with
  `errors: []` while most of the runcmd block had silently failed: no Docker,
  Ubuntu's Node 18 instead of Node 22, no npm, no Claude CLI, a crash-looping
  `caddy-previews.service`. Root cause is that the Caddyfile is written in
  `write_files` before `runcmd` installs Caddy, so dpkg hits a conffile prompt
  and every later install in the boot fails. The run README calls it "a real
  bug in `apps/flowstarter-main/src/lib/hosting/cloud-init.ts` and it will bite
  the next host too". It was repaired by hand on this host and not fixed at
  source.
- **The installer refuses a cloud-init'd Caddyfile.** `install-existing-host-agent.sh`
  rejects a Caddyfile containing `on_demand_tls`, and cloud-init v3 writes
  exactly that. Two pieces of first-party tooling that cannot be run in
  sequence.
- **There is no decommission endpoint.** Both allocation routes refuse to move
  an allocated workspace with "Decommission the existing site before
  re-allocating", and the product offers no such action. It was worked around
  by editing `workspaces.hosting_server_id` directly in Postgres.
- **Docker bypasses ufw.** The `{"ip": "127.0.0.1"}` daemon.json that stops a
  published container port from being exposed to the internet was added by hand
  and is not in cloud-init, so the next host will lack it. With Supabase and
  Cal.com planned for the same box, this is a Postgres-on-the-internet waiting
  to happen.
- **The disk was never grown.** Every rescale used `upgrade_disk: false`, so
  the box has the 40 GB the original cx23 came with, not the 160 GB a cx43
  nominally includes. Growing it is a one-way door.
- **Deploys from the laptop need an SSH reverse tunnel** that does not survive
  a reboot, because the build artifact lives on the laptop and the database is
  local.
- Three dangling DNS records (`staging.flowstarter.dev`,
  `*.staging.flowstarter.dev`, `*.preview.staging.flowstarter.dev`) still point
  at `2.29.32.166`, an address that no longer answers.
- The stable-ports fix for the deploy agent is still open as PR #112.

### Email

Resend is the provider and the domain is now verified: `flowstarter.net` was
registered in Resend on 2026-09-12, four DNS records were created, and the
first real email was delivered to Darius. That closes the blocker that had
stopped every run before it.

But it closed *after* the runs. Both the 2026-09-12 portfolio run and the
Hetzner run recorded `401 API key is invalid` on every send: preview ready,
deposit paid, balance invoice, and two separate "your site is live" notices. In
the words of the README, "Until it is replaced nobody on this machine receives
anything." Zero `[Email] Sent` lines have ever been observed in any run.

So the *transport* is now believed good and the *content* has never been
delivered end to end in a run. That needs one clean pass before launch.

Three further things:

- **`notifyClientOnce` writes its `project_events` row only after a successful
  send.** A failed send leaves no trace and will be retried, so a workspace
  whose mailer was down has no client-email history at all. Combined with the
  deliberate decision that a dead mailer must not fail a deploy, an email
  failure is visible only in a log nobody reads.
- **The branded email template PR (#111) is still open.**
- **`FLOWSTARTER_LOCAL_SITE_BASE_URL` is an email footgun.** Left set, the
  "your site is live" email carries `http://localhost:8790/<slug>/`, which the
  Hetzner run caught by hand. The ordering hazard in `deployedSiteUrl()` is
  still there.

### Bookings

Cal.com is a real integration surface now (PR #96), the fake blurred widget was
removed from paid builds (PR #100), and the funnel demo was pulled out. Nothing
is actually connected, because no link has been provided. Self-hosting is not
started.

The marketing site does not reflect this. `/contact` says "Send a message,
**book a call**, or write to us directly". `/help` says "just grab a free
30-minute call with us". `/faq` says "The fastest answer is a 30-minute call"
and "We set a realistic timeline together on the discovery call". I crawled
every marketing page and **there is not a single Cal.com or Calendly link
anywhere on the site.** The "Get my custom plan" buttons open the intake
conversation, not a calendar. Four pages promise a call that cannot be booked.

### Lead capture

PR #113 is open and unmerged. Separately, and more urgently:

**`/contact` is a dead letter box.** I filled the form on the running app and
submitted it. `POST /api/contact` returned `{"success":true,"message":"Message
sent successfully"}`. The route inserts into `contact_submissions` and sends no
notification of any kind. I then grepped the whole app:
`contact_submissions` appears in exactly two places, the insert and the
generated database types. **Nothing ever reads it.** The admin "Custom
inquiries" page reads `/api/admin/custom-inquiries`, a different table.

The page that swallows these messages says, on screen, "Every message gets a
reply within one business day. Weekends excluded." A prospect who writes to
Flowstarter today reaches nobody, and is told they will hear back tomorrow.

The four published addresses (`hello@`, `legal@`, `privacy@`) also need
checking. The Resend setup created an MX record for sending; whether inbound
mail to those addresses is received anywhere is a separate question and I could
not verify it from here.

### Auth

Clerk is on its **development instance**, shared between previews and
production. Depot's variable list confirms it:
`PROD_NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is a `pk_test_` value. The browser
console on every page of the running app carries Clerk's own warning:
"Clerk has been loaded with development keys. Development instances have strict
usage limits and should not be used when deploying your application to
production."

`docs/preview-environment.md` already names this a launch blocker. Nothing in
the app guards it: `src/env.ts` validates only that the key is a non-empty
string. There is no prefix check, no environment-conditional rule. The only
`pk_live` logic in the repo is the E2E refusal and the daily-QA assertion that
production is *not* live, which will need inverting on cutover day.

Creating the production instance is Darius-only work: new instance, new keys,
JWT template for Supabase, webhook endpoint and signing secret, redirect URLs,
domain verification, and migrating or re-inviting the two operator accounts.

### Data

Production is the hosted Supabase project. Development and staging are the
Supabase CLI stack, enforced in code by `src/lib/supabase-target.ts`, which
throws when the URL is not loopback in development or staging, and enforced in
CI by `deploy-slot.sh` refusing to expose a slot whose `/api/health` does not
say `"target":"local"`. That topology is sound and well defended.

**There are no backups.** Not for the hosted production project, not for the
Supabase CLI stack on the Hetzner box that is staging's database, not for
`/var/www/sites/{slug}/` where the customer sites themselves live. Searching
`docs/`, `deploy/` and `scripts/` for backup, pg_dump, restore, snapshot or
PITR turns up a Caddyfile backup in an install script and an unchecked P3
checkbox in an archived plan. There is no restore procedure and no restore
drill.

Meanwhile `terms/page.tsx` promises clients "Hosting on EU infrastructure,
**automated backups**, SSL, and uptime monitoring."

Production schema changes are applied by hand against the hosted project, and
`docs/release-process.md` correctly warns that an image rollback does not roll
the schema back. With no backup, a bad hand-applied migration on production is
unrecoverable.

### Security

This is the strongest engineering in the repository and it deserves saying
plainly.

Tenant isolation has a real CI lane. `quality-gate.yml`'s `tenant-isolation`
job stands up a throwaway Supabase stack, applies every migration, and runs
`verify-rls-local.mjs`, which proves seven distinct attack shapes per
tenant-scoped table using a genuine HS256 JWT with a Clerk user id in `sub`:
that a member of A sees zero rows of B, that an unfiltered select leaks
nothing, that a signed-in non-member sees nothing, that anon is denied at the
grant, that an insert carrying B's tenant key is refused, and that an update of
B's row changes nothing. It also proves the private storage bucket is scoped
and that the RLS helper functions are not executable by anon, so
`is_workspace_member()` cannot be used as a membership oracle. A companion
static guard fails CI for any new table with a tenant column that is not
classified.

Every table in `public` has RLS enabled. There is no `disable row level
security` anywhere in the 37 migrations and no `using (true)` policy. I
confirmed this against the live local database as well.

`20260909143500_tenant_isolation_hardening.sql` is a genuine audit with genuine
fixes, including one where anon retained EXECUTE on the membership helpers
because Supabase's bootstrap default privileges meant `revoke from public` did
nothing, and one where the change-request select policy had no `to` clause and
so defaulted to PUBLIC on a table holding Stripe session and payment intent
ids.

The gaps:

- **Arcjet is dead code in production.** `ARCJET_KEY` appears in no deploy
  config, no Depot secret, no env template. Without it every layer silently
  no-ops, and even with it the middleware fails open on error. The per-route
  limits that remain are hand-rolled process-local Maps keyed on a spoofable
  `x-forwarded-for`.
- **`/api/discovery/preview/live` has no rate limit at all.** It is the
  expensive endpoint, `maxDuration = 300`, and the only limits on it are the
  prerequisite check and the budget check.
- **The spend cap fails open.** `DISCOVERY_FUNNEL_BUDGET_EUR` defaults to EUR
  50 a month, but every failure path in `funnel-cost.ts` returns `ok`: no
  service key, missing table, query error, any throw. Cost accounting is
  best-effort and swallows write failures, the cap is checked once before the
  call rather than during, and unknown models fall back to an estimated rate.
  The realistic worst case is a few hundred euro, not unbounded, but the EUR 50
  default is more likely to block real customers than an attacker.
- `/api/contact` is an unauthenticated insert with Zod validation and no rate
  limit.

### Observability

There is essentially none, and this is my second-ranked blocker after the
preview regression.

No Sentry, no Bugsnag, no Datadog, no OpenTelemetry wiring (the
`@opentelemetry/*` entries in the root package.json are a pnpm override block
that nothing imports). No `instrumentation.ts`. Logging is `console.*` to
stdout, 178 `console.error` calls in `flowstarter-main` alone, with no log
driver configured in the Hetzner compose file, so logs sit in a local Docker
json file until rotation eats them. No uptime monitoring: searching the repo
for uptime, alerting, on-call, PagerDuty or any monitoring vendor returns
nothing.

What exists:

- `prod-synthetic.yml`, every six hours, read-only against the live site. On
  failure it emits a GitHub Actions annotation. No issue, no email, no page.
  This is the only lane that can go red for a production problem.
- `daily-qa.yml`, once a day, five deterministic journeys plus an AI explorer,
  which files a GitHub issue. By design "a degraded day is a thing to read, not
  an alarm to wake up to."

So: a production 500 is invisible for up to six hours and then only as a red
check on a repository. A **failed paid build is invisible indefinitely**.
`apps/build-worker` writes `status: 'failed'` with an error code to
`flowstarter_agent_jobs` and logs to stdout; grepping the whole worker for any
notification channel returns one comment. Someone has to query the table.

Today, `flowstarter.net` has been returning 404 to the whole internet and the
only thing that would have noticed is a six-hourly CI job whose output is an
annotation.

### Legal and copy

Privacy and cookies both render a `LegalDraftNotice` reading "DRAFT: UNDER
LEGAL REVIEW". **Terms does not**, which is backwards: terms is the actual
contract and the other two are disclosures.

Specific claims that appear not to be true:

| page | claim | problem |
| --- | --- | --- |
| terms | "governed by the laws of Romania, where Flowstarter is registered", "settled by the courts of Cluj-Napoca" | Company structure is still an open decision in the master doc (RO SRL / UK Ltd / Estonian). No entity name, registration number, VAT number or registered address appears anywhere on the site. If the entity does not exist, this is false; if it does, the mandatory trader-identification disclosures are missing. |
| terms | "automated backups ... and uptime monitoring" | Neither exists. |
| terms + landing | "we refund 50% of the setup fee, no questions asked" | No refund path in code. |
| privacy | "a two-person studio registered in the European Union" | Vaguer than terms, and GDPR Article 13 requires the controller's identity and contact details, meaning a legal name and address. |
| privacy | "Each one has signed a data-processing agreement with us covering Article 28" | Asserts eight executed DPAs. Verify each one exists as a signed document. |
| privacy + cookies | **Plausible** named as the analytics processor | Plausible is not installed. It appears only in the copy that claims it. Meanwhile `src/env.ts` declares `NEXT_PUBLIC_GA_MEASUREMENT_ID`, which is not disclosed. |
| privacy | **Calendly** named as a subprocessor | The product uses Cal.com, which is not listed at all. Either an undisclosed processor is in use or a disclosed one is not. |
| cookies | "We do not run Google Analytics" | Directly contradicted by the GA variable above if it is ever populated. |
| cookies | "the complete inventory of cookies" | `fs_country`, set by the middleware, is missing from it. |
| privacy | five retention periods (30 days, 12 months, 7 years, etc.) | None is enforced. There is no deletion job, no TTL, no cron. |
| privacy | "We verify the request and respond within 30 days" (DSAR) | No DSAR tooling and no export endpoint. |
| contact | "Every message gets a reply within one business day" | The message reaches nobody. |
| contact, help, faq | "book a call", "grab a free 30-minute call" | No booking link exists on the site. |

Copy hygiene from the hands-on crawl: **zero em dashes** on eleven of thirteen
marketing pages, one on `/faq`, and no emoji in Flowstarter's own voice. The
only emoji on the site (`✉️`, `📘`, `📷`, `★`) are inside `MockEditorPreview`,
the fake coffee-roaster demo on the landing page, where they read as cheap
placeholder social icons and would be better as real icons. No lorem ipsum, no
TODO, no "coming soon" anywhere. The "Cluj" mentions in the mock are a
fictional example business and are fine; the "Cluj-Napoca" in terms is a real
jurisdiction claim and is not.

### Design

Done, and done well. The liquid glass system is in place, the marketing pages
are flat cream as instructed, the intake modal is the one glass surface on
marketing, the contrast scripts and the near-neutral field test exist as gates.
Nothing I saw contradicts the taste rulings. I found no design defects worth
your time.

Two small mechanical things, both from the running app:

- `/design-gallery` logs one console error, "An empty string was passed to the
  src attribute", from three image fixtures with no URL. Dev-only page, so the
  severity is low, but the same asset component renders in the real client
  dashboard, so an asset row whose signed URL is missing would do the same
  there.
- `next.config` sets `images.qualities: [75]` while components request 76, 80
  and 90, producing four warnings per landing page load.

### Operations

`docs/release-process.md` and `docs/preview-environment.md` are both excellent:
specific, honest about what skips and why, and clear about what a rollback does
not undo. `deploy/hetzner-staging/README.md` is referenced throughout. The
one-script dev bootstrap and doctor (PR #106) is a good addition.

What is missing operationally: there is no runbook for the first customer.
Nothing says what an operator does between `DEPOSIT_PAID` and `LIVE_SUBSCRIPTION`,
who checks the build, what human QA actually consists of, or what to do when a
build fails. The `HUMAN_QA` to `LIVE_SUBSCRIPTION` transition is manual and
undocumented; the portfolio run left a workspace stuck there, and the client's
balance CTA is gated behind it.

Things only Darius can do, which no amount of code will close: incorporate the
company, get the VAT position right, create the Clerk production instance,
switch Stripe to live mode, repoint the production DNS, decide the disk, sign
or obtain the eight DPAs, and put a real booking link somewhere.

## Blockers to a first paying customer

Ranked by what would hurt most if a stranger paid us tomorrow.

1. **Generation is broken on `main`.** Every visitor gets a fallback template
   and is told so in amber text. Evidence: captured request body
   `{"businessName":""}` to `/api/discovery/preview/live`, response
   `{"skip":true}`.
2. **Production is a 404.** `https://flowstarter.net/` serves a Netlify 404
   through Cloudflare. Evidence: `cache-status: "Netlify Edge"; fwd-status=404`.
3. **Nothing tells anyone when something breaks.** No error tracking, no
   alerting, no uptime monitor; a failed paid build is invisible until someone
   queries a table. Evidence: no Sentry or equivalent in any package.json, one
   comment in the whole build worker matching any notification keyword.
4. **No backups.** Nothing can be restored. Terms promises the opposite.
5. **A paid change request ships nothing.** EUR 190.00 taken in a real run with
   no delivery path in the product. Evidence: the run README's own words, "it
   is the product".
6. **Refunds are not built** while a 50% refund is published on the landing
   page and in terms.
7. **Clerk is on a development instance in production**, confirmed by the
   `pk_test_` value in `PROD_NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.
8. **The contact form reaches nobody** while promising a reply within one
   business day.
9. **Legal pages assert facts that appear untrue**: a registered company with
   no identifying details, Plausible, Calendly, eight signed DPAs, five
   unenforced retention periods.
10. **Four pages promise a call that cannot be booked.**
11. **The cookie banner covers the primary CTA on a phone** (see Part 2).
12. **Arcjet is not deployed**, the expensive generation endpoint has no rate
    limit, and the spend cap fails open.

## Launch checklist

Owner is "code" where an agent or Darius can do it in the repository, and
"Darius" where it needs an account, a signature, a card or a decision. Days are
engineer-days for one person, including test and review.

### Must do before taking money from a stranger

| # | item | owner | days |
| --- | --- | --- | --- |
| 1 | Fix the `businessName` regression so generation runs again, and add a test that asserts a completed intake produces a generation attempt | code | 0.5 |
| 2 | Repoint `flowstarter.net` and `www` at the Hetzner `prod` slot, verify `/api/health` says `"env":"production"`, record the old Netlify values first | Darius | 0.5 |
| 3 | Add error tracking (Sentry or equivalent) to `flowstarter-main` and `build-worker`, with a real alert destination | code + Darius for the account | 1.5 |
| 4 | Alert on a failed build job and on a failed client email, to somewhere a human reads | code | 1 |
| 5 | External uptime check on `flowstarter.net` and the deployed client sites, paging Darius | Darius | 0.5 |
| 6 | Daily automated backup of the production Supabase project plus a documented and once-rehearsed restore | Darius + code for the script | 1.5 |
| 7 | Backup of `/var/www/sites/` on the Hetzner box | code | 0.5 |
| 8 | Create the Clerk production instance, new keys, JWT template, webhook secret, redirect URLs, migrate the operator accounts, and invert the `qa-05` assertion | Darius + code | 1.5 |
| 9 | Switch Stripe to live mode and re-verify the four money paths in live with a real card and an immediate refund | Darius | 1 |
| 10 | Build the refund path, or remove the 50% refund promise from terms and the landing page until it exists | code + Darius decides which | 1 (build) or 0.25 (remove) |
| 11 | Make `/contact` reach a human: notify on insert and surface `contact_submissions` in admin | code | 0.5 |
| 12 | Verify inbound mail to `hello@`, `legal@` and `privacy@` actually arrives | Darius | 0.25 |
| 13 | Put a real booking link on `/contact`, `/help` and `/faq`, or change the copy to stop promising a call | Darius provides the link, code wires it | 0.5 |
| 14 | Legal pass: incorporate or amend terms; add the entity name, number and address; remove Plausible; name Cal.com and remove Calendly; confirm or remove the DPA claim; add `fs_country` to the cookie inventory; put the draft notice on terms or take it off the others | Darius with counsel | 2 to 5 elapsed, 1 of our time |
| 15 | Either enforce the five retention periods or restate them as intentions | code | 1 |
| 16 | Provision `ARCJET_KEY` in the prod and staging env, and add a per-IP limit to `/api/discovery/preview/live` | Darius + code | 0.5 |
| 17 | Raise `DISCOVERY_FUNNEL_BUDGET_EUR` to a number that will not block a real customer, and make the cap fail closed on accounting errors | code | 0.5 |
| 18 | Fix the cookie banner covering the hero CTA on phone | code | 0.25 |
| 19 | Write the first-customer runbook: what an operator does at each state, what human QA is, what to do when a build fails | Darius, transcribed by code | 1 |

Subtotal: about **15 engineer-days**, of which roughly 6 are Darius-only.

### Should do before the second customer

| # | item | owner | days |
| --- | --- | --- | --- |
| 20 | Build change-request fulfilment, or stop selling it: an operator route that writes the manifest and enqueues a real agent pass, and a build payload that carries the client's uploaded assets | code | 4 to 6 |
| 21 | Fix `cloud-init.ts` so the next host provisions cleanly, and make the existing-host installer accept a cloud-init Caddyfile | code | 1 |
| 22 | Add a decommission endpoint | code | 0.5 |
| 23 | Put `{"ip":"127.0.0.1"}` into cloud-init before Supabase or Cal.com go on the box | code | 0.25 |
| 24 | Remove the hardcoded stub agent from `dev:local` and give `FLOWSTARTER_MAIN_URL` a sane default | code | 0.5 |
| 25 | Merge the five open PRs (#109 codegen regex, #110 placeholder gate, #111 email templates, #112 stable ports, #113 lead capture) | code | 0.5 |
| 26 | Unblock the client's balance payment: let the dashboard CTA appear for a project that has passed QA, and stop the operator invoicing a failed build | code | 1 |
| 27 | Repoint or retire the three dangling `staging.*` DNS records; retire the `local-dev` leftover allocation | Darius | 0.25 |
| 28 | Decide the disk on `fs-sites-01` before it fills | Darius | 0.25 |
| 29 | Reconcile the master decisions doc, next-steps and the improvement plan with what shipped; remove the add-on pack copy or build the purchase path | code + Darius on pricing | 0.5 |
| 30 | Fix the delivered-site defects: "0Minutes", the empty testimonials section, the footer `Services` link | code | 0.5 |

Subtotal: about **10 engineer-days**.

### Worth doing, not blocking

A staging full-journey tier so the readiness score can move; unit coverage on
`operator-invite-roles` (currently 0%); an E2E spec that signs in as a freshly
provisioned client; structured JSON logging with a log driver on the box;
`images.qualities` in the Next config; real icons instead of emoji in the
landing mock.

# Part 2: the hands-on test

Fresh worktree of `origin/main` at `980333148`, `pnpm install --frozen-lockfile`,
the two env files copied from the main checkout, `next dev -p 3063 -H ::`
against the local Supabase stack, driven with system Chrome through Playwright.
Screenshots in `/tmp/fs-review/`.

## Landing, desktop and phone

Desktop at 1440x900: clean. No page errors, no failed requests, no broken
internal links. The only console output is Clerk's development-keys warning
and four Next image quality warnings.

Phone at 390x844 (iPhone 14): no horizontal overflow anywhere, `scrollWidth`
equals `clientWidth` on every page tested. Layout holds.

**One real bug.** On the phone, the cookie consent banner occupies y=400 to
y=664 of a 664px viewport, and the hero's primary "Build my site" button sits
at y=419 to y=467, entirely underneath it. `document.elementFromPoint` at the
button's centre returns the banner's `<h3>We use cookies</h3>`. Playwright
cannot click it; a thumb cannot either. After clicking "Accept all" the button
works and the intake opens normally. So the first thing a phone visitor sees is
a covered call to action. Screenshot: `/tmp/fs-review/phone-intake-open.png`.

A second, smaller thing: the first `Build my site` in DOM order is a zero-size
hidden button (the desktop/mobile toggle), which is the same trap the
2026-09-11 showcase run hit in its readiness check. Anything that selects the
first matching button gets an element that never becomes visible.

## The four-question intake

Walked to the preview stage. It is good. Four questions, conversational,
in-place editing of earlier answers, a live summary panel, chips where
appropriate, and honest failure copy about not being able to read a
signed-out Instagram. Zero console errors and zero failed requests across the
whole conversation.

What the preview pane shows: a skeleton of labelled sections (OPENING, WHAT YOU
OFFER, BOOKING, ABOUT, CONTACT) under the caption "Your site appears here as
the agents build it. Nothing on this panel is real yet", then, seven seconds
later, a rendered one-page site for the fictional business inside a mock browser
chrome.

Three observations from that pane:

1. The amber note, on every run: "The live build was not available just now, so
   this is the simpler preview, written from your answers. It is a real draft,
   but it is not the generated site." This is the `businessName` regression
   described above.
2. "20/20 changes left" rather than 2, and the deposit CTA revealed
   immediately rather than after two spent edits.
3. The pane nests two browser chrome mocks, an outer one labelled
   `yoursite.preview` and an inner one labelled `anaionescu.com`. Doubled window
   chrome looks like a rendering mistake even though it is deliberate.

Money copy in the pane is clear and consistent: "you pay a 20% deposit of
EUR 159.80, and the EUR 639.20 balance is due only when it is finished. That is
EUR 799 for the build."

## Design gallery

`/design-gallery` renders. One console error: an empty string passed to an
image `src`, three times, from fixtures that carry image metadata but no URL.

## Admin and client dashboards

Not exercised signed in. Operator credentials live only as Depot secrets, which
are write-only; neither env file carries an `E2E_CLERK_*` value; and
`public.profiles` in the local stack has zero rows, so no seeded tenant would
link to a Clerk user anyway.

What I did verify, unauthenticated, and it all behaves correctly: every one of
the twenty-two `/admin/dashboard/**` and `/dashboard/**` routes linked from the
site redirects to the right login with the right `next` parameter, and neither
login page crashes. One oddity worth noting, matching a defect already recorded
on 2026-09-11: the signed-out `/dashboard` page renders a link to
`/admin/login?next=%2Fdashboard`, which is how a client ends up bounced through
the admin login and shown "This account isn't an admin" for a few seconds.

## Link crawl

Every internal link on the marketing pages, 43 distinct paths, returns 200 or
redirects correctly to a login. **No broken internal links.**

External links: `https://library.flowstarter.dev` returns 404 (linked from the
dev-only design gallery, so low impact). `https://flowstarter.net`, linked from
the app itself, returns 404 (see production above). `twitter.com/flowstarter`
and `linkedin.com/company/flowstarter` return 200, but both platforms return
200 for nonexistent handles behind a login wall, so whether those accounts
exist is unverified. The footer publishes both handles on every page.

## Accessibility

- No image is missing an `alt` attribute on any page.
- No unnamed buttons and no unlabelled form controls.
- Every page has exactly one or a sensible set of `h1` elements, and a "Skip to
  main content" link is present.
- **Footer links are 20px tall** on the phone, against a 24px WCAG 2.2 AA
  minimum target size and a 44px comfortable target. Ten links in a row at that
  size. This is the only accessibility finding worth fixing.
- One `/about` image has width or height modified but not the other, which Next
  warns about.
- I did not run a full automated contrast sweep, since the repository already
  gates on `check-tone-contrast.mjs` and `check-ink-contrast.mjs`. Nothing
  looked obviously wrong by eye on either viewport.

## Copy

- **Em dashes: one**, on `/faq`. Eleven of the thirteen marketing pages have
  zero. Good discipline.
- **Emoji: none in Flowstarter's own voice.** The only emoji are inside the
  fake coffee-roaster demo on the landing page (`✉️`, `📘`, `📷`, `★`), used as
  social icons. They read as cheap next to the rest of the design.
- **Placeholder text: none.** No lorem ipsum, no TODO, no "coming soon".
- **Invented facts:** the "Cluj" references are all inside the fictional demo
  business and are fine. The one real claim is `terms/page.tsx`, "the laws of
  Romania, where Flowstarter is registered", and "the courts of Cluj-Napoca",
  which asserts a company that the master decisions doc still lists as an open
  decision. `/privacy` names Plausible and Calendly, neither of which is used.
- **Promises the product cannot keep**, all of which read as invented facts to
  a customer: a reply within one business day to a form nobody reads; a
  30-minute call with no booking link; automated backups and uptime monitoring
  that do not exist; a 50% refund with no code path; add-on edit packs that
  cannot be purchased.
- **Minor inconsistency:** the intake header on phone reads "Step 1 of 6" while
  the progress line beneath it reads "0 of 4 questions answered".

## Contact form

Submitted successfully. `POST /api/contact` returned
`{"success":true,"message":"Message sent successfully"}` and the row went into
`contact_submissions`, which nothing in the application ever reads and which
triggers no notification. Covered above as a blocker.

## Cleanup

Dev server killed, `/tmp/fs-review-main` worktree removed, ports 3000, 3005 and
3051 untouched. The other agent's stack on 3005 and 8787 was still answering
when I finished. Screenshots left in `/tmp/fs-review/`.

---

## Corrections after the review (main session, same day)

- Production 404: flowstarter.net was serving Netlify's 404 page because Netlify's GitHub app kept building `main` after PR #104 removed `netlify.toml`, publishing an empty deploy at 10:35. The last good deploy (2026-09-10, PR #74) was restored at 16:55 and Netlify builds are stopped. Production is up but frozen at the 2026-09-10 code until the Hetzner prod slot takes the apex.
- Disk: `fs-sites-01` was resized with `upgrade_disk: true` on 2026-09-12; it has 160 GB, not 40 GB.
- Change requests: PR #103 added `CHANGE_REQUEST_BUILD` with an operator "Build this change" action. Four real runs the same day all failed on a `PAGE_BUDGET_EXCEEDED` false positive (`workflows.ts:2533` compares a source manifest through an `.html` filter), so the verdict "takes money and ships nothing" still holds in effect; the gate fix is a follow-up PR.
- The `businessName` regression, the Stripe write-error handling, the worker lease model, build isolation, the admin-by-domain rule, the preview frame origin and the Cal.com event ordering are being fixed in follow-up PRs referencing this file and `codex-review-2026-09-12.md`.
