#!/usr/bin/env node
/**
 * Does every liquid-glass tone still clear AA on its own wash?
 *
 * The tone inks in brand.css are not decorative: a StatTile prints its value in
 * `--fs-tone-T` on a tile whose background is `--fs-tone-T-soft` laid over
 * `--fs-glass-bg` laid over `--fs-bg-base`. That is three alpha composites deep,
 * so no one can eyeball whether the result is readable. This script does the
 * compositing and reports the ratio, for both modes, from the token values
 * themselves rather than from a copy of them.
 *
 * It checks two texts per tone, because both appear on a tinted tile:
 *   - the value, in the tone ink
 *   - the label and note, in `--fs-ink-dim`
 *
 * Run: node packages/flow-design-system/scripts/check-tone-contrast.mjs
 * Exits non-zero if any pair falls under 4.5:1.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AA = 4.5;
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(
  join(here, '..', 'src', 'styles', 'brand.css'),
  'utf8',
);

/** The surfaces a tone wash is laid over, per mode. Taken from brand.css. */
const MODE = {
  light: {
    base: '#fbf7ef',
    glass: 'rgba(255, 255, 255, 0.68)',
    dim: 'rgba(18, 10, 34, 0.62)',
  },
  dark: {
    base: '#040308',
    glass: 'rgba(22, 28, 45, 0.64)',
    dim: 'rgba(244, 238, 228, 0.72)',
  },
};

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

const composite = (fg, bg) =>
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

// ── token extraction ────────────────────────────────────────────────────────

/** Pulls the `--fs-tone-*` declarations out of one marked block of brand.css. */
function tonesFor(mode) {
  const start = css.indexOf(`/* @tone-tokens:${mode} */`);
  if (start < 0) throw new Error(`no @tone-tokens:${mode} marker in brand.css`);
  const end = css.indexOf('/* @tone-tokens:end */', start);
  const block = css.slice(start, end);

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
  const { base, glass, dim } = MODE[mode];
  const glassOverBase = composite(parseColor(glass), parseColor(base));

  for (const [tone, { ink, soft }] of Object.entries(tonesFor(mode))) {
    // The tile: tone wash over the glass over the page.
    const tile = composite(parseColor(soft), glassOverBase);
    const valueRatio = ratio(parseColor(ink), tile);
    const noteRatio = ratio(composite(parseColor(dim), tile), tile);

    if (valueRatio < AA || noteRatio < AA) failed = true;
    rows.push({
      mode,
      tone,
      value: valueRatio.toFixed(2),
      note: noteRatio.toFixed(2),
      ok: valueRatio >= AA && noteRatio >= AA ? 'pass' : 'FAIL',
    });
  }
}

const width = Math.max(...rows.map((r) => r.tone.length));
for (const r of rows) {
  console.log(
    `${r.mode.padEnd(5)}  ${r.tone.padEnd(width)}  value ${r.value.padStart(5)}:1   label/note ${r.note.padStart(5)}:1   ${r.ok}`,
  );
}
console.log(`\n${rows.length} pairs checked against ${AA}:1.`);

if (failed) {
  console.error(
    'Some tone is below AA. Adjust the ink lightness in brand.css.',
  );
  process.exit(1);
}
