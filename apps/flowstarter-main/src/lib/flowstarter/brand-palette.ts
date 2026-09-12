/**
 * The palette, derived from pictures by rule.
 *
 * A visitor gives us a profile link and, when the network will not talk to us,
 * one picture. From that we have to produce four colours the generated site can
 * wear: a primary, a secondary, an accent and a neutral. This module is the
 * whole of that decision, and it is deliberately pure.
 *
 *   rules decide, models phrase.
 *
 * No model picks a colour here. A model that is asked for "a nice palette for a
 * photographer" returns a different answer every time it is asked, cannot be
 * tested, and has no idea whether the result is legible on the template it is
 * about to be pasted into. So the pipeline is arithmetic from end to end:
 *
 *   downscale  -> a fixed grid of samples, nearest neighbour, integer steps
 *   quantise   -> a fixed bucket histogram, ties broken by bucket index
 *   choose     -> primary / secondary / accent / neutral by measured chroma
 *   adjust     -> every colour walked until it clears AA on the backgrounds
 *
 * Same bytes in, same four hex strings out, on every machine, forever. That is
 * what makes the palette testable, and it is why the quantiser does not use a
 * k-means with a random seed: the clustering would be better and the result
 * would not be reproducible, and for four colours off a profile picture the
 * trade is not close.
 *
 * Nothing here imports Supabase, `sharp`, `server-only` or the network. The
 * caller decodes an image into `Bitmap` and hands it over; see
 * `profile-image.ts` for the one adapter that owns the decoding.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** A decoded image. `data` is RGBA, row major, 4 bytes per pixel. */
export interface Bitmap {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array | readonly number[];
}

/** One colour the quantiser found, with the share of samples it holds. */
export interface Swatch {
  hex: string;
  rgb: Rgb;
  /** 0 to 1, the fraction of sampled opaque pixels in this bucket. */
  weight: number;
  /** 0 to 1. HSL saturation, kept so callers can rank without recomputing. */
  chroma: number;
  /** 0 to 1. HSL lightness. */
  lightness: number;
  /** 0 to 360. */
  hue: number;
}

export type PaletteRole = 'primary' | 'secondary' | 'accent' | 'neutral';

/** Which backgrounds a colour has to stay readable on. */
export interface PaletteBackgrounds {
  light: string;
  dark: string;
}

/**
 * One role, in the three forms a template needs.
 *
 * A single hex cannot be the answer. Clearing AA against a white page means a
 * relative luminance at or below 0.183; clearing it against a near-black one
 * means 0.201 or above. There is no colour that does both, which is not a
 * quirk of this module but arithmetic: it is why every design system that
 * supports two modes ships two values per token and why one that ships one is
 * illegible in whichever mode it was not designed in.
 *
 * So the derivation keeps `base` (the colour as the picture actually had it,
 * which is what the swatches in the wizard show and what a human would call
 * "their colour") and emits the two values the stylesheet uses.
 */
export interface PaletteColour {
  /** The colour as derived. Never adjusted; shown to the visitor. */
  base: string;
  /** What the light page uses. Clears AA on the light background. */
  onLight: string;
  /** What the dark page uses. Clears AA on the dark background. */
  onDark: string;
}

export interface PaletteAdjustment {
  role: PaletteRole;
  /** Which page's value had to move. */
  mode: 'light' | 'dark';
  from: string;
  to: string;
  /** The background it failed against. */
  against: string;
  ratioBefore: number;
  ratioAfter: number;
}

export interface Palette {
  primary: PaletteColour;
  secondary: PaletteColour;
  accent: PaletteColour;
  neutral: PaletteColour;
  /**
   * `image` when at least one picture was read, `tone` when the tone chips
   * were all we had, `default` when there was nothing at all.
   */
  source: 'image' | 'tone' | 'default';
  /** Every value the contrast rule had to move, in role then mode order. */
  adjustments: PaletteAdjustment[];
}

/** The four roles as they come out of the picture, before legibility. */
export type BasePalette = Record<PaletteRole, string>;

// ---------------------------------------------------------------------------
// Constants. Every number the module decides on, in one place.
// ---------------------------------------------------------------------------

/**
 * The long edge of the sampling grid. 64 is enough to keep a logo's accent
 * colour (a 3% band of a 1600px image is still 2 samples wide here) and small
 * enough that the histogram is a few thousand additions rather than millions.
 */
export const SAMPLE_EDGE = 64;

