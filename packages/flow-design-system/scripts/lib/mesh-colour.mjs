/**
 * What colour is the page, at this point, in this mode?
 *
 * Two scripts need the same answer. `check-tone-contrast.mjs` asks it about
 * tone inks on a tinted tile; `check-ink-contrast.mjs` asks it about plain body
 * copy on the marketing pages, which sit on the bare mesh with no tile under
 * them at all. Both have to composite the same four layers in the same order,
 * and both have to find the same brightest and darkest corners of the gradient,
 * so the maths lives here once instead of drifting in two places.
 *
 * Nothing here is a guess about where the blobs land: the `--fs-mesh` token is
 * parsed out of brand.css and evaluated, so moving a blob moves these numbers.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const AA = 4.5;
export const VIEWPORT = { w: 1440, h: 900 };
/** `.fs-mesh-backdrop::before` is inset by this much, so it is oversized. */
const MESH_INSET = -0.2;

const here = dirname(fileURLToPath(import.meta.url));

export function readStyles(file) {
  return readFileSync(join(here, '..', '..', 'src', 'styles', file), 'utf8');
}

export const brandCss = readStyles('brand.css');

// ── reading tokens out of a stylesheet ──────────────────────────────────────

/**
 * Every declaration of `--name`, in document order. Light mode is the first
 * (it lives in `:root`), dark is the second (in `.dark`); a token declared once
 * is shared by both modes.
 */
export function declarations(name, css = brandCss) {
  const found = [
    ...css.matchAll(new RegExp(`^\\s*${name}\\s*:\\s*([\\s\\S]*?);`, 'gm')),
  ].map((m) => m[1].trim());
  if (found.length === 0) throw new Error(`no ${name} in the stylesheet`);
  return found;
}

export function token(name, mode, css = brandCss) {
  const all = declarations(name, css);
  return all[mode === 'dark' ? Math.min(1, all.length - 1) : 0];
}

/** Follows one level of `var(--x)`, which is all brand.css uses for the bases. */
export function resolve(value, mode, css = brandCss) {
  const ref = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  return ref ? token(ref[1], mode, css) : value;
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

/** Parses `#rrggbb`, `rgba(r, g, b, a)` and `hsl(h, s%, l%[, a])` into [r,g,b,a]. */
export function parseColor(value) {
  const text = value.trim();
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
 */
function meshLayers(mode) {
  // The gradient box is the oversized pseudo-element, not the viewport: `vw`
  // still resolves against the viewport, but a `%` position resolves against
  // the box. Getting this wrong would move every blob by 20% of the screen.
  const box = {
    w: VIEWPORT.w * (1 - 2 * MESH_INSET),
    h: VIEWPORT.h * (1 - 2 * MESH_INSET),
    x: VIEWPORT.w * MESH_INSET,
    y: VIEWPORT.h * MESH_INSET,
  };

  const layers = [...token('--fs-mesh', mode).matchAll(LAYER)].map((m) => ({
    rx: parseFloat(m[1]) * 0.01 * VIEWPORT.w,
    ry: parseFloat(m[2]) * 0.01 * VIEWPORT.w,
    cx: box.x + parseFloat(m[3]) * 0.01 * box.w,
    cy: box.y + parseFloat(m[4]) * 0.01 * box.h,
    color: parseColor(token(m[5], mode)),
    end: parseFloat(m[6]) / 100,
  }));
  if (layers.length === 0) throw new Error('could not parse --fs-mesh');
  return layers;
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

/** The lightest and the darkest the page gets, sampled across the viewport. */
export function extremes(mode) {
  const base = parseColor(resolve(token('--fs-bg-base', mode), mode));
  const layers = meshLayers(mode);

  let lightest = null;
  let darkest = null;
  for (let i = 0; i <= 48; i++) {
    for (let j = 0; j <= 30; j++) {
      const rgb = meshAt(
        layers,
        base,
        (i / 48) * VIEWPORT.w,
        (j / 30) * VIEWPORT.h,
      );
      const l = luminance(rgb);
      if (!lightest || l > lightest.l) lightest = { rgb, l, name: 'brightest' };
      if (!darkest || l < darkest.l) darkest = { rgb, l, name: 'darkest' };
    }
  }
  return [lightest, darkest];
}
