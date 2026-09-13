/**
 * The allow-list sanitiser every generated site's content loader runs its
 * frontmatter through, before a single string reaches `set:html`.
 *
 * Why here *and* in a template copy. This file is the canonical one — it is
 * unit-tested against the hostile fixtures in
 * `test/site-html-sanitizer.test.ts`, and `scripts/sync-template-lib.mjs`
 * copies it byte-for-byte to every template's `src/lib/sanitize-html.ts`. A
 * generated site is a standalone Astro app whose `package.json` depends on
 * `astro` and nothing else, so it cannot import a workspace package; the copy
 * is how the rule ships with the site. The drift test refuses a copy that no
 * longer matches, which is the only thing keeping "canonical" true.
 *
 * Because of that copy this module has, and must keep, zero imports.
 *
 * What it is for. `src/content/*.md` is agent-writable in every build mode, a
 * brief or a change request is attacker-influenced text, and the design system
 * renders frontmatter as raw HTML (`set:html`). So the string that arrives
 * here is untrusted input, and the only safe reading of it is: a short list of
 * formatting tags, a short list of attributes, and nothing else — no scripts,
 * no event handlers, no URLs that execute, no elements that navigate or embed.
 * Everything outside the list is dropped rather than "cleaned": there is no
 * such thing as an `<iframe>` that is fine once you fix its attributes.
 *
 * How it reads. One linear scan, no regular expression ever applied to the
 * untrusted string — a pattern that backtracks is a denial of service on text
 * a stranger wrote, and the whole class of "sanitiser bypassed by a cleverly
 * nested tag" bugs comes from regexes pretending to be parsers. Entities are
 * never decoded, and `<` is always escaped on the way out, so `&lt;script&gt;`
 * stays the five printable characters it already was.
 */

/** What a caller gets to render as HTML, and the attributes each tag keeps. */
interface TagPolicy {
  /** Tags allowed through, mapped to the attribute names each may carry. */
  readonly tags: ReadonlyMap<string, ReadonlySet<string>>;
  /** Tags that never have an end tag. */
  readonly voids: ReadonlySet<string>;
  /** Tag names keep the case they were written in (SVG's `viewBox` etc.). */
  readonly preserveCase: boolean;
  /**
   * Attributes holding a URL. Their value has to survive {@link sanitizeUrl}
   * or the attribute is dropped — the tag itself stays.
   */
  readonly urlAttributes: ReadonlySet<string>;
  /**
   * Attributes force-written onto a tag when it is emitted, as name/value
   * pairs rather than a map: this module is copied verbatim into every
   * template and compiled by whatever each consumer targets, so it stays on
   * constructs that need no downlevel iteration.
   */
  readonly forcedAttributes: ReadonlyMap<
    string,
    ReadonlyArray<readonly [string, string]>
  >;
  /** True when this element's children are discarded along with the tag. */
  isDiscarded(tag: string): boolean;
}

/**
 * Elements whose *content* is discarded with them, rather than kept as text.
 *
 * Dropping `<script>` but keeping its body would print the attacker's
 * JavaScript on the page as prose; dropping `<svg>` in rich text but keeping
 * its body would leave a trail of stray path data. For everything else —
 * `<div>`, `<section>`, an unknown tag — the tag goes and the words stay,
 * which is what a client whose bio arrived wrapped in a stray `<div>` wants.
 */
const RICH_TEXT_DISCARDED: ReadonlySet<string> = new Set([
  'script',
  'style',
  'svg',
  'math',
  'iframe',
  'object',
  'embed',
  'template',
  'noscript',
  'textarea',
  'title',
  'head',
  'base',
  'link',
  'meta',
  'form',
  'button',
  'input',
  'select',
  'option',
  'video',
  'audio',
  'source',
  'track',
  'canvas',
  'frame',
  'frameset',
  'applet',
  'portal',
]);

/** `a` is the only tag that may carry anything but nothing. */
const RICH_TEXT_TAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['p', new Set<string>()],
  ['br', new Set<string>()],
  ['strong', new Set<string>()],
  ['em', new Set<string>()],
  ['a', new Set<string>(['href'])],
  ['ul', new Set<string>()],
  ['ol', new Set<string>()],
  ['li', new Set<string>()],
  ['h2', new Set<string>()],
  ['h3', new Set<string>()],
  ['span', new Set<string>()],
]);

/**
 * Every link leaves with `rel="noopener noreferrer"` whether the frontmatter
 * asked for it or not: a generated site's outbound links are written by a
 * model reading a stranger's brief, and `window.opener` is a capability no
 * marketing page needs to hand out.
 */
