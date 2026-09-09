# Daily QA

Once a day, something walks the live product the way a customer would, judges
what it saw, and files a report. This is what it does, what it is allowed to
touch, and how to read the result.

The lane is `.depot/workflows/daily-qa.yml`. It runs on Depot, like every
other lane here.

## What runs, and when

At **05:00 UTC every day**, and on demand. Two jobs, in order.

**1. `journeys`, the deterministic layer.** Five Playwright journeys from
`e2e/qa/journeys.qa.spec.ts`, in the `qa-journeys` project, against
`PLAYWRIGHT_BASE_URL`. They are the facts: the same five checks every night,
no model involved, so a regression is still caught on a day the model provider
is down.

| Journey | What it proves |
| --- | --- |
| `qa-01-intake-canary` | A visitor can open the discovery conversation from the landing page, answer the whole scripted intake, and reach a preview that actually starts generating. It records every phase the server reported. |
| `qa-02-client-dashboard` | The client QA user can sign in, `/dashboard` routes them somewhere real, and, when the workspace has a site, the editor loads. |
| `qa-03-operator-pipeline` | The operator QA user can sign in, the admin masthead renders, the pipeline board shows all six columns, and the project directory renders its table. |
| `qa-04-pricing-contact` | `/pricing` renders its headline and all three care plans; `/contact` renders its form and refuses both an empty and a malformed submit without sending anything. |
| `qa-05-deposit-checkout` | The deposit checkout route is deployed and refuses an anonymous caller, and the deployment is still on test-mode credentials. |

**2. `agent`, the judging layer.** OpenCode on `vars.QA_AGENT_MODEL`
(default `ollama-cloud/kimi-k3`) reads the journeys' JSON report, then
explores the same site in a pinned Playwright container for up to twenty
minutes: broken flows, dead links, console errors, layout breakage on a phone
viewport, copy problems, anything a first-time visitor would trip on. It ends
with a table, findings ranked by severity with steps to reproduce, and a
`Verdict:` line.

It runs `if: always()`, so a red journey is its most interesting input rather
than a reason to skip it.

## The canary rules

Every journey is read-mostly. The one exception is `qa-01`, and it is the
reason this lane runs daily instead of hourly.

`qa-01` answers the intake conversation as a canary business. The answers live
in one place, `e2e/qa/intake-canary.ts`, and they are deliberately impossible
to mistake for a customer:

- the business is **QA Canary Bakery**
- the address is **qa-canary@flowstarter.invalid** (`.invalid` is reserved by
  RFC 2606, so nothing can ever be delivered to it)
- the description says, in the description itself, that it is an automated QA
  canary and not a real business

What that writes on production is a **`funnel_previews` row**, keyed by the
`demoId` the run annotates, plus real model spend for the generation. It stops
before the final "save my brief" submit, so **no `discovery_leads` row and no
notification email are created**.

**What is not cleaned up, and why.** `e2e/support/cleanup-e2e-tenants.mjs` only
deletes workspaces whose slug starts with `e2e-`; for `funnel_previews` it
nulls the workspace reference and leaves the row alive, and its `assertSafeTarget`
guard refuses a production Supabase URL outright. So there is no cleanup script
that covers a canary preview today, and this lane does not invent one: pointing
a nightly job with a service-role key at the production database to delete rows
is a worse risk than the row it would remove.

The canary is therefore **left in place, tagged by its business name**, and two
things take care of it: the preview reaper
(`apps/flowstarter-main/src/lib/hosting/preview-reaper.ts`) expires unclaimed
previews on their TTL, and the row is trivially findable by hand:

```sql
select preview_id, created_at, expires_at, deploy_status
from funnel_previews
where brand_config->>'businessName' = 'QA Canary Bakery'
order by created_at desc;
```

The other rules, which the journeys enforce in code and the agent is told in
its prompt:

- never complete a payment, never type card details, never go past the hosted
  Checkout page
- never open or change another tenant's workspace
- sign in only as the two QA users, and only when their credentials are
  present; absent, those journeys skip with a warning
- the only business either layer ever describes is the canary

## How to read the issue

Every run files or updates one issue: **`Daily QA <date>: <verdict>`**, labelled
`daily-qa`, and `qa-broken` as well when the verdict is `broken`. A rerun on the
same day replaces that day's issue rather than filing a second one beside it.

The body, in order:

1. The AI-agent attribution header. This issue is written by a machine and says
   so on its first line.
2. Which origin was walked, and the verdict.
3. One line saying where the verdict came from: the agent and the journeys
   agreeing, the agent being overruled, or the agent not running at all.
4. The deterministic journey table, one row each, with the evidence the journey
   recorded.
5. What the agent found, verbatim.
6. Links to the run and its artifacts.

The three verdicts:

| Verdict | Means | Lane colour |
| --- | --- | --- |
| `healthy` | Nothing worth waking anyone for. | green |
| `degraded` | Something is wrong, but every flow a customer needs still completes. A skipped journey lands here. | green |
| `broken` | A visitor cannot complete a flow the business sells. | **red** |

