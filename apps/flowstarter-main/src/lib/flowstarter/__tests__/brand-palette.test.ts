import { describe, expect, it } from 'vitest';

import {
  AA_CONTRAST,
  type Bitmap,
  DEFAULT_BACKGROUNDS,
  DEFAULT_PALETTE,
  adjustForContrast,
  chooseRoles,
  contrastRatio,
  derivePalette,
  enforceContrast,
  hexToRgb,
  hslToRgb,
  legibleOn,
  paletteFromTone,
  paletteSwatches,
  quantise,
  relativeLuminance,
  rgbToHex,
  rgbToHsl,
  sampleBitmap,
  swatchesFromBitmaps,
} from '../brand-palette';

/**
 * Builds an RGBA bitmap from a row-major list of colours, so a test can say
 * "half of this picture is brand red" without a fixture file.
 */
function bitmapOf(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number]
): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const at = (y * width + x) * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = a;
    }
  }
  return { width, height, data };
}

const RED: [number, number, number, number] = [200, 30, 24, 255];
const TEAL: [number, number, number, number] = [22, 120, 128, 255];
const GREY: [number, number, number, number] = [128, 128, 130, 255];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];

describe('colour arithmetic', () => {
  it('round-trips hex and rgb', () => {
    expect(hexToRgb('#c81e18')).toEqual({ r: 200, g: 30, b: 24 });
    expect(rgbToHex({ r: 200, g: 30, b: 24 })).toBe('#c81e18');
  });

  it('accepts short hex and a missing hash', () => {
    expect(hexToRgb('#f00')).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb('0f0')).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('returns null for a colour that is not one', () => {
    expect(hexToRgb('rebeccapurple')).toBeNull();
    expect(hexToRgb('#12345')).toBeNull();
    expect(hexToRgb('')).toBeNull();
  });

  it('clamps out-of-range channels rather than emitting bad hex', () => {
    expect(rgbToHex({ r: 300, g: -20, b: 12 })).toBe('#ff000c');
  });

  it('round-trips through hsl within a rounding step', () => {
    for (const hex of ['#c81e18', '#167880', '#808082', '#ffffff', '#000000']) {
      const rgb = hexToRgb(hex);
      expect(rgb).not.toBeNull();
      const back = hslToRgb(rgbToHsl(rgb!));
      expect(Math.abs(back.r - rgb!.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb!.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb!.b)).toBeLessThanOrEqual(1);
    }
  });

  it('reads a grey as having no hue and no saturation', () => {
    expect(rgbToHsl({ r: 128, g: 128, b: 128 })).toMatchObject({ h: 0, s: 0 });
  });

  it('puts each primary in its own hue sector', () => {
    expect(Math.round(rgbToHsl({ r: 255, g: 0, b: 0 }).h)).toBe(0);
    expect(Math.round(rgbToHsl({ r: 0, g: 255, b: 0 }).h)).toBe(120);
    expect(Math.round(rgbToHsl({ r: 0, g: 0, b: 255 }).h)).toBe(240);
  });

  it('matches the WCAG reference contrast for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('treats an unparseable colour as failing everything', () => {
    expect(contrastRatio('not a colour', '#ffffff')).toBe(1);
  });

  it('gives white the maximum relative luminance', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
  });
});

describe('sampling', () => {
  it('takes every pixel of a small bitmap', () => {
    const samples = sampleBitmap(bitmapOf(4, 4, () => RED));
    expect(samples).toHaveLength(16);
  });

  it('strides a large bitmap down to the sampling grid', () => {
    const samples = sampleBitmap(bitmapOf(640, 640, () => RED));
    // 640 / ceil(640/64) = 64 across, 64 down.
    expect(samples).toHaveLength(64 * 64);
  });

  it('skips transparent padding', () => {
    const bitmap = bitmapOf(4, 4, (x) => (x < 2 ? RED : [0, 0, 0, 0]));
    expect(sampleBitmap(bitmap)).toHaveLength(8);
  });

  it('returns nothing for an empty bitmap', () => {
    expect(sampleBitmap({ width: 0, height: 0, data: [] })).toEqual([]);
  });

  it('ignores a truncated buffer rather than reading past its end', () => {
    expect(sampleBitmap({ width: 4, height: 4, data: [1, 2, 3] })).toEqual([]);
  });
});