/**
 * Bucket resolution per channel. 16 levels means 4096 buckets: fine enough that
 * a red logo and an orange one do not collapse together, coarse enough that
 * JPEG noise across a flat wall does not split into forty near-identical
 * swatches.
 */
export const BUCKET_LEVELS = 16;

/** Below this alpha a pixel is transparent padding and says nothing. */
export const MIN_ALPHA = 128;

/** A bucket holding fewer samples than this is noise, not a colour. */
export const MIN_SWATCH_WEIGHT = 0.005;

/** At or above this HSL saturation a swatch counts as a colour, not a grey. */
export const CHROMA_FLOOR = 0.18;

/**
 * Near white and near black carry no hue worth building a site on, and every
 * photograph has plenty of both. They are still eligible for the neutral.
 */
export const LIGHTNESS_CEILING = 0.92;
export const LIGHTNESS_FLOOR = 0.08;

/** Two swatches closer than this in hue are the same colour twice. */
export const MIN_HUE_SEPARATION = 25;

/** WCAG AA for normal-size text. */
export const AA_CONTRAST = 4.5;

/** How far one step of the contrast walk moves lightness. */
export const CONTRAST_STEP = 0.02;

/**
 * The template backgrounds a colour has to survive. These are the two page
 * fills every Flowstarter template ships with; a per-template override is
 * passed in by the caller when it knows better.
 */
export const DEFAULT_BACKGROUNDS: PaletteBackgrounds = {
  light: '#ffffff',
  dark: '#0d0b16',
};

/**
 * The palette used when there is no picture and no tone: a restrained,
 * legible default rather than a guess dressed up as a derivation. It clears AA
 * on both backgrounds as written.
 */
export const DEFAULT_PALETTE: BasePalette = {
  primary: '#2f3a8c',
  secondary: '#5a6488',
  accent: '#b4562a',
  neutral: '#6b6f7a',
};

/**
 * Tone word to a starting palette, for the fallback where the visitor gave us
 * chips and nothing to look at. The words are the ones in `TONE_PRESETS`,
 * lowercased; the first rule that matches wins, so the order is the ranking.
 */
const PALETTE_BY_TONE: ReadonlyArray<
  readonly [readonly string[], BasePalette]
> = [
  [
    ['bold', 'vibrant', 'energetic', 'confident'],
    {
      primary: '#b3340f',
      secondary: '#8a4b1e',
      accent: '#1f6f6b',
      neutral: '#6d6259',
    },
  ],
  [
    ['premium', 'elegant', 'editorial', 'minimal'],
    {
      primary: '#1b1b1b',
      secondary: '#585858',
      accent: '#8a6a2f',
      neutral: '#6f6f6f',
    },
  ],
  [
    ['earthy', 'natural', 'calm', 'warm'],
    {
      primary: '#3f6144',
      secondary: '#7a6a52',
      accent: '#a8562c',
      neutral: '#6f6a60',
    },
  ],
  [
    ['playful', 'friendly', 'approachable'],
    {
      primary: '#1f6f8a',
      secondary: '#7a5296',
      accent: '#c0501f',
      neutral: '#6b6f76',
    },
  ],
  [
    ['professional', 'trustworthy', 'modern'],
    {
      primary: '#2f3a8c',
      secondary: '#4a5b7a',
      accent: '#a75024',
      neutral: '#6b6f7a',
    },
  ],
];

// ---------------------------------------------------------------------------
// Colour arithmetic
// ---------------------------------------------------------------------------

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function byteToHex(value: number): string {
  return Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0');
}

export function rgbToHex(rgb: Rgb): string {
  return `#${byteToHex(rgb.r)}${byteToHex(rgb.g)}${byteToHex(rgb.b)}`;
}

/**
 * Parses `#rgb`, `#rrggbb` and the same without the hash. Returns null rather
 * than throwing: a stored colour that has gone bad should degrade to the
 * default, not take a page down.
 */
export function hexToRgb(hex: string): Rgb | null {
  const raw = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(raw)) return null;
  if (raw.length === 3) {
    const [r, g, b] = raw.split('');
    return {
      r: parseInt(`${r}${r}`, 16),
      g: parseInt(`${g}${g}`, 16),
      b: parseInt(`${b}${b}`, 16),
    };
  }
  if (raw.length === 6) {
    return {
      r: parseInt(raw.slice(0, 2), 16),
      g: parseInt(raw.slice(2, 4), 16),
      b: parseInt(raw.slice(4, 6), 16),
    };
  }
  return null;
}

