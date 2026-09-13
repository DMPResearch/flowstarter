/**
 * The `GENERATED_HTML_UNSAFE` gate: what a generated site's compiled HTML is
 * allowed to ask a visitor's browser to do.
 *
 * The gates that came before this one ask whether the build is *honest* — no
 * teaser in a paid site, no invented case study, no placeholder photograph.
 * None of them asks whether it is *safe*, and the site's content comes from a
 * model reading a brief a stranger wrote. A prompt injection that survives to
 * `dist/` lands on the client's own domain, in front of the client's own
 * customers: an inline `<script>`, a `<form action="https://evil">` that
 * collects every enquiry the client will ever receive, a `<meta http-equiv=
 * refresh>`, an `<iframe>`, a service worker that outlives the page.
 *
 * So this module states the capability policy as data and checks it by
 * parsing. Parsing, not matching: every attempt to find `<script` with a
 * regular expression is a bypass waiting for a stranger to write
 * `<script/x>`, and a pattern that backtracks over attacker-supplied text is a
 * denial of service besides. `parse5` is the HTML parser the browser spec
 * describes, and the tree it produces is what the visitor's browser would
 * build.
 *
 * The policy's shape:
 *   - Scripts. Only the template's own bundle (`_astro/…`, emitted by the
 *     Astro build), the platform's managed inline blocks (the lead-capture
 *     script, found by its marker; the layout's one-line bootstrap, found by
 *     its exact text), and script sources on an origin allow-list from config.
 *   - Event handlers. None, ever. `on*` is checked as a family.
 *   - URLs. No `javascript:` and no `data:` in `href`, `src` or `action` —
 *     except a `data:image/…` in an `<img>`, which is how a build inlines a
 *     tiny asset and which cannot execute.
 *   - Embedding. No `<object>` and no `<embed>` at all, and an `<iframe>`
 *     only when it points at the managed Cal.com booking embed or the map a
 *     contact page ships — by origin, not by what the tag claims to be.
 *   - Navigation. No `<base>`, no `<meta http-equiv="refresh">`.
 *   - Forms. `action` has to be the platform's lead-capture endpoint, a
 *     `mailto:`, or the page itself.
 *   - Stylesheets. Same-origin, or an origin on the allow-list (the webfont
 *     hosts the templates use, and the platform's own).
 *   - Service workers. No registration, anywhere in the output.
 *
 * The worker's on-disk half is `apps/build-worker/src/output-markup.ts`, and
 * `CommandSiteValidator` fails the build with it — the same shape as
 * `TEASER_IN_PAID_BUILD` and `PLACEHOLDER_IMAGE_SHIPPED`. The repair pass in
 * `workflows.ts` gets one chance to take the markup back out, and the gate is
 * re-run afterwards; nothing here trusts the agent to have done it.
 */

import { parse } from 'parse5';

/** The job fails with this when generated HTML asks for a capability. */
export const GENERATED_HTML_UNSAFE = 'GENERATED_HTML_UNSAFE';

/**
 * Where the Astro build puts the template's own bundled scripts. A path
 * segment rather than a prefix, because a preview build is emitted under a
 * `--base` and its bundle lands at `/preview/<template>/_astro/…`.
 */
export const TEMPLATE_BUNDLE_SEGMENT = '_astro';

/** The attribute the injected lead-capture block carries. */
export const LEAD_CAPTURE_MARKER_ATTRIBUTE = 'data-flowstarter-lead-capture';

/** The attribute the injected live Cal.com embed carries. */
export const CAL_EMBED_MARKER_ATTRIBUTE = 'data-flowstarter-cal-embed';

/** The hosts `normalizeCalLink` already accepts, as embed origins. */
export const CAL_EMBED_ORIGINS: readonly string[] = [
  'https://cal.com',
  'https://app.cal.com',
];

/**
 * The webfont hosts the templates' layouts link their stylesheets from. Fonts
 * are one of the two external subresources a generated site legitimately
 * loads, and they are a stylesheet rather than a script.
 */
export const TEMPLATE_FONT_ORIGINS: readonly string[] = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://api.fontshare.com',
  'https://cdn.fontshare.com',
];

/**
 * The other one: the map on a contact page. Every template's contact page
 * frames OpenStreetMap's embed, which is markup a designer wrote and not
 * something a brief can talk a model into pointing elsewhere — the origin is
 * what is checked, not the intent.
 */
export const TEMPLATE_MAP_ORIGINS: readonly string[] = [
  'https://www.openstreetmap.org',
  'https://openstreetmap.org',
];

