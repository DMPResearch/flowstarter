/**
 * What belongs in a preview manifest, and what a client edit can be held to.
 *
 * On 2026-09-12 a paid build was failed by the approved-edit gate against
 * eight phrases that were an Astro dev server's process id, port, LAN URL and
 * start time. The client's headline was on the site; the gate had never seen
 * it. Three separate things had to be true for that to happen, and all three
 * are rules rather than prompts, so all three live here:
 *
 *   1. `.astro/dev.json` was in the preview manifest at all. A dev server's
 *      scratch directory is tooling state. It is not the client's site, it
 *      changes on every restart, and shipping it to the build worker put a
 *      moving target inside a record that is supposed to be fixed.
 *   2. The phrase derivation walked the changed files in sorted path order,
 *      and `.astro/` sorts before `src/`. Eight slots, eight lines of dev
 *      server state, and the loop never reached the file with the headline.
 *   3. Nothing asked whether a phrase was prose. `"pid": 97132,` is twelve
 *      characters with letters in it, which was the whole test.
 *
 * A fourth thing, found on 2026-09-14 (job `7508bf52`): being prose was not
 * enough either. The approved-edit gate recorded
 * `<div class="contact-pagelead-capture" data-flowstarter-lead-capture-slot>
 * </div>` — the platform's own injected lead-capture *markup* — as a phrase
 * the client had approved, because the derivation read whole *source lines*,
 * tags and attributes included, and a line of markup can satisfy every prose
 * check `isUsablePhrase` runs (it has enough letters, it is not a URL, key or
 * timestamp) while still not being anything a visitor reads. Worse, the class
 * name it recorded was already corrupted — `contact-page__lead-capture` with
 * its `__` stripped to `contact-pagelead-capture` — by `phraseFromLine`'s own
 * markdown-emphasis strip (`/[*_~]{1,3}/g`), which matched that `__` as if it
 * were `_emphasis_` markup anywhere it occurred in the line, not just at the
 * edges of one. `visibleTextLines` below is the fix for the first half:
 * derive lines from parse5's own text nodes, so a tag name or an attribute
 * value — the class, the injector's marker — can never become a "line" in
 * the first place, managed blocks (the lead-capture script and slot, the Cal
 * embed) excluded outright by the same marker attributes
 * `markup-policy.ts` already checks elements for. `phraseFromLine`'s
 * emphasis strip is anchored to the edges of the text for the same reason
 * the tag exclusion exists: something that resembles markup in the *middle*
 * of a word is not formatting.
 *
 * Everything below is pure and shared. The app uses it when it captures a
 * preview; the worker uses it when it seeds a build from one and when it
 * checks the built site. One rule, three callers, so a manifest can never be
 * clean on the way in and dirty on the way out.
 */
import { parseFragment } from 'parse5';
import type { TemplateScaffoldFile } from './types';

/**
 * Attribute markers on an element whose entire subtree is the platform's own
 * injected markup, never the client's — the lead-capture script and its
 * unfilled slot placeholder, the Cal.com embed and its blurred preview demo.
 * None of it is prose a client wrote or approved; excluded outright rather
 * than merely "not text", so it can never contribute a phrase via any
 * descendant, managed script tags included.
 */
const MANAGED_BLOCK_MARKER_ATTRIBUTES: ReadonlySet<string> = new Set([
  'data-flowstarter-lead-capture',
  'data-flowstarter-lead-capture-slot',
  'data-flowstarter-cal-embed',
  'data-flowstarter-cal-preview',
]);

/** The slice of a parse5 node this module reads. Structurally typed, so the mock in tests needs no import from parse5's own types. */
interface Parse5Node {
  nodeName: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Parse5Node[];
}

function isManagedBlockMarker(node: Parse5Node): boolean {
  for (const attr of node.attrs ?? []) {
    if (MANAGED_BLOCK_MARKER_ATTRIBUTES.has(attr.name.toLowerCase()))
      return true;
  }
  return false;
}

