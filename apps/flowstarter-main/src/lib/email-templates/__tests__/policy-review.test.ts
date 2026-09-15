/**
 * The operator's "A brief needs your review" email.
 *
 * Before this template existed, `@/lib/policy/review`'s `recordPolicyOutcome`
 * wrote a `review` row to `policy_reviews` and nothing told anybody: the row
 * just sat on the board. What is asserted here mirrors
 * `custom-work.test.ts`'s house style for the sibling email: every rule that
 * can actually produce a `review` verdict renders one plain sentence and
 * nothing that looks like a rule id, a tier name or a raw number; the brief
 * is quoted as it is; and the primary link and button both open the review's
 * own place on the admin board.
 */
import { describe, expect, it } from 'vitest';
import { policyReviewOperatorEmail } from '../policy-review';

const DECIMAL_NUMBER = /\d+\.\d+/;
const RAW_FIELD_LABELS = /\bConfidence\b|\bTier\b|\bRule\b/;

const REVIEW_URL =
  'https://flowstarter.net/admin/dashboard/projects/ws-1#policy-review-review-1';

const BASE = {
  categoryId: 'none',
  categoryLabel: 'No policy category',
  briefText: 'We sell prescription medication online across Romania.',
  reviewUrl: REVIEW_URL,
} as const;

describe('policyReviewOperatorEmail, one sentence per rule', () => {
  it.each([
    {
      rule: 'sensitive_lawful',
      categoryId: 'licensed_pharmacy',
      categoryLabel: 'Licensed pharmacy or medicine retail',
      sentence:
        'The brief describes a licensed pharmacy, which we build only after a person checks it.',
    },
    {
      rule: 'prohibited_uncertain',
      categoryId: 'illegal_drugs',
      categoryLabel: 'Illegal drugs and controlled substances',
      sentence:
        'The brief may describe illegal drugs, and the classifier was not sure enough to refuse it on its own.',
    },
    {
      rule: 'unknown_category',
      categoryId: 'none',
      categoryLabel: 'No policy category',
      sentence:
        'The classifier flagged this brief but could not match it to a known category, so a person reads it instead.',
    },
    {
      rule: 'needs_human_flag',
      categoryId: 'none',
      categoryLabel: 'No policy category',
      sentence:
        'The classifier flagged this brief for a person to check, without naming a category.',
    },
    {
      rule: 'clean_but_abstained',
      categoryId: 'none',
      categoryLabel: 'No policy category',
      sentence:
        'The classifier could not confidently call this brief clean, so a person checks it before anything is built.',
    },
    {
      rule: 'classifier_failed_closed',
      categoryId: 'none',
      categoryLabel: 'No policy category',
      sentence:
        'We could not classify this brief automatically, so nothing was generated.',
    },
    {
      // Not wired up anywhere yet (a separate PR in progress adds it
      // alongside `classifier_failed_closed`); this template already knows
      // what to say when it lands.
      rule: 'classifier_unavailable',
      categoryId: 'none',
      categoryLabel: 'No policy category',
      sentence:
        'We could not classify this brief automatically, so nothing was generated.',
    },
    {
      rule: 'scope_visitor_disagrees_with_classifier',
      categoryId: 'none',
      categoryLabel: 'No policy category',
      sentence:
        'The visitor says this is a site that presents their business, and the classifier is confident it is software instead.',
    },
    {
      rule: 'scope_unresolved_after_question',
      categoryId: 'none',
      categoryLabel: 'No policy category',
      sentence:
        'The visitor answered the clarifying question and the brief is still unclear',
    },
  ])(
    '$rule reads as one plain sentence, no code, no number',
    ({ rule, categoryId, categoryLabel, sentence }) => {
      const mail = policyReviewOperatorEmail({
        ...BASE,
        rule,
        categoryId,
        categoryLabel,
      });

      expect(mail.text).toContain(sentence);
      expect(mail.text).not.toMatch(DECIMAL_NUMBER);
      expect(mail.html).not.toMatch(RAW_FIELD_LABELS);
      expect(mail.text).not.toMatch(RAW_FIELD_LABELS);
      // The rule id and the raw category id are lookup keys, never copy.
      expect(mail.html).not.toContain(rule);
      expect(mail.text).not.toContain(rule);
      if (categoryId !== 'none') {
        expect(mail.text).not.toContain(categoryId);
      }
    }
  );

  it('falls back to a true, unspecific sentence for a rule it does not recognise', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'someFutureRule',
      categoryId: 'none',
      categoryLabel: 'No policy category',
    });
    expect(mail.text).toContain(
      'The policy gate held this brief for a person to check.'
    );
    expect(mail.text).not.toContain('someFutureRule');
  });

  it('falls back to the category label, lowercased, for a category this template has not been taught a mention for', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'sensitive_lawful',
      categoryId: 'some_future_category',
      categoryLabel: 'Some Future Category',
    });
    expect(mail.text).toContain(
      'The brief describes some future category, which we build only after a person checks it.'
    );
  });
});

