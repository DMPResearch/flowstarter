/**
 * The acceptable-use gate on the BUILT site.
 *
 * The coding agent is told, in its system prompt, that it must not build a
 * site for a prohibited business. An instruction is a hope. This is the rule:
 * after the site compiles and before anything is committed or published, the
 * text the browser would actually render is read back and classified again. An
 * agent that ignored the instruction, or a build seeded from a brief that
 * slipped past the app's own gates, cannot ship.
 *
 * This module holds no policy and no vocabulary. There is no phrase list here,
 * no regular expression over business words, and no category table: those live
 * in `apps/flowstarter-main/src/lib/policy/`, behind one classifier, and this
 * package must not carry a second copy that can drift. What lives here is the
 * mechanical half:
 *
 *   - the error code the ledger records,
 *   - the {@link ContentPolicyScanner} seam the host injects,
 *   - a bounded, ordered reader that turns a compiled site into the text a
 *     classifier should read, including the places copy hides (title, meta
 *     description, image alt text, link text),
 *   - the operator-facing sentence a failure is reported with.
 *
 * The package never calls a model. It is handed a scanner or it is not.
 */

import { parse } from 'parse5';

/** The ledger code for a build the acceptable-use policy stopped. */
export const PROHIBITED_CONTENT = 'PROHIBITED_CONTENT';

/**
 * The code for a build that could not be scanned at all in an environment
 * where scanning is required. Distinct from a refusal on purpose: "we will not
 * build this" and "we could not check this" are different failures and an
 * operator must be able to tell them apart at a glance.
 */
export const CONTENT_POLICY_UNAVAILABLE = 'CONTENT_POLICY_UNAVAILABLE';

export interface ContentPolicyVerdict {
  decision: 'allow' | 'review' | 'refuse';
  /** The stable category id from the policy module, or 'none'. */
  categoryId: string;
  /** The plain-language label, for the operator. */
  categoryLabel: string;
  /** One sentence from the classifier about what it saw. */
  evidence: string;
  /** The hash of the scanned text. The text itself is never logged. */
  evidenceHash: string;
}

/**
 * The host's classifier, injected.
 *
 * `apps/build-worker` implements it by calling flowstarter-main's internal
 * policy endpoint with the build-worker shared secret, so the built site is
 * judged by exactly the same classifier, the same prompt version and the same
 * thresholds as the intake and the brief were. Nothing about the policy is
 * decided in this process.
 */
export type ContentPolicyScanner = (input: {
  text: string;
  workspaceId: string | null;
  projectId: string | null;
}) => Promise<ContentPolicyVerdict>;

/**
 * How much of a compiled site one scan reads.
 *
 * A site is far larger than any intake answer, and a classifier that is handed
 * a megabyte reads the navigation forty times and the offer once. The reader
 * below spends this budget on the pages a visitor lands on first, in order, so
 * the cap buys the most telling text rather than the first text on disk.
 */
export const BUILT_TEXT_SCAN_MAX_CHARS = 60_000;

/** Files whose content is markup or copy rather than code or data. */
const TEXT_EXTENSIONS = [
  '.html',
  '.htm',
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
];

/** Of those, the ones parse5 should read rather than take verbatim. */
const MARKUP_EXTENSIONS = ['.html', '.htm'];

/**
 * A linear suffix check, not a pattern.
 *
 * A path is short and this would be safe either way, but the whole reason this
 * module exists in its current shape is that a regex over a built site turned
 * out to be three security findings, so it does not keep one for convenience.
 */
function endsWithAny(path: string, extensions: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some(
    (extension) =>
      lower.length >= extension.length &&
      lower.slice(lower.length - extension.length) === extension,
  );
}

function hasTextExtension(path: string): boolean {
  return endsWithAny(path, TEXT_EXTENSIONS);
}

function isMarkup(path: string): boolean {
  return endsWithAny(path, MARKUP_EXTENSIONS);
}

/**
 * The most of any one file the scan will parse.
 *
 * Comfortably larger than a real page and far smaller than a compiled bundle,
 * so the bound is invisible on an honest site and is the thing that stops a
 * single generated file from deciding how long a build takes.
 */
const MAX_FILE_SCAN_CHARS = 200_000;

/**
 * Landing pages first, then everything else alphabetically.
 *
 * A prohibited business names itself on the page a visitor arrives at. Reading
 * `index.html` before `blog/2024/03/a-post.html` is the difference between
 * spending the budget on the offer and spending it on an archive.
 */
function scanOrder(a: string, b: string): number {
  const rank = (path: string): number => {
    const lower = path.toLowerCase();
    if (lower.indexOf('index.html') >= 0) return lower.split('/').length;
    return 100 + lower.split('/').length;
  };
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A parse5 node, reduced to what this reader touches. The same shape
 * `markup-policy.ts` narrows to, and for the same reason: parse5's own types
 * describe a union this code does not need to discriminate.
 */
interface HtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  content?: HtmlNode;
}

/**
 * Subtrees whose text is machine, not copy. Dropped whole: an inline analytics
 * blob is bytes the classifier's window would be spent on and learn nothing
 * from, and a CSS rule is not a sentence about a business.
 *
 * This is a tag-name check on a PARSED tree, not a pattern over the source. It
 * is the difference between a rule and a guess: `</script >` with a space,
 * `<script/>`, a `<script>` inside a comment, an unclosed one, are all things a
 * regex gets wrong and the HTML spec's own tokenizer gets right.
 */
const SKIPPED_SUBTREES = new Set(['script', 'style', 'noscript', 'template']);

