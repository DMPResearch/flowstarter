> **Archived 2026-09-14.** This scored a branch called `feature/concierge-pivot`
> that no longer exists as the shipped product; the self-serve funnel described
> in `docs/FLOWSTARTER_MASTER_DECISIONS.md` replaced it. Two of its items are
> specifically stale: S2 assumes Convex codegen, which the shipped product
> never adopted (Supabase is the database everywhere, see the master decisions
> doc), and SEC3 audits Daytona sandbox isolation, which PR #132 dropped for
> preview publishing in favor of the platform's own deploy-agent. The file
> paths, line numbers, and priority order below predate the current
> architecture and should not be treated as current. For the actual open work,
> see `docs/next-steps.md`, which lists live items from the 2026-09-13 security
> audits and the 2026-09-12 MVP readiness review instead. Kept here for
> historical context only.

# Flowstarter Monorepo — Improvement Plan

> Created after multi-agent quality pass on feature/concierge-pivot
> Score before: 5.4/10 → Score after: 7.2/10

---

## Current State (post-agent pass)

| Dimension | Before | After | Notes |
|---|---|---|---|
| Architecture | 7.5 | 7.5 | Unchanged — already solid |
| Type safety | 4.0 | 7.0 | tsc green in main + editor |
| Lint / tooling | 3.0 | 8.0 | All projects lint deterministically |
| Maintainability | 6.0 | 6.5 | Gates trustworthy, but large diffs |
| Testing | 5.5 | 5.5 | Cleanup only, no new coverage |
| Security | 5.5 | 6.0 | Supabase nullability, env guards |

**Overall: 7.2/10**

---

## Area 1 — Maintainability

### M1 — Migrate flowstarter-editor to `~/` imports (HIGH)
**Problem:** ~40 production source files use relative `../` imports instead of the configured `~/` alias. This causes `no-restricted-imports` lint failures and makes refactoring harder.

**Fix:** Run a codemod to rewrite all `../../` imports in `apps/flowstarter-editor/app/**` to `~/`.

```bash
# Example approach
npx jscodeshift -t scripts/codemods/relative-to-alias.js apps/flowstarter-editor/app --extensions=ts,tsx
```

**Effort:** 1 day
**Risk:** Low — purely mechanical

---

### M2 — Split god-object files (MEDIUM)
**Problem:** Several files are doing too much:
- `apps/flowstarter-main/src/app/(dynamic-pages)/team/dashboard/services/page.tsx` — 817 LOC
- `apps/flowstarter-main/src/app/(dynamic-pages)/team/dashboard/new/NewProjectWizard.tsx` — 800 LOC
- `apps/flowstarter-editor/app/components/editor/editor-chat/hooks/useEditorChatState.ts` — large orchestration hook

**Fix:** Break each file into focused modules with a clear single responsibility.

**Effort:** 2–3 days per file
**Risk:** Medium — behavior must be preserved exactly

---

### M3 — Standardize pnpm workspace config (MEDIUM)
**Problem:** `apps/flowstarter-editor/package.json` still has `pnpm.overrides`, `pnpm.peerDependencyRules`, and `resolutions` that have no effect in a pnpm workspace. They produce warnings on every `pnpm install`.

**Fix:** Move all overrides to root `package.json`. Remove per-app `packageManager` declarations that conflict with root.

**Effort:** Half a day
**Risk:** Low

---

### M4 — Add editor-engine build step to CI (HIGH)
**Problem:** `packages/editor-engine` must be built before `flowstarter-main` and `flowstarter-editor` can typecheck. This is not automated — fresh installs silently fail.

**Fix:** Add a `prebuild` / `dependsOn` in `nx.json` so the engine package is always built before dependent apps.

```json
// nx.json addition
"targetDefaults": {
  "typecheck": {
    "dependsOn": ["^build"]
  }
}
```

**Effort:** 2 hours
**Risk:** Low

---

## Area 2 — Scalability

### S1 — Add Nx project tags and enforce boundaries (HIGH)
**Problem:** There are no enforced module boundaries between apps and packages. Any app can import from any other app, which leads to coupling over time.

