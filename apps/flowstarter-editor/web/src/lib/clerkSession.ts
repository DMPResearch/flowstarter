/**
 * Web-side companion to `apps/flowstarter-editor/server/src/auth/clerkGate.ts`.
 *
 * The editor itself owns no sign-in UI. Instead:
 *   1. The browser calls `GET /api/clerk/me` on bootstrap.
 *   2. If the response is `{ authenticated: true, identity }`, we feed
 *      `identity.tier` into <TierProvider> and let the rest of the app render.
 *   3. If the response is `{ authenticated: false, loginUrl }`, we redirect
 *      the browser to `loginUrl` (typically `flowstarter.dev/login`) which
 *      lives in the main app's Clerk integration.
 *
 * Cookies are scoped to the parent domain, so once Clerk is happy the
 * session is automatically present on `editor.flowstarter.app`.
 */

/**
 * Mirrors the server's canonical `PlanKey`
 * (`apps/flowstarter-editor/server/src/usage/planEntitlements.ts`). The
 * server normalises legacy `tier_name` strings at its read boundary, so
 * the wire only ever carries these five canonical values.
 */
export type PlanKey = "starter" | "pro" | "max" | "ecommerce" | "admin";
export type EditorRole = "admin" | "client";

export interface ClerkWorkspaceContext {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly tier: PlanKey;
}

export interface ClerkIdentity {
  readonly userId: string;
  readonly role: EditorRole;
  readonly tier: PlanKey;
  readonly allowedWorkspaceIds: ReadonlyArray<string>;
  /**
   * Workspace this request was scoped to (derived server-side from the
   * `Host` header). `null` when the request didn't carry a recognised
   * workspace subdomain — e.g. local dev on `localhost:5733`.
   */
  readonly currentWorkspace: ClerkWorkspaceContext | null;
}

export type ClerkSessionResolution =
  | { readonly status: "authenticated"; readonly identity: ClerkIdentity }
  | { readonly status: "unauthenticated"; readonly loginUrl: string; readonly reason: string }
  | { readonly status: "config-error"; readonly reason: string }
  | { readonly status: "error"; readonly reason: string };

interface ClerkMeOk {
  readonly authenticated: true;
  readonly identity: ClerkIdentity;
}

interface ClerkMeFailure {
  readonly authenticated: false;
  readonly reason: string;
  readonly loginUrl?: string;
  readonly configError?: boolean;
}

// Vite strips its configured base from `import.meta.env.BASE_URL` (same
// pattern `router.ts` already uses). A root-mounted dev server has
// `BASE_URL === "/"`, so these fall back to the un-prefixed paths there —
// but a sub-path production deploy (`VITE_BASE_PATH=/editor/`, the shape
// `docs/operations/operator-editor.md` documents) sits behind Caddy's
// `handle_path /editor/*`, which strips the prefix before proxying to the
// router. An absolute `/api/...` fetch from a page served at `/editor/`
// therefore never reaches the router at all: it falls through Caddy's
// `handle {}` block to the tenant's own site content instead, which answers
// 200 with unrelated HTML. `safeReadJson` can't parse that, and the result
// is "Editor server returned empty body" with no indication the request
// went to the wrong place. Verified against a real sub-path deploy on
// fs-sites-01, 2026-09-15.
const EDITOR_BASE_PATH = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "");
const CLERK_ME_PATH = `${EDITOR_BASE_PATH}/api/clerk/me`;
const CLERK_AUTO_PAIR_PATH = `${EDITOR_BASE_PATH}/api/clerk/auto-pair`;

/** Must match server `EDITOR_CLERK_LOGIN_RETURN_HEADER` (`clerkHttp.ts`). */
const CLERK_LOGIN_RETURN_URL_HEADER = "X-Editor-Return-Url";

function editorClerkReturnHeaders(): HeadersInit | undefined {
  if (typeof window === "undefined") return undefined;
  return { [CLERK_LOGIN_RETURN_URL_HEADER]: window.location.href };
}

/**
 * Fetch the current identity from the editor server. Resolves to one of
 * four outcomes; never throws for ordinary unauthenticated cases. Network
 * + parse errors land in the `error` branch with a `reason` string.
 */
export async function fetchClerkSession(
  signal?: AbortSignal,
): Promise<ClerkSessionResolution> {
  let response: Response;
  try {
    const init: RequestInit = {
      method: "GET",
      credentials: "include",
      cache: "no-store",
    };
    const headers = editorClerkReturnHeaders();
    if (headers) init.headers = headers;
    if (signal) init.signal = signal;
    response = await fetch(CLERK_ME_PATH, init);
  } catch (error) {
    return {
      status: "error",
      reason: error instanceof Error ? error.message : "Network error",
    };
  }

  if (response.status === 503) {
    const body = await safeReadJson(response);
    return {
      status: "config-error",
      reason: typeof body?.reason === "string" ? body.reason : "Editor server is missing Clerk config",
    };
  }

  if (!response.ok && response.status !== 200) {
    const body = await safeReadJson(response);
    return {
      status: "error",
      reason: typeof body?.reason === "string" ? body.reason : `HTTP ${response.status}`,
    };
  }

  const body = (await safeReadJson(response)) as ClerkMeOk | ClerkMeFailure | null;
  if (!body) {
    return { status: "error", reason: "Editor server returned empty body" };
  }

  if (body.authenticated === true) {
    return { status: "authenticated", identity: body.identity };
  }

  if (body.configError === true) {
    return {
      status: "config-error",
      reason: body.reason ?? "Editor server is missing Clerk config",
    };
  }

  if (typeof body.loginUrl === "string" && body.loginUrl.length > 0) {
    return {
      status: "unauthenticated",
      loginUrl: body.loginUrl,
      reason: body.reason ?? "Sign-in required",
    };
  }

  return {
    status: "error",
    reason: body.reason ?? "Editor server returned an unexpected response",
  };
}

