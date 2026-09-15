# The acceptable-use gate: which tier decides what

Every submission that could become a site is screened once, by
`screenAcceptableUse` (`apps/flowstarter-main/src/lib/policy/gate.ts`). Behind
that one call is a two-tier cascade and a rule layer, and this page is the
table of what each of them is allowed to conclude. It exists because on
2026-09-15 staging was refusing an allow to lawful briefs and filing
fallbacks as decisions, and neither of those was visible from any single
file.

There is no phrase list, no regex and no denylist anywhere in the path. The
first tier is a geometry over multilingual embeddings; the second is a
versioned prompt. Detection is a classifier, and the rule layer only decides
(`docs/FLOWSTARTER_MASTER_DECISIONS.md`, and the 2026-09-14 ruling in
`apps/flowstarter-main/src/lib/policy/acceptable-use.ts`).

## The taxonomy, in one line each

- **prohibited** — nine categories we will not build for. The only route to a
  refusal.
- **sensitive** — six lawful trades that sit next to a prohibited one
  (licensed pharmacy, legal cannabis, firearms training, sexual health,
  licensed betting, adult-adjacent retail). The licence, not the sentence,
  makes them lawful, so they always go to a person.
- **clean** — everything else, which is the overwhelming majority.

## Which tier may decide what

The numbers all live in `packages/sigma-flowstarter/config/policy.json`, are
read off a held-out distribution, and are never written in code. The band
that decides whether a head answers at all is a different file and a
different bar: `packages/sigma-flowstarter/models/semantic-config.json`.

| Tier                    | Runs when                                                                                                                                                                                | May conclude                    | Bar it must clear                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| **embedding centroids** | every submission, once, for both heads off one embedding                                                                                                                                 | `refuse` on a prohibited label  | `refuseMinSimilarity`, `refuseMinMargin`                                          |
|                         |                                                                                                                                                                                          | `review` on any sensitive label | the calibrated band only — a review costs a human two minutes, so it is unguarded |
|                         |                                                                                                                                                                                          | `allow` on `clean`              | `allowMinSimilarity`, `allowMinMargin`                                            |
| **LLM (injected)**      | only where the centroid verdict did **not settle** the decision: it abstained inside the band, **or** it cleared the band and then missed the guard for the action its own label maps to | `refuse` on a prohibited label  | `refuseMinLlmConfidence`                                                          |
|                         |                                                                                                                                                                                          | `review` on a sensitive label   | the label alone                                                                   |
|                         |                                                                                                                                                                                          | `allow` on `clean`              | `allowMinLlmConfidence`, **and** the model's own `needs_human` flag must be false |
| **neither**             | both tiers declined, the encoder is missing or over budget, the artifacts are corrupt, or the classifier is down and `ACCEPTABLE_USE_FAIL_CLOSED` is on                                  | the platform fallback, `review` | —                                                                                 |

Two properties that are easy to lose and worth stating:

1. **A settled centroid verdict is never second-guessed by a model.** That is
   what bounds the cost: the common case never reaches a paid call. What
   changed on 2026-09-15 is the meaning of "settled" — clearing the band is
   not the same as clearing the guard for the action you are asking for, and
   a verdict that does the first and not the second now escalates instead of
   ending the cascade.
2. **A fallback is not a decision.** `review` is both a real verdict and the
   safe default, so the action alone cannot tell them apart. The package
   reports `decided` per head, and only a real verdict — a label a tier
   produced, mapped to an action, clearing that action's guard — is recorded
   as `rule=tier_decided`. Everything else lands on a rule that says what
   actually happened (`needs_human_flag`, `clean_but_abstained`,
   `classifier_failed_closed`).

## What each verdict means for routing

Per the routing rule in
`apps/flowstarter-main/src/lib/flowstarter/scope-route.ts`. The gate's
three-valued `PolicyDecision` is narrowed onto **five** routing values by
`acceptableUseFrom` (`scope-gate.ts`), because `review` was three unrelated
facts wearing one word and the funnel has to send them three different ways.

| Verdict, and what produced it                                        | Routing value | Route                  | The visitor gets                                                              | The operator gets                                          | Booking link |
| -------------------------------------------------------------------- | ------------- | ---------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------ |
| `refuse`                                                             | `blocked`     | `refused`              | the refusal notice, in their own language. No preview, no build.              | a `policy_reviews` row with the category and evidence hash | **never**    |
| `review` **naming a category** (`sensitive_lawful`, `prohibited_uncertain`) | `review`      | `self-serve`           | their preview; a person checks the licence in parallel                        | a `policy_reviews` row, open, with the category            | **never**    |
| `review` **naming none** (`needs_human_flag`, `clean_but_abstained`, `unknown_category`) | `unsettled`   | whatever **scope** says | the scope head's answer, unchanged — including the one clarifying question    | a row only if the scope rule asked for one                 | **never**    |
| `review` from `classifier_unavailable`                               | `hold`        | `hold`                 | "we are still checking this one", en or ro. No preview, no build, no CTA.     | a `policy_reviews` row, plus the outage alert              | **never**    |
| `allow`                                                              | `allowed`     | whatever **scope** says | `standard` → preview, `custom` → discovery call, `unclear` → one question     | nothing                                                    | only on scope `custom` |

Four things this table is load-bearing about:

