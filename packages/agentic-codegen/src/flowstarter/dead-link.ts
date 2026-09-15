/**
 * The `DEAD_LINK` gate: a built site may not link, from its own nav, footer,
 * body copy or XML sitemap, to an internal page that `dist/` does not
 * actually contain.
 *
 * The bug this closes. `page-set.ts` prunes a dropped page's own scaffold
 * file and every YAML-shaped nav entry that pointed at it, and rewrites the
 * one hardcoded `/book` call to action every template shipped — but a
 * template can carry other hardcoded internal `href`s in component source
 * (`Services.astro`'s home-page "view all services" button, for one, found
 * on a live delivered site: `/services` dropped by the page budget, the
 * button left pointing at it, the visitor landing wherever an unknown path
 * resolves). Before #165/#166 that was the home page, served a second time
 * with a 200; after them it is a real 404 — a better failure, but still one
 * the brief never asked for and a client should never click into. Rather
 * than trust every template author to find every such literal, this gate
 * reads the compiled output itself, the same way `empty-image.ts` and
 * `markup-policy.ts` do, and fails the build if one slipped through.
 *
 * Parsing, not matching, for an HTML page: `parse5` is the same parser
 * `empty-image.ts` uses, for the same reason — an `<a href>` spans arbitrary
 * attribute order and whitespace, and a pattern confident enough to find
 * every shape of it is confident enough to also find one inside a comment or
 * a string literal that was never rendered as an element. `sitemap.xml` is
 * not HTML, so its `<loc>` entries are read with a narrow, well-anchored
 * pattern instead — the tag has one legal shape and no attributes to dodge.
 *
 * Only *page* links are in scope. A link to an asset — anything whose last
 * path segment carries a dot, `/images/hero.jpg`, `/_astro/chunk.js`,
 * `/favicon.ico` — is not checked: `collectBuiltSiteText` reads text files
 * only, so a binary asset's own path is never in the file list this gate is
 * handed, and flagging it as "not in dist/" would be reading the absence of
 * evidence as evidence of absence. A path with no dot in its last segment is
 * a page, and every page `dist/` produced is a text file this gate can see.
 */

import { parse } from 'parse5';

/** The job fails with this when a built page links to a page dist/ does not have. */
export const DEAD_LINK = 'DEAD_LINK';

/** One internal link a built page or the sitemap carried to a page that does not exist. */
export interface DeadLinkFinding {
  /** The compiled file that carries the link, relative to `dist/`, posix form. */
  readonly path: string;
  /** 1-based line in the compiled file, when the source was HTML and the parser knew one. */
  readonly line: number | null;
  /** The literal `href` or `<loc>` text, before normalizing. */
  readonly href: string;
  /** The internal path it resolves to, e.g. `/services`. */
  readonly target: string;
}

/** A parse5 element, reduced to what this gate reads. */
interface HtmlNode {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  sourceCodeLocation?: { startLine?: number } | null;
}

function attributeOf(node: HtmlNode, name: string): string | null {
  for (const attr of node.attrs ?? []) {
    if (attr.name.toLowerCase() === name) return attr.value;
  }
  return null;
}

function lineOf(node: HtmlNode): number | null {
  const line = node.sourceCodeLocation?.startLine;
  return typeof line === 'number' ? line : null;
}

/**
 * The URL forms a single compiled `dist/` file answers to.
 *
 * `about/index.html` answers to `/about` and `/about/`; the root
 * `index.html` answers to `/`; a flat-format build's `about.html` answers to
 * `/about` and `/about/` too, so this gate reads either Astro output format
 * the same way. The file's own exact path is also a valid target, so a link
 * that names the compiled file directly (rare, but not wrong) is not flagged.
 */
function pageUrlsFor(distPath: string): string[] {
  const urls = new Set<string>([`/${distPath}`]);
  if (distPath === 'index.html') {
    urls.add('/');
    return Array.from(urls);
  }
  const lower = distPath.toLowerCase();
  if (lower.endsWith('/index.html')) {
    const dir = distPath.slice(0, -'index.html'.length);
    urls.add(`/${dir}`);
    urls.add(`/${dir.replace(/\/$/, '')}`);
  } else if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    const dot = distPath.lastIndexOf('.');
    const withoutExt = distPath.slice(0, dot);
    urls.add(`/${withoutExt}`);
    urls.add(`/${withoutExt}/`);
  }
  return Array.from(urls);
}

/** True when `path`'s last segment carries a dot — an asset, never a page. */
function looksLikeAsset(path: string): boolean {
  const lastSegment = path.split('/').pop() ?? '';
  return lastSegment.includes('.');
}

