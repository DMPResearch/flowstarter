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
 * and it checks each of those on both washes, because a tile wears the whisper
 * `-soft` by default and the much stronger `-emphasis` when it is the one thing
 * on the page that needs acting on.
 *
 * Run: node packages/flow-design-system/scripts/check-tone-contrast.mjs
 * Exits non-zero if any pair falls under 4.5:1.
 */
import {
  AA,
  brandCss as css,
  extremes,
  over,
  parseColor,
  ratio,
  token,
} from './lib/mesh-colour.mjs';

/** Pulls the `--fs-tone-*` declarations out of one marked block of brand.css. */
function tonesFor(mode) {
  const start = css.indexOf(`/* @tone-tokens:${mode} */`);
  if (start < 0) throw new Error(`no @tone-tokens:${mode} marker in brand.css`);
  const block = css.slice(start, css.indexOf('/* @tone-tokens:end */', start));

  // Both washes matter. `-soft` is what nearly every tile wears, `-emphasis`
  // is the loud one, and a tone that only reads on one of them is not safe.
  const KINDS = { '-soft': 'soft', '-emphasis': 'emphasis' };

  const tones = {};
  for (const [, name, value] of block.matchAll(
    /--fs-tone-([a-z-]+)\s*:\s*([^;]+);/g,
  )) {
    const suffix = Object.keys(KINDS).find((k) => name.endsWith(k));
    if (!suffix && name.includes('-')) continue; // -edge and -glow are not text
    const tone = suffix ? name.slice(0, -suffix.length) : name;
    tones[tone] ??= {};
    tones[tone][suffix ? KINDS[suffix] : 'ink'] = value.trim();
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

  for (const [tone, { ink, soft, emphasis }] of Object.entries(
    tonesFor(mode),
  )) {
    let worst = null;

    for (const surface of surfaces) {
      for (const [wash, which] of [
        [soft, 'default'],
        [emphasis, 'emphasis'],
      ]) {
        // tone wash over the glass over the mesh over the page.
        const tile = over(parseColor(wash), over(glass, surface.rgb));
        const value = ratio(parseColor(ink), tile);
        const note = ratio(over(dim, tile), tile);
        const low = Math.min(value, note);
        if (!worst || low < worst.low) {
          worst = { ...surface, value, note, low, which };
        }
      }
    }

    if (worst.low < AA) failed = true;
    rows.push({
      mode,
      tone,
      value: worst.value.toFixed(2),
      note: worst.note.toFixed(2),
      on: worst.name,
      wash: worst.which,
      ok: worst.low >= AA ? 'pass' : 'FAIL',
    });
  }
}

const width = Math.max(...rows.map((r) => r.tone.length));
for (const r of rows) {
  console.log(
    `${r.mode.padEnd(5)}  ${r.tone.padEnd(width)}  value ${r.value.padStart(5)}:1   label/note ${r.note.padStart(5)}:1   worst on the ${r.wash.padEnd(8)} wash where the mesh is ${r.on.padEnd(9)}  ${r.ok}`,
  );
}
console.log(
  `\n${rows.length} tones checked against ${AA}:1, on both washes, each over the brightest and the darkest point of the mesh.`,
);

if (failed) {
  console.error(
    'Some tone is below AA. Adjust the ink lightness in brand.css.',
  );
  process.exit(1);
}
