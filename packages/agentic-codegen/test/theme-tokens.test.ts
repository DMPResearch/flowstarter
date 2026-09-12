import { describe, expect, it } from 'vitest';
import { applyPaletteToTokens } from '../src/flowstarter/theme-tokens';
import { cssSkeleton } from '../src/flowstarter/workflows';
import type { BriefPalette } from '../src/flowstarter/types';

/** The shape the design system's own tokens file has, cut to what matters. */
const TOKENS_CSS = `/* Dorin design system tokens */
:root {
  --text-strong: #1a1a1a;
  --text-muted: #666666;
  --brand-primary: #fb8857;
  --accent: #b3b6ff;
  --accent-light: #f5e6d3;
  --surface-brand-glow: rgba(251, 136, 87, 0.16);
  --surface-accent-glow: rgba(179, 182, 255, 0.18);
  --surface-field-border-active: var(--brand-primary);
  --focus-ring-color: rgba(251, 136, 87, 0.28);
}

html.theme-dark {
  --text-strong: #f5f1e8;
  --text-muted: #969084;
  --brand-primary: #ff9d6e;
  --accent: #c9ccff;
  --surface-brand-glow: color-mix(in srgb, var(--brand-primary) 20%, transparent);
}

.card {
  color: var(--text-muted);
}
`;

function palette(): BriefPalette {
  return {
    primary: { base: '#2F5D50', onLight: '#2f5d50', onDark: '#8fd4be' },
    secondary: { base: '#E8DCC8', onLight: '#e8dcc8', onDark: '#3a352c' },
    accent: { base: '#B3541E', onLight: '#b3541e', onDark: '#f0a06a' },
    neutral: { base: '#6B6B6B', onLight: '#5f5f5f', onDark: '#a9a49a' },
    source: 'image',
  };
}

/** Every declared property name, in document order. */
function propertyNames(css: string): string[] {
  return Array.from(css.matchAll(/([\w-]+)\s*:/g), (match) => match[1] ?? '');
}

/** The body of one block, by its selector. */
function blockBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
}

describe('applyPaletteToTokens', () => {
  it('writes each role into the token it owns in :root', () => {
    const result = applyPaletteToTokens(TOKENS_CSS, palette());
    const root = blockBody(result.css, ':root');
    expect(root).toContain('--brand-primary: #2f5d50;');
    expect(root).toContain('--accent: #b3541e;');
    expect(root).toContain('--accent-light: #e8dcc8;');
    expect(root).toContain('--text-muted: #5f5f5f;');
    expect(result.applied).toContain('--brand-primary');
    expect(result.missing).toEqual([]);
  });

  it('uses the dark value inside the dark theme block', () => {
    const result = applyPaletteToTokens(TOKENS_CSS, palette());
    const dark = blockBody(result.css, 'html.theme-dark');
    expect(dark).toContain('--brand-primary: #8fd4be;');
    expect(dark).toContain('--accent: #f0a06a;');
    expect(dark).toContain('--text-muted: #a9a49a;');
    // The light value never leaks across the selector boundary.
    expect(dark).not.toContain('#2f5d50');
  });

  it('keeps the alpha the design system tuned on the glow tokens', () => {
    const result = applyPaletteToTokens(TOKENS_CSS, palette());
    const root = blockBody(result.css, ':root');
    expect(root).toContain('--surface-brand-glow: rgba(47, 93, 80, 0.16);');
    expect(root).toContain('--surface-accent-glow: rgba(179, 84, 30, 0.18);');
    expect(root).toContain('--focus-ring-color: rgba(47, 93, 80, 0.28);');
    // A glow the dark theme computes from the brand var is already correct,
    // so it is left exactly as its author wrote it.
    expect(blockBody(result.css, 'html.theme-dark')).toContain(
      'color-mix(in srgb, var(--brand-primary) 20%, transparent)',
    );
  });

  it('leaves a token the file does not declare alone and reports it', () => {
    const css = TOKENS_CSS.replace('  --accent-light: #f5e6d3;\n', '');
    const result = applyPaletteToTokens(css, palette());
    expect(result.css).not.toContain('--accent-light');
    expect(result.missing).toEqual(['--accent-light']);
    expect(result.applied).toContain('--accent');
  });

  it('touches no token outside the palette roles', () => {
    const result = applyPaletteToTokens(TOKENS_CSS, palette());
    const root = blockBody(result.css, ':root');
    expect(root).toContain('--text-strong: #1a1a1a;');
    expect(root).toContain(
      '--surface-field-border-active: var(--brand-primary);',
    );
    expect(blockBody(result.css, '.card')).toContain(
      'color: var(--text-muted);',
    );
  });

  it('adds no declaration and no selector, which is the integrity invariant', () => {
    const result = applyPaletteToTokens(TOKENS_CSS, palette());
    expect(propertyNames(result.css)).toEqual(propertyNames(TOKENS_CSS));
    // The same check the workspace integrity gate makes on every preview.
    expect(cssSkeleton(result.css)).toBe(cssSkeleton(TOKENS_CSS));
  });

  it('is idempotent', () => {
    const once = applyPaletteToTokens(TOKENS_CSS, palette());
    const twice = applyPaletteToTokens(once.css, palette());
    expect(twice.css).toBe(once.css);
    expect(twice.applied).toEqual(once.applied);
  });

  it('is not fooled by a brace inside a string', () => {
    const css = `.marker::before {\n  content: "{";\n}\n\n:root {\n  --brand-primary: #fb8857;\n}\n`;
    const result = applyPaletteToTokens(css, palette());
    expect(result.css).toContain('--brand-primary: #2f5d50;');
    expect(result.css).toContain('content: "{";');
  });

  it('leaves everything after an unterminated comment alone', () => {
    const css = ':root {\n  /* unterminated\n  --brand-primary: #fb8857;\n}\n';
    const result = applyPaletteToTokens(css, palette());
    expect(result.css).toBe(css);
    expect(result.applied).toEqual([]);
  });

  it('leaves a token alone when the palette has no usable colour for it', () => {
    const broken = {
      ...palette(),
      primary: { base: 'teal', onLight: 'teal', onDark: 'teal' },
    };
    const result = applyPaletteToTokens(TOKENS_CSS, broken);
    expect(result.css).toContain('--brand-primary: #fb8857;');
    expect(result.applied).not.toContain('--brand-primary');
    // The declaration is there, so it is not missing; it is simply refused.
    expect(result.missing).toEqual([]);
    expect(result.applied).toContain('--accent');
  });

  it('finds the tokens through a media query and past a commented-out one', () => {
    const css = `/* --brand-primary: #000000; */
@media (prefers-color-scheme: light) {
  :root {
    --brand-primary: #fb8857;
  }
}
`;
    const result = applyPaletteToTokens(css, palette());
    expect(result.css).toContain('--brand-primary: #2f5d50;');
    expect(result.css).toContain('/* --brand-primary: #000000; */');
  });
});
