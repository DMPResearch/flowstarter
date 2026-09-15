/**
 * Single source of truth for the editor SPA's configured sub-path base.
 *
 * The editor is built with `VITE_BASE_PATH=/editor/` for a production
 * sub-path deploy (`docs/operations/operator-editor.md`), where Caddy's
 * `handle_path /editor/*` strips the prefix before proxying to the router.
 * A page served at `/editor/` therefore has to add that prefix back onto
 * every absolute path it constructs itself — an un-prefixed `/api/...`
 * fetch, WebSocket URL, or same-app navigation link falls through Caddy's
 * `handle {}` block to the tenant's own site content instead of the
 * router, which answers 200 with unrelated HTML instead of the expected
 * JSON/upgrade response. A root-mounted dev server has `BASE_URL === "/"`,
 * so every helper here is a no-op there.
 *
 * Originally landed duplicated in three places (#182: `router.ts`,
 * `lib/clerkSession.ts`, `environments/primary/target.ts`) after PR #182
 * fixed the paths that blocked every session outright. This module is the
 * consolidation: every absolute-path literal in the SPA should route
 * through `withBasePath()` (or `EDITOR_BASE_PATH` directly for the few
 * call sites — router basepath config, URL-pathname joins — that need the
 * bare prefix rather than a full path). See `basePathLiterals.test.ts` for
 * the source-tree rule that keeps new hardcoded paths from creeping back
 * in.
 */

// Vite strips its configured base from `import.meta.env.BASE_URL`.
const RAW_BASE_URL = import.meta.env.BASE_URL ?? "/";

/** Base path with no trailing slash: `""` at root, `"/editor"` under a sub-path deploy. */
export const EDITOR_BASE_PATH = RAW_BASE_URL.replace(/\/+$/, "");

/**
 * Prefix an absolute path (leading `/`) with the editor's configured base
 * path. Use this for `fetch()` / same-origin URL literals — anywhere a
 * path like `/api/...` or `/pair` is constructed from a string literal
 * rather than joined onto an already-base-aware URL object.
 *
 *   withBasePath("/api/auth/sign-out") // "/api/auth/sign-out" at root,
 *                                      // "/editor/api/auth/sign-out" under
 *                                      // VITE_BASE_PATH=/editor/
 */
export function withBasePath(pathname: string): string {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${EDITOR_BASE_PATH}${normalized}`;
}

/**
 * The editor's own root URL on the current origin, base path included and
 * trailing slash kept (a bare `/editor` without one hits Caddy's `redir
 * /editor/ permanent`, which some callers — e.g. Clerk's post-sign-out
 * redirect — cannot follow). Returns `"/"` outside the browser (SSR/test).
 */
export function editorOriginUrl(): string {
  const suffix = EDITOR_BASE_PATH ? `${EDITOR_BASE_PATH}/` : "/";
  if (typeof window === "undefined") return suffix;
  return `${window.location.origin}${suffix}`;
}
