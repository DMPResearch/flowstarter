/**
 * Reading a rendered email the way a person reads it, for the assertions that
 * compare the two halves of one message.
 *
 * Deliberately NOT in `preview-fixtures.ts`. That module is bundled by
 * `scripts/render-email-previews.mjs`, and the scanner below comes from
 * `@flowstarter/agentic-codegen`, whose package entry esbuild follows into a
 * native `onnxruntime` binding it has no loader for. The fixtures and the
 * linter are what the harness needs; the readers are what the tests need, and
 * keeping the two apart is what keeps `node scripts/render-email-previews.mjs`
 * a thing anybody can run.
 */
// The house scanner, the same one `lib/flowstarter/person-source.ts` reads a
// remote page with. Indexed rather than matched, so nothing here closes a tag
// differently from a browser and nothing here backtracks.
import {
  decodeHtmlEntities,
  stripTagBlocks,
  stripTags,
  tagBlocks,
} from '@flowstarter/agentic-codegen/src/flowstarter/html-scan';

/**
 * References resolved once, then whitespace collapsed.
 *
 * `decodeHtmlEntities` rather than a chain of `.replace()` calls, for the
 * reason its own header gives: a chain reads its own output, so `&amp;lt;`
 * comes back as `<` when a browser would show the literal `&lt;`. These
 * templates escape a stranger's name and a stranger's brief into the HTML,
 * so a reader that decodes them once more than the renderer escaped them is
 * comparing a string nobody was ever sent.
 *
 * The shared table has no `middot`, which this layout uses once, as the
 * separator in the footer's `Flowstarter . hello@flowstarter.net` line. It
 * survives as its own literal text, and `words` below discards it with the
 * rest of the punctuation, so nothing downstream sees it.
 */
function decode(value: string): string {
  return decodeHtmlEntities(value).replace(/\s+/g, ' ');
}

/**
 * One sentence, reduced to the words in it.
 *
 * URLs go first, then everything that is not a letter or a digit. Both halves
 * of an email say the same thing about a link and neither says it the same
 * way: the HTML shows the label and hides the href behind it, and the text
 * part prints `label: href` because there is nowhere else for the address to
 * go. Comparing the punctuation would therefore fail on every inline link in
 * the system and catch nothing, so the comparison is on the words, which is
 * the thing that must not differ.
 */
export function words(value: string): string {
  return value
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Where every `<!-- … -->` sits, found by scanning.
 *
 * Nothing is removed. The first version of this reader stripped comments with
 * `.replace(/<!--[\s\S]*?-->/g, '')` and CodeQL was right to fail it
 * (`js/incomplete-multi-character-sanitization`): one pass over a
 * multi-character delimiter can leave a `<!--` behind, because the text that
 * closes one comment can open the next. Replacing in a loop until the string
 * stops changing would answer the alert and still be the wrong shape, since
 * the bug in a sanitiser is the sanitised string itself: something downstream
 * reads a document that never existed.
 *
 * So there is no sanitised string here. The ranges are computed once, the
 * document is left exactly as it was rendered, and the element reader below
 * skips anything that starts inside one. Scanning with `indexOf` the way
 * `tagBlocks` in `@flowstarter/agentic-codegen/src/flowstarter/html-scan`
 * does, so it is linear and has no quantifier to backtrack over.
 *
 * What this has to get right is the button, which is drawn twice. The VML
 * rectangle sits inside `<!--[if mso]> … <![endif]-->` and must stay
 * invisible; the anchor sits between `<!--[if !mso]><!-->` and
 * `<!--<![endif]-->`, two complete comments with live markup between them,
 * and must stay visible. Closing each comment at its own first `-->` is what
 * gets both right.
 */
function commentRanges(html: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  for (;;) {
    const open = html.indexOf('<!--', cursor);
    if (open < 0) return ranges;
    const close = html.indexOf('-->', open + 4);
    // An unterminated comment runs to the end, which is what a browser does
    // with one too.
    if (close < 0) {
      ranges.push([open, html.length]);
      return ranges;
    }
    cursor = close + 3;
    ranges.push([open, cursor]);
  }
}

/**
 * Every sentence the HTML part actually shows a reader.
 *
 * Read out of the leaf elements rather than out of the whole document,
 * because the whole document flattened would run the end of one paragraph
 * into the start of the next and invent sentences nobody wrote.
 *
 * Nothing is sanitised on the way. The head is taken out by the shared
 * scanner, and the two things that are in the HTML but not visible, the
 * hidden preheader and the Outlook-only conditional comments, are skipped
 * where they sit rather than deleted. See `commentRanges` above for why that
 * distinction is the whole fix and not a detail of it.
 *
 * A chunk counts as a sentence when it has four words or more. That is the
 * line between prose, which the text part must carry, and a label like
 * "Email" or a value like a URL, which the text part carries in its own
 * `label: value` shape instead.
 */
export function htmlSentences(html: string): string[] {
  // The `<head>` holds the title, the styles and an Outlook conditional, none
  // of which a reader sees. `stripTagBlocks` closes the tag the way the HTML
  // spec does rather than the way a lazy quantifier does.
  const visible = stripTagBlocks(html, ['head']);
  const hidden = commentRanges(visible);
  const inComment = (at: number) =>
    hidden.some(([from, to]) => at >= from && at < to);

  const chunks: string[] = [];
  const push = (raw: string) => {
    const text = decode(stripTags(raw)).trim();
    if (!text) return;
    // Split where one sentence ends and the next begins, so a paragraph of
    // three is checked as three.
    for (const part of text.split(/(?<=[.?!])\s+(?=[A-Z"'])/)) {
      const sentence = part.trim();
      if (sentence.split(/\s+/).length >= 4) chunks.push(sentence);
    }
  };

  for (const tag of ['h1', 'p', 'li'] as const) {
    for (const block of tagBlocks(visible, tag)) {
      if (!inComment(block.start)) push(block.inner);
    }
  }
  // A `td` counts only when it holds text and no markup, which is exactly the
  // label and value cells of a facts table. Every other cell in this layout
  // wraps a table or a paragraph that the pass above has already read, and
  // reading it again would run one block's last sentence into the next one's
  // first and invent a sentence nobody wrote.
  for (const block of tagBlocks(visible, 'td')) {
    if (!inComment(block.start) && !block.inner.includes('<')) {
      push(block.inner);
    }
  }

  // The hidden preheader is the one string deliberately in the HTML and not
  // in the text part. It is a `div`, the only one this layout has, and it
  // never reaches `chunks` because its content is inside no element this
  // reader looks at.
  return chunks;
}

/**
 * Every colour literal in the rendered HTML, lowercased.
 *
 * Both notations, because a hand-written `rgb()` would slip past a hex-only
 * sweep, and both places one can hide: a style attribute and the `bgcolor`
 * attribute Outlook and Gmail's inverting readers actually obey.
 */
export function htmlColours(html: string): string[] {
  // `&#8204;` is a numeric entity, not a colour. It pads the preheader, it is
  // the only `#` in this system that is not a hex value, and matching it here
  // would make this check fail on every template at once for no reason.
  const found = html.match(/(?<!&)#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) ?? [];
  return found.map((colour) => colour.toLowerCase());
}