describe('quantise', () => {
  it('returns nothing for no samples', () => {
    expect(quantise([])).toEqual([]);
  });

  it('orders swatches by weight', () => {
    const bitmap = bitmapOf(8, 8, (x) => (x < 6 ? RED : TEAL));
    const swatches = quantise(sampleBitmap(bitmap));
    expect(swatches[0]?.weight).toBeGreaterThan(swatches[1]?.weight ?? 1);
    expect(swatches[0]?.hex).toBe('#c81e18');
  });

  it('drops a bucket below the noise floor', () => {
    // One teal pixel in 400 is 0.25%, under MIN_SWATCH_WEIGHT of 0.5%.
    const bitmap = bitmapOf(20, 20, (x, y) =>
      x === 0 && y === 0 ? TEAL : RED
    );
    const swatches = quantise(sampleBitmap(bitmap));
    expect(swatches.map((s) => s.hex)).toEqual(['#c81e18']);
  });

  it('is deterministic: the same picture gives byte-identical swatches', () => {
    const bitmap = bitmapOf(96, 96, (x, y) => {
      if ((x + y) % 7 === 0) return TEAL;
      if (x % 3 === 0) return GREY;
      return RED;
    });
    const first = swatchesFromBitmaps([bitmap]);
    const second = swatchesFromBitmaps([bitmap]);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(1);
  });

  it('does not depend on which corner the sampler started in', () => {
    // The same two colours in two arrangements produce the same swatch set,
    // because ties break on bucket index and never on insertion order.
    const leftHeavy = bitmapOf(16, 16, (x) => (x < 8 ? RED : TEAL));
    const rightHeavy = bitmapOf(16, 16, (x) => (x < 8 ? TEAL : RED));
    const a = [...swatchesFromBitmaps([leftHeavy])].map((s) => s.hex).sort();
    const b = [...swatchesFromBitmaps([rightHeavy])].map((s) => s.hex).sort();
    expect(a).toEqual(b);
  });

  it('reports the mean of a bucket, not its centre', () => {
    // Both land in bucket (12, 1, 1) at 16 levels per channel, so they merge
    // and the swatch is their average rather than the bucket's midpoint.
    const swatches = quantise([
      { r: 200, g: 30, b: 24 },
      { r: 202, g: 28, b: 26 },
    ]);
    expect(swatches).toHaveLength(1);
    expect(swatches[0]?.hex).toBe('#c91d19');
  });

  it('splits two colours that fall either side of a bucket edge', () => {
    // g=30 is in bucket 1 and g=32 is in bucket 2, so these stay apart. The
    // tie in weight breaks on bucket index, never on insertion order.
    const swatches = quantise([
      { r: 202, g: 32, b: 26 },
      { r: 200, g: 30, b: 24 },
    ]);
    expect(swatches.map((swatch) => swatch.hex)).toEqual([
      '#c81e18',
      '#ca201a',
    ]);
  });

  it('pools samples across several pictures', () => {
    const red = bitmapOf(8, 8, () => RED);
    const teal = bitmapOf(8, 8, () => TEAL);
    const hexes = swatchesFromBitmaps([red, teal]).map((s) => s.hex);
    expect(hexes).toHaveLength(2);
    expect(hexes).toContain('#c81e18');
  });
});

describe('chooseRoles', () => {
  it('returns null when the picture has no colour in it', () => {
    const swatches = swatchesFromBitmaps([bitmapOf(8, 8, () => WHITE)]);
    expect(chooseRoles(swatches)).toBeNull();
  });

  it('makes the heaviest colour the primary', () => {
    const bitmap = bitmapOf(16, 16, (x) => (x < 12 ? RED : TEAL));
    const roles = chooseRoles(swatchesFromBitmaps([bitmap]));
    expect(roles?.primary).toBe('#c81e18');
  });

  it('picks a secondary far enough away in hue to read as another colour', () => {
    const bitmap = bitmapOf(16, 16, (x) => (x < 12 ? RED : TEAL));
    const roles = chooseRoles(swatchesFromBitmaps([bitmap]));
    expect(roles?.secondary).toBe('#167880');
  });

  it('rotates the primary when nothing is far enough away', () => {
    const nearRed: [number, number, number, number] = [206, 40, 30, 255];
    const bitmap = bitmapOf(16, 16, (x) => (x < 12 ? RED : nearRed));
    const roles = chooseRoles(swatchesFromBitmaps([bitmap]));
    expect(roles?.secondary).not.toBe(roles?.primary);
  });

  it('derives a neutral from the primary when the picture has no grey', () => {
    const bitmap = bitmapOf(16, 16, (x) => (x < 12 ? RED : TEAL));
    const roles = chooseRoles(swatchesFromBitmaps([bitmap]));
    const neutral = hexToRgb(roles!.neutral);
    expect(rgbToHsl(neutral!).s).toBeLessThan(0.18);
  });

  it('prefers a real grey when the picture has one', () => {
    const bitmap = bitmapOf(24, 24, (x) => {
      if (x < 10) return RED;
      if (x < 18) return TEAL;
      return GREY;
    });
    const roles = chooseRoles(swatchesFromBitmaps([bitmap]));
    expect(roles?.neutral).toBe('#808082');
  });

  it('makes the most saturated colour the accent', () => {
    const muted: [number, number, number, number] = [120, 110, 100, 255];
    const bitmap = bitmapOf(24, 24, (x) => (x < 18 ? muted : RED));
    const roles = chooseRoles(swatchesFromBitmaps([bitmap]));
    expect(roles?.accent).toBe('#c81e18');
  });
});