/** The path every managed lead-capture endpoint is under. */
export const LEAD_CAPTURE_PATH_PREFIX = '/api/leads/capture/';

/**
 * Inline scripts the platform itself puts in a page, by their exact text.
 *
 * One entry: the layout bootstrap that marks the document as JavaScript-
 * capable before first paint, which has to stay inline (`is:inline`) or the
 * no-JS styling flashes. A marker attribute would not do here — a marker is
 * something the agent can also write — so this one is matched on content,
 * with whitespace collapsed so a formatter cannot break the gate.
 *
 * `test/markup-policy.test.ts` reads the templates' own layouts and fails if
 * one carries an inline script that is not on this list, so the list cannot
 * silently fall behind the templates it describes.
 */
export const MANAGED_INLINE_SCRIPT_SOURCES: readonly string[] = [
  "document.documentElement.classList.add('js');",
];

/**
 * Script `type` values a browser does not execute. JSON-LD is structured data
 * a site legitimately ships; it is markup, not code.
 */
const NON_EXECUTABLE_SCRIPT_TYPES: ReadonlySet<string> = new Set([
  'application/ld+json',
  'application/json',
]);

/** How a build registers a service worker, in any of its spellings. */
const SERVICE_WORKER_MARKERS: readonly string[] = [
  'serviceWorker.register',
  'serviceworker.register',
  'navigator.serviceWorker',
];

/** URL schemes that execute or embed, and are refused in every attribute. */
const EXECUTABLE_SCHEMES: ReadonlySet<string> = new Set([
  'javascript',
  'vbscript',
  'data',
  'blob',
  'filesystem',
]);

/** Attributes carrying a URL this gate inspects. */
const URL_ATTRIBUTES: readonly string[] = [
  'href',
  'src',
  'action',
  'formaction',
  'data',
  'srcdoc',
  'xlink:href',
  'ping',
];

export interface MarkupPolicy {
  /**
   * Origins whose scripts may be loaded. Empty is the ordinary case: a
   * generated site's JavaScript is its own bundle and nothing else.
   */
  readonly scriptOrigins: readonly string[];
  /** Origins a `<link rel="stylesheet">` may point at. */
  readonly styleOrigins: readonly string[];
  /** Origins the managed booking embed may frame. */
  readonly frameOrigins: readonly string[];
  /** Origins a `<form action>` may post to (the platform's own API). */
  readonly formOrigins: readonly string[];
  /** Inline scripts allowed by the marker their block carries. */
  readonly inlineScriptMarkers: readonly string[];
  /** Inline scripts allowed by their exact (whitespace-collapsed) text. */
  readonly inlineScriptSources: readonly string[];
}

export interface SiteMarkupPolicyInput {
  /**
   * The platform's own origins — where the lead-capture endpoint lives, and
   * the only cross-origin destination a generated form may post to. From
   * config (`FLOWSTARTER_MAIN_URL`, the resolved platform domain), never a
   * literal in a caller.
   */
  readonly platformOrigins: readonly string[];
  /** Extra script origins an operator has deliberately allowed. */
  readonly scriptOrigins?: readonly string[];
}

/** Normalized `https://host[:port]`, or null when `value` is not a URL. */
function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return null;
  }
}

function uniqueOrigins(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const origin = originOf(value) ?? originOf(`https://${value}`);
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

/**
 * The policy a generated site is measured against, built from configuration.
 *
 * The platform origins arrive from the caller's config; the font host, the
 * Cal.com hosts and the managed markers are properties of the templates and
 * the injectors, and live here as data rather than as literals at the call
 * site.
 */
export function siteMarkupPolicy(input: SiteMarkupPolicyInput): MarkupPolicy {
  const platform = uniqueOrigins(input.platformOrigins);
  return {
    scriptOrigins: uniqueOrigins(input.scriptOrigins ?? []),
    styleOrigins: [...TEMPLATE_FONT_ORIGINS, ...platform],
    frameOrigins: [...CAL_EMBED_ORIGINS, ...TEMPLATE_MAP_ORIGINS],
    formOrigins: platform,
    inlineScriptMarkers: [LEAD_CAPTURE_MARKER_ATTRIBUTE],
    inlineScriptSources: [...MANAGED_INLINE_SCRIPT_SOURCES],
  };
}

/** One element that asked for a capability the policy does not grant. */
export interface MarkupViolation {
  /** The compiled file, relative to `dist/` and in posix form. */
  readonly path: string;
  /** The rule that refused it, for grouping and for tests. */
  readonly rule: MarkupViolationRule;
  /** The element, as a browser would name it (`<script>`, `<form>`). */
  readonly element: string;
  /** One sentence, in plain words, naming what was asked for. */
  readonly detail: string;
  /** 1-based line in the compiled file, when the parser knew one. */
  readonly line: number | null;
}

export type MarkupViolationRule =
  | 'script-inline'
  | 'script-src'
  | 'event-handler'
  | 'executable-url'
  | 'embedded-frame'
  | 'meta-refresh'
  | 'base-tag'
  | 'form-action'
  | 'external-stylesheet'
  | 'service-worker';

/** A parse5 element, reduced to what this gate reads. */
interface HtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
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

function textOf(node: HtmlNode): string {
  let text = '';
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === '#text') text += child.value ?? '';
  }
  return text;
}

