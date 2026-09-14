# @flowstarter/sigma-flowstarter

Flowstarter's two guardrail heads, over
[`@flowstarter/sigma-core`](../sigma-core/README.md).

```ts
import { classifyAcceptableUse, warmSigma } from '@flowstarter/sigma-flowstarter';

await warmSigma();                                   // once, at startup

const decision = await classifyAcceptableUse(brief); // ~4ms warm
decision.acceptableUse; // 'allow' | 'review' | 'refuse'
decision.scope;         // 'standard' | 'custom' | 'unclear'
```

There is no keyword list, no regex floor and no denylist in this package.
Flowstarter's guardrails are a system prompt and a classifier, and a classifier
here is a geometry over embeddings. Seed phrases exist in
`src/training/phrases.ts`, but they are averaged into centroids at train time
and never consulted at request time — the only thing that touches a user's text
in production is the tokenizer.

## The two heads

Both are scored from **one** embedding, so the second head is nearly free.

**`acceptable_use`** — 16 labels in three classes.

- *prohibited* (9): illegal drugs, prostitution and escort services, adult
  content, weapons and ammunition, unlicensed gambling, counterfeit goods,
  hate and harassment, scams and impersonation, unlicensed medical or
  financial claims. → `refuse`, when confident.
- *sensitive* (6): licensed pharmacy, legal cannabis, firearms training,
  sexual health, licensed betting, adult-adjacent lawful retail. → always
  `review`. These are not "almost prohibited" — a licensed pharmacy is a real
  customer. They go to a human because the licence, not the sentence, is what
  makes them lawful, and we cannot see a licence from a text box.
- *clean* → `allow`, when confident.

**`scope`** — can the self-serve funnel build this unattended, or does it have
to be contracted through DMPResearch after a discovery call?

- `standard-site` → `standard`. Brochure, portfolio, services, local business,
  restaurant, clinic, coach, small shop with a simple catalogue. **A contact
  form or an intro-call booking widget is part of a standard site**, not a
  reason to escalate — there is a test named after that, because it is the
  failure mode a classifier that learned surfaces would have.
- `custom-work` → `custom`. Web and mobile apps, SaaS, marketplaces, anything
  with user logins or an admin panel, booking or payment systems past a simple
  form, custom integrations and APIs, multi-tenant or multi-language
  enterprise sites, migrations of large existing systems.
- `unclear` → `unclear`. A real trained label, not just the abstention: "we
  need a digital presence" is genuinely underspecified and the funnel should
  ask. The abstention lands on the same action, so the product behaves
  identically either way.

## Abstention semantics

A head answers only outside its band: top cosine ≥ `min_sim` **and** margin
over the runner-up ≥ `margin`, both from `models/semantic-config.json`. Inside
the band it abstains.

On top of the band sit **guards** (`config/policy.json`): extra similarity and
margin required before an action that costs somebody something. The band
decides whether we answer; a guard decides whether the answer is strong enough
to act on. Refusing a business and sending a standard site to a sales call are
both guarded; `review` and `unclear` are the fallbacks and need no guard,
because doing them wrongly costs a human two minutes.

The resulting contract, which the gate depends on:

| situation | `acceptableUse` | `scope` |
|---|---|---|
| confident prohibited, guard met | `refuse` | — |
| confident clean, guard met | `allow` | — |
| any sensitive category | `review` | — |
| band abstained | `review` | `unclear` |
| guard not met | `review` | `unclear` |
| encoder missing, slow or broken | `review` | `unclear` |
| injected model says "clean" | `review` (never `allow`) | — |
| any error, in production | `review` | `unclear` |

There is no path through this package that throws in production, and none that
returns `allow` without a confident `clean` from the local tier. An injected
model may refuse (above 0.85 self-reported confidence) but may never allow: the
semantic tier abstaining is exactly the case where we want a person, and a
model saying "clean, 0.99" is not evidence of a licence.

## How the acceptable-use gate consumes it

```ts
// apps/flowstarter-main — once, at startup (instrumentation.ts or equivalent)
import { warmSigma } from '@flowstarter/sigma-flowstarter';
await warmSigma();   // ~600ms; throws if the model cache is missing

// in the request path
import { classifyAcceptableUse } from '@flowstarter/sigma-flowstarter';

const decision = await classifyAcceptableUse(brief.description);

switch (decision.acceptableUse) {
  case 'refuse':
    return refusal({ category: decision.category, reason: decision.reasons.acceptableUse });
  case 'review':
    return queueForReview({ decision });     // the common case; not a failure
  case 'allow':
    break;
}

if (decision.scope === 'custom') return bookDiscoveryCall({ decision });
if (decision.scope === 'unclear') return askOneMoreQuestion();
proceedToBuild();
```

Notes for the gate:

- `classifyScope(text)` is the same call under the name that reads better at a
  routing call site. Both return the full `Decision`, because throwing half of
  it away would only make you run the encoder twice.
- `decision.trace` is safe to log: labels, numbers, tier names and timings, and
  never the user's text — including inside error strings, which is asserted.