/**
 * `href` (or a sitemap `<loc>`) reduced to the internal page path it names,
 * or `null` when it is not an in-scope internal page link at all: empty,
 * an in-page anchor, `mailto:`/`tel:`/`javascript:`, an absolute URL on
 * another origin, or a path that looks like an asset rather than a page.
 *
 * A `<loc>` is always an absolute URL on the site's own origin — the origin
 * itself is not this gate's business, only the path is, so it is discarded
 * rather than compared against a configured domain the build may not have
 * been handed.
 */
function internalPageTarget(
  href: string,
  isSitemapLoc: boolean,
): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('#')) return null;
  if (/^(mailto|tel|javascript):/i.test(trimmed)) return null;

  let pathname: string;
  if (isSitemapLoc) {
    try {
      pathname = new URL(trimmed).pathname;
    } catch {
      // Not an absolute URL — read it as a bare path, the same as an href.
      pathname = trimmed;
    }
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) {
      return null; // an absolute URL, on this origin or another — out of scope
    }
    if (!trimmed.startsWith('/')) return null; // page-relative, not this gate's shape
    pathname = trimmed.split(/[?#]/)[0] ?? trimmed;
  }

  if (pathname.length === 0) return null;
  if (looksLikeAsset(pathname)) return null;
  return pathname;
}

function walkAnchors(
  node: HtmlNode,
  path: string,
  findings: DeadLinkFinding[],
  validTargets: ReadonlySet<string>,
): void {
  const tag = (node.tagName ?? '').toLowerCase();
  if (tag === 'a') {
    const href = attributeOf(node, 'href');
    if (href !== null) {
      const target = internalPageTarget(href, false);
      if (target !== null && !validTargets.has(target)) {
        findings.push({ path, line: lineOf(node), href, target });
      }
    }
  }
  for (const child of node.childNodes ?? []) {
    walkAnchors(child, path, findings, validTargets);
  }
  if (node.content) walkAnchors(node.content, path, findings, validTargets);
}

/** Every `<loc>` entry in a sitemap's raw XML text, in document order. */
function sitemapLocations(xml: string): string[] {
  const locations: string[] = [];
  const pattern = /<loc>([^<]*)<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const value = match[1];
    if (value) locations.push(value.trim());
  }
  return locations;
}

/**
 * The gate over a whole build: every internal page link in every compiled
 * HTML page, and every `<loc>` in a sitemap, checked against the pages
 * `dist/` actually produced.
 */
export function findDeadLinkFindings(
  files: readonly { path: string; content: string }[],
): DeadLinkFinding[] {
  const validTargets = new Set<string>();
  for (const file of files) {
    const lower = file.path.toLowerCase();
    if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      const relative = file.path.replace(/^dist\//, '');
      for (const url of pageUrlsFor(relative)) validTargets.add(url);
    }
  }

  const findings: DeadLinkFinding[] = [];
  for (const file of files) {
    const lower = file.path.toLowerCase();
    if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      const document = parse(file.content, {
        sourceCodeLocationInfo: true,
      }) as HtmlNode;
      walkAnchors(document, file.path, findings, validTargets);
    } else if (
      lower.endsWith('sitemap.xml') ||
      lower.endsWith('sitemap-index.xml')
    ) {
      for (const loc of sitemapLocations(file.content)) {
        const target = internalPageTarget(loc, true);
        if (target !== null && !validTargets.has(target)) {
          findings.push({ path: file.path, line: null, href: loc, target });
        }
      }
    }
  }
  return findings;
}

/** The gate's verdict, phrased once for the job log — plain words, no jargon. */
export function describeDeadLinkIssue(
  findings: readonly DeadLinkFinding[],
): string {
  const listed = findings.slice(0, 12);
  const overflow =
    findings.length > listed.length
      ? ` …and ${findings.length - listed.length} more.`
      : '';
  const lines = listed.map((finding) => {
    const where =
      finding.line === null
        ? finding.path
        : `${finding.path} line ${finding.line}`;
    return `- ${where}: links to "${finding.target}", which the build did not produce.`;
  });
  return (
    `${DEAD_LINK}: the built site links to a page that is not in its own ` +
    'dist/. A visitor who clicks it lands nowhere the brief describes — a ' +
    '404, or worse, whatever an unknown path happens to fall back to. Every ' +
    'page this brief dropped has to come out of navigation, footers, body ' +
    'copy and the sitemap along with it, not just out of the page set:\n' +
    lines.join('\n') +
    overflow
  );
}
