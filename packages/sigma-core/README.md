# @flowstarter/sigma-core

A sigma classifier with no taxonomy in it.

This package is the machinery: a local multilingual encoder, a centroid tier
with an explicit abstention band, a budgeted fail-open cascade, a policy
boundary, an asymmetric-cost scorer, and the trainer and calibrator. It does
not know what your labels mean, and there is a test that proves it —
`test/toy-taxonomy.test.ts` builds a complete working classifier from a
taxonomy about kitchen appliances that exists nowhere else in the repo.

Flowstarter's own heads live next door in
[`@flowstarter/sigma-flowstarter`](../sigma-flowstarter/README.md).

## The shape of a sigma classifier

```
  text
   │
   ▼
  encoder            one local embedding, no network, under a budget
   │
   ▼
  centroid tier      cosine vs per-label centroids, per head
   │
   ├── confident ────────────────────────────┐
   │                                         │
   └── abstained ──▶ injected tier (optional) ┤   caller-supplied, budgeted
                          │                   │
                          └── abstained ──────┤
                                              ▼
                                        policy boundary
                                     label ──▶ action, through
                                     a mapping and numeric guards
                                              │
                                              ▼
                                        allow / review / …
```

Four ideas carry the whole thing.

**Abstention is a first-class outcome.** A verdict counts only outside a band:
the top cosine must reach `min_sim` *and* lead the runner-up by `margin`.
Inside the band the head says so, and the platform's fallback action takes
over. Everything else is built on that — the cascade only spends money where
the local tier abstained, and the policy boundary turns an abstention into the
safe thing rather than into a coin flip.

**No tier may break the request.** Every tier runs inside a budget and a
try/catch. A failure falls through and is recorded in the trace as a string.
The core never invents a label to fill a gap, so the last thing in the chain is
an abstention and `decide()` maps that to whatever the platform said was safe.

**The expensive part runs once.** Every head is scored from the same
embedding. Adding a head costs a few hundred multiply-adds.

**The second tier is an argument.** The core never imports an LLM client,
never reads a key and never opens a socket. Pass a function or get a
pure-local classifier that works offline.

## Install-time model fetch

```bash
pnpm --filter @flowstarter/sigma-core fetch-model
```

Downloads the encoder pinned in `config/encoder.json` — repo, commit sha and a
sha256 per file — into `~/.cache/flowstarter/sigma-core` (override with
`SIGMA_MODEL_CACHE_DIR`). 135 MB, idempotent, safe to wire into a build step.

At runtime Transformers.js is configured with `allowRemoteModels = false`, so a
cache miss throws at load rather than reaching for huggingface.co inside
somebody's request. That is deliberate: an encoder that can fetch is an encoder
that can hang.

## Building a classifier

The short version; `test/toy-taxonomy.test.ts` is the same thing, executable.

```ts
import {
  CentroidScorer, LocalSentenceEncoder, classify, decide,
  loadEncoderConfig, trainCentroids, sweepBand, grid,
} from '@flowstarter/sigma-core';

// 1. Train centroids from labelled phrases, with the encoder that will serve.
const encoder = new LocalSentenceEncoder();
const { file: centroids } = await trainCentroids({
  encoder,
  encoderConfig: loadEncoderConfig(),
  phrases: [{ decision: 'colour', label: 'red', text: 'a fire engine' }, /* … */],
  version: '2026-09-14',
  centered: true,
});

// 2. Sweep the band on a held-out split, under YOUR cost table.
const { best } = sweepBand(samples, {
  minSimGrid: grid(0.02, 0.75, 0.01),
  marginGrid: grid(0, 0.3, 0.005),
  costs: { wrong: 5, abstained: 1 },
  cost: ({ expected, predicted }) =>
    predicted === null ? ['abstained'] : predicted === expected ? [] : ['wrong'],
  minCoverage: 0.9,
});

// 3. Serve.
const scorer = new CentroidScorer(centroids, config);
const trace = await classify(text, { encoder, scorer, centroids, config, encoderConfig });
const { action } = decide(trace, thresholds, mapping);
```

### Centring, and why the cosines look wrong

Sentence-embedding spaces are anisotropic. In raw `multilingual-e5-small`
space, "a dental clinic" and "selling cocaine by courier" sit at cosine 0.81,
while "a dental clinic" and "a wedding photographer" sit at 0.78 — the
similarity is dominated by *being a sentence*, not by what the sentence says,
and a band has nothing to work with.

So when a centroid file says `centered`, each decision's training mean is
subtracted from the query and the centroids before scoring. Similarities come
out in a usable range (0.1–0.6 rather than 0.75–0.9) and the margin starts to
mean something. The mean travels **inside** the centroid file rather than in
code, because the one thing that must never drift is train/serve agreement
about the space.

