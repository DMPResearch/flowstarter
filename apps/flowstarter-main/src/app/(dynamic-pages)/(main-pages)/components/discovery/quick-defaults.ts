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

/**
 * The four quick answers `deriveBusinessName` reads. A subset of
 * `DiscoveryData` rather than the whole shape, so a caller holding only a
 * partial spec (the live route's own request body) can pass it through
 * without satisfying fields this rule never looks at.
 */
export type QuickBusinessNameAnswers = Pick<
  DiscoveryData,
  'businessName' | 'fullName' | 'instagramUrl' | 'linkedinUrl' | 'websiteUrl'
>;

/**
 * A business name from the four quick answers, for the one consumer that
 * cannot work without one: a generated site has to be introduced as
 * *something*. The quick intake stopped asking for a business name directly
 * (it moved to the Brief, after the deposit), so this is what stands in for
 * that answer until the client gives the real one. Checked in this order:
 *
 *   1. The Brief's own answer, once given. Never guessed over: an answer the
 *      visitor actually typed beats a rule every time.
 *   2. The one link, when it is the visitor's own website: the hostname,
 *      with `www.` and the TLD stripped and the rest title-cased —
 *      `flowstarter.net` reads as `Flowstarter`. Read from the string alone,
 *      the same way `industryFromDescription` reads words rather than
 *      fetching anything: a domain that does not resolve derives exactly as
 *      well as one that does, because nothing here ever asks the network.
 *   3. Otherwise the visitor's own name. An Instagram or LinkedIn profile
 *      names a person, not a business — pointing this rule at a handle
 *      instead of a real domain would produce "Sablefig.Official" out of
 *      "@sablefig.official", which is worse than the honest answer: for a
 *      personal portfolio the business *is* the person, so their name is
 *      what the generated site is introduced with.
 *
 * Never empty when `fullName` is given. Step 1 of the intake requires a
 * name at least two characters long, so in practice this only returns ''
 * for a draft nobody has started.
 */
export function deriveBusinessName(answers: QuickBusinessNameAnswers): string {
  const briefName = answers.businessName?.trim();
  if (briefName) return briefName;

  const fromWebsite = businessNameFromHostname(answers.websiteUrl ?? '');
  if (fromWebsite) return fromWebsite;

  return (answers.fullName ?? '').trim();
}

/**
 * Second-level labels that are themselves generic rather than part of the
 * name, so a two-label ccTLD like `.co.uk` or `.com.au` is dropped whole
 * instead of leaving "Acme Co" behind.
 */
const GENERIC_SECOND_LEVEL_LABELS = new Set([
  'co',
  'com',
  'org',
  'net',
  'gov',
  'edu',
]);

/**
 * The hostname of a URL (or a bare domain typed without a scheme) as a
 * title-cased name, or '' when the string is not a URL at all.
 *
 * `new URL` only parses — it never opens a connection — so this derives the
 * same name whether or not the domain resolves to anything.
 */
function businessNameFromHostname(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  let hostname: string;
  try {
    const withScheme = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    hostname = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return '';
  }
  const labels = hostname
    .replace(/^www\./, '')
    .split('.')
    .filter(Boolean);
  if (labels.length === 0) return '';
  const dropTwo =
    labels.length >= 3 &&
    GENERIC_SECOND_LEVEL_LABELS.has(labels[labels.length - 2]);
  const nameLabels =
    labels.length === 1 ? labels : labels.slice(0, dropTwo ? -2 : -1);
  const words = nameLabels.join(' ').split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return '';
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