function lineOf(node: HtmlNode): number | null {
  const line = node.sourceCodeLocation?.startLine;
  return typeof line === 'number' ? line : null;
}

/** Whitespace-collapsed, for comparing an inline script against the list. */
function normalizeScript(source: string): string {
  return source.split(/\s+/).join(' ').trim();
}

/**
 * The scheme of a URL attribute, lowercased, or null when the value is a
 * relative URL.
 *
 * Control characters and whitespace are stripped first: `java\tscript:` is a
 * scheme a browser accepts, and a check that did not strip them would read it
 * as a relative path.
 */
function schemeOf(value: string): string | null {
  let cleaned = '';
  for (const char of value) {
    if (char <= ' ' || char === '') continue;
    cleaned += char;
  }
  let scheme = '';
  for (const char of cleaned) {
    if (char === ':') return scheme.toLowerCase();
    if (char === '/' || char === '?' || char === '#') return null;
    scheme += char;
  }
  return null;
}

/** True when this URL points somewhere on the site being built. */
function isSameOrigin(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith('//')) return false;
  return schemeOf(trimmed) === null;
}

function isOnAllowList(value: string, origins: readonly string[]): boolean {
  const origin = originOf(value.trim());
  return origin !== null && origins.includes(origin);
}

/** True when a path has an `_astro` segment: the template's own bundle. */
function isTemplateBundlePath(value: string): boolean {
  const path = value.split('?')[0]!.split('#')[0]!;
  return path.split('/').includes(TEMPLATE_BUNDLE_SEGMENT);
}

interface WalkContext {
  readonly path: string;
  readonly policy: MarkupPolicy;
  readonly violations: MarkupViolation[];
  /** Marker attributes carried by this element or an ancestor of it. */
  readonly markers: ReadonlySet<string>;
}

function markersOf(
  node: HtmlNode,
  inherited: ReadonlySet<string>,
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const attr of node.attrs ?? []) {
    const name = attr.name.toLowerCase();
    if (!name.startsWith('data-flowstarter-')) continue;
    next ??= new Set(inherited);
    next.add(name);
  }
  return next ?? inherited;
}

function checkScript(node: HtmlNode, context: WalkContext): void {
  const type = (attributeOf(node, 'type') ?? '').trim().toLowerCase();
  const src = attributeOf(node, 'src');

  if (src !== null) {
    if (isSameOrigin(src)) {
      if (!isTemplateBundlePath(src)) {
        context.violations.push({
          path: context.path,
          rule: 'script-src',
          element: '<script>',
          detail:
            `loads "${src}", which is not part of the template's own ` +
            `${TEMPLATE_BUNDLE_SEGMENT}/ bundle`,
          line: lineOf(node),
        });
      }
      return;
    }
    if (!isOnAllowList(src, context.policy.scriptOrigins)) {
      context.violations.push({
        path: context.path,
        rule: 'script-src',
        element: '<script>',
        detail: `loads a script from "${src}", an origin the site may not use`,
        line: lineOf(node),
      });
    }
    return;
  }

  const source = textOf(node);
  if (NON_EXECUTABLE_SCRIPT_TYPES.has(type)) return;
  if (source.trim().length === 0) return;

  const marked = context.policy.inlineScriptMarkers.some((marker) =>
    context.markers.has(marker.toLowerCase()),
  );
  if (marked) return;
  const normalized = normalizeScript(source);
  if (
    context.policy.inlineScriptSources.some(
      (allowed) => normalizeScript(allowed) === normalized,
    )
  ) {
    return;
  }

  context.violations.push({
    path: context.path,
    rule: 'script-inline',
    element: '<script>',
    detail:
      'runs inline JavaScript that is neither the template bundle nor one ' +
      `of the platform's managed blocks: "${normalized.slice(0, 120)}"`,
    line: lineOf(node),
  });
}

