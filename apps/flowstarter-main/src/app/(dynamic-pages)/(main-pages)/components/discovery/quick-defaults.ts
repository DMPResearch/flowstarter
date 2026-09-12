/**
 * What the intake stopped asking, decided by rule instead.
 *
 * Cutting the pre-preview form to four questions removed the answers the
 * preview used to be shaped by: the industry picked which sections the site
 * has, the page count decided how many pages it may have, the goal decided the
 * call to action, the commerce answer decided whether there is a product row.
 * None of those questions were wrong. They were just being asked of somebody
 * who had not yet been shown anything, and the price of asking them was the
 * visitors who never finished.
 *
 * So they are derived here, from the one sentence the visitor did write, and
 * then asked properly on the dashboard after the deposit, where the client
 * corrects them against a real site. Two different jobs:
 *
 *   before the preview   a defensible guess, so the skeleton and the
 *                        generation have something to work from.
 *   after the deposit    the client's own answer, which overwrites the guess.
 *
 * Everything here is a rule. A model does not pick the industry, because a
 * model that picks the industry picks a different one on Tuesday and the
 * visitor cannot tell why their preview changed shape. The one thing a model
 * is allowed near is the tone line, and that lives in `brand-tone.ts` and is
 * phrased from the visitor's own words or not at all.
 *
 * An answer the visitor actually gave is never overwritten. `withQuickDefaults`
 * only fills blanks, so a draft from before the cut, or a brief the client has
 * since corrected, passes through untouched.
 */
import type { CommerceMode, DiscoveryData, PageCount } from './discovery.logic';

/**
 * Words to an industry, first match wins.
 *
 * Keyed on the same vocabulary `preview-skeleton.ts` already matches against,
 * so a derived industry reshapes the skeleton exactly as a chosen one would.
 * Deliberately a small list of strong signals rather than a long list of weak
 * ones: a rule that guesses wrong loudly is worse than one that declines.
 */
const INDUSTRY_BY_WORD: ReadonlyArray<readonly [RegExp, string]> = [
  // `bars?` is anchored on both sides rather than left open like its
  // neighbours. Every other word here takes a `\w*` tail so "bakery" catches
  // "bakeries"; `bar` with that tail catches "barber", and a barber shop is
  // not a wine bar.
  [
    /\b(?:(?:restaurant|cafe|coffee|bakery|bistro|catering|kitchen|menu|roast)\w*|bars?)\b/i,
    'Hospitality & food',
  ],
  // No `studio`, for the same reason there is no `boutique` below: a design
  // studio, a yoga studio and a product studio are all more common than a
  // photography one, and first match wins in this table.
  [
    /\b(photograph|videograph|filmmak|film|portrait|wedding)\w*/i,
    'Photography',
  ],
  [
    /\b(design|designer|brand|illustrat|creative|art director|copywrit)\w*/i,
    'Creative & design',
  ],
  // No `boutique` here, deliberately. It reads as a fashion word and is used
  // far more often as a size adjective: a boutique dental clinic, a boutique
  // agency, a boutique hotel. First match wins in this table, so leaving it in
  // sent "a boutique dental clinic in Cluj" to Fashion & style and reshaped
  // the whole skeleton around it.
  [/\b(fashion|clothing|jewel|apparel|tailor|menswear)\w*/i, 'Fashion & style'],
  [
    /\b(therap|counsell|counsel|psycholog|wellness|wellbeing|massage|physio)\w*/i,
    'Therapy & wellness',
  ],
  [
    /\b(gym|fitness|personal train|pilates|yoga|coach athlete|strength)\w*/i,
    'Fitness & training',
  ],
  [/\b(salon|barber|hair|nails|beauty|aesthetic|spa)\w*/i, 'Beauty & salon'],
  [
    /\b(shop|store|ecommerce|e-commerce|online store|products for sale)\w*/i,
    'Online store / ecommerce',
  ],
  [/\b(coach|coaching|mentor)\w*/i, 'Coaching'],
  [/\b(consult|advisor|advisory|strategy)\w*/i, 'Consulting'],
  [
    /\b(dentist|dental|clinic|doctor|medical|vet|veterinar)\w*/i,
    'Therapy & wellness',
  ],
  [
    /\b(plumb|electric|carpent|builder|roofing|joiner|landscap|garden)\w*/i,
    'Professional services',
  ],
  [
    /\b(lawyer|legal|accountant|accounting|solicitor|architect|engineer)\w*/i,
    'Professional services',
  ],
  [
    /\b(developer|software|app|saas|product studio|agency)\w*/i,
    'Creative & design',
  ],
];

