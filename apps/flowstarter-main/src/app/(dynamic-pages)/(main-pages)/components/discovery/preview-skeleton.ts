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
import { withQuickDefaults } from './quick-defaults';

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
  id: 'fullName' | 'description' | 'links' | 'brandTone';
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

/** The first few words of a prose answer, so the fact list stays one line. */
function firstWords(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const atWord = cut.lastIndexOf(' ');
  return `${atWord > 16 ? cut.slice(0, atWord) : cut}...`;
}

/**
 * Which networks the visitor gave us, named rather than spelled out. The list
 * is a glance, and a pasted Instagram URL is forty characters of noise in it.
 */
function linksFact(data: DiscoveryData): string {
  const names: string[] = [];
  if ((data.instagramUrl ?? '').trim()) names.push('Instagram');
  if ((data.linkedinUrl ?? '').trim()) names.push('LinkedIn');
  if ((data.websiteUrl ?? '').trim()) names.push('Website');
  return names.join(', ');
}

/** The whole skeleton, derived. Pure: same data in, same skeleton out. */
export function derivePreviewSkeleton(raw: DiscoveryData): PreviewSkeleton {
  // The intake asks four questions now, so the industry, the goal, the page
  // count and the commerce answer are derived from the visitor's sentence
  // rather than asked. Same shape either way: a derived industry reshapes the
  // skeleton exactly as a chosen one did, which is the point of deriving it
  // into the same vocabulary.
  const data = withQuickDefaults(raw);
  const siteName = (data.businessName ?? '').trim();
  const industry = (data.industry ?? '').trim();
  const brandTone = (data.brandTone ?? '').trim();
  const shape = SHAPE_BY_PAGES[data.pageCount] ?? SHAPE_BY_PAGES[''];
  const { weight, radius } = toneShape(brandTone);
  const hasProductRow = sellsCatalogue(data.commerceMode);

  // The four facts are exactly the four things the quick intake asks about, so
  // the list fills in as the conversation runs and is complete when it ends.
  // It used to show the business name, the tone and the page count; those are
  // no longer asked before the preview, and a list that can never fill is a
  // list that reads as broken.
  const facts: KnownFact[] = [
    {
      id: 'fullName',
      labelKey: `${KEY}factName`,
      value: (data.fullName ?? '').trim(),
    },
    {
      id: 'description',
      labelKey: `${KEY}factDoes`,
      value: firstWords(data.description ?? ''),
    },
    {
      id: 'links',
      labelKey: `${KEY}factLinks`,
      value: linksFact(data),
    },
    // Derived rather than asked: the tone comes from the profile and the
    // visitor's own sentence. Shown because it visibly shapes the skeleton,
    // and editable through the link it was derived from.
    { id: 'brandTone', labelKey: `${KEY}factStyle`, value: brandTone },
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