- `decision.reasons` are machine-readable (`confident:acceptable_use:clean:semantic`,
  `guard_not_met:acceptable_use:illegal_drugs:min_margin`) and are what the
  review queue should show the reviewer.
- Adding an LLM second tier later is a one-line change at the call site and
  touches nothing in this package:
  `classifyAcceptableUse(text, { tiers: { acceptable_use: myTier } })`. It is
  consulted only where the local tier abstained.
- **Bundling.** `main`/`types`/`exports` point at built `dist/` output (see
  `@flowstarter/sigma-core`'s README, "Packaging: this ships built JS, not
  source" — the same fix applies here, via the same `tsc -p
  tsconfig.lib.json` build). `config/` and `models/` are read with
  `readFileSync` from paths next to the package root, which `dist/` sits
  beside exactly as `src/` did, so this resolves normally in a bundler that
  traces real files on disk — no `webpackIgnore`, no runtime-only import, no
  `serverExternalPackages` needed for **this** package. The one thing that
  still may need external-package treatment in the consuming app is
  `onnxruntime-node`'s native `.node` binding, several hops down in
  `@flowstarter/sigma-core`'s dependency tree — that is an ordinary "don't
  bundle a native addon" concern and not specific to this package. Override
  `SIGMA_FLOWSTARTER_ROOT` / `SIGMA_CORE_ROOT` only for something unusual, like
  a deploy layout that does not keep `config/`/`models/` next to `dist/`.

## Measured, 2026-09-14 (retrained)

Encoder: `Xenova/multilingual-e5-small`, q8 ONNX (`onnx/model_quantized.onnx`),
pinned at `761b726d…`, 135 MB on disk, 384 dimensions.

Operating point, from `scripts/calibrate.mjs` on a template-disjoint holdout
(1 416 phrases, up from 1 344 — see "Medical and clinical adjacency retrain"
below):

| head | `min_sim` | `margin` | holdout coverage | accuracy on covered | cost | robust cost |
|---|---|---|---|---|---|---|
| `acceptable_use` | 0.02 | 0.04 | 93.2 % | 97.2 % | 693 | 717 |
| `scope` | 0.06 | 0.00 | 93.2 % | 93.7 % | 212 | 236 |

Held-out evaluation, from the committed datasets (real briefs, written to look
nothing like the training templates):

| | cases | cost (gate) | coverage | accuracy on covered | the mistake that is not tradeable |
|---|---|---|---|---|---|
| acceptable use | 157 scored (+4 xfail) | **135** (≤ 200) | 95.5 % | 90.0 % | 0 prohibited misses |
| scope | 130 | **2** (≤ 40) | 99.2 % | 99.2 % | 0 custom work called standard |

Latency on an M-series Mac (`pnpm bench`), whole decision, both heads:

- cold load 571 ms, paid once by `warmSigma()`
- warm, uncached **p50 4.6 ms**, p95 6.0 ms
- warm, cached 0.0 ms (content-hash embedding cache)
- per-call budget 400 ms, after which the tier fails open to `review`

### Medical and clinical adjacency retrain, 2026-09-14

`test/data/acceptable-use-eval.json` gained `clean_dermatology_laser_tattoo_removal`,
mirroring flowstarter-main's own acceptable-use fixture `au-060` (a licensed
dermatology clinic offering laser tattoo removal and skin cancer screening).
Before this retrain, the committed centroids read that brief as
`unlicensed_medical_financial_claims` — margin 0.053 over the runner-up,
close enough to the `review` side of the `refuse` guard that it landed on
`review` rather than `refuse`, but for the wrong reason and one calibration
away from becoming a hard refusal. Confident and correct is the property that
matters here, not "did not quite refuse."

Fix: five new `clean` seeds per language in `src/training/phrases.ts`
(dermatology clinic with laser tattoo removal and skin cancer screening,
registered dermatologist for mole checks, physiotherapy clinic, cosmetic
clinic run by licensed practitioners, optician), plus one `licensed_pharmacy`
seed per language stating a licence number explicitly, then a full
`train` → `calibrate` cycle. Dentistry and veterinary practice were already
represented in `clean`.

| | before | after |
|---|---|---|
| `au-060`-equivalent fixture | `unlicensed_medical_financial_claims`, `review` (margin 0.053, one calibration from `refuse`) | `clean`, `allow` (similarity 0.304, margin 0.137) |
| acceptable-use held-out cost (157 cases incl. the new fixture) | 155 | **135** (≤ 200 gate) |
| acceptable-use held-out coverage | 94.9 % | 95.5 % |
| acceptable-use held-out accuracy on covered | 89.3 % | 90.0 % |
| prohibited misses | 0 | 0 (unchanged; the gate that must never move) |

Both numbers in the "before" row were measured on this same head with the new
fixture already added to the eval set but the old, unretrained centroids
still committed, so the comparison isolates the seed change rather than also
crediting it for a fixture that did not previously exist in the set.

## Known weaknesses

Four rows in `test/data/acceptable-use-eval.json` carry `xfail` with a reason.
They are verdicts we know are wrong, kept in the set rather than in an issue
comment: they are excluded from the cost, and the suite **fails if one starts
passing**, so fixing the classifier means deleting the marker in the same
commit.

All four are the same shape — a clean business that a mean-pooled sentence
embedding cannot separate from a prohibited one:

- a costume shop selling clearly-marked **replica** movie props → refused as
  counterfeit goods (sim 0.335, margin 0.140)
- a board-game cafe with a friendly **poker** night, no money → refused as
  unlicensed gambling
- an outdoor outfitter that says "**we do not sell firearms**" → refused as
  weapons; negation is exactly what mean pooling loses
- regulated debt advice → refused as a scam; the regulator's name is the only
  thing separating it from advance-fee fraud, and it is one token

No threshold fixes any of these. The fixes available are more clean-adjacency
training (the `clean` seed set already carries four such seeds — model railway
reproductions, fishing tackle, an arcade, a nutritionist — which is what pulled
several other rows out), or letting an injected LLM tier review confident
refusals as well as abstentions. The second would be a change to the cascade
contract and is not in this PR.

Also worth knowing: the euphemism and obfuscated-spelling rows ("c0ca1ne
d3livery", "party favours, you know what we mean") mostly **abstain** rather
than refuse. That is the intended behaviour — they land on `review`, a human
sees them, and they cost 10 rather than 100 — but it is a real limit of an
embedding tier, and it is why the obfuscated rows are in the set as inputs to
the encoder rather than as something a matcher would catch.

## Retraining, calibrating, evaluating

```bash
pnpm --filter @flowstarter/sigma-core fetch-model      # once, 135 MB
pnpm --filter @flowstarter/sigma-flowstarter train     # ~20s  -> models/centroids.json
pnpm --filter @flowstarter/sigma-flowstarter calibrate # ~15s  -> models/semantic-config.json
pnpm --filter @flowstarter/sigma-flowstarter test      # the gates
pnpm --filter @flowstarter/sigma-flowstarter bench     # latency on this machine
```

Run them in that order. Centroids without a re-swept band are a band
calibrated against geometry that no longer exists, and `train` also rewrites
`models/provenance.json` — encoder revision, the sha256 of every model file,
per-label phrase counts, the date — so a number in the band file can be traced
to something rather than to somebody's afternoon.

Each of `train`, `calibrate`, `test`, `bench`, `build` and `typecheck` carries
a `pre*` hook that builds `@flowstarter/sigma-core` first, because this
package now imports it through `exports` pointing at *its* `dist/` (see
"Bundling" below) rather than its source — a stale or missing
`sigma-core/dist` would otherwise be a confusing "cannot find module" a layer
away from the command you actually ran. The hooks make the commands above
work standalone on a fresh checkout; you do not need to build sigma-core by
hand first.

**To add a category**: add its labels to `src/taxonomy.ts`, seeds in six
languages to `src/training/phrases.ts`, rows to the eval dataset, then
train → calibrate → test. No code changes anywhere else; that is the payoff of
a centroid tier over a trained head.

**After changing the seeds, re-read the guards.** `config/policy.json` carries
numbers taken from the held-out distribution per language, and the comment at
the top of that file records the lesson that produced them: *similarity is the
wrong thing to lean on and margin is the right one*. Rows wrongly called
prohibited sat at similarity ~0.17 — which is also where correct French and
Romanian prohibited rows sat — so a similarity guard tuned on English does not
separate right from wrong, it separates English from French. Margin does
separate them.

**The sweep is a constrained optimisation**, not a minimisation. See
`calibration.minCoverage` in `config/evaluation.json` and the note in the core
README: an unconstrained sweep buys safety with abstention until the
classifier is useless.

**Do not calibrate against the eval datasets.** They are the holdout, and
`releaseReady()` fails the suite if the authorship recorded in a dataset's
`provenance` block overlaps with the calibration authors. One deliberate
exception is recorded here for honesty: after the first evaluation run, four
adjacency seeds were added to the `clean` class because the failures showed
the taxonomy had no coverage of lawful businesses that mention a prohibited
domain. That is a taxonomy gap visible on its own terms, but it was found on
the holdout, and the holdout is that much less independent for it.

## Files

```
config/policy.json         thresholds and guards — every number the boundary acts on
config/evaluation.json     asymmetric costs, the calibration constraint, release gates
models/centroids.json      per-label centroids + per-head training mean (generated)
models/semantic-config.json  the calibrated band, with what it scored (generated)
models/provenance.json     what the centroids were built from (generated)
src/taxonomy.ts            the two closed label sets
src/gate.ts                classifyAcceptableUse, classifyScope, decide, warmSigma
src/costs.ts               which mistake happened; config/ prices it
src/training/phrases.ts    the synthetic multilingual seeds, no LLM in the loop
test/data/*.json           the held-out evaluation sets
dist/                      what `main`/`exports` actually point at (generated,
                           gitignored — `pnpm run build`, see "Bundling")
```
