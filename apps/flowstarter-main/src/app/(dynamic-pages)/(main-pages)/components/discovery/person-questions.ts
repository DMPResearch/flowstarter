/**
 * Which visitors get asked who they are, and which of those questions they get.
 *
 * The intake asked four questions and none of them was about a person. That
 * is defensible for a plumbing company and indefensible for a portfolio,
 * which is a site whose entire subject is one human being. The portfolio this
 * module exists because of shipped with a stock graph for a hero, an empty
 * box where a face should be, and copy about "a studio" that was one person
 * who had never been asked a single thing about himself.
 *
 * So the conversation now has a person block. Everything about it is a rule:
 *
 * - **Who is asked.** Only a visitor whose site is about them. A plumber is
 *   never asked what they want people to feel, because a plumber's site is
 *   about a trade and a catchment area and a first-person life story on one
 *   is a genre mistake, not a missing feature. `asksPersonQuestions` is that
 *   rule and `siteKindFor` in the codegen package is the classifier, the same
 *   one that decides the page order, so a site cannot be a portfolio for one
 *   purpose and not for the other.
 * - **Which questions.** Not all of them, every time. A question whose answer
 *   the visitor has already given in another form is not asked again: that is
 *   what "keep the total intake short" means as code rather than as advice.
 * - **How many.** A visitor who skips two of these in a row is telling us
 *   something, and the block stops rather than asking nine more. `PERSON_
 *   BLOCK_SKIP_LIMIT` is that number and it is the friction rule for this
 *   block the way `quickRequiredCount` is the friction rule for the whole
 *   intake.
 *
 * Every question in the block is optional. None of them is `required`, none
 * of them moves `quickRequiredCount`, and none of them can stop a visitor
 * reaching a preview — the same shape the connect-photo offer already has.
 *
 * Nothing here touches React, the network or storage, and no model is
 * consulted. Rules decide.
 */
import {
  siteKindFor,
  type SiteKind,
} from '@flowstarter/agentic-codegen/src/flowstarter/page-set';
import type { DiscoveryData } from './discovery.logic';
import { deriveBusinessName } from './quick-defaults';

/**
 * The questions about the person, in the order the agent asks them.
 *
 * The order is the order a person tells you about themselves: who they are,
 * then how they work, then what they want you to feel, then the thing they
 * are proudest of. Tone words come last because they are the most abstract
 * ask in the block and the worst one to open with.
 */
export const PERSON_QUESTION_IDS = [
  'personStory',
  'personHowIWork',
  'personFeel',
  'personProudest',
  'personLinks',
  'personToneWords',
] as const;

/**
 * The questions about what they actually do.
 *
 * These are why the services page stops saying "bespoke solutions for
 * discerning clients". A site that cannot name the thing the person was hired
 * for last Tuesday has nothing to sell.
 */
export const ACTIVITY_QUESTION_IDS = [
  'activityWhat',
  'activityWho',
  'activityTypical',
  'activityKnownFor',
  'activityYears',
] as const;

export type PersonQuestionId =
  | (typeof PERSON_QUESTION_IDS)[number]
  | (typeof ACTIVITY_QUESTION_IDS)[number];

/** Both blocks, in the order they are asked. */
export const PERSON_BLOCK_IDS: readonly PersonQuestionId[] = [
  ...PERSON_QUESTION_IDS,
  ...ACTIVITY_QUESTION_IDS,
];

/**
 * How many of these a visitor may skip in a row before the block gives up.
 *
 * Two, because one skip is a question that did not land and two is an answer
 * about the whole block. The alternative is a visitor who wanted a website
 * being asked nine consecutive questions about their inner life, which is how
 * a funnel becomes a form again.
 */
export const PERSON_BLOCK_SKIP_LIMIT = 2;

/**
 * Enough of a "what you do" answer that asking the same thing again in the
 * activity block would read as not having listened.
 *
 * Roughly a full sentence. Below it the visitor typed a job title and the
 * activity question is the one that gets the real answer.
 */
export const ENOUGH_DESCRIPTION_CHARS = 60;

/**
 * Enough of an audience answer that "who do you do it for" is already
 * answered. Same reasoning, shorter: an audience is named in fewer words than
 * a trade is described in.
 */
export const ENOUGH_AUDIENCE_CHARS = 20;

/** Profile links already in hand that make the links question redundant. */
export const ENOUGH_PROFILE_LINKS = 2;

/**
 * How many of a person's links we are actually allowed to read.
 *
 * The count that matters, and not the same as how many they listed. A link
 * the client pasted so it could go in their footer is not permission to go
 * and fetch the page behind it, and `person-source.ts` will not touch one
 * without `consented`. Stated here rather than inside the fetcher so that
 * "nothing unconsented is read" is a property a test can assert without a
 * network in the room.
 */
export function consentedPersonLinkCount(
  person: { links: ReadonlyArray<{ consented: boolean }> } | null
): number {
  return (person?.links ?? []).filter((link) => link.consented).length;
}

// ---------------------------------------------------------------------------
// Who is asked
// ---------------------------------------------------------------------------