/** The industry the description points at, or '' when nothing is clear. */
export function industryFromDescription(description: string): string {
  const text = (description ?? '').toLowerCase();
  if (!text.trim()) return '';
  for (const [pattern, industry] of INDUSTRY_BY_WORD) {
    if (pattern.test(text)) return industry;
  }
  return '';
}

/**
 * Words to a primary goal.
 *
 * The goal decides the call to action and, through `page-set.ts`, how much of
 * the site is about getting in touch. A business that mentions booking wants a
 * booking button; one that mentions selling wants a shop.
 */
const GOAL_BY_WORD: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b(book|booking|appointment|session|reservation|schedule)\w*/i,
    'Take bookings or appointments',
  ],
  [
    /\b(sell|shop|store|product|order|buy|stock)\w*/i,
    'Sell products or services',
  ],
  // No bare `work`. "Doing cosmetic work", "we work with founders" and "how we
  // work" are all ordinary prose, and reading any of them as "this business
  // wants a portfolio page" reshapes the site around a section that may have
  // nothing to put in it.
  [
    /\b(portfolio|project|case stud|gallery|exhibit|past work|our work|my work)\w*/i,
    'Show a portfolio of work',
  ],
];

/** The default goal. Enquiries, because that is what most sites are for. */
export const DEFAULT_GOAL = 'Get enquiries / leads';

export function goalFromDescription(description: string): string {
  const text = (description ?? '').toLowerCase();
  for (const [pattern, goal] of GOAL_BY_WORD) {
    if (pattern.test(text)) return goal;
  }
  return DEFAULT_GOAL;
}

/**
 * The default page count.
 *
 * `'unsure'` on purpose, which `page-set.ts` reads as a six-page budget. It is
 * the honest value: nobody has been asked. Picking `'5-7'` would look like an
 * answer and would quietly stop the Brief's real answer from being needed.
 */
export const DEFAULT_PAGE_COUNT: PageCount = 'unsure';

/**
 * The default commerce mode.
 *
 * `'none'` rather than a guess from the words. A site that grows a product row
 * because the description said "products" and then has no catalogue behind it
 * is the exact failure the sufficiency gate exists to prevent, and the Brief
 * asks the question properly a few minutes later.
 */
export const DEFAULT_COMMERCE_MODE: CommerceMode = 'none';

/**
 * Fills the blanks the quick intake no longer asks about. Pure, and additive
 * only: a field the visitor answered, or the Brief later corrected, is left
 * exactly as it is.
 */
export function withQuickDefaults(data: DiscoveryData): DiscoveryData {
  const description = data.description ?? '';
  return {
    ...data,
    industry: data.industry?.trim()
      ? data.industry
      : industryFromDescription(description),
    goal: data.goal?.trim() ? data.goal : goalFromDescription(description),
    pageCount: data.pageCount || DEFAULT_PAGE_COUNT,
    commerceMode: data.commerceMode || DEFAULT_COMMERCE_MODE,
  };
}

/**
 * Which of the derived values are guesses rather than answers, so a surface
 * that shows them can say so. The Brief uses this to mark the fields it most
 * wants the client to confirm.
 */
export function guessedFields(data: DiscoveryData): string[] {
  const guessed: string[] = [];
  if (!data.industry?.trim()) guessed.push('industry');
  if (!data.goal?.trim()) guessed.push('goal');
  if (!data.pageCount) guessed.push('pageCount');
  if (!data.commerceMode) guessed.push('commerceMode');
  return guessed;
}
