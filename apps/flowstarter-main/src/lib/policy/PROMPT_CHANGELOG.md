# Acceptable-use classifier prompt changelog

The prompt in `prompt.ts` is the detection half of the acceptable-use gate. It
is versioned because a verdict is only explainable if you can read the words
that produced it: `ACCEPTABLE_USE_PROMPT_VERSION` is recorded on every
classification and shown on the operator review board.

Rules for an edit:

1. Change the words, bump the version, add a row here. All three, same commit.
2. Re-run the live evaluation before and after:
   `ACCEPTABLE_USE_LIVE_EVAL=1 pnpm --dir apps/flowstarter-main test -- acceptable-use-live`
   It needs `OPENROUTER_API_KEY` and is skipped without it. Record the
   before/after score in the row.
3. Never put a category, a phrase list or a threshold in the prompt. Categories
   are generated from `acceptable-use.ts`; thresholds belong to the rule layer.

The fixtures the evaluation runs on live in `test/data/acceptable-use-eval.json`.
They are shared with the held-out scorer for `packages/sigma-classifier`, so
their `id` and `expected` fields are a contract: add rows freely, do not
renumber or repurpose existing ones.

## 2026-09-14.1

First version. Written for the gate introduced in `feat/acceptable-use-gate`.

Covers: the nine prohibited categories and the six lawful-but-sensitive ones,
generated from the policy module; an untrusted-data boundary with an explicit
prompt-injection instruction; intent-over-vocabulary as the first judging rule;
euphemism, obfuscation (spacing, leetspeak, homoglyphs, hostnames and alt
text), multilingual reading with Romanian called out by name, jurisdiction
deference via `needs_human`, adult-adjacent separation, creator-page reasoning,
and a thin-text rule. Calibration guidance for `confidence` written to
discourage inflating a number into a refusal.

Live evaluation on the 65 fixtures in `test/data/acceptable-use-eval.json`,
run 2026-09-14 against this prompt version:

    category accuracy: 63/65
    decision accuracy: 62/65
    let through:       0
    over-refused:      0

Decision accuracy is the number that matters: naming `sexual_services` where
the fixture says `adult_content` is a different category and the same correct
refusal. Zero let through and zero over-refused across the euphemisms, the
leetspeak, the Cyrillic homoglyphs, the Romanian, the prompt injections and the
four clean trap cases (a harm-reduction charity, a museum exhibit on the opium
wars, a novelist writing about a cartel, a clinic that removes tattoos).

This is the baseline. Any edit to the words above has to beat it, or say in the
pull request why a regression is worth taking.