function collectVisibleText(
  node: Parse5Node,
  insideManagedBlock: boolean,
  out: string[],
): void {
  if (node.nodeName === '#text') {
    if (!insideManagedBlock && node.value) out.push(node.value);
    return;
  }
  // Neither ever visible copy: a script's own body is code, and a comment
  // (including the injector's own `flowstarter:lead-capture` marker comment)
  // is not content by definition.
  if (node.nodeName === 'script' || node.nodeName === 'style') return;
  if (node.nodeName === '#comment') return;
  const managed = insideManagedBlock || isManagedBlockMarker(node);
  for (const child of node.childNodes ?? []) {
    collectVisibleText(child, managed, out);
  }
}

/**
 * A file's content reduced to the lines a *reader* would see, never a tag
 * name, an attribute value, or the text inside a platform-managed block.
 *
 * Parsed with parse5 — the HTML parser `markup-policy.ts` already trusts to
 * read a browser's own view of generated output — rather than scanned line
 * by line: a `.astro`/`.html` file's markup can never become a "line" here,
 * so a class attribute cannot be misread as prose in the first place. A file
 * with no markup in it at all (YAML frontmatter, plain markdown) has nothing
 * for parse5 to treat as an element, so it parses as one text run — which,
 * split back into lines, is exactly the input `phraseFromLine` always saw
 * for that kind of file. The one behaviour change for markup files is the
 * fix: `<p>Reach out any day</p>` now yields the line `Reach out any day`,
 * not the tag around it.
 */
export function visibleTextLines(content: string): string[] {
  const root = parseFragment(content) as unknown as Parse5Node;
  const collected: string[] = [];
  collectVisibleText(root, false, collected);
  return collected.join('').split('\n');
}

/**
 * Directory names that hold tooling or build state, never authored site
 * content. Matched on any path segment, because a preview workspace can nest
 * one of these under a package directory.
 */
export const PREVIEW_TOOLING_DIRECTORIES: ReadonlySet<string> = new Set([
  '.astro',
  'node_modules',
  'dist',
  '.git',
  '.vite',
  '.cache',
  '.next',
  '.turbo',
  '.output',
  '.vercel',
  '.netlify',
]);

/** Lockfiles: reproducibility for a package manager, noise for a site. */
export const PREVIEW_LOCKFILES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'npm-shrinkwrap.json',
]);

/**
 * True for a path the manifest must never carry.
 *
 * Deliberately the same answer whether it is asked at capture time or at seed
 * time: manifests written before this rule existed still hold these files, and
 * the build has to skip them rather than fail on them.
 */
export function isPreviewToolingPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized) return true;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return true;
  if (segments.some((segment) => PREVIEW_TOOLING_DIRECTORIES.has(segment)))
    return true;
  // `.git`, `.gitignore`, `.gitattributes`, `.github`: all git's, none the
  // client's. This is the one prefix rule, and it is here because the preview
  // reader has always had it and dropping it would put `.gitignore` into a
  // manifest that never carried one.
  if (segments.some((segment) => segment.startsWith('.git'))) return true;
  const name = segments[segments.length - 1] ?? '';
  if (PREVIEW_LOCKFILES.has(name)) return true;
  if (name.toLowerCase().endsWith('.log')) return true;
  return false;
}

/** The manifest with the tooling taken out, order otherwise untouched. */
export function stripPreviewToolingFiles<T extends { path: string }>(
  files: readonly T[],
): T[] {
  return files.filter(
    (file) =>
      file && typeof file.path === 'string' && !isPreviewToolingPath(file.path),
  );
}

/**
 * How close a path is to something a client edit can meaningfully change,
 * lowest first. `Infinity` means "not client copy at all".
 *
 * The order is the order a reader would rank them in: the content collection
 * is the copy, pages are the copy in place, components and layouts are the
 * copy in a wrapper, and a text file under `public/` is copy somebody put
 * there by hand. Everything else is configuration or code.
 */
