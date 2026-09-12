/**
 * The client's palette written into the stylesheet by a rule, not by a prompt.
 *
 * Today the brand colours reach a site by being described to the preview
 * agent in prose: "update the styleTokenPaths file by changing only the values
 * of existing custom properties". When the agent does that well, the site is
 * on brand. When it does not, `findWorkspaceIntegrityIssue` notices the
 * stylesheet's skeleton changed and reverts the whole file, and the client's
 * own colours are silently lost with it. A palette derived from the client's
 * own photograph deserves better odds than that.
 *
 * So this module does the substitution itself. Its one invariant is the same
 * one the integrity check enforces: **values change, structure does not**. No
 * declaration is added, none is removed, no selector is touched, and the
 * output of `cssSkeleton` before and after is identical.
 *
 * ## Why a scanner and not a regular expression
 *
 * The obvious version is `css.replace(/--brand-primary:[^;]+;/, ...)`, and it
 * is wrong twice over. It cannot tell `:root` from `html.theme-dark`, so it
 * writes the light colour into the dark theme, and it cannot tell a real
 * declaration from the same characters inside a comment, a string or a media
 * query. Custom properties are block-scoped, and a writer that does not know
 * which block it is in has no business writing colours. So the file is walked
 * once: selectors, balanced braces, at-rules recursed into, and declarations
 * rewritten only inside a block whose selector this module recognises.
 */

import type { BriefPalette, BriefPaletteColour } from './types';

/**
 * Which template token each palette role owns.
 *
 * The names are real, taken from `templates/shared/dorin-ds/tokens.css` and
 * the per-template `src/styles/global.css` copies. Deliberately short: the
 * surface and text tokens are the design system's own contrast ladder and a
 * brand colour dropped into them is how a site becomes unreadable. `neutral`
 * reaches exactly one of them, `--text-muted`, which is the one token whose
 * job is to be quieter than the body text rather than to sit under it.
 */
export const TOKEN_BY_ROLE: Readonly<Record<string, readonly string[]>> = {
  primary: ['--brand-primary', '--surface-brand-glow', '--focus-ring-color'],
  secondary: ['--accent-light'],
  accent: ['--accent', '--surface-accent-glow'],
  neutral: ['--text-muted'],
};

/**
 * Tokens that carry a translucent wash of their role rather than the colour
 * itself. Their alpha is a design decision made by whoever tuned the glow, so
 * the writer keeps the existing alpha and changes only the channels.
 */
const ALPHA_TOKENS: ReadonlySet<string> = new Set([
  '--surface-brand-glow',
  '--surface-accent-glow',
  '--focus-ring-color',
]);

/** `rgba(r, g, b, a)` exactly; anything else is left for its author to own. */
const RGBA = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)$/i;

/** Six-digit hex, the only form a validated brief palette carries. */
const HEX = /^#[0-9a-fA-F]{6}$/;

/** The dark theme, scoped exactly as the design system scopes it. */
const DARK_SELECTOR = /html\.theme-dark\b/;

export interface ApplyPaletteResult {
  css: string;
  /** Tokens actually rewritten, for the job log. */
  applied: string[];
  /** Tokens the palette had a value for but the file does not declare. */
  missing: string[];
}

type ThemeMode = 'light' | 'dark';