describe('policyReviewOperatorEmail, the primary link', () => {
  it('points the button and primary link at the review on the board', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'sensitive_lawful',
      categoryId: 'licensed_pharmacy',
      categoryLabel: 'Licensed pharmacy or medicine retail',
    });
    expect(mail.html).toContain(`href="${REVIEW_URL}"`);
    expect(mail.text).toContain(`Open this review: ${REVIEW_URL}`);
  });
});

describe('policyReviewOperatorEmail, the brief and contact details', () => {
  it('quotes the brief as it is', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'sensitive_lawful',
      categoryId: 'licensed_pharmacy',
      categoryLabel: 'Licensed pharmacy or medicine retail',
    });
    expect(mail.text).toContain(BASE.briefText);
  });

  it('renders no quote block when there is no brief text', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'sensitive_lawful',
      categoryId: 'licensed_pharmacy',
      categoryLabel: 'Licensed pharmacy or medicine retail',
      briefText: '',
    });
    // The dark-mode stylesheet always defines `.fs-quote` as a CSS rule; only
    // the rendered block itself proves whether a quote was drawn.
    expect(mail.html).not.toContain('class="fs-quote"');
  });

  it('includes contact details when present', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'sensitive_lawful',
      categoryId: 'licensed_pharmacy',
      categoryLabel: 'Licensed pharmacy or medicine retail',
      contactName: 'Ana Popescu',
      contactEmail: 'ana@example.com',
    });
    expect(mail.text).toContain('Name: Ana Popescu');
    expect(mail.text).toContain('Email: ana@example.com');
  });

  it('omits the facts block entirely when there is no contact to show', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'sensitive_lawful',
      categoryId: 'licensed_pharmacy',
      categoryLabel: 'Licensed pharmacy or medicine retail',
    });
    expect(mail.text).not.toContain('Name:');
    expect(mail.text).not.toContain('Email:');
  });

  it('renders the link as its own labelled fact row, never folded into the quote', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'sensitive_lawful',
      categoryId: 'licensed_pharmacy',
      categoryLabel: 'Licensed pharmacy or medicine retail',
      linkUrl: 'https://instagram.com/farmaciasperantei',
      linkLabel: 'Their profile',
    });
    expect(mail.text).toContain(
      'Their profile: https://instagram.com/farmaciasperantei'
    );
    // The link is a fact, not part of what is quoted.
    const quoteText = mail.text.split('Their profile:')[0];
    expect(quoteText).not.toContain('instagram.com');
  });

  it('labels the link row "Their link" when the caller sends no label', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'sensitive_lawful',
      categoryId: 'licensed_pharmacy',
      categoryLabel: 'Licensed pharmacy or medicine retail',
      linkUrl: 'https://example.com',
    });
    expect(mail.text).toContain('Their link: https://example.com');
  });

  it('shows the facts block for a link alone, with no name or email', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'sensitive_lawful',
      categoryId: 'licensed_pharmacy',
      categoryLabel: 'Licensed pharmacy or medicine retail',
      linkUrl: 'https://example.com',
    });
    expect(mail.text).not.toContain('Name:');
    expect(mail.text).not.toContain('Email:');
    expect(mail.text).toContain('Their link:');
  });
});

describe('policyReviewOperatorEmail, never the composed classifier subject', () => {
  // The defect this template's callers exist to not repeat: `intakeSubject`'s
  // composed block ("What the business does: ... Link hostname: ...")
  // reaching this quote instead of the visitor's own words. The real fix
  // lives at the call site (`gate.ts`'s `ScreenInput.briefText` and its six
  // callers, asserted in their own suites); this pins the visitor's actual
  // sentence surviving untouched, with the link as its own fact row instead
  // of folded into the composed block the bug used to render.
  it('quotes the visitor description verbatim when the caller sends it, not a composed block', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'sensitive_lawful',
      categoryId: 'licensed_pharmacy',
      categoryLabel: 'Licensed pharmacy or medicine retail',
      briefText: 'I need a website for my business.',
      linkUrl: 'https://instagram.com',
      linkLabel: 'Their profile',
    });
    expect(mail.text).toContain('I need a website for my business.');
    expect(mail.text).not.toContain('What the business does:');
    expect(mail.text).not.toContain('Link hostname:');
  });
});

