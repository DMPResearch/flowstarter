/**
 * What colour is the page, at this point, in this mode?
 *
 * Two scripts need the same answer. `check-tone-contrast.mjs` asks it about
 * tone inks on a tinted tile; `check-ink-contrast.mjs` asks it about plain body
 * copy on the marketing pages, which sit on the bare field with no tile under
 * them at all. Both have to composite the same layers in the same order, and
 * both have to find the same brightest and darkest corners of it, so the maths
 * lives here once instead of drifting in two places.
 *
 * Nothing here is a guess about where the field lands. The `--fs-mesh` token is
 * parsed out of brand.css and evaluated, the `data-variant` overrides are read
 * from their own blocks, and each surface's `--fs-mesh-opacity` is applied — so
 * a surface is measured as it is painted, not as the default declares it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const AA = 4.5;
export const VIEWPORT = { w: 1440, h: 900 };

const here = dirname(fileURLToPath(import.meta.url));

export function readStyles(file) {
  return readFileSync(join(here, '..', '..', 'src', 'styles', file), 'utf8');
}

export const brandCss = readStyles('brand.css');
const indexCss = readStyles('index.css');

// ── reading tokens out of a stylesheet ──────────────────────────────────────

/**
 * The stylesheet as a flat list of `{ selector, body }`.
 *
 * Which block a declaration sits in is the whole question here, and document
 * order alone cannot answer it: `--fs-mesh` is declared in `:root` and again in
 * the landing variant's block, and reading "the second one" as the dark value
 * would have this whole file measuring marketing's field as if it were the
 * app's. Comments are stripped first so a `{` inside one cannot be mistaken for
 * the start of a block, and an at-rule is unwrapped into the rules it contains.
 */
function rulesOf(css) {
  const rules = [];
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let at = 0;
  while (at < source.length) {
    const open = source.indexOf('{', at);
    if (open < 0) break;
    let depth = 1;
    let end = open + 1;
    while (end < source.length && depth > 0) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') depth -= 1;
      end += 1;
    }
    const selector = source.slice(at, open).trim();
    const body = source.slice(open + 1, end - 1);
    if (selector.startsWith('@')) rules.push(...rulesOf(body));
    else rules.push({ selector, body });
    at = end;
  }
  return rules;
}

const parsed = new Map();
function sheet(css) {
  if (!parsed.has(css)) parsed.set(css, rulesOf(css));
  return parsed.get(css);
}

/**
 * Every declaration of `--name` in the page-level blocks, as `{ mode, value }`.
 * `:root` is the light value and `.dark` the dark one; a token declared only in
 * `:root` is shared by both modes. Variant blocks are deliberately not included
 * — `blockTokens` reads those, because they belong to an element, not a page.
 */