**Fix:** Add `@nx/enforce-module-boundaries` lint rule with explicit boundary definitions.

```json
// .eslintrc root addition
"@nx/enforce-module-boundaries": ["error", {
  "depConstraints": [
    { "sourceTag": "app:main", "onlyDependOnLibsWithTags": ["pkg:shared"] },
    { "sourceTag": "app:editor", "onlyDependOnLibsWithTags": ["pkg:shared"] },
    { "sourceTag": "pkg:shared", "onlyDependOnLibsWithTags": ["pkg:shared"] }
  ]
}]
```

**Effort:** 1 day
**Risk:** Low — only blocks new violations, doesn't break existing code

---

### S2 — Integrate Convex codegen into CI (HIGH)
**Problem:** `convex/_generated/` types are gitignored and must be generated locally. Fresh CI runs or new contributors get tsc failures until they run `npx convex dev`.

**Fix:** Either commit the generated types or run codegen as a pre-typecheck step in CI.

**Effort:** Half a day
**Risk:** Low

---

### S3 — Upgrade @typescript-eslint to v8 (MEDIUM)
**Problem:** `flowstarter-main` uses `@typescript-eslint` v6 while the root Nx uses ESLint 9 which resolves v8+. This version mismatch causes subtle compat warnings.

**Fix:** Upgrade `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` to `^8.0.0` in flowstarter-main, align with the editor which is already on a newer version.

**Effort:** Half a day
**Risk:** Low — just dependency upgrade

---

### S4 — Extract shared Supabase client utility (MEDIUM)
**Problem:** Supabase client creation logic is duplicated across `flowstarter-main/src/supabase-clients/` and editor. The nullable-client pattern was a recurring bug vector.

**Fix:** Move the authenticated Supabase client factory into `packages/editor-engine` or a new `packages/supabase-utils` shared package with proper typing and null-safety built in.

**Effort:** 1 day
**Risk:** Medium — requires coordinated refactor across two apps

---

## Area 3 — Testing

### T1 — Fix Vitest OOM configuration (HIGH)
**Problem:** `flowstarter-main` vitest config has heavy OOM workarounds:
```js
singleFork: true,
fileParallelism: false,
execArgv: ['--max-old-space-size=8192']
```
This means tests run sequentially and slowly. The root cause is likely large module graphs being loaded per test.

**Fix:** Identify which test files pull in large dependency trees and mock them at the module boundary. Then re-enable parallelism incrementally.

**Effort:** 2–3 days
**Risk:** Medium

---

### T2 — Add coverage thresholds to CI for flowstarter-editor (HIGH)
**Problem:** `flowstarter-editor` has no coverage thresholds set. `flowstarter-main` has thresholds (82% lines/functions) but they are not enforced in CI.

**Fix:**
- Add coverage thresholds to `flowstarter-editor/vitest.config.ts`
- Add `pnpm test --coverage` step to CI workflow

**Effort:** Half a day
**Risk:** Low — may initially fail if coverage is below threshold; add `--reporter=text` to see what's missing

---

### T3 — Fix or remove stale mcp-server tests (MEDIUM)
**Problem:** `apps/flowstarter-library/mcp-server` tests have historically been unreliable — running against both `src` and `build` output, with stale mock drift. Many tests were cleaned up but the underlying mock patterns are fragile.

**Fix:** Audit all mcp-server tests against current source. Remove tests that test compiled output. Stabilize the remaining ones with proper module mocks.

**Effort:** 1–2 days
**Risk:** Low

---

### T4 — Add E2E smoke tests to CI (MEDIUM)
**Problem:** Playwright E2E tests exist for the editor but are not run in CI. The `test:e2e:smoke` target exists but isn't wired into any workflow.

**Fix:** Add a CI job that runs `pnpm test:e2e:smoke` against a deployed preview URL after merge.

**Effort:** 1 day
**Risk:** Low

---

## Area 4 — Security

### SEC1 — Regenerate Supabase types after leads migration (HIGH)
**Problem:** The `leads` table is used in 3 API routes but is not in the generated `database.types.ts`. Those routes use `@ts-nocheck` as a workaround. This also means Supabase RLS and query typing for leads is untested at the type level.

