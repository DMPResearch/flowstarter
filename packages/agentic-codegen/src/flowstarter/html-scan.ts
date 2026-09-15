/**
 * Reading HTML without a regular expression.
 *
 * Three gates in this package now read a built page: the invented-project
 * check, the person check, and the template-effects check. Every one of them
 * started with the same four lines, and every one of them was wrong in the
 * same two ways, which is why the scanning lives here once instead of three
 * times.
 *
 * **`<script[\s\S]*?</script>` does not close a script tag.** A browser closes
 * `</script >` and that pattern does not, so a gate using it reads whatever
 * follows as visible prose. CodeQL calls this `js/bad-tag-filter` and it is
 * not a style note: a gate that can be made to read a page differently from
 * the browser is a gate that can be walked past. The spec's rule is simple
 * and is what `tagBlocks` implements: the tag name, then anything up to the
 * next `>`.
 *
 * **A lazy quantifier over attacker-supplied text is quadratic.** These
 * functions read files an agent wrote from a brief a stranger typed, so a
 * page full of `<script` openings is a plausible input rather than a
 * theoretical one (`js/polynomial-redos`). Indexed scanning is linear and
 * cannot backtrack at all.
 *
 * **Entity decoding is one pass, or it is a bug.** A chain of `.replace()`
 * calls that turns `&amp;` into `&` and then `&lt;` into `<` will turn
 * `&amp;lt;` into `<`, which is the double-unescaping CodeQL flags as
 * `js/double-escaping`. It matters here because these gates compare a
 * client's own sentences against a rendered page: text that decodes
 * differently on the two sides is a gate that fails a correct site, or
 * passes a wrong one. `decodeHtmlEntities` walks the string once, resolves
 * each reference from a fixed table, and never looks at its own output.
 *
 * Nothing here parses HTML properly, and nothing here needs to. These are
 * gates reading prose, not a renderer: the contract is "see roughly what a
 * reader sees, in linear time, the same way every time".
 */

/** Where one `<tag …>…</tag>` sits in a source file, and what is inside it. */
export interface TagBlock {
  inner: string;
  /** The `<` of the opening tag. */
  start: number;
  /** One past the `>` of the closing tag, or the end of the file. */
  end: number;
}

/** One character, so this can never backtrack over attacker-supplied text. */
const WORD_CHARACTER = /[A-Za-z0-9_-]/;

function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && WORD_CHARACTER.test(char);
}

/**
 * Every `<tag>…</tag>` block in a source, found by scanning rather than by
 * matching.
 *
 * Linear, and it closes a tag the way the HTML spec does: the name, then
 * anything up to the next `>`. `<style>` and `<style lang="scss">` both
 * match; `<styles>` does not. An unclosed block runs to the end of the
 * source, which is what a browser would do with it too.
 */
export function tagBlocks(source: string, tag: string): TagBlock[] {
  const blocks: TagBlock[] = [];
  const lower = source.toLowerCase();
  const name = tag.toLowerCase();
  const open = `<${name}`;
  const close = `</${name}`;
  let from = 0;
  for (;;) {
    const start = lower.indexOf(open, from);
    if (start < 0) return blocks;
    const afterName = start + open.length;
    if (isWordCharacter(source[afterName])) {
      from = afterName;
      continue;
    }
    const openEnd = source.indexOf('>', afterName);
    if (openEnd < 0) return blocks;
    const closeStart = lower.indexOf(close, openEnd + 1);
    if (closeStart < 0) {
      blocks.push({
        inner: source.slice(openEnd + 1),
        start,
        end: source.length,
      });
      return blocks;
    }
    // `</script>` and `</script >` alike: the tag ends at its own `>`.
    const closeEnd = source.indexOf('>', closeStart + close.length);
    const end = closeEnd < 0 ? source.length : closeEnd + 1;
    blocks.push({ inner: source.slice(openEnd + 1, closeStart), start, end });
    from = end;
  }
}

/**
 * The source with every named block taken out, opening and closing tags
 * included, each replaced by one space so words either side do not run
 * together.
 */
export function stripTagBlocks(
  source: string,
  tags: readonly string[],
): string {
  const ranges = tags
    .flatMap((tag) => tagBlocks(source, tag))
    .sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    // Nested or overlapping blocks: the outer one already consumed this.
    if (range.start < cursor) continue;
    out += `${source.slice(cursor, range.start)} `;
    cursor = range.end;
  }
  return out + source.slice(cursor);
}

/**
 * Every tag removed, by scanning: `<` to the next `>`, replaced by a space.
 *
 * A `<` with no `>` after it is the end of the readable text, the same way a
 * browser treats an unterminated tag. Linear, with no quantifier to backtrack
 * over.
 */
export function stripTags(html: string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const open = html.indexOf('<', cursor);
    if (open < 0) return out + html.slice(cursor);
    const close = html.indexOf('>', open + 1);
    if (close < 0) return `${out}${html.slice(cursor, open)} `;
    out += `${html.slice(cursor, open)} `;
    cursor = close + 1;
  }
}

/**
 * The named references worth resolving, and no more.
 *
 * Deliberately a short, fixed table rather than the full HTML5 set. These
 * gates read prose for words, so the only references that change what a word
 * IS are the handful below; the rest are punctuation and symbols that a
 * caller's own normalisation will flatten anyway. A short table is also a
 * table a reviewer can check.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

/**
 * One reference, in either form. Bounded on both sides and with no nested
 * quantifier, so it cannot backtrack: a name is letters and digits, a numeric
 * reference is digits or hex digits, and both must end in a semicolon.
 */
const ENTITY_REFERENCE =
  /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/** Above this a code point is not a character anybody wrote. */
const MAX_CODE_POINT = 0x10ffff;

/**
 * The surrogate range, which is not a character at all: it is half of one,
 * and `String.fromCodePoint` will happily build a lone one rather than throw.
 * A lone surrogate in text these gates compare is a value that survives one
 * round trip and not the next, so it is left as the source wrote it.
 */
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;

/**
 * HTML references resolved in ONE pass over the input.
 *
 * The output is never re-scanned, which is the whole point: `&amp;lt;` comes
 * back as the literal text `&lt;`, exactly as a browser renders it, rather
 * than being decoded twice into `<`. A replace chain cannot do this, however
 * the chain is ordered, because each call reads the previous call's output.
 */
export function decodeHtmlEntities(text: string): string {
  // `replace` with a function evaluates the callback against the ORIGINAL
  // string and splices the results in; it never re-matches what a callback
  // returned. That is what makes this single-pass by construction rather
  // than by careful ordering.
  return text.replace(ENTITY_REFERENCE, (whole, body: string) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const digits = hex ? body.slice(2) : body.slice(1);
      const code = Number.parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > MAX_CODE_POINT) {
        return whole;
      }
      if (code >= SURROGATE_FIRST && code <= SURROGATE_LAST) return whole;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/**
 * What a reader sees: scripts and styles gone, tags gone, references
 * resolved, whitespace collapsed.
 *
 * The one function every gate in this package should call, so that "what the
 * page says" has a single definition and two gates can never disagree about
 * whether a sentence is on a page.
 */
export function readableText(html: string): string {
  return decodeHtmlEntities(
    stripTags(stripTagBlocks(html, ['script', 'style'])),
  )
    .replace(/\s+/g, ' ')
    .trim();
}
