#!/usr/bin/env node
/**
 * Is the marketing copy still readable on the backdrop it would sit on?
 *
 * `check-tone-contrast.mjs` covers the tone inks on a tinted tile. This covers
 * the other, much larger case: the plain body and heading copy on the landing
 * and marketing pages, which has no card under it at all. A paragraph in the
 * middle of a section is `--ls-ink-dim` straight over the backdrop, with
 * nothing in between to guarantee it a contrast ratio.
 *
 * It measures the `landing` variant specifically, not whatever the field
 * declares by default. Marketing currently renders the flat `--fs-bg-base` it
 * was reverted to and mounts no backdrop at all, so the landing variant's own
 * blobs are the loudest thing these inks could ever be asked to sit on: hold
 * the line there and the flat page is covered for free.
 *
 * Two backdrops are checked per ink, the brightest and the darkest point that
 * variant reaches across a 1440x900 viewport, and each ink is checked twice:
 * bare, and again through `--fs-glass-bg`, which is what a paragraph inside a
 * `.ls-card` sits on.
 *
 * The bars are WCAG's, not invented here: 4.5:1 for body copy, and 3:1 for the
 * ink that is only ever used at display sizes (`--ls-accent`, the second line
 * of every headline) or for hairline rules and the small mono eyebrows that
 * repeat their meaning in the heading right under them.
 *
 * Run: node packages/flow-design-system/scripts/check-ink-contrast.mjs
 * Exits non-zero if any ink falls under its bar.
 */
import {
  extremes,
  over,
  parseColor,
  ratio,
  readStyles,
} from './lib/mesh-colour.mjs';
import { token } from './lib/mesh-colour.mjs';

const landingCss = readStyles('landing.css');

/**
 * The marketing inks, and what each one is actually used for. `--ls-*` tokens
 * are declared several times in landing.css (`.ls-theme`, `.ls-scope`, and the
 * `.dark` variant of each), so the light value is the first declaration and the
 * dark value is the first one after the `.dark .ls-theme` block opens.
 */
const INKS = [
  { name: '--ls-ink', bar: 4.5, what: 'headings and quoted copy' },
  { name: '--ls-ink-dim', bar: 4.5, what: 'body and lead paragraphs' },
  { name: '--ls-accent', bar: 3, what: 'the headline flourish, display size' },
  { name: '--ls-ink-faint', bar: 3, what: 'mono eyebrows and hairlines' },
];

/**
 * landing.css declares every `--ls-*` token four times in this order:
 * `.ls-theme`, `.dark .ls-theme`, `.ls-scope`, `.dark .ls-scope`. Light is the
 * first, dark is the second; the `.ls-scope` pair repeats the same values.
 */
function ink(name, mode) {
  const all = [
    ...landingCss.matchAll(new RegExp(`^\\s*${name}\\s*:\\s*([^;]+);`, 'gm')),
  ].map((m) => m[1].trim());
  if (all.length < 2) throw new Error(`no light/dark pair for ${name}`);
  return all[mode === 'dark' ? 1 : 0];
}

/** The `data-variant` the marketing pages would mount. */
const LANDING = 'landing';

let failed = false;
const rows = [];

for (const mode of ['light', 'dark']) {
  const glass = parseColor(token('--fs-glass-bg', mode));
  const surfaces = extremes(mode, LANDING);

  for (const { name, bar, what } of INKS) {
    const fg = parseColor(ink(name, mode));

    let worstMesh = null;
    let worstGlass = null;
    for (const surface of surfaces) {
      const onMesh = ratio(over(fg, surface.rgb), surface.rgb);
      const pane = over(glass, surface.rgb);
      const onGlass = ratio(over(fg, pane), pane);
      if (!worstMesh || onMesh < worstMesh.r)
        worstMesh = { r: onMesh, name: surface.name };
      if (!worstGlass || onGlass < worstGlass.r)
        worstGlass = { r: onGlass, name: surface.name };
    }

    const low = Math.min(worstMesh.r, worstGlass.r);
    if (low < bar) failed = true;
    rows.push({
      mode,
      name,
      what,
      bar,
      mesh: worstMesh.r.toFixed(2),
      glass: worstGlass.r.toFixed(2),
      on: worstMesh.name,
      ok: low >= bar ? 'pass' : 'FAIL',
    });
  }
}

const nameWidth = Math.max(...rows.map((r) => r.name.length));
const whatWidth = Math.max(...rows.map((r) => r.what.length));
for (const r of rows) {
  console.log(
    `${r.mode.padEnd(5)}  ${r.name.padEnd(nameWidth)}  ${r.what.padEnd(whatWidth)}  ` +
      `bare ${r.mesh.padStart(5)}:1   on glass ${r.glass.padStart(5)}:1   ` +
      `needs ${String(r.bar).padStart(3)}:1  ${r.ok}`,
  );
}
console.log(
  `\n${rows.length} inks checked, each over the brightest and the darkest point of the` +
    `\nlanding backdrop, bare and through the glass.`,
);

if (failed) {
  console.error('Some ink is below its bar. Adjust it in landing.css.');
  process.exit(1);
}