/** `[\w-]`: what a CSS property name is made of. */
function isPropertyNameCharacter(char: string | undefined): boolean {
  if (char === undefined) return false;
  return (
    char === '-' ||
    char === '_' ||
    (char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    (char >= '0' && char <= '9')
  );
}

/**
 * Which theme a block writes, or null when this module has no opinion about
 * it.
 *
 * The comma list is split, so `:root` is recognised whether it stands alone
 * or sits in a group. It is compared whole: `:root[data-theme='high-contrast']`
 * is somebody else's block and this module leaves it alone.
 */
function selectorMode(selector: string): ThemeMode | null {
  const parts = selector.split(',').map((part) => part.trim());
  if (parts.some((part) => DARK_SELECTOR.test(part))) return 'dark';
  if (parts.some((part) => part === ':root')) return 'light';
  return null;
}

/** The channels of a six-digit hex, or null when it is not one. */
function channels(hex: string): [number, number, number] | null {
  if (!HEX.test(hex)) return null;
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * The value this token should carry, or null to leave the declaration exactly
 * as it is.
 *
 * A glow token is rewritten only when it already holds an `rgba()`. The dark
 * theme writes its glows as `color-mix(in srgb, var(--brand-primary) 20%,
 * transparent)`, which already follows the brand colour; replacing that with a
 * flat rgba would freeze a value the design system deliberately computes.
 */
function nextValue(
  token: string,
  current: string,
  colour: string,
): string | null {
  const rgb = channels(colour);
  if (!rgb) return null;
  if (!ALPHA_TOKENS.has(token)) return colour;
  const alpha = RGBA.exec(current.trim())?.[1];
  if (alpha === undefined) return null;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/** The colour a role contributes to one theme. */
function colourFor(colour: BriefPaletteColour, mode: ThemeMode): string {
  return mode === 'light' ? colour.onLight : colour.onDark;
}

/** Token to colour, for one theme, from the palette the brief carries. */
function paletteTokens(
  palette: BriefPalette,
  mode: ThemeMode,
): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [role, names] of Object.entries(TOKEN_BY_ROLE)) {
    const colour = (palette as unknown as Record<string, BriefPaletteColour>)[
      role
    ];
    if (!colour) continue;
    for (const name of names) tokens.set(name, colourFor(colour, mode));
  }
  return tokens;
}

/** Every token the palette has an opinion about, in role order. */
function allTokens(): string[] {
  return Object.values(TOKEN_BY_ROLE).flat();
}

/**
 * The index just past a comment or a quoted string starting here, or -1 when
 * nothing starts here.
 *
 * Both scanners below need this for the same reason: a `{` inside
 * `/* ... *\/` or inside `content: "{"` is not a block, and a
 * `--brand-primary: #fff;` inside a comment is not a declaration. An
 * unterminated comment or string swallows the rest of the file, which is the
 * safe reading: nothing after it is rewritten.
 */
function skipNoise(css: string, index: number): number {
  if (css[index] === '/' && css[index + 1] === '*') {
    const end = css.indexOf('*/', index + 2);
    return end < 0 ? css.length : end + 2;
  }
  const quote = css[index];
  if (quote !== '"' && quote !== "'") return -1;
  let cursor = index + 1;
  while (cursor < css.length) {
    const char = css[cursor];
    if (char === '\\') {
      cursor += 2;
      continue;
    }
    if (char === quote) return cursor + 1;
    if (char === '\n') return cursor;
    cursor += 1;
  }
  return css.length;
}

interface Walk {
  applied: Set<string>;
  declared: Set<string>;
  palette: BriefPalette;
}

/**
 * Declarations inside one block's body, rewritten in place.
 *
 * The body arrives without its braces, so every `name: value` run in it is a
 * declaration of this block. The scan is the same shape as the one in
 * `collapseDeclarationValues`: take the whole name run, expect a colon, take
 * everything up to the first `;`, and give up on the declaration the moment a
 * brace appears where a value should be.
 */
function rewriteDeclarations(
  body: string,
  tokens: ReadonlyMap<string, string>,
  walk: Walk,
): string {
  let out = '';
  let kept = 0;
  let index = 0;
  while (index < body.length) {
    const noise = skipNoise(body, index);
    if (noise >= 0) {
      index = noise;
      continue;
    }
    if (!isPropertyNameCharacter(body[index])) {
      index += 1;
      continue;
    }
    let nameEnd = index;
    while (isPropertyNameCharacter(body[nameEnd])) nameEnd += 1;
    const name = body.slice(index, nameEnd);

    let cursor = nameEnd;
    while (cursor < body.length && /\s/.test(body[cursor] as string))
      cursor += 1;
    if (body[cursor] !== ':') {
      index = nameEnd;
      continue;
    }
    const valueStart = cursor + 1;
    cursor = valueStart;
    while (
      cursor < body.length &&
      body[cursor] !== ';' &&
      body[cursor] !== '{' &&
      body[cursor] !== '}'
    ) {
      cursor += 1;
    }
    if (body[cursor] === '{' || body[cursor] === '}') {
      index = nameEnd;
      continue;
    }
    // A declaration that ends at the end of the body has no semicolon, and
    // that is still a declaration: `:root { --a: #fff }` is valid CSS.
    const valueEnd = cursor;
    const current = body.slice(valueStart, valueEnd);

    const colour = tokens.get(name);
    if (colour !== undefined) {
      walk.declared.add(name);
      const replacement = nextValue(name, current, colour);
      if (replacement !== null) {
        // The single space keeps the file formatted the way Prettier writes
        // it; the value itself never contains a brace, a colon or a
        // semicolon, so the skeleton cannot move.
        out += `${body.slice(kept, valueStart)} ${replacement}`;
        kept = valueEnd;
        walk.applied.add(name);
      }
    }
    index = valueEnd;
  }
  return out + body.slice(kept);
}

/** The end of the block that opens at `open`, by brace counting. */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < css.length) {
    const noise = skipNoise(css, index);
    if (noise >= 0) {
      index = noise;
      continue;
    }
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return css.length;
}

