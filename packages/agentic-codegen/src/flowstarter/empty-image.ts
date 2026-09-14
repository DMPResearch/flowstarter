/**
 * The `EMPTY_IMAGE_SHIPPED` gate: a built page may never ship an `<img>`
 * with an empty or missing `src`.
 *
 * The bug this closes. A template component that renders `<img src={x}>`
 * unconditionally is fine right up until `x` is `""` — which is exactly what
 * the seed cleaner (`seed-placeholders.ts`, #128) leaves behind once it takes
 * a gated placeholder out of a brief with no client photo. `src=""` is not
 * "no image": a browser resolves an empty `src` against the document's own
 * URL and requests the page again, so the element paints as a broken image
 * on a paid client's site. `AboutStory.astro` and its siblings across every
 * template are now written to render nothing (or the no-photo layout) for an
 * empty `imageSrc`, matching #110's `PLACEHOLDER_IMAGE_SHIPPED` fallback
 * pattern — but a component is a rule an author has to remember to apply
 * every time a template gains a new photo slot, and this gate is the check
 * that a future one did not forget.
 *
 * Parsing, not matching, for the same reason `markup-policy.ts` parses
 * rather than greps: an `<img>` spans arbitrary attribute order and
 * whitespace, and a regular expression confident enough to find every shape
 * of it is confident enough to also find one inside a comment or a string
 * literal that was never rendered as an element at all. `parse5` is the
 * parser a browser's own tree would come from.
 *
 * `src` is read exactly as the browser would resolve it: `srcset` is a
 * different attribute with different fallback rules and is not this gate's
 * job, and `data-src` (a lazy-load placeholder some third-party embed might
 * carry) is not `src` and is left alone.
 */

import { parse } from 'parse5';

/** The job fails with this when a built page ships an `<img>` with no src. */
export const EMPTY_IMAGE_SHIPPED = 'EMPTY_IMAGE_SHIPPED';

/** One `<img>` element the built page shipped with no usable `src`. */
export interface EmptyImageFinding {
  /** The compiled file, relative to `dist/` and in posix form. */
  readonly path: string;
  /** 1-based line in the compiled file, when the parser knew one. */
  readonly line: number | null;
  /** `'missing'` when the element carries no `src` attribute at all,
   * `'blank'` when it carries one that is empty or all whitespace. */
  readonly reason: 'missing' | 'blank';
  /** The element's `alt` text, if any, for a finding a human can place. */
  readonly alt: string | null;
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

function walk(
  node: HtmlNode,
  path: string,
  findings: EmptyImageFinding[],
): void {
  const tag = (node.tagName ?? '').toLowerCase();
  if (tag === 'img') {
    const src = attributeOf(node, 'src');
    if (src === null) {
      findings.push({
        path,
        line: lineOf(node),
        reason: 'missing',
        alt: attributeOf(node, 'alt'),
      });
    } else if (src.trim().length === 0) {
      findings.push({
        path,
        line: lineOf(node),
        reason: 'blank',
        alt: attributeOf(node, 'alt'),
      });
    }
  }
  for (const child of node.childNodes ?? []) walk(child, path, findings);
  // `<template>` content is parsed into a separate document fragment.
  if (node.content) walk(node.content, path, findings);
}

/**
 * Every `<img>` in `html` that ships with no `src` a browser could actually
 * load. Empty means the page is clean.
 */
export function findEmptyImagesInHtml(
  path: string,
  html: string,
): EmptyImageFinding[] {
  const document = parse(html, { sourceCodeLocationInfo: true }) as HtmlNode;
  const findings: EmptyImageFinding[] = [];
  walk(document, path, findings);
  return findings;
}

/**
 * The gate over a whole build: every compiled HTML page, scanned for an
 * `<img>` with no `src`. Files that are not HTML are not this gate's
 * business — a `.js` bundle does not paint a broken image in a browser.
 */
export function findEmptyImageFindings(
  files: readonly { path: string; content: string }[],
): EmptyImageFinding[] {
  const findings: EmptyImageFinding[] = [];
  for (const file of files) {
    const lower = file.path.toLowerCase();
    if (!lower.endsWith('.html') && !lower.endsWith('.htm')) continue;
    findings.push(...findEmptyImagesInHtml(file.path, file.content));
  }
  return findings;
}

/** The gate's verdict, phrased once for the job log — plain words, no jargon. */
export function describeEmptyImageIssue(
  findings: readonly EmptyImageFinding[],
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
    const what =
      finding.reason === 'missing'
        ? 'an <img> with no src attribute at all'
        : 'an <img> with an empty src';
    const named = finding.alt ? ` (alt "${finding.alt}")` : '';
    return `- ${where}: ${what}${named}.`;
  });
  return (
    `${EMPTY_IMAGE_SHIPPED}: the built site has a picture frame with nothing ` +
    "in it. An empty src asks the visitor's browser to reload the page as " +
    'an image, which paints as a broken-image icon — never a photo, never ' +
    'blank space. The component that renders it has to check for a missing ' +
    'photo itself and show nothing, or the no-photo layout, instead:\n' +
    lines.join('\n') +
    overflow
  );
}
