/**
 * Per-site Caddy snippet generation, shared by the filesystem runtime
 * (Caddy serves `SITES_ROOT/<slug>` directly) and the Docker runtime
 * (Caddy reverse-proxies to the site's container on loopback). Which one a
 * deploy gets is the only difference the snippet encodes — the domain
 * list, the editor route and the previews noindex semantics are identical
 * either way.
 */

/** Kept in step with NOINDEX_HEADER_VALUE in lib/hosting/site-archive.ts. */
export const ROBOTS_HEADER = 'noindex, nofollow, noarchive';

/** Where a site's Caddy block should read its content from. */
export type ServeTarget =
  | { kind: 'static'; rootDir: string }
  | { kind: 'proxy'; upstream: string };

function serveLines(target: ServeTarget, indent: string): string[] {
  if (target.kind === 'proxy') {
    return [`${indent}reverse_proxy ${target.upstream}`];
  }
  return [
    `${indent}root * ${target.rootDir}`,
    `${indent}try_files {path} {path}/ /index.html`,
    `${indent}file_server`,
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
  editorUpstream: string
): string {
  const hosts = [primary, ...additional, previewHost].filter(
    (h): h is string => !!h && h.length > 0
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
    ...serveLines(target, '    '),
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
  sitePort: number
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
    ...serveLines(target, '  '),
    `}`,
    ``,
  ].join('\n');
}