const RICH_TEXT_FORCED: ReadonlyMap<
  string,
  ReadonlyArray<readonly [string, string]>
> = new Map([['a', [['rel', 'noopener noreferrer'] as const]]]);

const RICH_TEXT_POLICY: TagPolicy = {
  tags: RICH_TEXT_TAGS,
  voids: new Set(['br']),
  preserveCase: false,
  urlAttributes: new Set(['href']),
  forcedAttributes: RICH_TEXT_FORCED,
  isDiscarded: (tag) => RICH_TEXT_DISCARDED.has(tag),
};

/**
 * The second policy: inline icon SVG.
 *
 * The design system renders social and service icons with `set:html` too, and
 * those are template-authored literals rather than frontmatter — but the same
 * sink cannot be trusted to stay that way, since a full build lets the agent
 * write `.astro` source directly. Shapes and geometry are allowed; `onload`,
 * `href`, `xlink:href`, `<script>` and `<foreignObject>` are not, which is the
 * whole of how an SVG runs code.
 */
const SVG_SHAPE_ATTRIBUTE_NAMES: readonly string[] = [
  'd',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'width',
  'height',
  'points',
  'transform',
  'fill',
  'fill-rule',
  'fill-opacity',
  'clip-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-opacity',
  'opacity',
  'class',
  'aria-hidden',
  'role',
  'focusable',
];

const SVG_SHAPE_ATTRIBUTES: ReadonlySet<string> = new Set(
  SVG_SHAPE_ATTRIBUTE_NAMES,
);

const SVG_ROOT_ATTRIBUTES: ReadonlySet<string> = new Set(
  SVG_SHAPE_ATTRIBUTE_NAMES.concat(['viewBox', 'xmlns', 'preserveAspectRatio']),
);

const SVG_TAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['svg', SVG_ROOT_ATTRIBUTES],
  ['g', SVG_SHAPE_ATTRIBUTES],
  ['path', SVG_SHAPE_ATTRIBUTES],
  ['circle', SVG_SHAPE_ATTRIBUTES],
  ['ellipse', SVG_SHAPE_ATTRIBUTES],
  ['rect', SVG_SHAPE_ATTRIBUTES],
  ['line', SVG_SHAPE_ATTRIBUTES],
  ['polyline', SVG_SHAPE_ATTRIBUTES],
  ['polygon', SVG_SHAPE_ATTRIBUTES],
  ['defs', SVG_SHAPE_ATTRIBUTES],
  ['linearGradient', SVG_SHAPE_ATTRIBUTES],
  ['radialGradient', SVG_SHAPE_ATTRIBUTES],
  ['stop', new Set(['offset', 'stop-color', 'stop-opacity'])],
  ['title', new Set<string>()],
]);

const SVG_DISCARDED: ReadonlySet<string> = new Set([
  'script',
  'style',
  'foreignObject',
  'use',
  'image',
  'animate',
  'animateTransform',
  'animateMotion',
  'set',
  'handler',
  'a',
  'iframe',
  'embed',
  'object',
]);

const SVG_POLICY: TagPolicy = {
  tags: SVG_TAGS,
  voids: new Set(),
  preserveCase: true,
  urlAttributes: new Set(),
  forcedAttributes: new Map(),
  isDiscarded: (tag) => SVG_DISCARDED.has(tag),
};

/** URL schemes a generated site may point at. Everything else is refused. */
const ALLOWED_URL_SCHEMES: ReadonlySet<string> = new Set([
  'https',
  'mailto',
  'tel',
]);

function isAsciiLetter(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
}

function isNameChar(char: string): boolean {
  return (
    isAsciiLetter(char) ||
    (char >= '0' && char <= '9') ||
    char === '-' ||
    char === '_' ||
    char === ':' ||
    char === '.'
  );
}

function isSpace(char: string): boolean {
  return (
    char === ' ' ||
    char === '\t' ||
    char === '\n' ||
    char === '\r' ||
    char === '\f'
  );
}

/**
 * Text, made safe to concatenate into markup.
 *
 * `<` and `>` only. `&` is deliberately left alone: nothing downstream decodes
 * it back into a tag, and escaping it would turn every `&amp;` a previous pass
 * wrote into a visible `&amp;amp;` the client then reports as a typo.
 */
function escapeText(value: string): string {
  let out = '';
  for (const char of value) {
    if (char === '<') out += '&lt;';
    else if (char === '>') out += '&gt;';
    else out += char;
  }
  return out;
}

/** Attribute values additionally escape the quote they are wrapped in. */
function escapeAttribute(value: string): string {
  let out = '';
  for (const char of value) {
    if (char === '<') out += '&lt;';
    else if (char === '>') out += '&gt;';
    else if (char === '"') out += '&quot;';
    else out += char;
  }
  return out;
}