async function safeReadJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type AutoPairResolution =
  | { readonly status: "paired"; readonly identity: ClerkIdentity }
  | { readonly status: "no-workspace"; readonly reason: string }
  | { readonly status: "unauthenticated"; readonly loginUrl?: string; readonly reason: string }
  | { readonly status: "config-error"; readonly reason: string }
  | { readonly status: "error"; readonly reason: string };

/**
 * Bridge from a Clerk-authenticated browser to a T3 session cookie. The
 * server validates the Clerk JWT, mints a one-shot pairing credential
 * with the appropriate role (admin → owner, client → client), exchanges
 * it for a session, and sets the `t3_session` cookie.
 *
 * Idempotent — repeat calls just create extra T3 sessions; the editor
 * deduplicates them on the next descriptor refresh.
 */
export async function autoPairWithEditor(
  signal?: AbortSignal,
): Promise<AutoPairResolution> {
  let response: Response;
  try {
    const init: RequestInit = {
      method: "POST",
      credentials: "include",
      cache: "no-store",
    };
    const headers = editorClerkReturnHeaders();
    if (headers) init.headers = headers;
    if (signal) init.signal = signal;
    response = await fetch(CLERK_AUTO_PAIR_PATH, init);
  } catch (error) {
    return {
      status: "error",
      reason: error instanceof Error ? error.message : "Network error",
    };
  }

  const body = (await safeReadJson(response)) as
    | { paired?: boolean; identity?: ClerkIdentity; reason?: string; loginUrl?: string; configError?: boolean; code?: string }
    | null;

  if (response.status === 401) {
    return {
      status: "unauthenticated",
      reason: body?.reason ?? "Sign-in required",
      ...(body?.loginUrl ? { loginUrl: body.loginUrl } : {}),
    };
  }
  if (response.status === 403) {
    if (body?.code === "no_workspace") {
      return {
        status: "no-workspace",
        reason: body?.reason ?? "No workspaces are accessible to this user",
      };
    }
    return {
      status: "error",
      reason: body?.reason ?? "Forbidden",
    };
  }
  if (response.status === 503) {
    return {
      status: "config-error",
      reason: body?.reason ?? "Editor server is missing Clerk config",
    };
  }
  if (!response.ok || !body || body.paired !== true || !body.identity) {
    return {
      status: "error",
      reason: body?.reason ?? `HTTP ${response.status}`,
    };
  }
  return { status: "paired", identity: body.identity };
}

function isApiReturnPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function parseRedirectUrlParam(raw: string | null): URL | null {
  if (!raw?.trim()) return null;
  const trimmed = raw.trim();
  try {
    return new URL(decodeURIComponent(trimmed));
  } catch {
    try {
      return new URL(trimmed);
    } catch {
      return null;
    }
  }
}

/**
 * Returns sign-in URL with `redirect_url` set to the editor return address when
 * the server did not already attach one. Used for anchor `href`s (direct
 * clicks) as well as `redirectToLogin()`.
 *
 * If `redirect_url` already points at `/api/*` (e.g. a stale `/api/clerk/me`
 * from an earlier hop), it is replaced so Clerk never lands the browser on a
 * JSON API route after sign-in.
 */
export function withEditorReturnUrl(loginUrl: string, currentHref: string): string {
  try {
    const target = new URL(loginUrl);
    const existing = parseRedirectUrlParam(target.searchParams.get("redirect_url"));
    const existingIsUnusable =
      !existing ||
      (existing.protocol !== "http:" && existing.protocol !== "https:") ||
      isApiReturnPath(existing.pathname);

    if (!existingIsUnusable) {
      return target.toString();
    }

    let next: string | undefined;
    try {
      const cur = new URL(currentHref);
      if (cur.protocol === "http:" || cur.protocol === "https:") {
        next = isApiReturnPath(cur.pathname) ? `${cur.origin}/` : currentHref;
      }
    } catch {
      /* leave next unset */
    }
    if (next) {
      target.searchParams.set("redirect_url", next);
    }
    return target.toString();
  } catch {
    return loginUrl;
  }
}

/**
 * Hard-redirect the browser to the given login URL, augmenting it with the
 * current page so the user lands back here after signing in.
 */
export function redirectToLogin(
  loginUrl: string,
  currentHref: string = typeof window !== "undefined" ? window.location.href : "",
): void {
  if (typeof window === "undefined") return;
  if (!currentHref) {
    window.location.href = loginUrl;
    return;
  }
  window.location.href = withEditorReturnUrl(loginUrl, currentHref);
}
