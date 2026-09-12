/**
 * The layout, not the copy.
 *
 * Everything asserted here is a thing no reviewer can see by reading the
 * markup and no test elsewhere would catch: that the document is the shape a
 * mail client needs, that the dark variant is still legible, and that a value
 * from a stranger cannot get out of the text node it was put in.
 */
import { describe, expect, it } from 'vitest';
import {
  EMAIL_COLORS,
  escapeHtml,
  renderEmail,
  safeHref,
  type Block,
} from '../base';

const SAMPLE: Block[] = [
  { kind: 'heading', text: 'A heading' },
  { kind: 'paragraph', content: 'A paragraph.' },
  {
    kind: 'paragraph',
    content: [
      'With ',
      { strong: 'emphasis' },
      ' and ',
      { link: { href: 'https://example.com', label: 'a link' } },
      '.',
    ],
  },
  { kind: 'callout', title: 'An aside', content: 'Worth knowing.' },
  { kind: 'quote', text: 'Their own words.' },
  { kind: 'facts', rows: [{ label: 'Who', value: 'Ana' }] },
  { kind: 'panel', rows: [{ label: 'Code', value: '418209' }] },
  { kind: 'hero', href: 'https://acme.example' },
  { kind: 'button', label: 'Do the thing', href: 'https://acme.example/go' },
  { kind: 'note', content: 'Small print.' },
];

const mail = renderEmail({
  subject: 'A subject',
  preheader: 'The line under the subject',
  blocks: SAMPLE,
});