/** The next block opener at this level, comments and strings stepped over. */
function nextBlockOpen(css: string, from: number): number {
  let index = from;
  while (index < css.length) {
    const noise = skipNoise(css, index);
    if (noise >= 0) {
      index = noise;
      continue;
    }
    if (css[index] === '{') return index;
    index += 1;
  }
  return -1;
}

/**
 * One stylesheet level: the text between blocks is untouched, an at-rule is
 * recursed into so a `@media` wrapper does not hide the `:root` inside it, and
 * a theme block has its declarations rewritten.
 */
function rewriteStylesheet(css: string, walk: Walk): string {
  let out = '';
  let cursor = 0;
  while (cursor < css.length) {
    const open = nextBlockOpen(css, cursor);
    if (open < 0) {
      out += css.slice(cursor);
      break;
    }
    const close = blockEnd(css, open);
    const selector = css.slice(cursor, open);
    const body = css.slice(open + 1, close);

    out += selector + '{';
    // The selector text is everything since the last block closed, so it
    // carries the comment above the rule and the blank line before it. Both
    // go before anything is decided from it.
    const cleaned = selector.replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
    const mode = selectorMode(cleaned);
    if (cleaned.startsWith('@')) {
      out += rewriteStylesheet(body, walk);
    } else if (mode) {
      out += rewriteDeclarations(body, paletteTokens(walk.palette, mode), walk);
    } else {
      out += body;
    }
    out += close < css.length ? '}' : '';
    cursor = close + 1;
  }
  return out;
}

/**
 * The palette, written into the stylesheet's existing tokens.
 *
 * `missing` names a token the palette has a colour for that the file declares
 * in no theme block at all. A token the light theme declares and the dark
 * theme deliberately leaves alone is not missing: inheriting the brand colour
 * into dark mode is how the design system is built, and reporting it would
 * make the log noise rather than information.
 */
export function applyPaletteToTokens(
  css: string,
  palette: BriefPalette,
): ApplyPaletteResult {
  const walk: Walk = { applied: new Set(), declared: new Set(), palette };
  const rewritten = rewriteStylesheet(css, walk);
  const missing = allTokens().filter((token) => !walk.declared.has(token));
  return {
    css: rewritten,
    applied: allTokens().filter((token) => walk.applied.has(token)),
    missing,
  };
}