`degraded` stays green on purpose. A lane that goes red for both teaches people
to ignore red.

**The agent cannot talk the verdict up.** The `journeys` job computes a floor in
shell from its own results (any failure is `broken`, any skip is `degraded`,
otherwise `healthy`), and the workflow takes the worse of the floor and the
agent's line. A model that says `healthy` over a failed journey does not get to.
It can only make the verdict worse, which is the direction where a model is
useful.

If the agent produced no `Verdict:` line at all, because the provider errored or
the step timed out, the issue says so and the verdict is the deterministic layer
alone.

## Running it by hand

```sh
depot ci dispatch --repo DMPResearch/flowstarter \
  --workflow daily-qa.yml --ref main \
  --input base_url=https://flowstarter.net
```

Both inputs are optional:

- `base_url`, default `https://flowstarter.net`. Any origin, no trailing slash.
- `journeys`, default `all`. Anything else is passed to Playwright as `--grep`,
  so `--input journeys=qa-04` runs only the pricing and contact journey. Useful
  when you want the fast checks without spending a canary intake.

Locally, against production, with the credentials exported in your shell and
never printed:

```sh
QA_JOURNEYS=1 pnpm exec playwright test --list --project qa-journeys
CI=true QA_JOURNEYS=1 PLAYWRIGHT_BASE_URL=https://flowstarter.net \
  pnpm exec playwright test --project qa-journeys
```

The project only exists when `QA_JOURNEYS=1`, the same way the visual and
prod-synthetic projects are opt-in, so `playwright test` with no `--project`
never picks these up and never runs them against localhost by accident.

## Secrets and variables

Depot's store is separate from GitHub's. Import with
`depot ci secrets add NAME --repo DMPResearch/flowstarter` and
`depot ci vars add NAME --repo DMPResearch/flowstarter`.

| Name | Kind | Required for | Absent means |
| --- | --- | --- | --- |
| `OLLAMA_API_KEY` | secret | the agent layer | the agent steps skip with a warning; the issue is filed from the journeys alone |
| `E2E_CLERK_CLIENT_EMAIL` | secret | `qa-02` | `qa-02` skips, so the verdict floor is `degraded` |
| `E2E_CLERK_CLIENT_PASSWORD` | secret | `qa-02` | same |
| `E2E_CLERK_OPERATOR_EMAIL` | secret | `qa-03` | `qa-03` skips, so the verdict floor is `degraded` |
| `E2E_CLERK_OPERATOR_PASSWORD` | secret | `qa-03` | same |
| `GH_REVIEW_TOKEN` | secret | a stable identity on the issue | the workflow token files it instead |
| `QA_AGENT_MODEL` | var | choosing the model | defaults to `ollama-cloud/kimi-k3` |
| `QA_UNLOCK_WORKSPACE_ID` | var | the unlock-page leg of `qa-05` | that leg is skipped and says so |
| `QA_STRIPE_CHECKOUT_URL` | var | the hosted-Checkout leg of `qa-05` | that leg is skipped and says so |

The two QA users must be ordinary accounts on the deployment being walked: the
client one an ordinary client with no team role, the operator one a team member.
`qa-02` fails deliberately if the client user turns out to carry a team role,
because that means it is checking the wrong surface.

**On the two optional `qa-05` vars.** Reaching Stripe's hosted Checkout means
creating a Checkout Session, which is a write to Stripe and needs a signed-in
client whose workspace is `PREVIEW_READY` with an unpaid deposit and a quote. A
nightly job has none of that, and manufacturing it would mean writing to a
paying customer's workspace. So the always-on part of `qa-05` proves the entry
point is deployed and guarded, and the two legs that touch Stripe run only when
an operator nominates a disposable fixture.

Test mode is likewise not visible from the browser: the app ships no Stripe
publishable key to the client, so there is no `pk_test` in the page source to
read. What is in the page source is the Clerk publishable key, and
`docs/preview-environment.md` records that production runs on the same test-mode
Stripe account and development-instance Clerk as the previews do. `qa-05`
asserts that key is still `pk_test_`, which is the tell that would change the
day production splits onto live credentials, and it is the journey that would
notice.

## What it costs

Per day:

- **one Kimi K3 session** on the flat-rate Ollama Cloud subscription, so no
  per-run bill, but it does draw on the same session budget the OpenCode review
  lane uses. A large pull request reviewed on the big tier plus this run in the
  same window is the likeliest way to hit the provider's session limit.
- **one canary intake**: one `funnel_previews` row, one generation's worth of
  model spend through OpenRouter, and one temporary site deployed to the
  previews host until the reaper expires it.
- Depot runner minutes: about twenty for the journeys, up to thirty-two more
  for the agent.

The lane runs Playwright with `--retries=0`, overriding the config's CI
default of two. Retrying is right for a lane that only reads; here it would
answer the canary intake three times in one night, spend three generations,
and leave three preview rows behind. One walk a day is the whole premise, and
a flake is a finding like any other.

Nothing here bills Stripe, and no payment is ever completed.
