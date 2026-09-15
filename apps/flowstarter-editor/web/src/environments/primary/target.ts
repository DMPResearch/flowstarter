import type { KnownEnvironment } from "@flowstarter/editor-client-runtime";
import { EDITOR_BASE_PATH } from "../../lib/basePath";

export interface PrimaryEnvironmentTarget {
  readonly source: KnownEnvironment["source"];
  readonly target: KnownEnvironment["target"];
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

function normalizeBaseUrl(rawValue: string): string {
  return new URL(rawValue, window.location.origin).toString();
}

function swapBaseUrlProtocol(
  rawValue: string,
  nextProtocol: "http:" | "https:" | "ws:" | "wss:",
): string {
  const url = new URL(normalizeBaseUrl(rawValue));
  url.protocol = nextProtocol;
  return url.toString();
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

function resolveHttpRequestBaseUrl(httpBaseUrl: string): string {
  const configuredDevServerUrl = import.meta.env.VITE_DEV_SERVER_URL?.trim();
  if (!configuredDevServerUrl) {
    return httpBaseUrl;
  }

  const currentUrl = new URL(window.location.href);
  const targetUrl = new URL(httpBaseUrl);
  const devServerUrl = new URL(configuredDevServerUrl, currentUrl.origin);

  const isCurrentOriginDevServer =
    (currentUrl.protocol === "http:" || currentUrl.protocol === "https:") &&
    currentUrl.origin === devServerUrl.origin;

  if (
    !isCurrentOriginDevServer ||
    currentUrl.origin === targetUrl.origin ||
    !isLoopbackHostname(currentUrl.hostname) ||
    !isLoopbackHostname(targetUrl.hostname)
  ) {
    return httpBaseUrl;
  }

  return currentUrl.origin;
}

function resolveConfiguredPrimaryTarget(): PrimaryEnvironmentTarget | null {
  const configuredHttpBaseUrl = import.meta.env.VITE_HTTP_URL?.trim() || undefined;
  const configuredWsBaseUrl = import.meta.env.VITE_WS_URL?.trim() || undefined;

  if (!configuredHttpBaseUrl && !configuredWsBaseUrl) {
    return null;
  }

  const resolvedHttpBaseUrl =
    configuredHttpBaseUrl ??
    (configuredWsBaseUrl?.startsWith("wss:")
      ? swapBaseUrlProtocol(configuredWsBaseUrl, "https:")
      : swapBaseUrlProtocol(configuredWsBaseUrl!, "http:"));
  const resolvedWsBaseUrl =
    configuredWsBaseUrl ??
    (configuredHttpBaseUrl?.startsWith("https:")
      ? swapBaseUrlProtocol(configuredHttpBaseUrl, "wss:")
      : swapBaseUrlProtocol(configuredHttpBaseUrl!, "ws:"));

  return {
    source: "configured",
    target: {
      httpBaseUrl: normalizeBaseUrl(resolvedHttpBaseUrl),
      wsBaseUrl: normalizeBaseUrl(resolvedWsBaseUrl),
    },
  };
}

// See `../../lib/basePath.ts`: a sub-path production deploy
// (`VITE_BASE_PATH=/editor/`, the shape
// `docs/operations/operator-editor.md` documents) sits behind Caddy's
// `handle_path /editor/*`, which strips the prefix before proxying to the
// router. Without `EDITOR_BASE_PATH` here, `window.location.origin` alone
// (no path) is indistinguishable from a root deploy, and every HTTP call
// this target resolves — auth/session, auth/bootstrap, ws-token,
// pairing-links, clients, observability tracing — lands one level too
// high, past the prefix Caddy is stripping for, and falls through to the
// tenant's own site content instead of the router. That answers 200 with
// unrelated HTML, which breaks JSON parsing downstream with no indication
// the request went to the wrong place. Verified against a real sub-path
// deploy on fs-sites-01, 2026-09-15 (same root cause as the
// `CLERK_ME_PATH` / `CLERK_AUTO_PAIR_PATH` fix in `../../lib/clerkSession.ts`).

function resolveWindowOriginPrimaryTarget(): PrimaryEnvironmentTarget {
  const httpBaseUrl = normalizeBaseUrl(window.location.origin + EDITOR_BASE_PATH);
  const url = new URL(httpBaseUrl);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    throw new Error(`Unsupported HTTP base URL protocol: ${url.protocol}`);
  }
  // Unlike `httpBaseUrl` (joined with a further pathname by
  // `resolvePrimaryEnvironmentHttpUrl`, so a bare `/editor` is fine there),
  // `wsBaseUrl` is handed to `WsTransport` and used as the literal socket
  // URL, no further path appended. The Caddy snippet distinguishes
  // `/editor/*` (proxied to the router) from bare `/editor` (301 redirect
  // to add the trailing slash) — and a WebSocket handshake cannot follow a
  // redirect, so it fails closed with no error surfaced past "no projects
  // yet". Keep the trailing slash here so the RPC socket URL actually
  // matches `/editor/*`.
  if (url.pathname !== "" && !url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return {
    source: "window-origin",
    target: {
      httpBaseUrl,
      wsBaseUrl: url.toString(),
    },
  };
}

export function resolvePrimaryEnvironmentHttpUrl(
  pathname: string,
  searchParams?: Record<string, string>,
): string {
  const primaryTarget = readPrimaryEnvironmentTarget();
  if (!primaryTarget) {
    throw new Error("Unable to resolve the primary environment HTTP base URL.");
  }

  const url = new URL(resolveHttpRequestBaseUrl(primaryTarget.target.httpBaseUrl));
  // Join onto the base's own pathname rather than overwrite it: a
  // window-origin target now carries the editor's sub-path base (see
  // `resolveWindowOriginPrimaryTarget` above), and a bare assignment here
  // would throw that away, landing the request back outside `/editor/*`.
  const basePathname = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePathname}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
  if (searchParams) {
    url.search = new URLSearchParams(searchParams).toString();
  }
  return url.toString();
}

export function readPrimaryEnvironmentTarget(): PrimaryEnvironmentTarget | null {
  return resolveConfiguredPrimaryTarget() ?? resolveWindowOriginPrimaryTarget();
}