/**
 * Attributes that carry copy the eye may never see.
 *
 * A prohibited site reliably puts its trade in at least one of them: the
 * document title, the meta description, an image's alt text, a link's target.
 * A page that says nothing on screen and links to `gram-prices.html` with an
 * image alt of "cocaine, 1g" has told us what it is.
 */
const COPY_ATTRIBUTES = new Set([
  'alt',
  'title',
  'aria-label',
  'content',
  'href',
]);

/** Longest attribute value worth reading. A data URI is not a sentence. */
const MAX_ATTRIBUTE_CHARS = 300;

/**
 * The copy a browser would show, out of compiled markup.
 *
 * Parsed with parse5, the same parser the `GENERATED_HTML_UNSAFE` gate already
 * trusts to decide what a page asks the browser to do. Nothing here is a
 * regular expression over the page.
 *
 * That is not tidiness. The hand-written stripper this replaces had three real
 * defects, all of which CodeQL named on PR #158 and any of which a generated
 * site could have hit by accident:
 *
 *   - `/<script[\s\S]*?<\/script>/` does not match `</script >`, so a page
 *     could have smuggled its whole inline bundle into the classifier's
 *     window, or hidden copy behind a close tag the stripper did not see.
 *   - the same pattern is polynomial on input full of `<script`, which is a
 *     denial of service reachable from a built site.
 *   - replacing `&amp;` before `&lt;` double-unescapes: `&amp;lt;` came out as
 *     `<`, so the text handed to the classifier was not the text on the page.
 *
 * parse5 has none of those: it decodes character references itself, exactly
 * once, per the spec, and it decides where a script ends the way a browser
 * does. Reusing it means the scan reads what a visitor reads.
 */
export function readableTextFromMarkup(markup: string): string {
  const parts: string[] = [];

  const visit = (node: HtmlNode): void => {
    const tag = node.tagName?.toLowerCase();
    if (tag && SKIPPED_SUBTREES.has(tag)) return;

    if (node.nodeName === '#text' && typeof node.value === 'string') {
      parts.push(node.value);
    }
    for (const attr of node.attrs ?? []) {
      if (!COPY_ATTRIBUTES.has(attr.name.toLowerCase())) continue;
      const value = attr.value ?? '';
      parts.push(
        value.length > MAX_ATTRIBUTE_CHARS
          ? value.slice(0, MAX_ATTRIBUTE_CHARS)
          : value,
      );
    }

    for (const child of node.childNodes ?? []) visit(child);
    // A `<template>`'s content is parsed into its own fragment. Its tag is on
    // the skip list, so this is reached only for the document itself and for
    // any other node parse5 gives a `content` on.
    if (node.content) visit(node.content);
  };

  visit(parse(markup) as HtmlNode);
  // One linear pass to collapse runs of whitespace. Not a scan of the page: by
  // here the page is a list of already-decoded strings.
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export interface ScannableFile {
  path: string;
  content: string;
}

/**
 * One bounded string for the classifier, out of a compiled site.
 *
 * Each file contributes its path (a route name is copy too: `/escorte` says
 * something) and its readable text, in landing-page-first order, until the
 * budget runs out. The result is deterministic, so the same build produces the
 * same scan and therefore the same cached verdict.
 */
export function collectBuiltTextForScan(
  files: ScannableFile[],
  maxChars: number = BUILT_TEXT_SCAN_MAX_CHARS,
): string {
  const ordered = files
    .filter((file) => hasTextExtension(file.path))
    .slice()
    .sort((a, b) => scanOrder(a.path, b.path));

  const parts: string[] = [];
  let used = 0;
  for (const file of ordered) {
    if (used >= maxChars) break;
    // Truncated BEFORE parsing, not after. The scan never reads more than its
    // budget anyway, and a generated site is allowed to contain one enormous
    // file; parsing it in full to then throw most of it away is work a build
    // should not be made to do.
    const source =
      file.content.length > MAX_FILE_SCAN_CHARS
        ? file.content.slice(0, MAX_FILE_SCAN_CHARS)
        : file.content;
    const body = isMarkup(file.path)
      ? readableTextFromMarkup(source)
      : source.replace(/\s+/g, ' ').trim();
    if (body.length === 0) continue;
    const header = 'PAGE ' + file.path + ': ';
    const room = maxChars - used - header.length;
    if (room <= 0) break;
    const slice = body.length > room ? body.slice(0, room) : body;
    parts.push(header + slice);
    used += header.length + slice.length;
  }
  return parts.join('\n');
}

/**
 * What the operator reads on the ledger when a build is stopped.
 *
 * It names the category, quotes the classifier's one sentence, and carries the
 * hash of the scanned text. It does not quote the site: an operator who needs
 * to see the copy opens the build's own worktree, and a failure detail that
 * reproduced a drug price list would put it in the job ledger forever.
 */
export function describeProhibitedContent(
  verdict: ContentPolicyVerdict,
): string {
  return (
    'The built site was stopped by the acceptable-use policy: ' +
    verdict.categoryLabel +
    '. ' +
    verdict.evidence +
    ' This build is not published and the project is on the review board ' +
    '(scanned text ' +
    verdict.evidenceHash +
    '). The agent was instructed not to build this; it built it anyway, or ' +
    'the brief it was given changed after the intake was screened.'
  );
}

/** What the operator reads when the scan itself could not run. */
export function describeUnavailableScan(detail: string): string {
  return (
    'The acceptable-use scan of the built site could not run, and this ' +
    'environment requires it before a site is published: ' +
    detail +
    '. Nothing is published. Fix the policy endpoint and re-queue the build.'
  );
}