export function declarations(name, css = brandCss) {
  const pattern = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([\\s\\S]*?);`, 'g');
  const found = sheet(css)
    .filter((rule) => rule.selector === ':root' || rule.selector === '.dark')
    .flatMap((rule) =>
      [...rule.body.matchAll(pattern)].map((m) => ({
        mode: rule.selector === '.dark' ? 'dark' : 'light',
        value: m[1].trim(),
      })),
    );
  if (found.length === 0) throw new Error(`no ${name} in the stylesheet`);
  return found;
}

/**
 * One page-level token. `.dark` outranks `:root` on specificity, and within one
 * mode the last declaration wins, so that is the order this reads them in.
 */
export function token(name, mode, css = brandCss) {
  const all = declarations(name, css);
  const forMode = (want) => all.filter((d) => d.mode === want).at(-1);
  const pick = (mode === 'dark' && forMode('dark')) || forMode('light');
  if (!pick) throw new Error(`no ${mode} value for ${name}`);
  return pick.value;
}

/**
 * Follows `var(--x)` down to a literal. The field's dark wash is
 * `var(--fs-bg-raised)`, which is itself `var(--fs-primitive-dark-raised)`, so
 * one hop is no longer enough; the loop guard is there because a typo in the
 * stylesheet should fail loudly rather than hang the check.
 */
export function resolve(value, mode, css = brandCss) {
  let current = value.trim();
  for (let hops = 0; hops < 8; hops++) {
    const ref = current.match(/^var\(\s*(--[\w-]+)\s*\)$/);
    if (!ref) return current;
    current = token(ref[1], mode, css).trim();
  }
  throw new Error(`${value} does not resolve to a literal colour`);
}

/**
 * The custom properties declared inside one selector's block.
 *
 * Used for the `.fs-mesh-backdrop[data-variant='…']` overrides, which is where
 * a surface says how loud its field is. Do not point this at `:root` or
 * `.dark`: those are the page-level pair, and `token()` is the one that knows
 * how they rank against each other.
 */
export function blockTokens(selector, css = brandCss) {
  const body = sheet(css)
    .filter((rule) => rule.selector === selector)
    .map((rule) => rule.body)
    .join('\n');
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([\s\S]*?);/g)].map((m) => [
      m[1],
      m[2].trim(),
    ]),
  );
}

/**
 * One token as the backdrop element actually sees it.
 *
 * Custom properties on `.fs-mesh-backdrop` come from three places: the page
 * (`:root`, then `.dark`), the variant block, and the dark variant block. The
 * later two are rules that match the element itself, so they outrank what it
 * inherits, and `.dark .fs-mesh-backdrop[…]` outranks the undarkened one.
 */
function scoped(name, mode, variant) {
  if (variant) {
    const selector = `.fs-mesh-backdrop[data-variant='${variant}']`;
    const dark = mode === 'dark' ? blockTokens(`.dark ${selector}`) : {};
    const light = blockTokens(selector);
    if (dark[name] !== undefined) return dark[name];
    if (light[name] !== undefined) return light[name];
  }
  return token(name, mode);
}

/**
 * `.fs-mesh-backdrop::before` paints `--fs-mesh` at `--fs-mesh-opacity` and at
 * nothing else, so that token is the whole of how loud a surface is. This
 * guards the assumption rather than trusting it: if someone adds a second
 * multiplier back into the rule, the checks below would quietly start
 * measuring a field brighter than the one on screen.
 */
function assertOneDial() {
  const rule = indexCss.match(/\.fs-mesh-backdrop::before\s*\{([^}]*)\}/);
  if (!rule) throw new Error('no .fs-mesh-backdrop::before rule in index.css');
  if (!/opacity:\s*var\(--fs-mesh-opacity\);/.test(rule[1])) {
    throw new Error(
      '.fs-mesh-backdrop::before no longer paints at plain --fs-mesh-opacity',
    );
  }
  if (/\[data-variant='[a-z]+'\]::before/.test(indexCss)) {
    throw new Error(
      'a variant dims the field in index.css again; it belongs in brand.css',
    );
  }
}

// ── colour maths ────────────────────────────────────────────────────────────

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * Parses `transparent`, `#rrggbb`, `rgba(r, g, b, a)` and `hsl(h, s%, l%[, a])`
 * into [r,g,b,a]. `transparent` is how a variant turns a layer off — the editor
 * keeps the field's wash and drops the accent bloom — and CSS defines it as
 * transparent black, which composites to nothing.
 */
export function parseColor(value) {
  const text = value.trim();
  if (text === 'transparent') return [0, 0, 0, 0];
  if (text.startsWith('#')) {
    return [
      parseInt(text.slice(1, 3), 16),
      parseInt(text.slice(3, 5), 16),
      parseInt(text.slice(5, 7), 16),
      1,
    ];
  }
  const inside = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'));
  const parts = inside.split(/[,/]/).map((p) => parseFloat(p));
  if (text.startsWith('hsl')) {
    return [...hslToRgb(parts[0], parts[1], parts[2]), parts[3] ?? 1];
  }
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

/** Lays `fg` over `bg`. `bg` is opaque by the time it reaches here. */
export const over = (fg, bg) =>
  [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));

export function luminance([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

export function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// ── evaluating the mesh ─────────────────────────────────────────────────────

const LAYER =
  /radial-gradient\(\s*([\d.-]+)vw\s+([\d.-]+)vw\s+at\s+([\d.-]+)%\s+([\d.-]+)%\s*,\s*var\(\s*(--[\w-]+)\s*\)\s*0%\s*,\s*transparent\s+([\d.]+)%\s*\)/g;

/**
 * The `--fs-mesh` stack, as something that can be evaluated at a point. CSS
 * paints the first background layer on top, so the list is kept in that order
 * and composited back to front later.
 *
 * The gradient box is `.fs-mesh-backdrop::before`, which is now `inset: 0` on
 * a fixed full-bleed parent, so it is the viewport: a `%` position and a `vw`
 * length resolve against the same box. It was oversized while the field
 * drifted, and the drift is gone.
 */
function meshLayers(mode, variant) {
  assertOneDial();
  const dial = parseFloat(scoped('--fs-mesh-opacity', mode, variant));

  const layers = [...scoped('--fs-mesh', mode, variant).matchAll(LAYER)].map(
    (m) => {
      const [r, g, b, a] = parseColor(
        resolve(scoped(m[5], mode, variant), mode),
      );
      return {
        rx: parseFloat(m[1]) * 0.01 * VIEWPORT.w,
        ry: parseFloat(m[2]) * 0.01 * VIEWPORT.w,
        cx: parseFloat(m[3]) * 0.01 * VIEWPORT.w,
        cy: parseFloat(m[4]) * 0.01 * VIEWPORT.h,
        // The layer's own alpha, turned down by however loud this surface is.
        color: [r, g, b, a * dial],
        end: parseFloat(m[6]) / 100,
      };
    },
  );
  if (layers.length === 0) throw new Error('could not parse --fs-mesh');
  return layers;
}

/**
 * One entry per layer of a surface's field, with the two numbers worth
 * asserting on.
 *
 * `peak` is the strongest alpha the layer actually paints, which is not the
 * alpha in the token: a radial centred above the viewport has already faded by
 * the time it reaches the first pixel anyone sees, and `--fs-mesh-opacity`
 * scales it again. `chroma` is how far the layer's colour is from grey, so a
 * saturated blob cannot creep back in under a low alpha without being seen.
 */
export function fieldLayers(mode, variant) {
  return meshLayers(mode, variant).map((layer) => {
    const [r, g, b, alpha] = layer.color;
    let peak = 0;
    for (let i = 0; i <= 96; i++) {
      for (let j = 0; j <= 60; j++) {
        const d = Math.hypot(
          ((i / 96) * VIEWPORT.w - layer.cx) / layer.rx,
          ((j / 60) * VIEWPORT.h - layer.cy) / layer.ry,
        );
        peak = Math.max(peak, alpha * (1 - Math.min(1, d / layer.end)));
      }
    }
    return {
      rgb: [r, g, b],
      alpha,
      peak,
      chroma: (Math.max(r, g, b) - Math.min(r, g, b)) / 255,
    };
  });
}

/**
 * The mesh colour at one point, composited onto the page. A radial-gradient
 * from a colour at 0% to `transparent` at E% interpolates in premultiplied
 * alpha, which for these two stops means the hue stays put and the alpha ramps
 * linearly to zero at E% of the gradient ray.
 */
function meshAt(layers, base, x, y) {
  return layers.reduceRight((under, layer) => {
    const d = Math.hypot((x - layer.cx) / layer.rx, (y - layer.cy) / layer.ry);
    const t = Math.min(1, d / layer.end);
    const [r, g, b, a] = layer.color;
    return over([r, g, b, a * (1 - t)], under);
  }, base);
}

/**
 * The lightest and the darkest the page gets, sampled across the viewport.
 *
 * `variant` is the `data-variant` on the backdrop, and it matters: the client
 * dashboard renders `app`, the editor renders `editor`, and each one dims the
 * field differently. Omit it to measure the default the tokens declare.
 */
export function extremes(mode, variant) {
  const base = parseColor(resolve(token('--fs-bg-base', mode), mode));
  const layers = meshLayers(mode, variant);

  const samples = [];
  for (let i = 0; i <= 48; i++) {
    for (let j = 0; j <= 30; j++) {
      const rgb = meshAt(
        layers,
        base,
        (i / 48) * VIEWPORT.w,
        (j / 30) * VIEWPORT.h,
      );
      samples.push({ rgb, l: luminance(rgb) });
    }
  }
  samples.sort((a, b) => a.l - b.l);

  return [
    { ...samples[samples.length - 1], name: 'brightest' },
    { ...samples[0], name: 'darkest' },
  ];
}
