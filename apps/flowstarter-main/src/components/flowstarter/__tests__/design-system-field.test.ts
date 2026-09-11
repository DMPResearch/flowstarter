/**
 * The field behind the glass, measured rather than eyeballed.
 *
 * `packages/flow-design-system` has no test runner, so, like the glass
 * components, its stylesheet is exercised from the app that consumes it. The
 * measuring is not reimplemented here: this imports the same parser the two
 * contrast scripts use, so the gradient a check reads and the gradient a test
 * reads cannot drift apart.
 *
 * What is being defended is a rule, not a set of numbers. Darius has asked
 * twice for the background to stop announcing itself, and the second ask was
 * only necessary because the first fix silently did nothing: a variant that
 * overrode `--fs-mesh-1` never changed a pixel, because a custom property
 * containing `var()` is substituted where it is declared. Nothing about that
 * failure was visible in a diff. It is visible here.
 *
 * The rule, in one sentence: every layer of a working surface's field is
 * either a near neighbour of the page's own background tone, or it is painted
 * so faintly that the eye takes it for a temperature rather than a colour.
 */
import { describe, expect, it } from 'vitest';
import {
  blockTokens,
  extremes,
  fieldLayers,
  parseColor,
  readStyles,
  resolve,
  token,
} from '@flowstarter/flow-design-system/field-measure';

/** The surfaces someone works on. Marketing is louder on purpose. */
const WORKING = ['app', 'editor'] as const;
const MODES = ['light', 'dark'] as const;

/** The bar for an accent bloom, set by the brief: under 0.06 where painted. */
const MAX_BLOOM_ALPHA = 0.06;

/**
 * How far a wash may sit from `--fs-bg-base`, in points of HSL lightness.
 *
 * Lightness rather than raw channel distance, because the two modes are not on
 * the same scale: twelve levels of blue is nothing on a 96%-light cream and is
 * most of the colour in a 2%-light near-black. The brief asks for three or four
 * points either way, and both washes land inside that.
 */
const MAX_WASH_LIGHTNESS_DRIFT = 4;

/** A layer with more colour in it than this is a hue, not a surface tone. */
const IS_A_HUE = 0.1;

/** HSL lightness, 0 to 100, of an [r, g, b] triple. */
function lightness([r, g, b]: number[]): number {
  return ((Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255) * 100;
}

function baseFor(mode: string): number[] {
  return parseColor(resolve(token('--fs-bg-base', mode), mode));
}

describe('the field behind the app', () => {
  it.each(MODES)('has no saturated blob on a working surface (%s)', (mode) => {
    const base = lightness(baseFor(mode));

    for (const variant of WORKING) {
      const layers = fieldLayers(mode, variant);
      expect(layers.length).toBeGreaterThan(0);

      for (const layer of layers) {
        if (layer.chroma > IS_A_HUE) {
          // It carries a hue, so it has to be almost invisible.
          expect(layer.peak).toBeLessThan(MAX_BLOOM_ALPHA);
        } else {
          // It is a surface tone, so it may be opaque, but only if it is a
          // neighbour of the page rather than a paint of its own.
          expect(Math.abs(lightness(layer.rgb) - base)).toBeLessThanOrEqual(
            MAX_WASH_LIGHTNESS_DRIFT
          );
        }
      }
    }
  });

  it.each(MODES)(
    'keeps exactly one accent bloom, high and faint (%s)',
    (mode) => {
      for (const variant of WORKING) {
        const blooms = fieldLayers(mode, variant).filter(
          (layer) => layer.chroma > IS_A_HUE
        );
        expect(blooms).toHaveLength(1);
        expect(blooms[0].peak).toBeLessThan(MAX_BLOOM_ALPHA);
      }
    }
  );

  it.each(MODES)('never strays further than its own wash does (%s)', (mode) => {
    const base = baseFor(mode);

    for (const variant of WORKING) {
      const layers = fieldLayers(mode, variant);
      const wash = layers.find((layer) => layer.chroma <= IS_A_HUE);
      expect(wash).toBeDefined();

      const spread = (colour: number[]) =>
        Math.max(
          ...colour.map((c: number, i: number) => Math.abs(c - base[i]))
        );

      // The wash is the loudest thing the field is allowed to be, so the
      // composited page may not land further from the base tone than the wash
      // itself does, give or take what one faint bloom can add. Catches the
      // regression the per-layer checks cannot: four quiet blobs stacking into
      // one loud rectangle.
      const allowance = spread(wash!.rgb) + 6;
      for (const corner of extremes(mode, variant)) {
        expect(spread(corner.rgb)).toBeLessThanOrEqual(allowance);
      }
    }
  });

  it('turns the volume with one dial, in one file', () => {
    // A variant says how loud it is and nothing else. If it needs different
    // colours it has to restate `--fs-mesh`, because of the substitution rule
    // above -- so a colour token on its own in a variant block is dead code
    // that reads like a working override.
    for (const variant of WORKING) {
      const declared = Object.keys(
        blockTokens(`.fs-mesh-backdrop[data-variant='${variant}']`)
      );
      expect(declared).toEqual(['--fs-mesh-opacity']);
    }

    // And the second dimmer that used to live in index.css is gone, so the
    // token is the whole answer rather than half of a product.
    expect(readStyles('index.css')).not.toMatch(
      /\[data-variant='[a-z]+'\]::before/
    );
  });

  it('is still, and dithered rather than grainy', () => {
    const index = readStyles('index.css');
    const backdrop = index.slice(
      index.indexOf('.fs-mesh-backdrop::before'),
      index.indexOf('.fs-mesh-backdrop::after')
    );

    // A surface that is never quite the same twice is a surface you re-read.
    expect(backdrop).not.toMatch(/animation/);

    // Grain at this strength is there to break up banding in a shallow wash,
    // not to be seen.
    for (const mode of MODES) {
      expect(
        parseFloat(token('--fs-mesh-grain-opacity', mode))
      ).toBeLessThanOrEqual(0.015);
    }
  });
});
