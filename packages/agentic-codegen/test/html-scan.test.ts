/**
 * The three defects this scanner exists because of.
 *
 * Each describe block below is one CodeQL alert raised against the first
 * version of the person gate, written as the input that would have walked
 * past it. They are regression tests in the strict sense: every one of them
 * fails against a `<script[\s\S]*?</script>` strip and a chain of entity
 * replacements.
 */
import { describe, expect, test } from 'vitest';
import {
  decodeHtmlEntities,
  readableText,
  stripTagBlocks,
  stripTags,
  tagBlocks,
} from '../src/flowstarter/html-scan';

describe('a tag closes the way the spec closes it', () => {
  test('closes `</script >`, which a regular expression does not', () => {
    // js/bad-tag-filter. A browser ends the script here; a lazy pattern
    // looking for the literal `</script>` does not, and everything after it
    // is then read as prose by the gate and as script by the reader.
    const html =
      '<p>Real prose.</p><script >var hidden = "invented studio copy";</script >' +
      '<p>More real prose.</p>';
    const text = readableText(html);
    expect(text).toContain('Real prose.');
    expect(text).toContain('More real prose.');
    expect(text).not.toContain('invented studio copy');
  });

  test('closes an uppercase and attribute-laden opening tag', () => {
    const html =
      '<SCRIPT type="module" defer>var x = "hidden";</SCRIPT><p>Shown.</p>';
    expect(readableText(html)).toBe('Shown.');
  });

  test('does not mistake `<styles>` for `<style>`', () => {
    expect(tagBlocks('<styles>kept</styles>', 'style')).toEqual([]);
    expect(tagBlocks('<style>gone</style>', 'style')).toHaveLength(1);
  });

  test('treats an unclosed block as running to the end, as a browser does', () => {
    const blocks = tagBlocks('<p>a</p><script>never closed', 'script');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.inner).toBe('never closed');
    expect(readableText('<p>a</p><script>never closed')).toBe('a');
  });

  test('keeps the words either side of a removed block apart', () => {
    // Without the space the two sentences would be glued into one word and a
    // phrase match across the join would find something nobody wrote.
    expect(readableText('<p>one</p><style>x{}</style><p>two</p>')).toBe(
      'one two',
    );
  });

  test('is linear in the number of unclosed openings', () => {
    // js/polynomial-redos. This input is 40,000 `<script` openings and no
    // closing tag: quadratic behaviour here is measured in minutes, and this
    // is a page an agent could be talked into writing.
    const hostile = '<script'.repeat(40_000);
    const started = Date.now();
    readableText(hostile);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('handles a `<` with no `>` after it', () => {
    expect(readableText('<p>text</p><span class="x')).toBe('text');
  });
});

describe('entities are decoded once', () => {
  test('does not double-unescape `&amp;lt;`', () => {
    // js/double-escaping. A replace chain turns this into `<`, whatever
    // order it runs in, because each call reads the previous call's output.
    // A browser renders the literal text `&lt;`.
    expect(decodeHtmlEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  test('resolves the references that change what a word is', () => {
    expect(decodeHtmlEntities('Sam &amp; Co')).toBe('Sam & Co');
    expect(decodeHtmlEntities('it&rsquo;s')).toBe('it’s');
    expect(decodeHtmlEntities('a&nbsp;b')).toBe('a b');
  });

  test('resolves numeric references in both forms', () => {
    expect(decodeHtmlEntities('&#39;')).toBe("'");
    expect(decodeHtmlEntities('&#x2019;')).toBe('’');
  });

  test('leaves anything it does not recognise exactly as written', () => {
    expect(decodeHtmlEntities('&notareference; &amp')).toBe(
      '&notareference; &amp',
    );
    // Out of range, and a lone surrogate. Neither is a character somebody
    // wrote, and inventing one would be worse than leaving the source alone.
    expect(decodeHtmlEntities('&#x110000;')).toBe('&#x110000;');
    expect(decodeHtmlEntities('&#xD800;')).toBe('&#xD800;');
  });

  test('matches a page against a brief that used the plain character', () => {
    // The reason this is in a gate rather than in a renderer: the client
    // wrote "Sam & Co" in their brief and the built page says `Sam &amp; Co`.
    // A decoder that deleted entities instead of resolving them would make
    // those two texts fail to match, and fail a correct build.
    expect(readableText('<p>Sam &amp; Co</p>')).toBe('Sam & Co');
  });
});

describe('stripTags and stripTagBlocks', () => {
  test('removes tags without touching the text between them', () => {
    // A removed tag leaves a space behind, so two words either side of one
    // never glue into a third word that nobody wrote. Callers collapse.
    expect(
      stripTags('<b>bold</b> and <i>italic</i>').replace(/\s+/g, ' ').trim(),
    ).toBe('bold and italic');
  });

  test('removes several block kinds in one pass, in document order', () => {
    const html = '<style>a{}</style>one<script>b</script>two';
    expect(
      stripTagBlocks(html, ['script', 'style']).replace(/\s+/g, ' ').trim(),
    ).toBe('one two');
  });

  test('does not fall over on a block inside a block', () => {
    const html = '<script>var a = "<style>x</style>";</script><p>only this</p>';
    expect(readableText(html)).toBe('only this');
  });
});
