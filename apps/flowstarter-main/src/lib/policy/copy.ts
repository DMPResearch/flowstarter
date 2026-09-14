/**
 * What we say when the gate stops someone.
 *
 * Pure, so a test can read the exact sentence a stranger will read, and so the
 * six enforcement points all say the same thing.
 *
 * The tone is set deliberately. A refusal is the worst moment in the funnel
 * and most of the people who hit it are not criminals: they are a lingerie
 * shop, a pharmacy, or someone whose four-word description read badly. So the
 * copy is polite, it names the policy in one sentence, it links to the clause,
 * and it offers a person. It does not lecture, it does not accuse, and it
 * never repeats the visitor's own words back at them.
 *
 * House rules: no em dashes, no emoji.
 */

import type { PolicyCategory, PolicyDecision } from './acceptable-use';

/** The anchor on `/terms`. The heading there carries this id. */
export const ACCEPTABLE_USE_ANCHOR = '/terms#acceptable-use';
export const CONTACT_HREF = '/contact';

export interface PolicyNotice {
  /** A short heading, for a card or a dialog. */
  title: string;
  /** The sentence that names the policy. */
  message: string;
  /** What happens next, in one sentence. */
  next: string;
  termsHref: string;
  contactHref: string;
  /** Machine-readable, for a client that branches rather than renders. */
  decision: PolicyDecision;
  categoryId: string;
}

/**
 * The refusal. One sentence of policy, one of consequence, one door out.
 *
 * The category label is included because vagueness here is cruel: "we cannot
 * help with this" leaves a lingerie shop guessing, while "adult content and
 * its promotion" tells them we read them wrong and that the contact link is
 * worth using.
 */
export function refusalNotice(category: PolicyCategory): PolicyNotice {
  return {
    title: 'We cannot build this one',
    message: `Our acceptable-use policy does not allow us to build sites for ${category.label.toLowerCase()}, so we have stopped here and nothing has been charged.`,
    next: 'If we have read your business wrong, tell us what you do and a person will look at it.',
    termsHref: ACCEPTABLE_USE_ANCHOR,
    contactHref: CONTACT_HREF,
    decision: 'refuse',
    categoryId: category.id,
  };
}

/**
 * The review. Not a refusal, and it must not read like one: this is where the
 * pharmacy and the licensed bookmaker land, and they are customers.
 */
export function reviewNotice(category: PolicyCategory): PolicyNotice {
  return {
    title: 'One of us needs to look at this first',
    message:
      'Your business sits close enough to our acceptable-use policy that a person checks it rather than a machine deciding, so we have paused here and nothing has been charged.',
    next: 'We usually come back the same working day. You can add anything that helps, such as a licence number, through the contact page.',
    termsHref: ACCEPTABLE_USE_ANCHOR,
    contactHref: CONTACT_HREF,
    decision: 'review',
    categoryId: category.id,
  };
}

/** The notice for a verdict, or `null` when the verdict allows. */
export function noticeFor(input: {
  decision: PolicyDecision;
  category: PolicyCategory;
}): PolicyNotice | null {
  if (input.decision === 'refuse') return refusalNotice(input.category);
  if (input.decision === 'review') return reviewNotice(input.category);
  return null;
}

/**
 * The same refusal as one paragraph, for surfaces with no room for a card:
 * an email body, a plain-text API message, a build log line.
 */
export function noticeParagraph(notice: PolicyNotice): string {
  return `${notice.message} ${notice.next} You can read the acceptable-use section of our terms at ${notice.termsHref} or reach us at ${notice.contactHref}.`;
}