export function previewPathRelevance(path: string): number {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (isPreviewToolingPath(normalized)) return Infinity;
  if (normalized.toLowerCase().endsWith('.d.ts')) return Infinity;
  if (normalized.startsWith('src/content/')) return 0;
  if (normalized.startsWith('src/pages/')) return 1;
  if (normalized.startsWith('src/components/')) return 2;
  if (normalized.startsWith('src/layouts/')) return 3;
  if (
    normalized.startsWith('public/') &&
    /\.(md|mdx|txt|html)$/i.test(normalized)
  )
    return 4;
  return Infinity;
}

/** True for a file whose text a client's free change could be evidenced by. */
export function isClientEditablePath(path: string): boolean {
  return Number.isFinite(previewPathRelevance(path));
}

/**
 * A phrase shorter than this is not evidence that a change survived: "Home",
 * "Contact" and "2026" appear in every template ever written.
 */
export const MIN_PHRASE_CHARS = 12;
/** Longer than this and a reflowed paragraph would fail a verbatim check. */
export const MAX_PHRASE_CHARS = 200;
/** Enough letters that the line is words rather than punctuation and digits. */
export const MIN_PHRASE_LETTERS = 8;

/** Values that are long enough but carry no prose: ids, colours, numbers, urls. */
const NOT_PROSE =
  /^(https?:\/\/\S*|\/\S*|#[0-9a-fA-F]{3,8}|[\s\d.,:;%+\-_/\\|*#[\]{}()"'`=<>]*)$/;

/**
 * `"pid": 97132,` and every other quoted JSON key with a value after it.
 * Every quantifier is bounded: this runs over untrusted file content, and an
 * unbounded one here is a denial of service with extra steps.
 */
const JSON_KEYED = /^["'][^"']{0,80}["'][ \t]{0,8}:/;

/** `2026-09-11T21:51:12.985Z`, in a line or on its own. */
const TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Whitespace-insensitive, case-insensitive form used for every comparison. */
export function normalizePhrase(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * One line of a content file reduced to the text a reader would see.
 *
 * The preview's content lives in YAML-ish front matter and markdown, so the
 * interesting half of `heroHeadline: "I build websites with AI agents"` is the
 * quoted value, not the key. Stripping the key also means renaming a key never
 * looks like new copy.
 */
export function phraseFromLine(line: string): string | null {
  let text = line.trim();
  if (!text) return null;
  // List bullet, then `key:` prefix, then surrounding quotes.
  text = text.replace(/^[-*+]\s+/, '');
  // Bounded on both sides of the colon. The unbounded `+\s*:\s*` this
  // replaces is a polynomial-backtracking shape on a line of the form
  // `$:` followed by a long run of spaces, and the input here is a file the
  // client's own preview workspace produced.
  const keyed = /^([A-Za-z0-9_.$[\]-]{1,80})[ \t]{0,8}:[ \t]{0,8}(.+)$/.exec(
    text,
  );
  if (keyed?.[2]) text = keyed[2].trim();
  text = text.replace(/^(['"`])([\s\S]*)\1$/, '$2').trim();
  // Markdown emphasis and heading markers are formatting, not words — but
  // only at the edges of the text, where formatting actually lives.
  // `/[*_~]{1,3}/g` (unanchored, matching anywhere) used to strip a `__` out
  // of the *middle* of a line too, which is how a BEM class name like
  // `contact-page__lead-capture` — never meant to be a phrase at all, see
  // this file's header — came out of this function as the mangled
  // `contact-pagelead-capture`. A run of `*`, `_` or `~` in the middle of a
  // word is not markup; it is the word.
  text = text
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[*_~]{1,3}(?=\S)/, '')
    .replace(/(?<=\S)[*_~]{1,3}$/, '')
    .trim();
  if (text.length < MIN_PHRASE_CHARS) return null;
  if (NOT_PROSE.test(text)) return null;
  if (!/[A-Za-z]/.test(text)) return null;
  return text.slice(0, MAX_PHRASE_CHARS);
}

/**
 * True when a phrase is prose a site could plausibly display.
 *
 * The path filter is the first line of defence and would have been enough on
 * its own for the 2026-09-12 failure. This is the second, and it is what makes
 * the fix hold for a manifest captured before the path filter existed: the
 * eight stored phrases on workspace `c009105e` are rejected here one by one,
 * without anybody editing the row.
 */
export function isUsablePhrase(value: string): boolean {
  const text = value.trim();
  if (text.length < MIN_PHRASE_CHARS) return false;
  if (JSON_KEYED.test(text)) return false;
  if (text.includes('://')) return false;
  if (TIMESTAMP.test(text)) return false;
  const letters = text.replace(/[^A-Za-z]/g, '').length;
  if (letters < MIN_PHRASE_LETTERS) return false;
  return true;
}

/** The subset of a stored phrase list that can still hold a build to account. */
export function usablePhrases(phrases: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const phrase of phrases) {
    if (typeof phrase !== 'string') continue;
    if (!isUsablePhrase(phrase)) continue;
    const key = normalizePhrase(phrase);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(phrase.trim());
  }
  return kept;
}

/**
 * Client-editable paths, most relevant first, ties broken alphabetically so
 * two runs over the same file set produce the same order.
 */
export function orderByRelevance(paths: readonly string[]): string[] {
  return paths
    .filter((path) => isClientEditablePath(path))
    .slice()
    .sort((a, b) => {
      const byRelevance = previewPathRelevance(a) - previewPathRelevance(b);
      if (byRelevance !== 0) return byRelevance;
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

/** A manifest file whose content is readable text rather than packed bytes. */
export function isTextManifestFile(file: {
  path?: unknown;
  content?: unknown;
  encoding?: unknown;
}): boolean {
  return (
    typeof file?.path === 'string' &&
    typeof file?.content === 'string' &&
    file.encoding !== 'base64'
  );
}

/**
 * How many candidate lines a re-derivation will consider before ranking them.
 * Bounded because this runs over a whole content collection.
 */
const PHRASE_CANDIDATE_CAP = 200;

/**
 * Every usable phrase in the given files, most relevant first.
 *
 * Used to re-derive an edit's evidence at build time when what was stored is
 * unusable. It is a weaker record than a diff - it cannot tell the line the
 * client's change added from the lines that were always there - but the check
 * it feeds fails a build only when *every* phrase is gone, so a wider list can
 * never fail a build a narrower one would have passed. It can only stop the
 * gate from firing on nothing at all.
 *
 * `instruction` is what stops it being merely wider. A phrase the client's own
 * sentence contains is the one line in the file that this edit is certainly
 * about, so those come first. For the 2026-09-12 workspace that is the
 * difference between checking the site's meta title and checking "I build
 * websites with AI agents, supervised by people", which is what the client
 * actually asked for and paid for.
 */
export function phrasesFromFiles(
  files: readonly TemplateScaffoldFile[],
  options: {
    paths?: readonly string[];
    limit: number;
    /** The client's own words, used to rank rather than to generate. */
    instruction?: string;
  },
): string[] {
  const byPath = new Map<string, string>();
  for (const file of files) {
    if (!isTextManifestFile(file)) continue;
    byPath.set(file.path, file.content as string);
  }
  const candidates = options.paths
    ? options.paths.filter((path) => byPath.has(path))
    : Array.from(byPath.keys());

  const asked = normalizePhrase(options.instruction ?? '');
  const named: string[] = [];
  const rest: string[] = [];
  const seen = new Set<string>();
  outer: for (const path of orderByRelevance(candidates)) {
    for (const line of visibleTextLines(byPath.get(path) ?? '')) {
      if (named.length + rest.length >= PHRASE_CANDIDATE_CAP) break outer;
      const phrase = phraseFromLine(line);
      if (!phrase || !isUsablePhrase(phrase)) continue;
      const key = normalizePhrase(phrase);
      if (seen.has(key)) continue;
      seen.add(key);
      if (asked.length > 0 && asked.includes(key)) named.push(phrase);
      else rest.push(phrase);
    }
  }
  return [...named, ...rest].slice(0, options.limit);
}