/**
 * A URL a generated site may navigate to, or `fallback`.
 *
 * Relative paths pass (`/contact`, `#book`, `images/hero.webp`); `https:`,
 * `mailto:` and `tel:` pass; everything else — `javascript:`, `data:`,
 * `vbscript:`, a protocol-relative `//evil.example` that silently inherits the
 * page's scheme — comes back as the fallback.
 *
 * The scheme is read by scanning, and control characters and spaces are
 * stripped first, because `java\tscript:alert(1)` is a scheme browsers accept
 * and a naive `startsWith('javascript:')` does not.
 */
export function sanitizeUrl(value: unknown, fallback = '#'): string {
  if (typeof value !== 'string') return fallback;
  let cleaned = '';
  for (const char of value) {
    // Anything at or below the space, plus DEL, is not part of a URL a human
    // typed. Browsers drop them before resolving the scheme; so does this.
    if (char <= ' ' || char === '') continue;
    cleaned += char;
  }
  if (cleaned.length === 0) return fallback;
  if (cleaned.startsWith('//')) return fallback;

  let scheme = '';
  for (const char of cleaned) {
    if (char === ':') break;
    if (char === '/' || char === '?' || char === '#') {
      // A path separator before any colon: this is a relative URL.
      return cleaned;
    }
    scheme += char;
  }
  if (scheme.length === cleaned.length) return cleaned; // no colon at all
  return ALLOWED_URL_SCHEMES.has(scheme.toLowerCase()) ? cleaned : fallback;
}

interface TagToken {
  kind: 'open' | 'close';
  name: string;
  selfClosing: boolean;
  attributes: Array<{ name: string; value: string }>;
  /** Index just past the token's `>`. */
  end: number;
}

/** Reads one `<...>` starting at `at`, or null when it is not a tag. */
function readTag(
  input: string,
  at: number,
  preserveCase: boolean,
): TagToken | null {
  let cursor = at + 1;
  const kind: 'open' | 'close' = input[cursor] === '/' ? 'close' : 'open';
  if (kind === 'close') cursor += 1;
  const first = input[cursor];
  if (first === undefined || !isAsciiLetter(first)) return null;

  let name = '';
  while (cursor < input.length && isNameChar(input[cursor]!)) {
    name += input[cursor];
    cursor += 1;
  }
  if (!preserveCase) name = name.toLowerCase();

  const attributes: Array<{ name: string; value: string }> = [];
  let selfClosing = false;
  for (;;) {
    while (cursor < input.length && isSpace(input[cursor]!)) cursor += 1;
    const char = input[cursor];
    if (char === undefined) {
      // An unterminated tag. Treat what was read as the whole token: the
      // alternative is emitting the attacker's half-written tag as text.
      return { kind, name, selfClosing, attributes, end: input.length };
    }
    if (char === '>')
      return { kind, name, selfClosing, attributes, end: cursor + 1 };
    if (char === '/') {
      selfClosing = true;
      cursor += 1;
      continue;
    }
    if (!isNameChar(char)) {
      cursor += 1;
      continue;
    }

    let attrName = '';
    while (cursor < input.length && isNameChar(input[cursor]!)) {
      attrName += input[cursor];
      cursor += 1;
    }
    while (cursor < input.length && isSpace(input[cursor]!)) cursor += 1;
    let attrValue = '';
    if (input[cursor] === '=') {
      cursor += 1;
      while (cursor < input.length && isSpace(input[cursor]!)) cursor += 1;
      const quote = input[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        while (cursor < input.length && input[cursor] !== quote) {
          attrValue += input[cursor];
          cursor += 1;
        }
        cursor += 1;
      } else {
        while (
          cursor < input.length &&
          !isSpace(input[cursor]!) &&
          input[cursor] !== '>'
        ) {
          attrValue += input[cursor];
          cursor += 1;
        }
      }
    }
    attributes.push({
      name: preserveCase ? attrName : attrName.toLowerCase(),
      value: attrValue,
    });
  }
}

