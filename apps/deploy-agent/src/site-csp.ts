/**
 * The security headers a deployed client site is served with, built from the
 * site's own configuration and from what its artifact actually contains.
 *
 * Why this exists. Until now a client site went out with `nosniff`, a
 * referrer policy and `X-Frame-Options`, and no Content-Security-Policy at
 * all — so a script that reached `dist/` (see the `GENERATED_HTML_UNSAFE`
 * gate in the build worker) had a visitor's browser entirely to itself: any
 * origin to fetch from, any form to retarget, any frame to open. The gate is
 * the first layer and this is the second, for the day the gate has a hole.
 *
 * Two rules shape it:
 *   - The policy is *derived*, never pasted. Origins come from the deploy
 *     agent's configuration; the inline-script hashes come from scanning the
 *     artifact that is about to be served (`site-capabilities.ts`), so the two
 *     managed inline blocks are named by their content and nothing else is
 *     allowed inline at all.
 *   - It is written by the builder into the site's own Caddy configuration —
 *     the snippet for a filesystem deploy, the container's Caddyfile for a
 *     Docker one — and never by hand into a `.caddy` file on a host.
 */

/** A header, as Caddy will emit it. */
export interface SiteHeader {
  readonly name: string;
  readonly value: string;
}

export interface SiteCspInput {
  /**
   * The platform's API origin — where the managed lead-capture script posts
   * a visitor's enquiry. From the deploy agent's own configuration.
   */
  readonly platformOrigin: string | null;
  /**
   * Base64 sha256 of every inline script the platform manages, as found in
   * the artifact. Anything else inline is refused by the policy.
   */
  readonly inlineScriptHashes: readonly string[];
  /**
   * Origins the site's own pages frame (the managed booking embed, the
   * contact page's map). Empty means the site frames nothing.
   */
  readonly frameOrigins: readonly string[];
  /**
   * Origins that may frame *this* site. Empty is the ordinary case and
   * produces `frame-ancestors 'none'`; the previews runtime passes the
   * funnel's origin, because the discovery funnel shows a preview in an
   * iframe and nothing else may.
   */
  readonly frameAncestors: readonly string[];
  /**
   * Origins the site loads stylesheets and fonts from. The webfont hosts the
   * templates use, passed in rather than written here.
   */
  readonly styleOrigins: readonly string[];
}

/** `'sha256-…'`, the source-expression spelling of a hash. */
function hashSource(hash: string): string {
  return `'sha256-${hash}'`;
}

function directive(name: string, sources: readonly string[]): string {
  return `${name} ${sources.join(' ')}`;
}