export interface Hsl {
  /** 0 to 360. */
  h: number;
  /** 0 to 1. */
  s: number;
  /** 0 to 1. */
  l: number;
}

export function rgbToHsl(rgb: Rgb): Hsl {
  const r = clamp(rgb.r, 0, 255) / 255;
  const g = clamp(rgb.g, 0, 255) / 255;
  const b = clamp(rgb.b, 0, 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = 60 * (((g - b) / delta) % 6);
  else if (max === g) h = 60 * ((b - r) / delta + 2);
  else h = 60 * ((r - g) / delta + 4);
  return { h: (h + 360) % 360, s: clamp(s, 0, 1), l };
}

export function hslToRgb(hsl: Hsl): Rgb {
  const h = ((hsl.h % 360) + 360) % 360;
  const s = clamp(hsl.s, 0, 1);
  const l = clamp(hsl.l, 0, 1);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor(h / 60) % 6;
  const table: ReadonlyArray<readonly [number, number, number]> = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = table[sector] ?? [0, 0, 0];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

/** WCAG relative luminance. */
export function relativeLuminance(rgb: Rgb): number {
  const channel = (value: number): number => {
    const v = clamp(value, 0, 255) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
  );
}

/**
 * WCAG contrast ratio between two colours, 1 to 21. An unparseable colour
 * returns 1, which reads as "fails everything" and sends the caller down the
 * adjustment path rather than silently passing.
 */
export function contrastRatio(a: string, b: string): number {
  const left = hexToRgb(a);
  const right = hexToRgb(b);
  if (!left || !right) return 1;
  const la = relativeLuminance(left);
  const lb = relativeLuminance(right);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// Downscale and quantise
// ---------------------------------------------------------------------------

/**
 * A fixed grid of nearest-neighbour samples, at most `SAMPLE_EDGE` on the long
 * edge. Integer arithmetic only, so two runs sample the same pixels.
 *
 * Averaging a box instead would be prettier and would also blend a red logo on
 * a white field into pink, which is exactly the colour the site must not wear.
 * Nearest neighbour keeps the source colours intact, and the histogram below
 * is what decides which of them matter.
 */
export function sampleBitmap(bitmap: Bitmap): Rgb[] {
  const { width, height, data } = bitmap;
  if (width <= 0 || height <= 0) return [];
  const long = Math.max(width, height);
  const stride = Math.max(1, Math.ceil(long / SAMPLE_EDGE));
  const samples: Rgb[] = [];
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const at = (y * width + x) * 4;
      if (at + 3 >= data.length) continue;
      if ((data[at + 3] ?? 0) < MIN_ALPHA) continue;
      samples.push({
        r: data[at] ?? 0,
        g: data[at + 1] ?? 0,
        b: data[at + 2] ?? 0,
      });
    }
  }
  return samples;
}

function bucketIndex(rgb: Rgb): number {
  const step = 256 / BUCKET_LEVELS;
  const r = Math.min(
    BUCKET_LEVELS - 1,
    Math.floor(clamp(rgb.r, 0, 255) / step)
  );
  const g = Math.min(
    BUCKET_LEVELS - 1,
    Math.floor(clamp(rgb.g, 0, 255) / step)
  );
  const b = Math.min(
    BUCKET_LEVELS - 1,
    Math.floor(clamp(rgb.b, 0, 255) / step)
  );
  return (r * BUCKET_LEVELS + g) * BUCKET_LEVELS + b;
}

/**
 * The histogram, as swatches ordered by weight.
 *
 * Ties are broken by bucket index ascending, never by insertion order, so the
 * result does not depend on which corner of the image the sampler started in.
 * Each swatch's colour is the mean of its bucket rather than the bucket centre:
 * a brand red that sits just inside a bucket edge comes back as itself.
 */
export function quantise(samples: readonly Rgb[]): Swatch[] {
  if (samples.length === 0) return [];
  const buckets = new Map<
    number,
    { r: number; g: number; b: number; n: number }
  >();
  for (const sample of samples) {
    const key = bucketIndex(sample);
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += sample.r;
    bucket.g += sample.g;
    bucket.b += sample.b;
    bucket.n += 1;
    buckets.set(key, bucket);
  }
  const total = samples.length;
  return Array.from(buckets.entries())
    .sort((a, b) => (b[1].n - a[1].n !== 0 ? b[1].n - a[1].n : a[0] - b[0]))
    .map(([, bucket]) => {
      const rgb: Rgb = {
        r: Math.round(bucket.r / bucket.n),
        g: Math.round(bucket.g / bucket.n),
        b: Math.round(bucket.b / bucket.n),
      };
      const hsl = rgbToHsl(rgb);
      return {
        hex: rgbToHex(rgb),
        rgb,
        weight: bucket.n / total,
        chroma: hsl.s,
        lightness: hsl.l,
        hue: hsl.h,
      };
    })
    .filter((swatch) => swatch.weight >= MIN_SWATCH_WEIGHT);
}

/** Sample and quantise in one call. Pure. */
export function swatchesFromBitmaps(bitmaps: readonly Bitmap[]): Swatch[] {
  const samples = bitmaps.flatMap((bitmap) => sampleBitmap(bitmap));
  return quantise(samples);
}

// ---------------------------------------------------------------------------
// Choosing the four
// ---------------------------------------------------------------------------

function hueDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
}

