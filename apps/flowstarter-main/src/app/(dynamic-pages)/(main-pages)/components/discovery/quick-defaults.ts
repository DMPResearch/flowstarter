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
import {
  recommendTier,
  type CommerceMode,
  type DiscoveryData,
  type PageCount,
} from './discovery.logic';

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
 * The default commerce mode — and, for now, the only one a workspace can
 * have.
 *
 * `'none'` rather than a guess from the words: a site that grows a product
 * row because the description said "products" and then has no catalogue
 * behind it is the exact failure the sufficiency gate exists to prevent.
 *
 * This used to say the Brief asks the question properly a few minutes
 * later. It never did: `intake-script.ts` carried a `commerceMode` question
 * at `phase: 'brief'`, but `BriefForm.tsx` — the Brief as it actually
 * shipped — has no commerce section and nothing reads that phase, so the
 * question was unreachable from day one and every workspace has always
 * filed `'none'` regardless of what the business sells. Wiring commerce into
 * the Brief for real (a `workspace_briefs` column, a form section, a route
 * change, and a way for the answer to reach the generator's page-set rule)
 * is out of scope for closing that gap — this default is the honest,
 * explicit decision until it is: commerce is out of pilot scope, not merely
 * unasked.
 */
export const DEFAULT_COMMERCE_MODE: CommerceMode = 'none';

/**
 * Fills the blanks the quick intake no longer asks about. Pure, and additive
 * only: a field the visitor answered, or the Brief later corrected, is left
 * exactly as it is.
 *
 * `selectedTier` belongs here for the same reason the others do: step 6 (the
 * tier confirmation) comes after the preview, so every quick-intake visitor
 * reaches the preview — and the claim/checkout buttons on it — with an empty
 * `selectedTier`. `recommendTier` is the same deterministic rule the
 * recommendation step itself uses, run against the *other* derived fields
 * above (a recommendation read off an empty `commerceMode`/`pageCount` would
 * be a worse guess than one read off the defaults just filled in). Leaving
 * this blank was R2/R3 of the PR #108 regression: a required tier enum 400'd
 * the guest deposit checkout, and an absent one left the signed-in claim's
 * quote — and therefore `/unlock`'s Pay button — null.
 */
export function withQuickDefaults(data: DiscoveryData): DiscoveryData {
  const description = data.description ?? '';
  const derived: DiscoveryData = {
    ...data,
    industry: data.industry?.trim()
      ? data.industry
      : industryFromDescription(description),
    goal: data.goal?.trim() ? data.goal : goalFromDescription(description),
    pageCount: data.pageCount || DEFAULT_PAGE_COUNT,
    commerceMode: data.commerceMode || DEFAULT_COMMERCE_MODE,
  };
  return {
    ...derived,
    selectedTier: data.selectedTier || recommendTier(derived).tier,
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
 * The six quick answers `deriveBusinessName` reads. A subset of
 * `DiscoveryData` rather than the whole shape, so a caller holding only a
 * partial spec (the live route's own request body) can pass it through
 * without satisfying fields this rule never looks at.
 */
export type QuickBusinessNameAnswers = Pick<
  DiscoveryData,
  | 'businessName'
  | 'fullName'
  | 'description'
  | 'instagramUrl'
  | 'linkedinUrl'
  | 'websiteUrl'
  | 'websiteIsOwnSite'
>;

/** Extra evidence `deriveBusinessName` cannot read off `QuickBusinessNameAnswers` alone. */
export interface DeriveBusinessNameOptions {
  /**
   * True when the visitor has completed at least one question in the person
   * or activity block — answered, not merely offered it; see
   * `personBlockAnswered` in `person-questions.ts`, the one place that reads
   * `DiscoveryData`'s person fields to produce this.
   *
   * This is the strongest evidence `deriveBusinessName` ever sees that the
   * visitor IS the business: nobody writes six sentences about themselves
   * for a company that is not them. It outranks even a hostname the visitor
   * has confirmed is their own — see the precedence note below.
   *
   * Optional, and false by default, so every caller that has no person
   * section to offer (the claim route's own re-derivation, in particular)
   * keeps deriving exactly as it always has.
   */
  personAnswered?: boolean;
}

/**
 * Names this rule will never derive, however plausibly a string suggests one.
 *
 * This product's own name is on the list because of the incident this change
 * exists to fix: a portfolio shipped under the name "Flowstarter", which is
 * us, not the client. It got there through `businessNameFromDescription`, out
 * of a visitor who described their work by mentioning the tool they build
 * with, and nothing anywhere asked whether the name a rule had just extracted
 * was our own.
 *
 * A client who genuinely trades under one of these may still type it into the
 * brief's business-name field, and it is honoured: this list rejects DERIVED
 * names only. A rule guessing our own name onto a client's site is never
 * right; a client asserting it might be.
 */
export const UNDERIVABLE_BUSINESS_NAMES: readonly string[] = ['flowstarter'];

/** True when a derived candidate is one this rule refuses to produce. */
export function isUnderivableBusinessName(candidate: string): boolean {
  return UNDERIVABLE_BUSINESS_NAMES.includes(
    candidate.trim().toLowerCase().replace(/\s+/g, ' ')
  );
}

/**
 * A business name from the quick answers, for the one consumer that cannot
 * work without one: a generated site has to be introduced as *something*. The
 * quick intake stopped asking for a business name directly (it moved to the
 * Brief, after the deposit), so this is what stands in for that answer until
 * the client gives the real one. Checked in this order:
 *
 *   1. The Brief's own answer, once given. Never guessed over: an answer the
 *      visitor actually typed beats a rule every time.
 *   2. A name stated in the "what you do" answer (`businessNameFromDescription`
 *      below) — the visitor's own words, read rather than guessed.
 *   3. The one link, but ONLY when it is confirmed to be the visitor's OWN
 *      website (`websiteIsOwnSite === 'yes'`) and no name was stated above,
 *      AND no person section has been answered (`options.personAnswered`):
 *      the hostname, with `www.` and the TLD stripped and the rest
 *      title-cased — `flowstarter.net` reads as `Flowstarter`.
 *
 *      This is the fix for the real incident that named a workspace after a
 *      trademark that was not the client's: a visitor typed "Arome Coffee, a
 *      specialty roastery in Cluj" and pasted `onyxcoffeelab.com` as a
 *      reference, not their own site, and the old rule — which trusted every
 *      pasted website as "theirs" — named the workspace "Onyxcoffeelab" and
 *      the generated site "Onyx Coffee Lab". The intake has no "is this your
 *      site" signal on its own, so the links question now asks it as a
 *      one-tap follow-up whenever the one link is a website rather than a
 *      social profile, defaulting to no. Read from the string alone, the same
 *      way `industryFromDescription` reads words rather than fetching
 *      anything: a domain that does not resolve derives exactly as well as
 *      one that does, because nothing here ever asks the network.
 *
 *      A second visitor claimed a site this way and was still named after its
 *      hostname: he owned the domain, gave his own name at step 1, and then
 *      answered all eleven person and activity questions about himself. The
 *      hostname check ran first and never looked at the person section, so it
 *      named him after a subdomain his preview happened to sit on. A
 *      completed person section is stronger evidence than an owned hostname —
 *      nobody writes six sentences about themselves for a company that is not
 *      them — so it is checked first now (`options.personAnswered`, step 3a
 *      below), and a hostname only names the business when that section was
 *      never answered at all. The remaining chicken-and-egg case — the person
 *      block has not run yet, so there is no `personAnswered` evidence either
 *      way, and the visitor has both an owned site and a name — is not
 *      guessed at all: `ownedSiteNameIsAmbiguous` below is what the intake's
 *      `nameOnSite` question uses to ask, once, before the person block would
 *      otherwise start on a guess.
 *   4. Otherwise the visitor's own name. An Instagram or LinkedIn profile
 *      names a person, not a business — pointing this rule at a handle
 *      instead of a real domain would produce "Sablefig.Official" out of
 *      "@sablefig.official", which is worse than the honest answer: for a
 *      personal portfolio the business *is* the person, so their name is
 *      what the generated site is introduced with. The one link's hostname
 *      falls through to here too, on any answer other than "yes".
 *
 * Never empty when `fullName` is given. Step 1 of the intake requires a
 * name at least two characters long, so in practice this only returns ''
 * for a draft nobody has started.
 */
export function deriveBusinessName(
  answers: QuickBusinessNameAnswers,
  options: DeriveBusinessNameOptions = {}
): string {
  const briefName = answers.businessName?.trim();
  if (briefName) return briefName;

  const personName = (answers.fullName ?? '').trim();

  const fromDescription = businessNameFromDescription(
    answers.description ?? ''
  );
  // Step 2, with the guard that was missing. A name extracted from a sentence
  // is a guess, and a guess that lands on this product's own name is one we
  // would rather not make at all: the client's own name is both truer and
  // safer than putting our brand on their website.
  if (fromDescription && !isUnderivableBusinessName(fromDescription)) {
    return fromDescription;
  }

  // Step 3, but only for a business that is not simply a person. For a
  // one-person portfolio the business IS the person, so their own name
  // outranks a hostname: "Darius Mihai" beats "Dmpresearch", which is a
  // subdomain their preview happens to sit on rather than anything they
  // trade under. `visitorIsTheBusiness` in `person-questions.ts` is defined
  // as "this rule landed on their own name", so the intake's question set and
  // the site's name are decided by one reading rather than two that can
  // disagree. `personalSiteAnswers` itself checks `options.personAnswered`
  // first (step 3a of the module doc above): a completed person section wins
  // even over an owned hostname, which is what makes this branch unreachable
  // for a visitor who has actually answered the block.
  const personal = personalSiteAnswers(
    answers,
    options.personAnswered ?? false
  );

  if (!personal && answers.websiteIsOwnSite === 'yes') {
    const fromWebsite = businessNameFromHostname(answers.websiteUrl ?? '');
    if (fromWebsite && !isUnderivableBusinessName(fromWebsite)) {
      return fromWebsite;
    }
  }

  if (personal && personName) return personName;

  if (answers.websiteIsOwnSite === 'yes') {
    const fromWebsite = businessNameFromHostname(answers.websiteUrl ?? '');
    if (fromWebsite && !isUnderivableBusinessName(fromWebsite)) {
      return fromWebsite;
    }
  }

  return personName;
}

/**
 * Whether these answers describe a person rather than a company.
 *
 * A local reading rather than a call into `person-questions.ts`, and
 * deliberately so: that module imports the codegen package's site-kind
 * classifier, this one is imported by the wizard's own client components, and
 * a cycle between the two would be paid for on every page load. `personAnswered`
 * crosses that boundary in the other direction instead -- `person-questions.ts`
 * already imports `deriveBusinessName` from here, so it is the one place that
 * can compute "has the person block said anything" and hand the answer down,
 * rather than this module reaching up for it.
 *
 * The rule, in order:
 *
 *   1. a business name given outright is never a person's site (unchanged);
 *   2. a completed person section is -- regardless of an owned hostname,
 *      because nobody answers six questions about themselves for a company
 *      that is not them;
 *   3. otherwise the narrow reading `visitorIsTheBusiness` has always used:
 *      no website they have claimed as their own, and a name given -- which
 *      is exactly the condition under which a hostname is the wrong thing to
 *      name somebody after.
 */
function personalSiteAnswers(
  answers: QuickBusinessNameAnswers,
  personAnswered: boolean
): boolean {
  if ((answers.businessName ?? '').trim()) return false;
  if (personAnswered) return true;
  const ownSite =
    (answers.websiteUrl ?? '').trim() && answers.websiteIsOwnSite === 'yes';
  if (ownSite) return false;
  return Boolean((answers.fullName ?? '').trim());
}

/**
 * True when `deriveBusinessName` cannot yet tell a company's owned site from
 * a person's, because the person block that would settle it has not run.
 *
 * Both readings are plausible here: the visitor claimed the one link as
 * their own, gave a name at step 1 (always required), and has not typed a
 * business name anywhere in the quick phase. Left alone, the naming rule
 * would fall back to the hostname -- today's behaviour for a company, and
 * exactly the wrong guess for somebody like a solo consultant whose "owned
 * site" is a personal domain. The intake's `nameOnSite` question in
 * `intake-script.ts` uses this to ask once, explicitly, rather than let the
 * person block's own gate guess and risk flipping the answer once it runs.
 */
export function ownedSiteNameIsAmbiguous(
  answers: QuickBusinessNameAnswers
): boolean {
  return (
    !(answers.businessName ?? '').trim() &&
    Boolean((answers.websiteUrl ?? '').trim()) &&
    answers.websiteIsOwnSite === 'yes' &&
    Boolean((answers.fullName ?? '').trim())
  );
}

/**
 * The most words a name extracted from the "what you do" answer may have
 * before this declines rather than guesses. A real business name is a
 * handful of words ("Arome Coffee", "The Blue Door Bakery"); a leading phrase
 * longer than this is almost always the rest of the sentence leaking through
 * because the visitor did not happen to use one of the delimiters below, and
 * a rule that guesses wrong loudly is worse than one that declines. A single
 * named constant rather than a literal inline, so the cap is one thing a
 * reviewer can see change rather than a number buried in a condition.
 */
export const MAX_DESCRIPTION_NAME_WORDS = 5;

/**
 * Openers that mean the sentence is talking ABOUT the business, not naming
 * it. Matched against the leading words only — "Arome Coffee" does not start
 * with the word "a", even though it starts with the letter — so a real name
 * that merely begins with one of these letters is never caught by mistake.
 */
const GENERIC_DESCRIPTION_OPENERS: ReadonlyArray<readonly string[]> = [
  ['i', 'am'],
  ['we', 'are'],
  ['a'],
  ['sunt'],
  ['suntem'],
];

/**
 * Where a stated name, if any, ends: a comma, a hyphen used as a separator
 * (surrounded by spaces, so "co-founder" is not split), an em/en dash
 * anywhere, or " is " / " este " (English and Romanian) as whole words.
 */
const DESCRIPTION_NAME_DELIMITERS = /,| - |[–—]| is | este /i;

/**
 * A business name stated in the "what you do" answer, or '' when nothing
 * there reads as one.
 *
 * A pure extractor, in the same spirit as `industryFromDescription`: it reads
 * the leading proper-noun phrase up to the first delimiter above, refuses
 * openers that mean the sentence is describing the business rather than
 * naming it, and refuses a phrase too long to plausibly be a name rather than
 * truncating it — silently cutting "Arome Coffee is a specialty roastery" at
 * five words would have produced "Arome Coffee Is A Specialty", which is not
 * a name either. "Arome Coffee, a specialty roastery in Cluj" derives "Arome
 * Coffee": the comma is the delimiter, and the leading phrase is short enough
 * and starts with neither an opener nor a bare letter.
 */
export function businessNameFromDescription(description: string): string {
  const text = (description ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const cut = DESCRIPTION_NAME_DELIMITERS.exec(text);
  const leading = (cut ? text.slice(0, cut.index) : text).trim();
  if (!leading) return '';

  const words = leading.split(/\s+/);
  if (words.length > MAX_DESCRIPTION_NAME_WORDS) return '';

  const lower = words.map((word) => word.toLowerCase());
  const isGenericOpener = GENERIC_DESCRIPTION_OPENERS.some((opener) =>
    opener.every((word, index) => lower[index] === word)
  );
  if (isGenericOpener) return '';

  return words.map(titleCaseWord).join(' ');
}

/**
 * One word, title-cased — and, because a hyphenated compound like "Well-Fed"
 * is one word by this module's own rule (only a *spaced* hyphen is a
 * delimiter), capitalised after an internal hyphen too, the same way a
 * proper name would be written.
 */
function titleCaseWord(word: string): string {
  return word
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('-');
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
 *
 * Exported for `intake-script.ts`'s `nameOnSite` question, which needs the
 * same candidate name to put in front of the visitor rather than a second,
 * possibly-drifting copy of this parsing.
 */
export function businessNameFromHostname(rawUrl: string): string {
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