/** The attributes an allowed tag keeps, rendered. */
function renderAttributes(
  policy: TagPolicy,
  tag: string,
  attributes: Array<{ name: string; value: string }>,
): string {
  const allowed = policy.tags.get(tag);
  if (!allowed) return '';
  const forced = policy.forcedAttributes.get(tag);
  let out = '';
  const written = new Set<string>();
  for (const attribute of attributes) {
    const name = attribute.name;
    // Belt and braces over the positive list: no policy may ever grow an
    // event handler by accident, and `on*` is the whole family.
    if (name.length > 2 && name.slice(0, 2).toLowerCase() === 'on') continue;
    if (!allowed.has(name)) continue;
    if (written.has(name)) continue;
    if (forced?.some((pair) => pair[0] === name)) continue;
    let value = attribute.value;
    if (policy.urlAttributes.has(name)) {
      const url = sanitizeUrl(value, '');
      if (url.length === 0) continue;
      value = url;
    }
    written.add(name);
    out += ` ${name}="${escapeAttribute(value)}"`;
  }
  if (forced) {
    for (const pair of forced) {
      out += ` ${pair[0]}="${escapeAttribute(pair[1])}"`;
    }
  }
  return out;
}

/** Skips an element whose content is discarded with it, nesting and all. */
function skipDiscarded(
  input: string,
  from: number,
  name: string,
  preserveCase: boolean,
): number {
  let depth = 1;
  let cursor = from;
  while (cursor < input.length) {
    const next = input.indexOf('<', cursor);
    if (next === -1) return input.length;
    const tag = readTag(input, next, preserveCase);
    if (!tag) {
      cursor = next + 1;
      continue;
    }
    if (tag.name === name) {
      if (tag.kind === 'close') {
        depth -= 1;
        if (depth === 0) return tag.end;
      } else if (!tag.selfClosing) {
        depth += 1;
      }
    }
    cursor = tag.end;
  }
  return input.length;
}

function sanitize(input: string, policy: TagPolicy): string {
  let out = '';
  const open: string[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const next = input.indexOf('<', cursor);
    if (next === -1) {
      out += escapeText(input.slice(cursor));
      break;
    }
    out += escapeText(input.slice(cursor, next));

    // Comments, doctypes and processing instructions carry no content worth
    // keeping, and a conditional comment is a way to smuggle one.
    if (input.startsWith('<!--', next)) {
      const close = input.indexOf('-->', next + 4);
      cursor = close === -1 ? input.length : close + 3;
      continue;
    }
    if (input.startsWith('<!', next) || input.startsWith('<?', next)) {
      const close = input.indexOf('>', next + 2);
      cursor = close === -1 ? input.length : close + 1;
      continue;
    }

    const tag = readTag(input, next, policy.preserveCase);
    if (!tag) {
      // A bare `<` in prose ("<3", "a < b"). It leaves as text.
      out += '&lt;';
      cursor = next + 1;
      continue;
    }

    const lowered = tag.name.toLowerCase();
    if (tag.kind === 'close') {
      const at = open.lastIndexOf(tag.name);
      if (at !== -1) {
        // Close everything this end tag implicitly closes, innermost first,
        // so the output is never left with a dangling open element.
        for (let index = open.length - 1; index >= at; index -= 1) {
          out += `</${open[index]}>`;
        }
        open.length = at;
      }
      cursor = tag.end;
      continue;
    }

    if (policy.isDiscarded(lowered) || policy.isDiscarded(tag.name)) {
      cursor = tag.selfClosing
        ? tag.end
        : skipDiscarded(input, tag.end, tag.name, policy.preserveCase);
      continue;
    }

    if (!policy.tags.has(tag.name)) {
      // An unknown-but-harmless wrapper: drop the tag, keep the words.
      cursor = tag.end;
      continue;
    }

    out += `<${tag.name}${renderAttributes(policy, tag.name, tag.attributes)}`;
    if (policy.voids.has(tag.name) || tag.selfClosing) {
      out += ' />';
    } else {
      out += '>';
      open.push(tag.name);
    }
    cursor = tag.end;
  }

  for (let index = open.length - 1; index >= 0; index -= 1) {
    out += `</${open[index]}>`;
  }
  return out;
}

/**
 * Frontmatter prose, safe to hand to `set:html`.
 *
 * Keeps `p`, `br`, `strong`, `em`, `a` (https/mailto/tel only, always
 * `rel="noopener noreferrer"`), `ul`, `ol`, `li`, `h2`, `h3` and a bare
 * `span`. Drops every other tag, keeping the text inside it unless the
 * element is one whose content is code rather than words.
 */
export function sanitizeRichText(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (value.length === 0) return '';
  return sanitize(value, RICH_TEXT_POLICY);
}

/**
 * An inline icon, safe to hand to `set:html`.
 *
 * Returns an empty string for anything that is not an `<svg>`: the sink this
 * feeds is an icon slot, and a "clean" fragment of stray text in an icon slot
 * is a rendering bug rather than a design.
 */
export function sanitizeInlineSvg(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  const cleaned = sanitize(trimmed, SVG_POLICY).trim();
  return cleaned.startsWith('<svg') ? cleaned : '';
}