function checkUrls(node: HtmlNode, tag: string, context: WalkContext): void {
  for (const name of URL_ATTRIBUTES) {
    const value = attributeOf(node, name);
    if (value === null) continue;
    const scheme = schemeOf(value);
    if (scheme === null || !EXECUTABLE_SCHEMES.has(scheme)) continue;
    // An inlined raster or vector in an `<img>` is how a build ships a tiny
    // asset, and an image source cannot execute. Everything else can.
    const inlineImage =
      scheme === 'data' &&
      name === 'src' &&
      (tag === 'img' || tag === 'source') &&
      value.trim().toLowerCase().startsWith('data:image/');
    if (inlineImage) continue;
    context.violations.push({
      path: context.path,
      rule: 'executable-url',
      element: `<${tag}>`,
      detail: `has ${name}="${scheme}:…", a URL scheme that executes or embeds`,
      line: lineOf(node),
    });
  }
}

function checkForm(node: HtmlNode, context: WalkContext): void {
  const action = attributeOf(node, 'action');
  if (action === null || action.trim().length === 0) return;
  const scheme = schemeOf(action);
  if (scheme === 'mailto') return;
  if (isSameOrigin(action)) return;
  if (isOnAllowList(action, context.policy.formOrigins)) {
    // On the platform's own origin, and only at the endpoint that files an
    // enquiry into this client's workspace — not at any other route there.
    let pathname = '';
    try {
      pathname = new URL(action.trim()).pathname;
    } catch {
      pathname = '';
    }
    if (pathname.startsWith(LEAD_CAPTURE_PATH_PREFIX)) return;
  }
  context.violations.push({
    path: context.path,
    rule: 'form-action',
    element: '<form>',
    detail:
      `posts to "${action}", which is neither the client's own lead-capture ` +
      'endpoint nor a mailto: address',
    line: lineOf(node),
  });
}

/**
 * A frame is allowed by *where it points*, never by what it says about
 * itself: the booking embed the injector writes, and the map a template's
 * contact page ships. `<object>` and `<embed>` have no such use and are
 * refused outright — they load plugin content, and nothing here needs one.
 */
function checkFrame(node: HtmlNode, tag: string, context: WalkContext): void {
  const src = attributeOf(node, 'src') ?? attributeOf(node, 'data') ?? '';
  if (tag === 'iframe' && isOnAllowList(src, context.policy.frameOrigins)) {
    return;
  }
  context.violations.push({
    path: context.path,
    rule: 'embedded-frame',
    element: `<${tag}>`,
    detail:
      src.trim().length > 0
        ? `embeds "${src}", which is not the managed booking embed or the ` +
          'contact page map'
        : 'embeds a document of its own; only the managed booking embed and ' +
          'the contact page map may frame anything',
    line: lineOf(node),
  });
}

function checkLink(node: HtmlNode, context: WalkContext): void {
  const rel = (attributeOf(node, 'rel') ?? '').toLowerCase();
  if (!rel.split(/\s+/).includes('stylesheet')) return;
  const href = attributeOf(node, 'href') ?? '';
  if (isSameOrigin(href)) return;
  if (isOnAllowList(href, context.policy.styleOrigins)) return;
  context.violations.push({
    path: context.path,
    rule: 'external-stylesheet',
    element: '<link rel="stylesheet">',
    detail: `loads a stylesheet from "${href}", an origin the site may not use`,
    line: lineOf(node),
  });
}

function checkMeta(node: HtmlNode, context: WalkContext): void {
  const equiv = (attributeOf(node, 'http-equiv') ?? '').trim().toLowerCase();
  if (equiv !== 'refresh') return;
  context.violations.push({
    path: context.path,
    rule: 'meta-refresh',
    element: '<meta http-equiv="refresh">',
    detail:
      `sends the visitor to "${(attributeOf(node, 'content') ?? '').trim()}" ` +
      'without a click',
    line: lineOf(node),
  });
}