function unique(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * The site's Content-Security-Policy.
 *
 * Read it as a list of answers to "what may this page do":
 *   - `script-src 'self'` plus the hash of each managed inline block: the
 *     template's own bundle under `_astro/`, the lead-capture script and the
 *     layout bootstrap, and no other JavaScript of any origin.
 *   - `connect-src` the site itself and the platform API: an enquiry can be
 *     filed, and nothing can be exfiltrated to a third party.
 *   - `form-action` the same two, plus `mailto:` for the no-JavaScript
 *     fallback. A rewritten `action` cannot send the client's enquiries
 *     anywhere else.
 *   - `frame-ancestors`, `base-uri 'none'` and `object-src 'none'`: the site
 *     cannot be reframed, its relative URLs cannot be re-based, and no
 *     plugin content loads.
 *   - `style-src` allows inline styles, which the templates use heavily for
 *     per-instance layout, and `img-src https:` allows client photography
 *     from wherever the client's images live.
 */
export function buildSiteCsp(input: SiteCspInput): string {
  const platform = input.platformOrigin?.trim() ?? '';
  const styleOrigins = unique(input.styleOrigins);
  const frameOrigins = unique(input.frameOrigins);
  const frameAncestors = unique(input.frameAncestors);

  const directives = [
    directive('default-src', ["'self'"]),
    directive('script-src', [
      "'self'",
      ...unique(input.inlineScriptHashes).map(hashSource),
    ]),
    directive('img-src', ["'self'", 'data:', 'https:']),
    directive('style-src', ["'self'", "'unsafe-inline'", ...styleOrigins]),
    directive('font-src', ["'self'", 'https:', 'data:']),
    directive('connect-src', ["'self'", ...(platform ? [platform] : [])]),
    directive('form-action', [
      "'self'",
      ...(platform ? [platform] : []),
      'mailto:',
    ]),
    directive(
      'frame-src',
      frameOrigins.length > 0 ? ["'self'", ...frameOrigins] : ["'none'"],
    ),
    directive(
      'frame-ancestors',
      frameAncestors.length > 0 ? frameAncestors : ["'none'"],
    ),
    directive('base-uri', ["'none'"]),
    directive('object-src', ["'none'"]),
    // A generated marketing site has no reason to install one, the markup
    // gate refuses any registration it finds, and this is the half that holds
    // if a worker is ever misconfigured past the gate.
    directive('worker-src', ["'none'"]),
  ];
  return directives.join('; ');
}

/**
 * Everything a site's response carries, CSP included.
 *
 * `X-Frame-Options` rides along with `frame-ancestors` for browsers that
 * still prefer it, and it is `DENY` only when nothing may frame the site —
 * a previews host that allowed the funnel in CSP and denied it here would
 * serve a blank iframe.
 */
export function buildSiteSecurityHeaders(input: SiteCspInput): SiteHeader[] {
  const framed = unique(input.frameAncestors).length > 0;
  return [
    { name: 'Content-Security-Policy', value: buildSiteCsp(input) },
    { name: 'X-Content-Type-Options', value: 'nosniff' },
    { name: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    // The three capabilities a browser will hand to a page without asking
    // twice, and which a marketing site never needs.
    {
      name: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    },
    ...(framed ? [] : [{ name: 'X-Frame-Options', value: 'DENY' }]),
  ];
}

/** Caddy escapes nothing inside a quoted header value but the quote itself. */
function caddyValue(value: string): string {
  return `"${value.split('"').join('\\"')}"`;
}

/** The headers as Caddyfile directives, indented to sit inside a block. */
export function renderCaddyHeaderLines(
  headers: readonly SiteHeader[],
  indent: string,
): string[] {
  return headers.map(
    (header) => `${indent}header ${header.name} ${caddyValue(header.value)}`,
  );
}

/**
 * The line the site-runtime Caddyfile carries where its security headers go.
 *
 * A placeholder rather than an append, because the Caddyfile is a template
 * this repository owns and an operator may override it
 * (`DEPLOY_AGENT_DOCKER_TEMPLATE_DIR`). Substitution fails loudly on a
 * template that has dropped the marker, which is the right outcome: a site
 * served without a policy is the defect this module exists to prevent, and a
 * silent fallback would hide it.
 */
export const SITE_HEADERS_PLACEHOLDER = '# flowstarter:security-headers';

export class SiteHeadersError extends Error {}

/**
 * The site-runtime Caddyfile with its security headers filled in.
 *
 * The placeholder's own indentation is reused for the directives that replace
 * it, so the result is a Caddyfile a human can still read.
 */
export function applySiteSecurityHeaders(
  caddyfile: string,
  headers: readonly SiteHeader[],
): string {
  const lines = caddyfile.split('\n');
  const index = lines.findIndex(
    (line) => line.trim() === SITE_HEADERS_PLACEHOLDER,
  );
  if (index === -1) {
    throw new SiteHeadersError(
      `site runtime Caddyfile has no "${SITE_HEADERS_PLACEHOLDER}" line, so ` +
        'the site would be served with no Content-Security-Policy. Add the ' +
        'placeholder back to the template (or to the override directory in ' +
        'DEPLOY_AGENT_DOCKER_TEMPLATE_DIR).',
    );
  }
  const line = lines[index]!;
  const indent = line.slice(0, line.length - line.trimStart().length);
  lines.splice(index, 1, ...renderCaddyHeaderLines(headers, indent));
  return lines.join('\n');
}