**Fix:**
```bash
pnpm --dir apps/flowstarter-main gen:types
```
Then remove `@ts-nocheck` from the 3 leads routes and fix the resulting type errors properly.

**Effort:** Half a day
**Risk:** Low

---

### SEC2 — Add input validation to all API routes (HIGH)
**Problem:** Several API routes accept request bodies without Zod validation:
- `src/app/api/leads/capture/route.ts`
- `src/app/api/integrations/**/route.ts`
- `src/app/api/projects/route.ts`

This is a real injection risk — unvalidated input reaching Supabase queries.

**Fix:** Add Zod schemas at the top of every route handler for request body parsing. Use `next-safe-action` or `zod.parseAsync` consistently.

**Effort:** 2–3 days
**Risk:** Low to medium

---

### SEC3 — Audit Daytona sandbox isolation (MEDIUM)
**Problem:** The Daytona sandbox service runs user-generated code. File service and shell execution paths in `apps/flowstarter-editor/app/lib/services/daytona/` could be path-traversal vectors if sandbox isolation breaks.

**Fix:** Audit `fileService.ts`, `sandboxService.ts`, and `devServerService.ts` for path sanitization. Add tests that attempt traversal patterns.

**Effort:** 2 days
**Risk:** Medium

---

### SEC4 — Add rate limiting to AI generation endpoints (MEDIUM)
**Problem:** `flowstarter-main` uses Arcjet for rate limiting but it's only applied to some routes. Key AI generation endpoints in `flowstarter-editor` (api.build, api.modify-site, api.assets-agent) have no rate limiting.

**Fix:** Apply Arcjet or a simple Redis-backed rate limiter to all AI generation routes. Set per-user and per-IP limits.

**Effort:** 1–2 days
**Risk:** Low

---

### SEC5 — Rotate and audit E2E secret handling (LOW)
**Problem:** E2E tests use a `E2E_SECRET` env var as a bypass token for authentication. This pattern is correct in principle but:
- The secret should be rotated regularly
- It should not leak into logs
- The bypass should be guarded behind `process.env.NODE_ENV !== 'production'` — which it is, but it should be validated in CI

**Fix:** Add a CI step that verifies `E2E_SECRET` is not set in production environment variables.

**Effort:** 2 hours
**Risk:** Low

---

## Priority Order

| Priority | Task | Effort | Impact |
|---|---|---|---|
| 1 | SEC1 — Regenerate Supabase types | 0.5 day | Removes @ts-nocheck from leads routes |
| 2 | M4 — editor-engine CI build step | 2 hrs | Fixes fresh install tsc |
| 3 | S2 — Convex codegen in CI | 0.5 day | Fixes editor tsc in CI |
| 4 | M1 — ~/  import migration | 1 day | Clears editor lint debt |
| 5 | SEC2 — Input validation on routes | 2–3 days | Real security improvement |
| 6 | M3 — Workspace pnpm config | 0.5 day | Eliminates install warnings |
| 7 | T2 — Coverage thresholds in CI | 0.5 day | Enforces test quality |
| 8 | S1 — Nx module boundaries | 1 day | Prevents future coupling |
| 9 | T1 — Fix vitest OOM | 2–3 days | Faster, parallel test runs |
| 10 | SEC3 — Daytona sandbox audit | 2 days | Sandbox security |
| 11 | SEC4 — Rate limiting AI endpoints | 1–2 days | API abuse protection |
| 12 | M2 — Split god-object files | 2–3 days each | Long-term maintainability |
| 13 | S3 — Upgrade @typescript-eslint | 0.5 day | Removes compat warnings |
| 14 | S4 — Shared Supabase client | 1 day | Prevents future nullability bugs |
| 15 | T3 — Fix stale mcp-server tests | 1–2 days | Test reliability |
| 16 | T4 — E2E smoke tests in CI | 1 day | Regression protection |
| 17 | SEC5 — E2E secret audit | 2 hrs | Security hygiene |
