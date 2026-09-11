/**
 * The preview skeleton, derived from the intake answers.
 *
 * The modal used to hold the preview back until the very last step: the
 * visitor answered sixteen questions into a chat log and only then saw
 * anything resembling a website. This module is the other half of the fix --
 * a site-shaped skeleton that stands next to the conversation from the first
 * frame and fills in as the answers land.
 *
 * It follows the same division of labour as the rest of the intake:
 *
 *   rules decide, models phrase.
 *
 * Everything here is a rule. Which sections the skeleton shows, how many nav
 * items and cards it draws, whether it has a product row, and what type
 * weight and corner radius it wears are all decided by pure functions over
 * `DiscoveryData`. No model is consulted and no network call is made, which
 * is the point: the same answers always produce the same skeleton, so the
 * whole thing is testable without rendering anything and can never disagree
 * with itself between two renders.
 *
 * This is deliberately NOT the generator. The skeleton is a promise about
 * shape, not a draft of the site: it carries the business name and nothing
 * else the visitor did not type. The real generation pipeline
 * (`/api/discovery/preview/live`) is untouched and still owns the actual
 * build; when it starts, this skeleton becomes its loading frame.
 */
import type { DiscoveryData, PageCount } from './discovery.logic';

/** A band in the skeleton, in the order it is drawn. */
export type SkeletonSectionId =
  | 'hero'
  | 'services'
  | 'menu'
  | 'work'
  | 'products'
  | 'booking'
  | 'about'
  | 'testimonials'
  | 'contact';

/** How the skeleton's type and corners read, derived from the tone answer. */
export type SkeletonWeight = 'light' | 'regular' | 'bold';
export type SkeletonRadius = 'sharp' | 'soft' | 'round';

/** One line of the "what we know so far" list under the pane. */
export interface KnownFact {
  /** Matches an `IntakeQuestionId`, so the edit affordance can jump back. */
  id: 'fullName' | 'businessName' | 'brandTone' | 'pageCount';
  /** Locale key for the label. */
  labelKey: string;
  /** The visitor's own words, or '' when they have not answered yet. */
  value: string;
}

export interface PreviewSkeleton {
  /** The business name, or '' when it has not been given yet. */
  siteName: string;
  /** True once the visitor has named the business. */
  named: boolean;
  /** Nav placeholders in the skeleton's header bar. */
  navCount: number;
  /** The bands the skeleton draws, in order. */
  sections: readonly SkeletonSectionId[];
  /** Cards in the skeleton's card row. */
  cardCount: number;
  /** True when the commerce answer says there is a catalogue to show. */
  hasProductRow: boolean;
  weight: SkeletonWeight;
  radius: SkeletonRadius;
  /** The four facts under the pane, always all four, value '' when unknown. */
  facts: readonly KnownFact[];
  /**
   * How many of the shape-deciding answers have landed (0-4). 0 is the
   * resting state: a generic skeleton with nothing derived from the visitor.
   */
  answeredCount: number;
}

const KEY = 'landing.discovery.preview.pane.';

/**
 * Industry -> the bands that business actually has. Keyed on the values in
 * `INDUSTRY_OPTIONS`, lowercased, but matched loosely (see `sectionsFor`) so a
 * typed answer the chips do not cover still lands somewhere sensible rather
 * than falling straight through to the default.
 */
const SECTIONS_BY_INDUSTRY: ReadonlyArray<
  readonly [readonly string[], readonly SkeletonSectionId[]]
> = [
  [
    ['hospitality', 'food', 'restaurant', 'cafe', 'bar', 'catering'],
    ['hero', 'menu', 'about', 'testimonials', 'contact'],
  ],
  [
    ['photography', 'creative', 'design', 'fashion', 'style', 'studio'],
    ['hero', 'work', 'about', 'testimonials', 'contact'],
  ],
  [
    ['retail', 'ecommerce', 'online store', 'products', 'shop'],
    ['hero', 'products', 'about', 'testimonials', 'contact'],
  ],
  [
    ['therapy', 'wellness', 'beauty', 'salon', 'fitness', 'training', 'clinic'],
    ['hero', 'services', 'booking', 'about', 'contact'],
  ],
];

const DEFAULT_SECTIONS: readonly SkeletonSectionId[] = [
  'hero',
  'services',
  'about',
  'testimonials',
  'contact',
];