Consequence worth remembering: a number in a band file is not a raw e5 cosine
and is comparable only to centroids built the same way.

### Calibration picks a plateau, not a minimum

`sweepBand` does not return the cheapest point. It returns the point that is
cheapest **in the worst case** when both thresholds are nudged by
`noiseAllowance` (default 0.006). int8 kernels differ between an ARM dev Mac
and an x86 CI box by a few thousandths of a cosine on the same text; a band
chosen for its cost at exactly one pair of thresholds is a band chosen for one
CPU. Ereno shipped one of those once — a safety question that drew a confident
verdict on x86 and abstained on ARM — and spent a PR cycle finding it.

`minCoverage` is a constraint rather than another term in the objective. An
abstention is the cheapest line in any sensible cost table, so an
unconstrained sweep buys safety with abstention until the classifier is
technically excellent and commercially useless. How often you are willing to
ask a human is a product decision, so it binds the search.

## Evaluation

`src/evaluation.ts` ships no corpus, on purpose: calibration examples and
release holdouts must be separate artifacts with separately recorded
authorship, or a green score only measures how well you encoded your own
examples. `releaseReady()` is a gate on exactly that — it checks provenance,
not quality.

The dataset shape matches Ereno's `tests/data/classifier_eval.json`:
`parity_groups` (one request in several languages, all of which must reach the
same verdict) plus `cases` (one prompt, absolute expectation), with a row-level
`xfail` string for a verdict you know is wrong and want the suite to hold you
to. Scoring is by named mistake, priced from the platform's own table.

`parityViolations()` defaults to the **contradiction** property, not strict
equality, and the reasoning is in the source: a band is a threshold on a
continuous score, and six translations of the same request do not land on the
same score. Gating on strict equality gates on where translations happen to
sit relative to a cosine, and the usual "fix" is to widen the band until the
tier stops abstaining — exactly backwards. What you want is that language
never changes *what* you conclude, only whether you were confident enough to
conclude it. Run `strict` as a reported number.

## Relationship to Ereno sigma

This is an extension of the design in `ask-sage-next/apps/api/sigma`, not a
fork of it. Ereno's sigma stays where it is; what moved here is the part that
was never about travel.

**Shared, deliberately.**

| | Ereno | here |
|---|---|---|
| encoder | `multilingual-e5-small`, int8 ONNX, `query: ` prefix, mean-pool + L2 | same model, same prefix, q8 ONNX via Transformers.js |
| threshold file | `models/semantic_config.json`: `encoder` + `decisions: { labels, min_sim, margin }` | identical shape, plus additive `held_out` and `version` |
| centroid file | `semantic_centroids.npz`, flat `"<decision>/<label>"` keys | same key convention as JSON, mean under `"<decision>/__mean__"` |
| eval dataset | `tests/data/classifier_eval.json`: `parity_groups` + `cases` + `xfail` | same schema |
| cascade | budgeted, fail-open, tier abstains rather than throws | same, with the tiers injectable |
| policy | rules decide; the classifier only suggests | same, generic over label and action |

A centroid set or an eval set therefore moves between the two platforms. The
npz↔JSON conversion is one line of numpy each way (`np.savez(path, **{k:
np.array(v) for k, v in file["vectors"].items()})`).

**Not shared, deliberately.**

- Ereno's travel taxonomy. None of it is here, and nothing in this package
  knows a category name.
- Ereno's regex floors (`sigma/floors.py`) and lexicon. Flowstarter's
  guardrails are a system prompt and a classifier — never keyword or regex
  matchers — so there is no equivalent and there should not be one.
- Ereno's trained SSM router head. The centroid tier is the only local model
  here; a trained head has to be retrained whenever a label moves, and the
  point of this tier is that a category can be added by writing phrases.

**What Ereno would need to adopt this core.** Nothing about its artifacts, and
that is the point of keeping the formats. Practically: a TypeScript runtime
next to the Python one (the API is Python, so this would be a second process or
a port), `semantic_centroids.npz` dumped to JSON, and a decision about the
floors — `apply_floors` runs *before* the semantic tier and is final, which
this cascade has no equivalent of. The clean way to express it here would be a
tier that runs ahead of the centroid one and never abstains, which the cascade
would need a small change to support. Worth doing only if Ereno wants the
calibration and evaluation machinery, which is where most of the value is.

## Tests

```bash
pnpm --filter @flowstarter/sigma-core test
```

Four files, 48 tests. `policy`, `evaluation` and `semantic` are pure — stub
encoders and hand-placed vectors, so the abstention band is checked against
numbers we chose. `toy-taxonomy` trains and serves a real classifier and needs
the fetched model.