function collapsed(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * How the visitor described their line of work, as one string, which is what
 * `siteKindFor` reads. The industry chip and the free-text description in
 * either order, exactly as `derivePageSet` composes it, so the intake and the
 * page-set rule classify the same visitor the same way.
 */
export function businessTypeText(data: DiscoveryData): string {
  return `${collapsed(data.industry)} ${collapsed(data.description)}`.trim();
}

/**
 * True when the visitor IS the business.
 *
 * Asked of `deriveBusinessName` rather than reasoned about again here, and
 * that is the whole trick: the name rule already walks every signal a visitor
 * has given -- a name they typed, a name stated in their own sentence, the
 * hostname of a site they claimed -- and it falls through to their own name
 * only when none of those produced a business. So "the derivation landed on
 * the person" is precisely "there is no entity here but the person", and the
 * two rules cannot drift apart, because there is only one of them.
 *
 * It matters that this is not a second opinion. If the intake decided a
 * visitor was a person and the name rule decided they were a company, a
 * freelancer would be asked six questions about themselves and then have
 * somebody else's name put on their website, which is a worse outcome than
 * either rule produces on its own.
 */
export function visitorIsTheBusiness(data: DiscoveryData): boolean {
  const fullName = collapsed(data.fullName).toLowerCase();
  if (!fullName) return false;
  return collapsed(deriveBusinessName(data)).toLowerCase() === fullName;
}

/**
 * Whether this visitor's site is about a person.
 *
 * `siteKindFor` answers it for the trade ("photographer", "designer",
 * "illustrator"); `visitorIsTheBusiness` answers it for everybody whose trade
 * is not on that list but who is nonetheless the only person in the business.
 * An accountant working alone gets the person block; an accountancy firm with
 * a name does not.
 */
export function intakeSiteKind(data: DiscoveryData): SiteKind {
  if (siteKindFor(businessTypeText(data)) === 'portfolio') return 'portfolio';
  return visitorIsTheBusiness(data) ? 'portfolio' : 'services';
}

/** The gate on the whole block. A plumbing company answers `false` here. */
export function asksPersonQuestions(data: DiscoveryData): boolean {
  return intakeSiteKind(data) === 'portfolio';
}

// ---------------------------------------------------------------------------
// Which questions
// ---------------------------------------------------------------------------

/** How many profile links the visitor has already handed over. */
export function profileLinkCount(data: DiscoveryData): number {
  return [
    collapsed(data.instagramUrl),
    collapsed(data.linkedinUrl),
    collapsed(data.websiteUrl),
    collapsed(data.personLinks),
  ].filter(Boolean).length;
}

/**
 * Questions whose answer the visitor has already given elsewhere.
 *
 * Each entry is one redundancy and each one is worth stating out loud,
 * because "we already know this" is the only honest reason not to ask
 * something that would otherwise be useful.
 */
function alreadyAnswered(id: PersonQuestionId, data: DiscoveryData): boolean {
  switch (id) {
    // The links question in the quick intake already asks for profiles, and
    // asking a second time for the same three URLs is how a conversation
    // reads as a form.
    case 'personLinks':
      return profileLinkCount(data) >= ENOUGH_PROFILE_LINKS;
    // The tone chips, when the visitor picked any.
    case 'personToneWords':
      return collapsed(data.brandTone).length > 0;
    // "What does your business actually do" is the third required question,
    // and a visitor who answered it properly has already said what they do.
    case 'activityWhat':
      return collapsed(data.description).length >= ENOUGH_DESCRIPTION_CHARS;
    case 'activityWho':
      return collapsed(data.targetAudience).length >= ENOUGH_AUDIENCE_CHARS;
    default:
      return false;
  }
}

/**
 * How many questions in the block the visitor has skipped in a row, reading
 * back from the most recent one they dealt with.
 *
 * A skip is an answered question with nothing stored against it, which is
 * exactly how the script records one everywhere else.
 */
export function trailingSkips(
  data: DiscoveryData,
  answered: readonly string[],
  valueOf: (id: PersonQuestionId) => string
): number {
  let run = 0;
  for (let i = answered.length - 1; i >= 0; i -= 1) {
    const id = answered[i] as PersonQuestionId;
    if (!PERSON_BLOCK_IDS.includes(id)) break;
    if (valueOf(id)) break;
    run += 1;
  }
  return run;
}

/**
 * The rule the script's `when` predicates call: is this person question asked
 * of this visitor, given everything they have said so far.
 *
 * Three conditions, in the order they matter:
 *
 *   1. the site is about a person at all;
 *   2. the visitor has not already skipped their way out of the block;
 *   3. this particular answer is not already in hand.
 */
export function personQuestionApplies(
  id: PersonQuestionId,
  data: DiscoveryData,
  answered: readonly string[],
  valueOf: (questionId: PersonQuestionId) => string
): boolean {
  if (!asksPersonQuestions(data)) return false;
  if (trailingSkips(data, answered, valueOf) >= PERSON_BLOCK_SKIP_LIMIT) {
    return false;
  }
  return !alreadyAnswered(id, data);
}