describe('contrast adjustment', () => {
  it('leaves a colour that already clears AA alone', () => {
    // #595959 is 7.0:1 on white. The walk must not touch a passing colour:
    // moving one is a change the visitor can see and the rule cannot justify.
    expect(contrastRatio('#595959', '#ffffff')).toBeGreaterThanOrEqual(
      AA_CONTRAST
    );
    expect(adjustForContrast('#595959', '#ffffff')).toBeNull();
  });

  it('darkens a colour too pale for the light background', () => {
    const moved = adjustForContrast('#ffe9a8', '#ffffff');
    expect(moved).not.toBeNull();
    expect(contrastRatio(moved!.hex, '#ffffff')).toBeGreaterThanOrEqual(
      AA_CONTRAST
    );
    expect(rgbToHsl(hexToRgb(moved!.hex)!).l).toBeLessThan(
      rgbToHsl(hexToRgb('#ffe9a8')!).l
    );
  });

  it('lightens a colour too dark for the dark background', () => {
    const moved = adjustForContrast('#101018', '#0d0b16');
    expect(moved).not.toBeNull();
    expect(contrastRatio(moved!.hex, '#0d0b16')).toBeGreaterThanOrEqual(
      AA_CONTRAST
    );
    expect(rgbToHsl(hexToRgb(moved!.hex)!).l).toBeGreaterThan(
      rgbToHsl(hexToRgb('#101018')!).l
    );
  });

  it('keeps the hue while it walks', () => {
    const from = '#ffe9a8';
    const moved = adjustForContrast(from, '#ffffff');
    const before = rgbToHsl(hexToRgb(from)!).h;
    const after = rgbToHsl(hexToRgb(moved!.hex)!).h;
    expect(Math.abs(after - before)).toBeLessThan(4);
  });

  it('reports the ratio it started from and the one it reached', () => {
    const moved = adjustForContrast('#ffe9a8', '#ffffff');
    expect(moved!.ratioAfter).toBeGreaterThan(moved!.ratioBefore);
    expect(moved!.ratioAfter).toBeGreaterThanOrEqual(AA_CONTRAST);
  });

  it('returns null for a colour it cannot parse', () => {
    expect(adjustForContrast('teal-ish', '#ffffff')).toBeNull();
    expect(adjustForContrast('#ffe9a8', 'not a background')).toBeNull();
  });

  it('legibleOn hands back the colour itself when it already passes', () => {
    expect(legibleOn('#595959', '#ffffff')).toBe('#595959');
    expect(legibleOn('#ffe9a8', '#ffffff')).not.toBe('#ffe9a8');
  });

  it('keeps the base colour and moves only the page values', () => {
    const { colours, adjustments } = enforceContrast(
      {
        primary: '#ffe9a8',
        secondary: '#fff4d0',
        accent: '#2f3a8c',
        neutral: '#6b6f7a',
      },
      DEFAULT_BACKGROUNDS
    );
    expect(colours.primary.base).toBe('#ffe9a8');
    expect(colours.primary.onLight).not.toBe('#ffe9a8');
    // A pale yellow is already legible on a near-black page, so the dark value
    // is the colour itself.
    expect(colours.primary.onDark).toBe('#ffe9a8');
    expect(
      adjustments.some(
        (entry) => entry.role === 'primary' && entry.mode === 'light'
      )
    ).toBe(true);
    for (const entry of adjustments) {
      expect(entry.from).not.toBe(entry.to);
      expect(entry.ratioAfter).toBeGreaterThan(entry.ratioBefore);
    }
  });

  it('records nothing when every role passes on both pages', () => {
    const base = {
      primary: '#595959',
      secondary: '#5a5a5a',
      accent: '#5b5b5b',
      neutral: '#5c5c5c',
    };
    const { colours, adjustments } = enforceContrast(base, {
      light: '#ffffff',
      dark: '#ffffff',
    });
    expect(adjustments).toEqual([]);
    expect(colours.primary).toEqual({
      base: '#595959',
      onLight: '#595959',
      onDark: '#595959',
    });
  });
});