function checkElement(node: HtmlNode, context: WalkContext): void {
  const tag = (node.tagName ?? node.nodeName).toLowerCase();

  for (const attr of node.attrs ?? []) {
    const name = attr.name.toLowerCase();
    if (name.length > 2 && name.startsWith('on')) {
      context.violations.push({
        path: context.path,
        rule: 'event-handler',
        element: `<${tag}>`,
        detail: `carries the inline event handler ${name}="…"`,
        line: lineOf(node),
      });
    }
  }

  checkUrls(node, tag, context);

  switch (tag) {
    case 'script':
      checkScript(node, context);
      break;
    case 'iframe':
    case 'object':
    case 'embed':
    case 'frame':
      checkFrame(node, tag, context);
      break;
    case 'base':
      context.violations.push({
        path: context.path,
        rule: 'base-tag',
        element: '<base>',
        detail: `rewrites every relative URL on the page to "${(attributeOf(node, 'href') ?? '').trim()}"`,
        line: lineOf(node),
      });
      break;
    case 'meta':
      checkMeta(node, context);
      break;
    case 'form':
      checkForm(node, context);
      break;
    case 'link':
      checkLink(node, context);
      break;
    default:
      break;
  }
}

function walk(node: HtmlNode, context: WalkContext): void {
  const markers = markersOf(node, context.markers);
  const scoped: WalkContext = { ...context, markers };
  if (node.tagName !== undefined) checkElement(node, scoped);
  for (const child of node.childNodes ?? []) walk(child, scoped);
  // `<template>` content is parsed into a separate document fragment, and a
  // browser will happily clone it into the page.
  if (node.content) walk(node.content, scoped);
}

/**
 * Every capability the compiled page at `path` asks for that `policy` does
 * not grant. Empty means the file is clean.
 */
export function findMarkupPolicyViolations(
  path: string,
  html: string,
  policy: MarkupPolicy,
): MarkupViolation[] {
  const document = parse(html, { sourceCodeLocationInfo: true }) as HtmlNode;
  const violations: MarkupViolation[] = [];
  walk(document, { path, policy, violations, markers: new Set() });
  violations.push(...findServiceWorkerRegistration(path, html));
  return violations;
}

/**
 * A service worker outlives the page that registered it and answers every
 * later request for the whole origin, so it is refused wherever it appears —
 * in a page, in the template's own bundle, in a file that only looks like
 * JavaScript. This is a text scan by design: it runs over compiled bundles
 * too, where there is no tree to walk.
 */
export function findServiceWorkerRegistration(
  path: string,
  content: string,
): MarkupViolation[] {
  for (const marker of SERVICE_WORKER_MARKERS) {
    if (!content.includes(marker)) continue;
    return [
      {
        path,
        rule: 'service-worker',
        element: 'service worker registration',
        detail:
          `registers a service worker (${marker}), which would keep serving ` +
          "the client's visitors after the page that installed it is gone",
        line: null,
      },
    ];
  }
  return [];
}

/** The gate's verdict, phrased once for the job log and for the agent. */
export function describeMarkupPolicyViolations(
  violations: readonly MarkupViolation[],
): string {
  const listed = violations.slice(0, 12);
  const overflow =
    violations.length > listed.length
      ? ` …and ${violations.length - listed.length} more.`
      : '';
  const lines = listed.map((violation) => {
    const where =
      violation.line === null
        ? violation.path
        : `${violation.path} line ${violation.line}`;
    return `- ${where}: ${violation.element} ${violation.detail}.`;
  });
  return (
    `${GENERATED_HTML_UNSAFE}: the compiled site asks the visitor's browser ` +
    'for capabilities a generated marketing site is never allowed — the ' +
    'markup below reached the build from content nobody hand-wrote, and it ' +
    "would run on the client's own domain. Remove it:\n" +
    lines.join('\n') +
    overflow
  );
}

/**
 * The in-memory half, for the agent-side repair pass: the same rules over the
 * text the build produced, as one message, or null when the site is clean.
 *
 * `apps/build-worker/src/output-markup.ts` is the gate of record — it reads
 * `dist/` from disk and fails the job. This one runs earlier, inside the
 * workflow, so the agent gets a chance to take its own markup back out before
 * anything is packaged.
 */
export function findMarkupPolicyIssue(
  files: readonly { path: string; content: string }[],
  policy: MarkupPolicy,
): string | null {
  const violations: MarkupViolation[] = [];
  for (const file of files) {
    const lower = file.path.toLowerCase();
    if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      violations.push(
        ...findMarkupPolicyViolations(file.path, file.content, policy),
      );
      continue;
    }
    if (
      lower.endsWith('.js') ||
      lower.endsWith('.mjs') ||
      lower.endsWith('.cjs')
    ) {
      violations.push(
        ...findServiceWorkerRegistration(file.path, file.content),
      );
    }
  }
  if (violations.length === 0) return null;
  return describeMarkupPolicyViolations(violations);
}
