/**
 * Per-site Caddy snippet generation, shared by the filesystem runtime
 * (Caddy serves `SITES_ROOT/<slug>` directly) and the Docker runtime
 * (Caddy reverse-proxies to the site's container on loopback). Which one a
 * deploy gets is the only difference the snippet encodes — the domain
 * list, the editor route and the previews noindex semantics are identical
 * either way.
 */

import { renderCaddyHeaderLines, type SiteHeader } from './site-csp';

/** Kept in step with NOINDEX_HEADER_VALUE in lib/hosting/site-archive.ts. */
export const ROBOTS_HEADER = 'noindex, nofollow, noarchive';

/** Where a site's Caddy block should read its content from. */
export type ServeTarget =
  | { kind: 'static'; rootDir: string }
  | { kind: 'proxy'; upstream: string };

function serveLines(
  target: ServeTarget,
  indent: string,
  headers: readonly SiteHeader[],
): string[] {
  if (target.kind === 'proxy') {
    return [`${indent}reverse_proxy ${target.upstream}`];
  }
  return [
    `${indent}root * ${target.rootDir}`,
    // An unknown path is a real 404, never the home page — the same rule
    // the Docker runtime's site-runtime.Caddyfile applies to a container
    // upstream. `try_files` only rewrites to a file, or a directory's own
    // index, that actually exists on disk (`{path}` for a file, `{path}/`
    // for a directory, which is what lets `/work` still resolve to
    // `/work/index.html`); `=404` is the literal fallback: nothing on disk
    // answered, so the request becomes a real 404 instead of silently
    // rewriting to `/index.html`.
    `${indent}try_files {path} {path}/ =404`,
    `${indent}file_server`,
    ``,
    // The template's own 404 page (every template ships `404.astro`, built
    // to `404.html`) serves with the real 404 status and the same security
    // headers as every other page. If a build somehow shipped no
    // `404.html`, `file_server` here fails too and Caddy falls back to its
    // own minimal built-in error response — still a 404, never `index.html`.
    `${indent}handle_errors {`,
    ...renderCaddyHeaderLines(headers, `${indent}  `),
    `${indent}  @404 expression \`{http.error.status_code} == 404\``,
    `${indent}  rewrite @404 /404.html`,
    `${indent}  file_server`,
    `${indent}}`,
  ];
}

/**
 * The site is split into two routes:
 *   /editor*  → multitenant editor container (path stripped before forward
 *               so the editor sees `/`, `/api/...`, etc. without prefix)
 *   /...      → the site content, static files or a container upstream
 *
 * Editor requests carry the workspace slug via the `Host` header, which
 * Caddy preserves automatically — the editor server (`clerkGate.ts`) reads
 * it to scope the auth check to that specific workspace.
 */
export function buildCaddySnippet(
  slug: string,
  target: ServeTarget,
  primary: string | null,
  additional: string[],
  previewHost: string | null,
  editorUpstream: string,
  /**
   * The site's FINAL hostname, `{slug}.{platformDomain}`, from
   * `DEPLOY_AGENT_SITE_DOMAIN_TEMPLATE`. Every paid site has one whether or
   * not the client ever attaches a domain of their own; it comes before the
   * preview host because it is the name that is meant to outlive it.
   */
  siteHost: string | null = null,
  /**
   * The site's security headers, built by `site-csp.ts` from this artifact.
   * They go on the site's own route and not on the editor's: the editor is a
   * different application with a policy of its own, and a site policy handed
   * to it would block it. Empty only for a caller with nothing to serve.
   */
  headers: readonly SiteHeader[] = [],
): string {
  const seen = new Set<string>();
  const hosts = [primary, ...additional, siteHost, previewHost].filter(
    (h): h is string => {
      if (!h || h.length === 0) return false;
      const key = h.toLowerCase();
      // A client whose custom domain happens to be the site domain must not
      // produce `acme.net, acme.net {` — Caddy refuses a duplicated host.
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  );
  if (hosts.length === 0) return '';

  return [
    `# Managed by flowstarter deploy-agent — site ${slug}`,
    `${hosts.join(', ')} {`,
    `  encode gzip zstd`,
    ``,
    `  # Editor (multitenant) — Clerk-gated; auth derives workspace from Host.`,
    `  handle_path /editor/* {`,
    `    reverse_proxy ${editorUpstream} {`,
    `      header_up X-Forwarded-Host {host}`,
    `      header_up X-Forwarded-Proto {scheme}`,
    `    }`,
    `  }`,
    `  # Editor health/short URL — `,
    `  handle /editor {`,
    `    redir /editor/ permanent`,
    `  }`,
    ``,
    `  # Site content (static files, or the deployed container)`,
    `  handle {`,
    ...renderCaddyHeaderLines(headers, '    '),
    ...serveLines(target, '    ', headers),
    `  }`,
    `}`,
    ``,
  ].join('\n');
}

/**
 * The previews snippet. Deliberately not a variant of `buildCaddySnippet`:
 * it has no editor route, no custom domains, and one job — serve content
 * for exactly one unguessable hostname, telling every crawler not to index
 * it.
 *
 * `http://` and an explicit port because the front Caddy already terminated
 * TLS and forwarded here on loopback; `auto_https off` in the previews
 * Caddyfile means this block is matched on the Host header alone.
 */
export function buildPreviewCaddySnippet(
  slug: string,
  target: ServeTarget,
  hostname: string | null,
  sitePort: number,
  /** As above. A preview's policy differs in one directive: the funnel is
   * allowed to frame it, because showing the preview in an iframe is what
   * the funnel is for. */
  headers: readonly SiteHeader[] = [],
): string {
  const host = hostname && hostname.length > 0 ? hostname : null;
  if (!host) return '';
  return [
    `# Managed by flowstarter deploy-agent (previews) — ${slug}`,
    `http://${host}:${sitePort} {`,
    `  encode gzip zstd`,
    ``,
    `  # A preview carries a real business's name and copy nobody approved.`,
    `  # The manifest's HTML also carries <meta name="robots">; this is the`,
    `  # half that survives a crawler which only reads headers.`,
    `  header X-Robots-Tag "${ROBOTS_HEADER}"`,
    ``,
    ...renderCaddyHeaderLines(headers, '  '),
    ...serveLines(target, '  ', headers),
    `}`,
    ``,
  ].join('\n');
}