describe('paletteFromTone', () => {
  it('returns null when there are no tone chips', () => {
    expect(paletteFromTone('')).toBeNull();
    expect(paletteFromTone(null)).toBeNull();
    expect(paletteFromTone(undefined)).toBeNull();
  });

  it('returns null for tone words it has no rule for', () => {
    expect(paletteFromTone('nautical, brackish')).toBeNull();
  });

  it('reads the first matching rule, so the ranking is the order', () => {
    // "Bold" outranks "Professional" because it is listed first.
    expect(paletteFromTone('Professional, Bold')).toEqual(
      paletteFromTone('Bold')
    );
  });

  it('is case insensitive', () => {
    expect(paletteFromTone('EARTHY')).toEqual(paletteFromTone('earthy'));
  });
});

describe('derivePalette', () => {
  it('falls all the way back to the default with nothing at all', () => {
    const palette = derivePalette({});
    expect(palette.source).toBe('default');
    expect(palette.primary.base).toBe(DEFAULT_PALETTE.primary);
    expect(paletteSwatches(palette)).toEqual([
      DEFAULT_PALETTE.primary,
      DEFAULT_PALETTE.secondary,
      DEFAULT_PALETTE.accent,
      DEFAULT_PALETTE.neutral,
    ]);
  });

  it('uses the tone chips when there is no picture', () => {
    const palette = derivePalette({ brandTone: 'Bold, Confident' });
    expect(palette.source).toBe('tone');
  });

  it('prefers a picture over the tone chips', () => {
    const bitmap = bitmapOf(16, 16, (x) => (x < 12 ? RED : TEAL));
    const palette = derivePalette({ bitmaps: [bitmap], brandTone: 'Minimal' });
    expect(palette.source).toBe('image');
    expect(palette.primary.base).toBe('#c81e18');
  });

  it('falls back to the tone when the picture has no colour in it', () => {
    const blank = bitmapOf(16, 16, () => WHITE);
    const palette = derivePalette({ bitmaps: [blank], brandTone: 'Earthy' });
    expect(palette.source).toBe('tone');
  });

  it('always returns page values that clear AA on their own background', () => {
    const cases = [
      derivePalette({}),
      derivePalette({ brandTone: 'Playful' }),
      derivePalette({
        bitmaps: [bitmapOf(16, 16, () => [255, 240, 190, 255])],
      }),
      derivePalette({
        bitmaps: [bitmapOf(16, 16, (x) => (x < 12 ? RED : TEAL))],
      }),
      derivePalette({ bitmaps: [bitmapOf(16, 16, () => [12, 10, 20, 255])] }),
    ];
    for (const palette of cases) {
      for (const role of [
        'primary',
        'secondary',
        'accent',
        'neutral',
      ] as const) {
        expect(
          contrastRatio(palette[role].onLight, DEFAULT_BACKGROUNDS.light)
        ).toBeGreaterThanOrEqual(AA_CONTRAST);
        expect(
          contrastRatio(palette[role].onDark, DEFAULT_BACKGROUNDS.dark)
        ).toBeGreaterThanOrEqual(AA_CONTRAST);
      }
    }
  });

  it('records the values it had to move and leaves the base alone', () => {
    const pale = bitmapOf(16, 16, () => [255, 240, 190, 255]);
    const palette = derivePalette({ bitmaps: [pale] });
    expect(palette.adjustments.length).toBeGreaterThan(0);
    // A pale yellow fails on the light page, so that is the value that moves.
    expect(
      palette.adjustments.some(
        (entry) => entry.role === 'primary' && entry.mode === 'light'
      )
    ).toBe(true);
    // The base is the colour the picture actually had, and nothing rewrites it.
    expect(palette.primary.base).toBe('#fff0be');
    for (const entry of palette.adjustments) {
      expect(palette[entry.role].base).toBe(entry.from);
    }
  });

  it('is deterministic end to end', () => {
    const bitmap = bitmapOf(120, 90, (x, y) => {
      if ((x * y) % 11 === 0) return TEAL;
      if (x % 5 === 0) return GREY;
      return RED;
    });
    expect(derivePalette({ bitmaps: [bitmap] })).toEqual(
      derivePalette({ bitmaps: [bitmap] })
    );
  });

  it("honours a template's own backgrounds", () => {
    const palette = derivePalette({
      brandTone: 'Minimal',
      backgrounds: { light: '#f2efe6', dark: '#14140f' },
    });
    for (const role of ['primary', 'secondary', 'accent', 'neutral'] as const) {
      expect(
        contrastRatio(palette[role].onLight, '#f2efe6')
      ).toBeGreaterThanOrEqual(AA_CONTRAST);
      expect(
        contrastRatio(palette[role].onDark, '#14140f')
      ).toBeGreaterThanOrEqual(AA_CONTRAST);
    }
  });
});