/** WCAG relative luminance, so the dark variant is a measurement not a hope. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('the email document', () => {
  it('is a full HTML document a mail client can parse', () => {
    expect(mail.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(mail.html).toContain('<meta charset="utf-8" />');
    expect(mail.html).toContain('<title>A subject</title>');
    expect(mail.html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('declares both colour schemes and ships a dark variant', () => {
    expect(mail.html).toContain('name="color-scheme" content="light dark"');
    expect(mail.html).toContain(
      'name="supported-color-schemes" content="light dark"'
    );
    expect(mail.html).toContain('@media (prefers-color-scheme: dark)');
    expect(mail.html).toContain(EMAIL_COLORS.dark.page);
  });

  it('is a 600px table shell, not a stylesheet layout', () => {
    expect(mail.html).toContain('width="600"');
    expect(mail.html).toContain('max-width:600px');
    expect(mail.html).toContain('role="presentation"');
    expect(mail.html).not.toContain('display:flex');
    expect(mail.html).not.toContain('display:grid');
  });

  it('carries the preheader once, hidden', () => {
    expect(mail.preheader).toBe('The line under the subject');
    expect(mail.html).toContain('The line under the subject');
    expect(mail.html).toContain('display:none;max-height:0');
  });

  it('shows the wordmark as an HTML mark tile with live text beside it, no remote image', () => {
    expect(mail.html).toContain('class="fs-mark"');
    expect(mail.html).toContain('>Flow</span>starter');
    // No EMAIL_ASSET_BASE_URL is set, so nothing depends on an asset this
    // deployment cannot prove is reachable: no <img> at all.
    expect(mail.html).not.toContain('<img');
    expect(mail.html).not.toContain('flowstarter.net/email');
  });

  it('falls back to the PNG only when EMAIL_ASSET_BASE_URL is explicitly set', () => {
    const previous = process.env.EMAIL_ASSET_BASE_URL;
    process.env.EMAIL_ASSET_BASE_URL = 'https://assets.example.com';
    try {
      const withAsset = renderEmail({
        subject: 'A subject',
        preheader: 'The line under the subject',
        blocks: SAMPLE,
      });
      expect(withAsset.html).toContain(
        'https://assets.example.com/email/flowstarter-mark.png'
      );
      expect(withAsset.html.match(/<img/g) ?? []).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.EMAIL_ASSET_BASE_URL;
      else process.env.EMAIL_ASSET_BASE_URL = previous;
    }
  });

  it('draws the button twice so Outlook gets a real box', () => {
    expect(mail.html).toContain('v:roundrect');
    expect(mail.html).toContain('<!--[if mso]>');
    expect(mail.html).toContain('<!--[if !mso]><!-->');
    expect(mail.html).toContain('xmlns:v="urn:schemas-microsoft-com:vml"');
    expect(mail.html).toContain('href="https://acme.example/go"');
  });

  it('names the sender and why there is no unsubscribe, and invents no address', () => {
    expect(mail.html).not.toContain('Cluj');
    expect(mail.text).not.toContain('Cluj');
    expect(mail.html).toContain('hello@flowstarter.net');
    expect(mail.html).toContain('nothing to unsubscribe from');
    expect(mail.text).toContain('nothing to unsubscribe from');
  });

  it('stays far under the 100 KB clipping limit', () => {
    // Gmail clips a message over about 102 KB and hides the rest behind
    // "view entire message", which would hide the button.
    expect(Buffer.byteLength(mail.html, 'utf8')).toBeLessThan(100 * 1024);
  });
});

describe('the plain-text alternative', () => {
  it('is generated from the same blocks, so it carries every fact', () => {
    expect(mail.text).toContain('A heading');
    expect(mail.text).toContain(
      'With emphasis and a link: https://example.com'
    );
    expect(mail.text).toContain('An aside Worth knowing.');
    expect(mail.text).toContain('Their own words.');
    expect(mail.text).toContain('Who: Ana');
    expect(mail.text).toContain('Code: 418209');
    expect(mail.text).toContain('Do the thing: https://acme.example/go');
    expect(mail.text).toContain('Small print.');
  });

  it('carries no markup', () => {
    expect(mail.text).not.toMatch(/<[a-z/]/i);
  });
});

describe('dark mode contrast', () => {
  const pairs: Array<[string, string, string]> = [
    ['light body text', EMAIL_COLORS.light.ink, EMAIL_COLORS.light.card],
    ['light muted text', EMAIL_COLORS.light.inkDim, EMAIL_COLORS.light.card],
    ['light muted on page', EMAIL_COLORS.light.inkDim, EMAIL_COLORS.light.page],
    ['light link', EMAIL_COLORS.light.accent, EMAIL_COLORS.light.card],
    [
      'light button label',
      EMAIL_COLORS.light.accentInk,
      EMAIL_COLORS.light.accent,
    ],
    ['dark body text', EMAIL_COLORS.dark.ink, EMAIL_COLORS.dark.card],
    ['dark muted text', EMAIL_COLORS.dark.inkDim, EMAIL_COLORS.dark.card],
    ['dark muted on page', EMAIL_COLORS.dark.inkDim, EMAIL_COLORS.dark.page],
    ['dark link', EMAIL_COLORS.dark.accent, EMAIL_COLORS.dark.card],
    [
      'dark button label',
      EMAIL_COLORS.dark.accentInk,
      EMAIL_COLORS.dark.button,
    ],
  ];

  it.each(pairs)('%s clears AA', (_name, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('escaping', () => {
  it('neutralises a value that is trying to be markup', () => {
    expect(escapeHtml('<script>&"\'')).toBe('&lt;script&gt;&amp;&quot;&#39;');
  });

  it('escapes every place a caller can put a string', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const nasty = renderEmail({
      subject: hostile,
      preheader: hostile,
      blocks: [
        { kind: 'heading', text: hostile },
        { kind: 'paragraph', content: hostile },
        { kind: 'paragraph', content: [{ strong: hostile }] },
        { kind: 'paragraph', content: [{ mono: hostile }] },
        { kind: 'note', content: hostile },
        { kind: 'quote', text: hostile },
        { kind: 'facts', rows: [{ label: hostile, value: hostile }] },
        { kind: 'panel', rows: [{ label: hostile, value: hostile }] },
        { kind: 'callout', title: hostile, content: hostile },
        { kind: 'button', label: hostile, href: 'https://x.example' },
        { kind: 'hero', href: 'https://x.example', label: hostile },
      ],
    });
    // No real `<img` at all: the wordmark is an HTML mark tile by default.
    expect(nasty.html.match(/<img/g) ?? []).toHaveLength(0);
    expect(nasty.html).toContain('&lt;img src=x');
  });

  it('refuses an href that is not a link', () => {
    expect(safeHref('javascript:alert(1)')).toBe('#');
    expect(safeHref('data:text/html,<script>')).toBe('#');
    expect(safeHref(' https://ok.example ')).toBe('https://ok.example');
    expect(safeHref('mailto:hello@flowstarter.net')).toBe(
      'mailto:hello@flowstarter.net'
    );
    // One caller sends a root-relative path on purpose; a protocol-relative
    // host is not one.
    expect(safeHref('/login')).toBe('/login');
    expect(safeHref('//evil.example/login')).toBe('#');
  });
});