/** Page count -> how wide the nav gets and how many cards the row holds. */
const SHAPE_BY_PAGES: Record<
  PageCount | '',
  { navCount: number; cardCount: number }
> = {
  'lt-5': { navCount: 3, cardCount: 2 },
  '5-7': { navCount: 5, cardCount: 3 },
  '8-15': { navCount: 6, cardCount: 4 },
  '15+': { navCount: 7, cardCount: 6 },
  unsure: { navCount: 4, cardCount: 3 },
  '': { navCount: 4, cardCount: 3 },
};

/**
 * Tone words -> type weight and corner radius. First match wins, in the order
 * listed, so a visitor who picks "Bold, Friendly" gets the bolder reading:
 * the stronger signal is the one they are least likely to have picked by
 * accident.
 */
const TONE_RULES: ReadonlyArray<
  readonly [readonly string[], SkeletonWeight, SkeletonRadius]
> = [
  [['bold', 'confident', 'energetic', 'vibrant'], 'bold', 'sharp'],
  [['minimal', 'editorial', 'modern'], 'light', 'sharp'],
  [['premium', 'elegant', 'calm', 'earthy', 'natural'], 'light', 'soft'],
  [['playful', 'friendly', 'warm', 'approachable'], 'regular', 'round'],
];

function normalise(value: string | undefined | null): string {
  return (value ?? '').toLowerCase();
}

function sectionsFor(
  industry: string,
  commerceMode: DiscoveryData['commerceMode']
): readonly SkeletonSectionId[] {
  const needle = normalise(industry);
  let base = DEFAULT_SECTIONS;
  if (needle) {
    const hit = SECTIONS_BY_INDUSTRY.find(([words]) =>
      words.some((word) => needle.includes(word))
    );
    if (hit) base = hit[1];
  }
  // A catalogue earns its own band wherever the industry did not already give
  // it one: the answer "I sell physical products" changes the site's shape,
  // not just a line in the brief.
  if (sellsCatalogue(commerceMode) && !base.includes('products')) {
    const rest = base.filter((section) => section !== 'hero');
    return ['hero', 'products', ...rest];
  }
  return base;
}

/** True when the commerce answer means a real catalogue, not a few offers. */
export function sellsCatalogue(
  commerceMode: DiscoveryData['commerceMode']
): boolean {
  return (
    commerceMode === 'digital' ||
    commerceMode === 'physical' ||
    commerceMode === 'mixed'
  );
}

function toneShape(brandTone: string): {
  weight: SkeletonWeight;
  radius: SkeletonRadius;
} {
  const needle = normalise(brandTone);
  if (needle) {
    const hit = TONE_RULES.find(([words]) =>
      words.some((word) => needle.includes(word))
    );
    if (hit) return { weight: hit[1], radius: hit[2] };
  }
  return { weight: 'regular', radius: 'soft' };
}

/**
 * The pages answer, as the visitor picked it. Deliberately the raw value and
 * not a locale lookup: the caller has `t` and the option labels, this module
 * stays free of both.
 */
function pagesFact(data: DiscoveryData): string {
  return data.pageCount === '' ? '' : data.pageCount;
}

/** The whole skeleton, derived. Pure: same data in, same skeleton out. */
export function derivePreviewSkeleton(data: DiscoveryData): PreviewSkeleton {
  const siteName = (data.businessName ?? '').trim();
  const industry = (data.industry ?? '').trim();
  const brandTone = (data.brandTone ?? '').trim();
  const shape = SHAPE_BY_PAGES[data.pageCount] ?? SHAPE_BY_PAGES[''];
  const { weight, radius } = toneShape(brandTone);
  const hasProductRow = sellsCatalogue(data.commerceMode);

  const facts: KnownFact[] = [
    {
      id: 'fullName',
      labelKey: `${KEY}factName`,
      value: (data.fullName ?? '').trim(),
    },
    {
      id: 'businessName',
      labelKey: `${KEY}factBusiness`,
      value: siteName,
    },
    { id: 'brandTone', labelKey: `${KEY}factStyle`, value: brandTone },
    { id: 'pageCount', labelKey: `${KEY}factPages`, value: pagesFact(data) },
  ];

  return {
    siteName,
    named: siteName.length > 0,
    navCount: shape.navCount,
    sections: sectionsFor(industry, data.commerceMode),
    cardCount: shape.cardCount,
    hasProductRow,
    weight,
    radius,
    facts,
    answeredCount: facts.filter((fact) => fact.value).length,
  };
}