1. **Only `allowed` may produce a calendar.** Every other value strips
   `discovery-call` (see `withoutACalendar`). A brief nobody has cleared is
   not a brief to sell to, and on staging a request to sell drugs and
   unregistered firearms was offered thirty minutes with Darius, name and
   email already in the URL.
2. **A refusal does not go to `self-serve` any more.** It used to, on the
   reasoning that the preview route screens again and owns the refusal copy,
   and that the second screen "costs nothing because the classifier is
   cached". That is false: the two screens compose **different subjects** —
   `runScopeGate` uses the description, links and link title, while
   `/api/discovery/preview/live` uses the full spec including `businessName`,
   `industry`, `targetAudience`, `goal`, `offer` and `services` — so the
   second screen misses the content-hash cache and makes a *fresh* paid call
   that can time out on its own. Routing a refusal through the component
   whose job is to start generations, and trusting a second coin flip to stop
   it, is the same mistake in a different place.
3. **`hold` is not `review`.** A review says something about the business. A
   hold says something about us, and the copy has to match: telling a florist
   their brief "sits close enough to our acceptable-use policy that a person
   checks it" when in fact our classifier timed out is untrue.
4. **`unsettled` never overrides the scope head.** "The classifier was not
   confident enough to call this clean" is not a finding about the business,
   so "I need a website for my business." still earns its clarifying question
   instead of disappearing into the acceptable-use branch.

The whole table is executable:
`apps/flowstarter-main/src/lib/policy/__tests__/acceptable-use-outcome-table.test.ts`
replays all seven 2026-09-15 scenario briefs through the real gate, the real
rule layer and the real router, with the LLM tier stubbed three ways — the
answers the model actually gave, a timeout, and a thrown error.

## When the gate cannot answer

This is the branch the 2026-09-15 staging failure lived in, and it failed in
three places at once. The brief

> I sell recreational drugs and unregistered firearms by post and I need a
> shop page where buyers can pick what they want and pay in crypto without any
> ID checks.

returned `route=self-serve` three times — a preview being generated — on a
row reading `review|none|0.000|needs_human_flag|embedding`. An hour earlier
the identical text was correctly refused at `refuse|illegal_drugs|0.900|llm`.

### 1. The budget was sized for the wrong kind of tier

`@flowstarter/sigma-core`'s cascade applies `DEFAULT_TIER_BUDGET_MS` (3 s) to
any injected tier whose caller does not override it, and that default is
sized for a *local* tier. The app injected a paid `openai/gpt-4o-mini` call
and said nothing, so turning the embedding tier on silently replaced the
app's own 15 s `ACCEPTABLE_USE_TIMEOUT_MS` with 3 s — a 5x cut invisible in
either file's diff.

Measured against OpenRouter with the real prompt at temperature 0 and the
real 300-token cap, 25 samples per brief:

| Brief                | min    | p50            | max     |
| -------------------- | ------ | -------------- | ------- |
| drugs and firearms   | 706 ms | 802 / 1953 ms  | 2237 ms |
| Romanian adult site  | 680 ms | 748 / 805 ms   | 872 ms  |

(two medians: the model's latency on this prompt is bimodal across runs an
hour apart, which is the point.)

The model call alone reaches 2.2 s — about 75% of the old budget — and that
is *before* `callLlmObject` spends the same budget on the `prepare()`
workspace-cap read and the `settle()` `llm_usage` insert it wraps the call
in, both real round trips against a hosted Supabase on staging. The drugs
brief measured 2.4x the adult brief's median and 2.6x its maximum, so the
budget bit on one and held on the other. That is the whole of why one was
refused correctly and the other was not.

The fix is `ACCEPTABLE_USE_LLM_TIER_BUDGET_MS`, default **12 s**: about 5x
the measured worst case, room for both ledger round trips, and still 3 s
inside `ACCEPTABLE_USE_TIMEOUT_MS` so the cascade's budget — the layer that
records the timeout — is the one that fires first.

### 2. A timeout was indistinguishable from an abstention

`runTier` aborted with no reason, resolved `null`, and pushed nothing to
`trace.errors`, so a blown budget produced a trace byte-identical to one from
a consumer that supplied no tier at all. It now aborts with a
`TierBudgetExpiredError` naming the head and the budget, records
`tier:<head>:timeout:<n>ms`, and reports a per-head `injectedOutcome` of
`verdict | abstained | timeout | error | malformed`. `Decision.tierFailed`
surfaces that to consumers; `tierFailed()` is the predicate.

### 3. The fail-closed rule failed open at the route

A cascade whose deciding tier failed is now a **classifier failure**: the
classification carries `failed`, the rule layer files it under
`classifier_unavailable` (formerly `classifier_failed_closed` — renamed for
what happened, not for the branch that caught it) rather than
`needs_human_flag`, it counts toward `CLASSIFIER_FAILURE_ALERT_THRESHOLD`,
and it routes to `hold` instead of `self-serve`.

The counter also moved up a layer, from `classifyWithLlm` to
`classifyAcceptableUse`. A run of failures is per *submission*, not per model
call, and only the adapter can see a cascade whose deciding tier died without
the model call itself throwing.

`[policy] acceptable-use classifier unavailable` in a log nobody is tailing
is not an alert. A run of `CLASSIFIER_FAILURE_ALERT_THRESHOLD` failures
raises `acceptable_use_classifier_failed` — see `docs/operations/alerts.md`.

