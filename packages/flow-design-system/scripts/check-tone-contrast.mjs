#!/usr/bin/env node
/**
 * Does every liquid-glass tone still clear AA, anywhere on the mesh?
 *
 * The tone inks in brand.css are not decorative: a StatTile prints its value in
 * `--fs-tone-T` on a tile whose background is `--fs-tone-T-soft` laid over
 * `--fs-glass-bg` laid over the mesh laid over `--fs-bg-base`. That is four
 * alpha composites deep, so no one can eyeball whether the result is readable.
 *
 * The mesh is why this script has to do real work. The glass is only 52%
 * opaque in light mode and 42% in dark, so about half of whatever the mesh is
 * doing shows through the tile, and the mesh is four big saturated blobs that
 * make the page much lighter in some places than others. A single "average
 * background" number would hide the worst corner.
 *
 * So the script evaluates the `--fs-mesh` gradient stack itself: it parses the
 * radial-gradient layers out of the token, samples them across a 1440x900
 * viewport, and takes the lightest and darkest points it finds as the two
 * backdrops every tone has to survive. Nothing here is a guess about where the
 * blobs land — move a blob in brand.css and these numbers move with it.
 *
 * It checks two texts per tone, because both appear on a tinted tile:
 *   - the value, in the tone ink
 *   - the label and note, in `--fs-glass-ink-dim`
 *
 * Run: node packages/flow-design-system/scripts/check-tone-contrast.mjs
 * Exits non-zero if any pair falls under 4.5:1.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AA = 4.5;
const VIEWPORT = { w: 1440, h: 900 };
/** `.fs-mesh-backdrop::before` is inset by this much, so it is oversized. */
const MESH_INSET = -0.2;
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(
  join(here, '..', 'src', 'styles', 'brand.css'),
  'utf8',
);

// ── reading tokens out of the stylesheet ────────────────────────────────────

/**
 * Every declaration of `--name`, in document order. Light mode is the first
 * (it lives in `:root`), dark is the second (in `.dark`); a token declared once
 * is shared by both modes.
 */
function declarations(name) {
  const found = [
    ...css.matchAll(new RegExp(`^\\s*${name}\\s*:\\s*([\\s\\S]*?);`, 'gm')),
  ].map((m) => m[1].trim());
  if (found.length === 0) throw new Error(`no ${name} in brand.css`);
  return found;
}

function token(name, mode) {
  const all = declarations(name);
  return all[mode === 'dark' ? Math.min(1, all.length - 1) : 0];
}

/** Follows one level of `var(--x)`, which is all brand.css uses for the bases. */
function resolve(value, mode) {
  const ref = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  return ref ? token(ref[1], mode) : value;
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
function parseColor(value) {
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
const over = (fg, bg) =>
  [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));

function luminance([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function ratio(a, b) {
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
function extremes(mode) {
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

/** Pulls the `--fs-tone-*` declarations out of one marked block of brand.css. */
function tonesFor(mode) {
  const start = css.indexOf(`/* @tone-tokens:${mode} */`);
  if (start < 0) throw new Error(`no @tone-tokens:${mode} marker in brand.css`);
  const block = css.slice(start, css.indexOf('/* @tone-tokens:end */', start));

  const tones = {};
  for (const [, name, value] of block.matchAll(
    /--fs-tone-([a-z-]+)\s*:\s*([^;]+);/g,
  )) {
    const soft = name.endsWith('-soft');
    if (!soft && name.includes('-')) continue; // -edge and -glow are not text
    const tone = soft ? name.slice(0, -'-soft'.length) : name;
    tones[tone] ??= {};
    tones[tone][soft ? 'soft' : 'ink'] = value.trim();
  }
  return tones;
}

// ── report ──────────────────────────────────────────────────────────────────

let failed = false;
const rows = [];

for (const mode of ['light', 'dark']) {
  const glass = parseColor(token('--fs-glass-bg', mode));
  const dim = parseColor(token('--fs-glass-ink-dim', mode));
  const surfaces = extremes(mode);

  for (const [tone, { ink, soft }] of Object.entries(tonesFor(mode))) {
    let worst = null;

    for (const surface of surfaces) {
      // tone wash over the glass over the mesh over the page.
      const tile = over(parseColor(soft), over(glass, surface.rgb));
      const value = ratio(parseColor(ink), tile);
      const note = ratio(over(dim, tile), tile);
      const low = Math.min(value, note);
      if (!worst || low < worst.low) worst = { ...surface, value, note, low };
    }

    if (worst.low < AA) failed = true;
    rows.push({
      mode,
      tone,
      value: worst.value.toFixed(2),
      note: worst.note.toFixed(2),
      on: worst.name,
      ok: worst.low >= AA ? 'pass' : 'FAIL',
    });
  }
}

const width = Math.max(...rows.map((r) => r.tone.length));
for (const r of rows) {
  console.log(
    `${r.mode.padEnd(5)}  ${r.tone.padEnd(width)}  value ${r.value.padStart(5)}:1   label/note ${r.note.padStart(5)}:1   worst where the mesh is ${r.on.padEnd(9)}  ${r.ok}`,
  );
}
console.log(
  `\n${rows.length} tones checked against ${AA}:1, each over the brightest and the darkest point of the mesh.`,
);

if (failed) {
  console.error(
    'Some tone is below AA. Adjust the ink lightness in brand.css.',
  );
  process.exit(1);
}