function isColourful(swatch: Swatch): boolean {
  return (
    swatch.chroma >= CHROMA_FLOOR &&
    swatch.lightness <= LIGHTNESS_CEILING &&
    swatch.lightness >= LIGHTNESS_FLOOR
  );
}

/**
 * Picks the four roles out of an ordered swatch list.
 *
 * Primary is the heaviest colourful swatch, because that is what the picture is
 * mostly made of. Secondary is the next one far enough away in hue to read as a
 * different colour. Accent is the most saturated swatch that is not already the
 * primary, since an accent's job is to be the loud one. Neutral is the greyest
 * swatch, and when a picture has no grey in it the primary is desaturated into
 * one rather than a grey being invented from nowhere.
 */
export function chooseRoles(swatches: readonly Swatch[]): {
  primary: string;
  secondary: string;
  accent: string;
  neutral: string;
} | null {
  const colourful = swatches.filter(isColourful);
  if (colourful.length === 0) return null;

  const primary = colourful[0] as Swatch;
  const secondary =
    colourful.find(
      (swatch) => hueDistance(swatch.hue, primary.hue) >= MIN_HUE_SEPARATION
    ) ??
    // Nothing far enough away: rotate the primary rather than repeat it, so
    // the site still has two colours instead of one colour twice.
    ({
      hex: rgbToHex(
        hslToRgb({
          h: primary.hue + 32,
          s: primary.chroma * 0.7,
          l: clamp(primary.lightness + 0.1, 0, 1),
        })
      ),
    } as Swatch);

  const accent =
    [...colourful]
      .sort((a, b) =>
        b.chroma - a.chroma !== 0
          ? b.chroma - a.chroma
          : a.hex.localeCompare(b.hex)
      )
      .find((swatch) => swatch.hex !== primary.hex) ?? primary;

  const greys = [...swatches]
    .filter(
      (swatch) =>
        swatch.lightness > LIGHTNESS_FLOOR &&
        swatch.lightness < LIGHTNESS_CEILING
    )
    .sort((a, b) =>
      a.chroma - b.chroma !== 0
        ? a.chroma - b.chroma
        : a.hex.localeCompare(b.hex)
    );
  const neutralSwatch = greys.find((swatch) => swatch.chroma < CHROMA_FLOOR);
  const neutral =
    neutralSwatch?.hex ??
    rgbToHex(hslToRgb({ h: primary.hue, s: 0.06, l: 0.45 }));

  return {
    primary: primary.hex,
    secondary: secondary.hex,
    accent: accent.hex,
    neutral,
  };
}

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

/**
 * Walks a colour until it clears AA against one background, keeping its hue.
 *
 * The direction is the background's, not the colour's: on a light page a
 * failing colour is too light and must go down, on a dark page it is too dark
 * and must go up. Saturation and hue are held, so the result is recognisably
 * the same colour and not a different one that happens to be legible.
 *
 * Returns null when the colour already passes or cannot be parsed. The walk is
 * bounded by construction: it ends at black or at white, and one of those
 * always clears AA against any background.
 */
