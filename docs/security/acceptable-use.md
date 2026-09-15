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
`apps/flowstarter-main/src/lib/flowstarter/scope-route.ts`:

| Verdict            | The visitor gets                                                                                                                             | The operator gets                                                     | Booking link                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `refuse` (blocked) | 451 and the refusal notice, in their own language. No preview, no build.                                                                     | a `policy_reviews` row with the category and the evidence hash        | **never** — a business we will not build for is the last one to be handed a calendar invite to the studio |
| `review`           | the self-serve path: this rule steps aside, the preview route holds the build on the same verdict, and nothing is emailed                    | a `policy_reviews` row, open, with the category when a tier named one | **never**                                                                                                 |
| `allow`            | whatever the **scope** head decides: `standard` goes to a preview, `custom` goes to a discovery call, `unclear` gets one clarifying question | nothing                                                               | only on the scope head's `custom`                                                                         |

Note what `review` does **not** do: it does not route to the discovery call.
It used to, and on staging the embedding tier abstained on nearly every
brief, so nearly every brief became a sales call — a flower shop, and also an
escort service and a firearms seller, each handed a prefilled calendar link.

## When the gate cannot answer

The LLM tier fails closed to `review` in production, which is the right
behaviour and an invisible one: every enforcement point keeps answering, and
the only symptom is an operator queue filling with ordinary businesses. So
consecutive failures are counted, and a run of
`CLASSIFIER_FAILURE_ALERT_THRESHOLD` of them raises an
`acceptable_use_classifier_failed` ops alert — the same rule, threshold and
counter the scope classifier uses. See `docs/operations/alerts.md`.

`[policy] acceptable-use classifier unavailable` in a log nobody is tailing
is not an alert.
