# Secret scanning

Two independent GitGuardian scanners run against this repo. They don't share
configuration, so a change to one doesn't affect the other.

## ggshield (CLI / pre-commit / pre-push)

`ggshield` is the CLI scanner. Where it's wired into a hook, it reads
`.gitguardian.yaml` at the repo root — a v2-schema config
(`version: 2`, keys nested under `secret:`) — and honours its
`secret.ignored_paths` globs, so test and fixture files under those paths are
never scanned locally. See `.gitguardian.yaml` for the exact list; it's kept
narrow (test/spec files, `__tests__/`, `test/`, `tests/`, `e2e/`, `fixtures/`)
so a real secret leaking into application code is never masked.

`ggshield` is not currently wired into a `.husky` hook in this repo. If that
changes, point it at this file with `ggshield secret scan` (it picks up
`.gitguardian.yaml` automatically from the repo root).

## GitGuardian GitHub app (pull request check)

The GitGuardian check that appears on pull requests is the GitHub app, not
`ggshield`. It scans the PR diff server-side against GitGuardian's own policy
and **does not read `.gitguardian.yaml`** — there is no way to give it a path
exclusion from this repo. It will flag anything shaped like a secret,
including test fixtures, unless the fixture itself isn't a string literal.

## The fixture convention

Because the PR check ignores our path excludes, tests must not rely on
`.gitguardian.yaml` to keep the PR check green. Instead:

- Values used as secrets, tokens, passwords, or keys in tests are **minted at
  runtime** (`crypto.randomUUID()`, `randomBytes(...).toString('hex')`, a
  per-process constant built from non-secret-looking parts, etc.), not
  hardcoded string literals.
- Never assign a quoted literal to a variable, constant, or field whose name
  contains `secret`, `token`, `password`, or `key` — that's the exact shape
  both scanners pattern-match on, and it's what the GitHub app check has no
  way to ignore.
- `.gitguardian.yaml`'s `ignored_paths` exists only to keep local `ggshield`
  runs quiet in test/fixture directories where the runtime-minted convention
  above is already followed — it is a courtesy for local development, not the
  mechanism that keeps the PR check green.

When adding a new test that needs a secret-shaped value, mint it in the test
setup rather than pasting a literal, even under a path this file's
`ignored_paths` covers.