export function adjustForContrast(
  hex: string,
  background: string
): { hex: string; ratioBefore: number; ratioAfter: number } | null {
  const before = contrastRatio(hex, background);
  if (before >= AA_CONTRAST) return null;

  const rgb = hexToRgb(hex);
  const backgroundRgb = hexToRgb(background);
  if (!rgb || !backgroundRgb) return null;
  const hsl = rgbToHsl(rgb);
  const darken = relativeLuminance(backgroundRgb) > 0.18;

  const steps = Math.ceil(1 / CONTRAST_STEP);
  let best = hex;
  let bestRatio = before;
  for (let i = 1; i <= steps; i += 1) {
    const l = clamp(hsl.l + (darken ? -1 : 1) * CONTRAST_STEP * i, 0, 1);
    const candidate = rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l }));
    const ratio = contrastRatio(candidate, background);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = candidate;
    }
    if (ratio >= AA_CONTRAST) {
      return { hex: candidate, ratioBefore: before, ratioAfter: ratio };
    }
  }
  if (best === hex) return null;
  return { hex: best, ratioBefore: before, ratioAfter: bestRatio };
}

/** The value a page should use for a colour: adjusted only when it has to be. */
export function legibleOn(hex: string, background: string): string {
  return adjustForContrast(hex, background)?.hex ?? hex;
}

const ROLE_ORDER: readonly PaletteRole[] = [
  'primary',
  'secondary',
  'accent',
  'neutral',
];

/**
 * Expands four base colours into the light and dark values a template needs,
 * and records every move so an operator can see what the rule did and why.
 */
export function enforceContrast(
  base: BasePalette,
  backgrounds: PaletteBackgrounds = DEFAULT_BACKGROUNDS
): {
  colours: Record<PaletteRole, PaletteColour>;
  adjustments: PaletteAdjustment[];
} {
  const colours = {} as Record<PaletteRole, PaletteColour>;
  const adjustments: PaletteAdjustment[] = [];
  for (const role of ROLE_ORDER) {
    const from = base[role];
    const modes: ReadonlyArray<readonly ['light' | 'dark', string]> = [
      ['light', backgrounds.light],
      ['dark', backgrounds.dark],
    ];
    const resolved: Record<'light' | 'dark', string> = {
      light: from,
      dark: from,
    };
    for (const [mode, background] of modes) {
      const moved = adjustForContrast(from, background);
      if (!moved) continue;
      resolved[mode] = moved.hex;
      adjustments.push({
        role,
        mode,
        from,
        to: moved.hex,
        against: background,
        ratioBefore: moved.ratioBefore,
        ratioAfter: moved.ratioAfter,
      });
    }
    colours[role] = {
      base: from,
      onLight: resolved.light,
      onDark: resolved.dark,
    };
  }
  return { colours, adjustments };
}

// ---------------------------------------------------------------------------
// The whole derivation
// ---------------------------------------------------------------------------

/** The tone fallback, for when there is nothing to look at. */
export function paletteFromTone(
  brandTone: string | null | undefined
): BasePalette | null {
  const needle = (brandTone ?? '').toLowerCase();
  if (!needle.trim()) return null;
  const hit = PALETTE_BY_TONE.find(([words]) =>
    words.some((word) => needle.includes(word))
  );
  return hit ? hit[1] : null;
}

export interface DerivePaletteInput {
  /** Every picture we were allowed to read, already decoded. */
  bitmaps?: readonly Bitmap[];
  /** The intake's tone chips, used only when no picture produced a colour. */
  brandTone?: string | null;
  backgrounds?: PaletteBackgrounds;
}

/**
 * The palette, start to finish. Pure, deterministic, and never empty: a caller
 * always gets four colours that clear AA, and `source` says how much of that
 * was the visitor's own material.
 */
export function derivePalette(input: DerivePaletteInput): Palette {
  const backgrounds = input.backgrounds ?? DEFAULT_BACKGROUNDS;
  const swatches = swatchesFromBitmaps(input.bitmaps ?? []);
  const fromImage = chooseRoles(swatches);
  const fromTone = fromImage ? null : paletteFromTone(input.brandTone);
  const source: Palette['source'] = fromImage
    ? 'image'
    : fromTone
    ? 'tone'
    : 'default';
  const base = fromImage ?? fromTone ?? DEFAULT_PALETTE;
  const { colours, adjustments } = enforceContrast(base, backgrounds);
  return { ...colours, source, adjustments };
}

/**
 * The four base colours as plain hex, which is what the wizard draws as
 * swatches and what a human means when they say "my colours".
 */
export function paletteSwatches(palette: Palette): string[] {
  return ROLE_ORDER.map((role) => palette[role].base);
}