describe('policyReviewOperatorEmail, what happens next', () => {
  it('states the review stays open until a decision', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'sensitive_lawful',
      categoryId: 'licensed_pharmacy',
      categoryLabel: 'Licensed pharmacy or medicine retail',
    });
    expect(mail.text).toContain(
      'It stays open until an operator approves or refuses it.'
    );
  });
});

describe('policyReviewOperatorEmail, the subject line', () => {
  it('summarises the reason in one line', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'sensitive_lawful',
      categoryId: 'licensed_pharmacy',
      categoryLabel: 'Licensed pharmacy or medicine retail',
    });
    expect(mail.subject).toBe(
      'A brief needs your review: a lawful but sensitive brief'
    );
  });
});

describe('policyReviewOperatorEmail, house style', () => {
  it('has no em dash, no emoji, and no marketing tone', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'sensitive_lawful',
      categoryId: 'licensed_pharmacy',
      categoryLabel: 'Licensed pharmacy or medicine retail',
    });
    expect(mail.html).not.toMatch(/[—–]/);
    expect(mail.text).not.toMatch(/[—–]/);
    expect(mail.html).not.toMatch(/[←-⯿]|️|[\uD83C-\uD83E][\uDC00-\uDFFF]/);
  });

  it('carries the same brand header every operator email uses', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'sensitive_lawful',
      categoryId: 'licensed_pharmacy',
      categoryLabel: 'Licensed pharmacy or medicine retail',
    });
    expect(mail.html).toContain('Flowstarter');
    expect(mail.html).toContain('<!DOCTYPE html>');
  });

  it('renders the pharmacy example end to end (snapshot)', () => {
    const mail = policyReviewOperatorEmail({
      rule: 'sensitive_lawful',
      categoryId: 'licensed_pharmacy',
      categoryLabel: 'Licensed pharmacy or medicine retail',
      briefText:
        'We are Farmacia Sperantei, a licensed pharmacy in Cluj. We want a site where regular customers can reorder their repeat prescriptions.',
      contactName: 'Ana Popescu',
      contactEmail: 'ana@farmaciasperantei.ro',
      reviewUrl: REVIEW_URL,
    });
    expect(mail.text).toMatchSnapshot();
  });
});

describe('policyReviewOperatorEmail, no classifier evidence field to leak', () => {
  // The sibling of #191's bug on the scope head (`customWorkOperatorEmail`)
  // would be this template quoting `PolicyClassification.evidence` -- a
  // sentence that, on the sigma path, used to be a reason code like
  // `confident:acceptable_use:prostitution_escort:semantic` before the fix in
  // `@/lib/policy/classifier`. This template never took an `evidence`
  // parameter at all: `categoryId`/`categoryLabel` pick a fixed, written
  // sentence from `RULE_REASON`/`CATEGORY_MENTION`, and the only free text it
  // ever prints is `briefText`, quoted as it is. This test pins that down so
  // it stays true if the template is ever extended.
  const REASON_CODE = 'confident:acceptable_use:prostitution_escort:semantic';

  it('has no evidence parameter in its input type', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'sensitive_lawful',
      categoryId: 'licensed_pharmacy',
      categoryLabel: 'Licensed pharmacy or medicine retail',
      // @ts-expect-error -- `evidence` is not part of this template's input;
      // passing it must be a type error, not a silently ignored field.
      evidence: [REASON_CODE],
    });
    expect(mail.text).not.toContain(REASON_CODE);
    expect(mail.html).not.toContain(REASON_CODE);
  });

  it('never renders a reason code even when the category and brief are adversarial', () => {
    const mail = policyReviewOperatorEmail({
      ...BASE,
      rule: 'unknown_category',
      categoryId: REASON_CODE,
      categoryLabel: REASON_CODE,
      briefText: 'An ordinary brief about a bakery website.',
    });
    // `unknown_category`'s sentence never reads `mention` at all -- see
    // `RULE_REASON` -- so even a category id shaped like a reason code cannot
    // reach the rendered text through it.
    expect(mail.text).not.toContain(REASON_CODE);
    expect(mail.html).not.toContain(REASON_CODE);
  });
});
