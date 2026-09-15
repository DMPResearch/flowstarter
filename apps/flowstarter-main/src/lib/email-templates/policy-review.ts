/**
 * The operator's "A brief needs your review" email.
 *
 * The companion `customWorkOperatorEmail` (`./custom-work.ts`) exists for one
 * queue -- a brief that is custom work rather than a site to generate. This is
 * for the other one: `policy_reviews`, written by `@/lib/policy/review`'s
 * `recordPolicyOutcome` whenever a verdict is `review` rather than `allow` or
 * `refuse` -- a category real enough to want a licence checked, a classifier
 * that could not answer, or a scope disagreement the funnel could not settle
 * on its own (`@/lib/flowstarter/scope-route`'s two review rules).
 *
 * Before this template existed, none of that reached an inbox. The row sat on
 * the board, open, and the only way to learn it was there was to go and look.
 *
 * Same rules as the custom-work email, because it is the same kind of
 * message: one plain sentence for why, chosen by the rule that opened the row
 * (and, where the rule is a category verdict, the category); no reason codes,
 * no tier names, no raw numbers; the brief quoted as it is, when there is one
 * to quote; the primary link opens the review's own place on the board.
 */
import { renderEmail, type RenderedEmail } from './base';

interface ReviewReason {
  /** A few words for the subject line. Never a full sentence. */
  subjectSummary: string;
  /** The one sentence the email opens with. `mention` is set only for a category-driven rule. */
  sentence: (mention: string) => string;
}

/**
 * A short, sayable noun phrase for a category -- distinct from
 * `PolicyCategory.label` in `@/lib/policy/acceptable-use`, which is written
 * for a list ("Licensed pharmacy or medicine retail") and reads awkwardly
 * dropped into a sentence. This is the same category, said the way a person
 * would say it out loud.
 */
const CATEGORY_MENTION: Record<string, string> = {
  licensed_pharmacy: 'a licensed pharmacy',
  legal_cannabis: 'legal cannabis',
  firearms_training: 'firearms training',
  sexual_health_clinic: 'a sexual health clinic',
  licensed_betting: 'licensed betting',
  adult_adjacent_lawful: 'a lawful adult-adjacent business',
  illegal_drugs: 'illegal drugs',
  sexual_services: 'sexual services',
  adult_content: 'adult content',
  weapons_sales: 'weapons sales',
  unlicensed_gambling: 'unlicensed gambling',
  counterfeit_goods: 'counterfeit goods',
  hate_or_harassment: 'hate or harassment',
  scams_impersonation: 'a scam or impersonation',
  unlicensed_claims: 'unlicensed medical or financial claims',
};

/**
 * One sentence per `PolicyRule` that can actually produce a `review` verdict
 * (`decide()` in `@/lib/policy/acceptable-use`: `sensitive_lawful`,
 * `prohibited_uncertain`, `unknown_category`, `needs_human_flag`,
 * `clean_but_abstained`, `classifier_failed_closed`; plus
 * `classifier_unavailable`, a hold a classifier-availability change is adding
 * alongside `classifier_failed_closed`; plus the scope gate's own two,
 * `scope_visitor_disagrees_with_classifier` and
 * `scope_unresolved_after_question`, opened by `openScopeReview` in
 * `@/lib/flowstarter/scope-gate`). Anything else falls through to
 * `FALLBACK_REVIEW_REASON`, which stays true without naming the rule.
 */
const RULE_REASON: Record<string, ReviewReason> = {
  sensitive_lawful: {
    subjectSummary: 'a lawful but sensitive brief',
    sentence: (mention) =>
      `The brief describes ${mention}, which we build only after a person checks it.`,
  },
  prohibited_uncertain: {
    subjectSummary: 'a brief that may be prohibited',
    sentence: (mention) =>
      `The brief may describe ${mention}, and the classifier was not sure enough to refuse it on its own.`,
  },
  unknown_category: {
    subjectSummary: 'a brief the classifier could not place',
    sentence: () =>
      'The classifier flagged this brief but could not match it to a known category, so a person reads it instead.',
  },
  needs_human_flag: {
    subjectSummary: 'a brief the classifier flagged',
    sentence: () =>
      'The classifier flagged this brief for a person to check, without naming a category.',
  },
  clean_but_abstained: {
    subjectSummary: 'a brief the classifier was unsure about',
    sentence: () =>
      'The classifier could not confidently call this brief clean, so a person checks it before anything is built.',
  },
  classifier_failed_closed: {
    subjectSummary: 'a brief nothing could classify',
    sentence: () =>
      'We could not classify this brief automatically, so nothing was generated.',
  },
  classifier_unavailable: {
    subjectSummary: 'a brief nothing could classify',
    sentence: () =>
      'We could not classify this brief automatically, so nothing was generated.',
  },
  scope_visitor_disagrees_with_classifier: {
    subjectSummary: 'a visitor and the classifier disagree',
    sentence: () =>
      'The visitor says this is a site that presents their business, and the classifier is confident it is software instead. They are continuing to their preview either way.',
  },
  scope_unresolved_after_question: {
    subjectSummary: 'a brief still unclear after the question',
    sentence: () =>
      'The visitor answered the clarifying question and the brief is still unclear, so a person reads it while they continue to their preview.',
  },
};

const FALLBACK_REVIEW_REASON: ReviewReason = {
  subjectSummary: 'a brief needs a person',
  sentence: () => 'The policy gate held this brief for a person to check.',
};

function reviewReasonFor(rule: string): ReviewReason {
  return RULE_REASON[rule] ?? FALLBACK_REVIEW_REASON;
}

export function policyReviewOperatorEmail(input: {
  /** Which rule in `decide()`, or the scope gate's own two, opened this row. */
  rule: string;
  /** The category id the verdict carries. `'none'` for a rule with no category. */
  categoryId: string;
  /** `PolicyCategory.label`. Used only as the fallback mention, never printed as-is. */
  categoryLabel: string;
  /** The exact text that was classified, quoted as it is. Empty renders no quote. */
  briefText: string;
  contactName?: string | null;
  contactEmail?: string | null;
  /** The review's own place on the admin board. The primary link and the button's target. */
  reviewUrl: string;
}): RenderedEmail {
  const reason = reviewReasonFor(input.rule);
  const mention =
    CATEGORY_MENTION[input.categoryId] ?? input.categoryLabel.toLowerCase();
  const sentence = reason.sentence(mention);
  const name = input.contactName?.trim();
  const email = input.contactEmail?.trim();
  const brief = input.briefText.trim();

  return renderEmail({
    subject: `A brief needs your review: ${reason.subjectSummary}`,
    preheader: sentence,
    blocks: [
      { kind: 'heading', text: 'A brief needs your review' },
      { kind: 'paragraph', content: sentence },
      {
        kind: 'paragraph',
        content: 'It stays open until an operator approves or refuses it.',
      },
      ...(brief ? [{ kind: 'quote' as const, text: brief }] : []),
      ...(name || email
        ? [
            {
              kind: 'facts' as const,
              rows: [
                { label: 'Name', value: name ?? '' },
                { label: 'Email', value: email ?? '' },
              ],
            },
          ]
        : []),
      { kind: 'button', label: 'Open this review', href: input.reviewUrl },
    ],
  });
}
