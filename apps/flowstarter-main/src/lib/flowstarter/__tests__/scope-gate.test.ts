/**
 * The gate end to end, with the classifier swapped out through the seam that
 * exists for the sigma package.
 *
 * What is asserted: which route each verdict produces, that a lead row is
 * written with the classifier's own evidence on it, that both emails go, that
 * the clarifying question is asked once and once only, and that a `self-serve`
 * answer files nothing and mails nobody.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

interface SentEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}
const sendEmail = vi.fn<
  (input: SentEmail) => Promise<{ success: boolean; error?: string }>
>(async () => ({ success: true }));
/** Switchable: a deployment with no operator address is a real state. */
const operatorEmail = { value: 'ops@flowstarter.net' };
vi.mock('@/lib/email', () => ({
  sendEmail: (input: SentEmail) => sendEmail(input),
  resolveOperatorNotifyEmail: () => operatorEmail.value,
}));

/**
 * The acceptable-use gate (PR #158) reaches a classifier and Supabase, so it is
 * stubbed here. `runScopeGate` calls it for real; what this file is about is
 * what the scope gate does with each answer.
 */
const policyDecision = { value: 'allow' as 'allow' | 'review' | 'refuse' };
interface ScreenCall {
  surface: string;
  text: string;
  locale?: string;
}
const screenAcceptableUse = vi.fn(async (_input: ScreenCall) => ({
  verdict: { decision: policyDecision.value },
  blocked: policyDecision.value !== 'allow',
  notice: null,
  reviewId: null,
}));
vi.mock('@/lib/policy/gate', () => ({
  screenAcceptableUse: (input: ScreenCall) => screenAcceptableUse(input),
}));

const insertedRows: Array<Record<string, unknown>> = [];
const updatedRows: Array<Record<string, unknown>> = [];
/**
 * Every insert, with the table it went to.
 *
 * `insertedRows` is the custom-work lane and stays that way so the assertions
 * about leads keep reading one list. The acceptable-use review rows the scope
 * gate now opens go to a different table, and a test that could not tell them
 * apart would let "filed a lead" and "asked an operator to read it" pass for
 * each other.
 */
const insertedByTable: Array<{
  table: string;
  values: Record<string, unknown>;
}> = [];
const policyRows = () =>
  insertedByTable
    .filter((row) => row.table === 'policy_reviews')
    .map((row) => row.values);
/* eslint-disable @typescript-eslint/no-explicit-any */
const supabase = {
  from: vi.fn((table: string) => ({
    insert: (values: Record<string, unknown>) => {
      insertedByTable.push({ table, values });
      if (table === 'custom_work_leads') insertedRows.push(values);
      return {
        select: () => ({
          single: async () => ({ data: { id: 'lead-1' }, error: null }),
          maybeSingle: async () => ({ data: { id: 'review-1' }, error: null }),
        }),
      };
    },
    update: (values: Record<string, unknown>) => {
      updatedRows.push(values);
      return { eq: async () => ({ error: null }) };
    },
  })),
} as any;
/* eslint-enable @typescript-eslint/no-explicit-any */
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => supabase,
}));

import {
  resetScopeClassifier,
  setScopeClassifier,
  type ScopeClassification,
} from '../scope-classifier';
import {
  SCOPE_QUESTION_KEY,
  fileCustomWorkEnquiry,
  readLinkTitle,
  runScopeGate,
} from '../scope-gate';

const BRIEF = {
  fullName: 'Sarah Smith',
  email: 'sarah@example.com',
  description: 'A portal my customers log into to track their orders',
  websiteUrl: 'https://acme.example.com',
};

/** No test in this tree makes a network request. */
const noNetwork = {
  read: vi.fn(async () => ({
    status: 'exposed' as const,
    network: 'website' as const,
    url: 'https://acme.example.com',
    title: 'Acme - Client Portal Login',
    description: null,
    imageUrl: null,
  })),
};

function classifierSaying(
  partial: Partial<ScopeClassification>
): ScopeClassification {
  return {
    scope: 'custom',
    confidence: 0.95,
    evidence: ['customers log into'],
    classifier: 'test',
    // The default reads as "confidently decided", matching what 0.95 used to
    // mean to `decideRoute` on its own before `decided` existed. A row that
    // wants to prove the two are independent overrides this explicitly.
    decided: true,
    ...partial,
  };
}

const seen: string[] = [];

beforeEach(() => {
  insertedRows.length = 0;
  insertedByTable.length = 0;
  updatedRows.length = 0;
  seen.length = 0;
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ success: true });
  operatorEmail.value = 'ops@flowstarter.net';
  noNetwork.read.mockClear();
  screenAcceptableUse.mockClear();
  policyDecision.value = 'allow';
  process.env.CAL_BASE_URL = 'https://cal.flowstarter.dev';
});

afterEach(() => {
  resetScopeClassifier();
  delete process.env.CAL_BASE_URL;
  delete process.env.DMPRESEARCH_DISCOVERY_CAL_URL;
});

describe('runScopeGate on a custom brief', () => {
  beforeEach(() => {
    setScopeClassifier(async (text) => {
      seen.push(text);
      return classifierSaying({});
    });
  });

  it('routes to the discovery call and hands back a prefilled booking URL', async () => {
    const result = await runScopeGate(BRIEF, noNetwork);
    expect(result.route).toBe('discovery-call');
    const url = new URL(result.bookingUrl!);
    expect(url.host).toBe('cal.flowstarter.dev');
    expect(url.searchParams.get('name')).toBe('Sarah Smith');
    expect(url.searchParams.get('email')).toBe('sarah@example.com');
  });

  it('shows the classifier the answers and the title of the linked page', async () => {
    await runScopeGate(BRIEF, noNetwork);
    expect(seen[0]).toContain('A portal my customers log into');
    expect(seen[0]).toContain('https://acme.example.com');
    expect(seen[0]).toContain('Acme - Client Portal Login');
    // The email is not evidence about scope and would make every hash unique.
    expect(seen[0]).not.toContain('sarah@example.com');
  });

  it('files a lead carrying the verdict, the evidence and the route', async () => {
    const result = await runScopeGate(BRIEF, noNetwork);
    expect(result.leadId).toBe('lead-1');
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      name: 'Sarah Smith',
      email: 'sarah@example.com',
      description: BRIEF.description,
      link_url: 'https://acme.example.com',
      link_title: 'Acme - Client Portal Login',
      scope: 'custom',
      scope_confidence: 0.95,
      scope_evidence: ['customers log into'],
      classifier: 'test',
      route: 'discovery-call',
      route_rule: 'customAboveThreshold',
      source: 'funnel',
      booking_status: 'offered',
    });
  });

  it('sends the visitor a branded confirmation and the operator the brief', async () => {
    await runScopeGate(BRIEF, noNetwork);
    expect(sendEmail).toHaveBeenCalledTimes(2);

    const visitor = sendEmail.mock.calls.find(
      (call) => call[0].to === 'sarah@example.com'
    )![0];
    expect(visitor.subject).toContain('DMPResearch');
    expect(visitor.html).toContain('custom work');
    // Both halves are rendered from the same blocks, so neither can drift.
    expect(visitor.text).toContain('DMPResearch');
    expect(visitor.html).toContain('cal.flowstarter.dev');

    const operator = sendEmail.mock.calls.find(
      (call) => call[0].to === 'ops@flowstarter.net'
    )![0];
    expect(operator.subject).toContain('Sarah Smith');
    expect(operator.text).toContain('customers log into');
  });

  it('points the operator email at the lead on the admin board, not the visitor’s own site', async () => {
    // Darius's own objection to PR #162's email: raw internals (a cosine
    // margin printed as a confidence, "Scope: standard" beside "Route:
    // discovery-call") and, once fixed, a request that the one clickable link
    // open the lead on the board rather than the visitor's Instagram or site.
    const result = await runScopeGate(BRIEF, noNetwork);
    const operator = sendEmail.mock.calls.find(
      (call) => call[0].to === 'ops@flowstarter.net'
    )![0];
    expect(operator.html).toContain(`#custom-work-lead-${result.leadId}"`);
    expect(operator.text).toContain(`custom-work-lead-${result.leadId}`);
    // The button is the primary link, and it is the board, never the site.
    expect(operator.html).not.toContain(`href="${BRIEF.websiteUrl}"`);
    // No raw internals: no reason code, no rule id, no confidence number.
    expect(operator.text).not.toMatch(/\bConfidence\b|\bRoute\b/);
    expect(operator.text).not.toContain('customAboveThreshold');
    expect(operator.text).not.toMatch(/\d\.\d\d\b/);
    // The visitor's own site is still there, as a labelled fact, not the link.
    expect(operator.text).toContain(`Their site: ${BRIEF.websiteUrl}`);
  });

  it('records that the confirmation actually reached them', async () => {
    await runScopeGate(BRIEF, noNetwork);
    expect(updatedRows).toHaveLength(1);
    expect(updatedRows[0]).toHaveProperty('confirmation_sent_at');
  });

  it('sends the enquiry email, not the booking one, with no Cal.com configured', async () => {
    delete process.env.CAL_BASE_URL;
    const result = await runScopeGate(BRIEF, noNetwork);
    expect(result.bookingUrl).toBeNull();
    expect(insertedRows[0]).toMatchObject({ booking_status: 'enquiry' });
    const visitor = sendEmail.mock.calls.find(
      (call) => call[0].to === 'sarah@example.com'
    )![0];
    expect(visitor.html).toContain('will write to you');
  });
});

describe('the acceptable-use gate, ahead of the scope classification', () => {
  beforeEach(() => {
    setScopeClassifier(async () => classifierSaying({}));
  });

  it('screens the same subject the preview route screens', async () => {
    await runScopeGate(BRIEF, noNetwork);
    expect(screenAcceptableUse).toHaveBeenCalledTimes(1);
    const call = screenAcceptableUse.mock.calls[0][0];
    expect(call.surface).toBe('preview');
    expect(call.text).toContain('A portal my customers log into');
    // Composed through `intakeSubject`, so the link title it read is in it.
    expect(call.text).toContain('Acme - Client Portal Login');
  });

  it('passes the visitor locale through to the acceptable-use screen', async () => {
    await runScopeGate({ ...BRIEF, locale: 'ro' }, noNetwork);
    expect(screenAcceptableUse.mock.calls[0][0].locale).toBe('ro');
  });

  it('defaults to English when the caller sends no locale', async () => {
    await runScopeGate(BRIEF, noNetwork);
    expect(screenAcceptableUse.mock.calls[0][0].locale).toBeUndefined();
  });

  it('files nothing and offers nothing for a refused brief', async () => {
    policyDecision.value = 'refuse';
    const result = await runScopeGate(BRIEF, noNetwork);
    // Not the discovery call: a business we will not build for must not be
    // invited to a sales call. The preview route writes the actual refusal.
    expect(result.route).toBe('self-serve');
    expect(result.rule).toBe('acceptableUseRefused');
    expect(insertedRows).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('offers a sensitive-but-lawful brief no calendar at all', async () => {
    // It used to be offered one. On staging the embedding tier abstained on
    // nearly every brief, every abstention is a `review`, and this branch
    // handed each of them a prefilled link to Darius's calendar -- including
    // an escort service and a firearms seller. The hold is already recorded by
    // `screenAcceptableUse`, and the preview route holds the build on the same
    // verdict; what must not happen here is a booking link.
    policyDecision.value = 'review';
    const result = await runScopeGate(
      { ...BRIEF, description: 'A clinic offering medical cannabis' },
      noNetwork
    );
    expect(result.route).toBe('self-serve');
    expect(result.rule).toBe('acceptableUseNeedsAHuman');
    expect(result.bookingUrl).toBeUndefined();
    expect(insertedRows).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('never hands a prohibited brief a booking URL, whatever it says next', async () => {
    // The property as a loop, because the staging report found it on two
    // separate briefs and on both passes of the question.
    for (const decision of ['refuse', 'review'] as const) {
      for (const answerKey of [
        undefined,
        'site',
        'software',
        'other',
      ] as const) {
        policyDecision.value = decision;
        insertedRows.length = 0;
        sendEmail.mockClear();
        const result = await runScopeGate(
          {
            ...BRIEF,
            description:
              'Selling controlled substances and unregistered firearms',
            ...(answerKey ? { answerKey } : {}),
          },
          noNetwork
        );
        expect(result.bookingUrl).toBeUndefined();
        expect(result.route).not.toBe('discovery-call');
        expect(insertedRows).toHaveLength(0);
      }
    }
  });

  it('records the verdict it actually screened on the lead', async () => {
    await runScopeGate(BRIEF, noNetwork);
    expect(insertedRows[0]).toMatchObject({ acceptable_use: 'allowed' });
  });
});

describe('runScopeGate on a standard brief', () => {
  it('continues to the preview and files nothing', async () => {
    setScopeClassifier(async () =>
      classifierSaying({ scope: 'standard', confidence: 0.9, evidence: [] })
    );
    const result = await runScopeGate(
      { ...BRIEF, description: 'A bakery in Cluj' },
      noNetwork
    );
    expect(result.route).toBe('self-serve');
    expect(result.bookingUrl).toBeUndefined();
    expect(insertedRows).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('routes self-serve on a sigma-shaped confident verdict, however small the raw margin', async () => {
    // The defect this fix exists for: a sigma cosine margin around 0.07 for a
    // confident `standard` verdict is nowhere near the 0.6 confidence bar, but
    // `decided: true` is what the routing rule reads now, not the number.
    setScopeClassifier(async () =>
      classifierSaying({
        scope: 'standard',
        confidence: 0.07,
        evidence: [],
        classifier: 'sigma',
        decided: true,
      })
    );
    const result = await runScopeGate(
      { ...BRIEF, description: 'A bakery in Cluj' },
      noNetwork
    );
    expect(result.route).toBe('self-serve');
    expect(result.questionKey).toBeUndefined();
  });

  it('still asks once when nothing decided it, even at a confidence that used to clear the bar on its own', async () => {
    // 0.65 cleared the old 0.6 standard bar under the previous, confidence-only
    // contract. Without `decided` set, it must not act by itself any more --
    // otherwise this is the same bug back under a different classifier.
    setScopeClassifier(async () =>
      classifierSaying({
        scope: 'standard',
        confidence: 0.65,
        evidence: [],
        classifier: 'llm:test',
        decided: false,
      })
    );
    const result = await runScopeGate(
      { ...BRIEF, description: 'A bakery in Cluj' },
      noNetwork
    );
    expect(result.route).toBe('ask-one-more-question');
    expect(result.questionKey).toBe(SCOPE_QUESTION_KEY);
  });
});

describe('the clarifying question', () => {
  it('is asked once when the verdict is unclear, and files nothing yet', async () => {
    setScopeClassifier(async () =>
      classifierSaying({ scope: 'unclear', confidence: 0, evidence: [] })
    );
    const result = await runScopeGate(BRIEF, noNetwork);
    expect(result.route).toBe('ask-one-more-question');
    expect(result.questionKey).toBe(SCOPE_QUESTION_KEY);
    expect(insertedRows).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('is never asked twice: a still-unclear second pass continues and is filed for a person', async () => {
    setScopeClassifier(async (text) => {
      seen.push(text);
      return classifierSaying({
        scope: 'unclear',
        confidence: 0,
        evidence: [],
      });
    });
    const result = await runScopeGate(
      { ...BRIEF, clarification: 'Honestly I am not sure' },
      noNetwork
    );
    expect(result.route).toBe('self-serve');
    expect(result.rule).toBe('clarifiedStillUnclear');
    expect(result.operatorReview).toBe(true);
    // The answer is part of the text the second classification sees.
    expect(seen[0]).toContain('Honestly I am not sure');
    // And an operator has the brief, which is the whole point of not sending
    // somebody who asked for a website to a sales call.
    expect(policyRows()).toHaveLength(1);
    expect(policyRows()[0]).toMatchObject({
      decision: 'review',
      surface: 'preview',
      rule: 'scope_unresolved_after_question',
    });
    // And the operator hears about it by email too, not just on the board.
    const notification = sendEmail.mock.calls.find((call) =>
      call[0]?.subject?.startsWith('A brief needs your review:')
    );
    expect(notification).toBeDefined();
    expect(notification![0].text).toContain('the brief is still unclear');
  });

  it('lets the visitor answer settle the scope when the classifier is down', async () => {
    // Run 8, 2026-09-15: the classifier failed on 100% of calls, so every
    // brief carried `unclear` at confidence 0. A visitor who tapped "A site
    // that presents my business" got `{"route":"discovery-call","scope":
    // "unclear"}` -- the answer moved the route and not the verdict, and no
    // visitor could reach a preview for as long as the classifier was down.
    setScopeClassifier(async () =>
      classifierSaying({ scope: 'unclear', confidence: 0, evidence: [] })
    );
    const result = await runScopeGate(
      {
        ...BRIEF,
        description: 'A portfolio showing the three projects I have shipped',
        clarification: 'A site that presents my business',
        answerKey: 'site',
      },
      noNetwork
    );
    expect(result.route).toBe('self-serve');
    expect(result.scope).toBe('standard');
    expect(result.rule).toBe('visitorSaysSite');
    expect(result.bookingUrl).toBeUndefined();
    expect(result.offerCopy).toBeUndefined();
    expect(insertedRows).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('never asserts custom work over a scope it did not settle', async () => {
    setScopeClassifier(async () =>
      classifierSaying({ scope: 'unclear', confidence: 0, evidence: [] })
    );
    const result = await runScopeGate(
      {
        ...BRIEF,
        clarification: 'A site that presents my business',
        answerKey: 'site',
      },
      noNetwork
    );
    // The serialised body, exactly as the browser receives it. The copy key
    // that asserts "it is software built for it" must not be in it.
    expect(JSON.stringify(result)).not.toContain(
      'landing.discovery.scope.offer.body'
    );
  });

  it('takes the visitor at their word when they say it is software', async () => {
    setScopeClassifier(async () =>
      classifierSaying({ scope: 'unclear', confidence: 0, evidence: [] })
    );
    const result = await runScopeGate(
      {
        ...BRIEF,
        clarification: 'Software my customers log into',
        answerKey: 'software',
      },
      noNetwork
    );
    expect(result.route).toBe('discovery-call');
    expect(result.scope).toBe('custom');
    expect(result.rule).toBe('visitorSaysSoftware');
    // A custom scope is the only one allowed the assertion, and this one was
    // reached from the visitor's own answer.
    expect(result.offerCopy?.bodyKey).toBe(
      'landing.discovery.scope.offer.body'
    );
    expect(result.bookingUrl).toContain('cal.flowstarter.dev');
  });

  it('files the disagreement for an operator and still shows the preview', async () => {
    setScopeClassifier(async () =>
      classifierSaying({ scope: 'custom', confidence: 0.99 })
    );
    const result = await runScopeGate(
      {
        ...BRIEF,
        clarification: 'A site that presents my business',
        answerKey: 'site',
      },
      noNetwork
    );
    expect(result.route).toBe('self-serve');
    expect(result.scope).toBe('unclear');
    expect(result.classifiedScope).toBe('custom');
    expect(result.operatorReview).toBe(true);
    expect(policyRows()).toHaveLength(1);
    expect(policyRows()[0]).toMatchObject({
      decision: 'review',
      surface: 'preview',
      rule: 'scope_visitor_disagrees_with_classifier',
      category_id: 'none',
      status: 'open',
    });
    // No lead: this is a visitor continuing to their preview, not a
    // custom-work enquiry. An operator does still hear about it, through the
    // review notification rather than a custom-work lead -- see the next
    // test.
    expect(insertedRows).toHaveLength(0);
  });

  it('never sends the custom-work operator email for a review outcome, but does send the review notification', async () => {
    // The requirement in full: a brief that opens an acceptable-use or scope
    // review row is a different thing from a custom-work lead, and it must go
    // to a person through the review queue, not through
    // `customWorkOperatorEmail` -- an email that says "A custom work lead" and
    // hands over a discovery-call link. `operatorReview: true` here is exactly
    // that review, opened by `openScopeReview` against `policy_reviews`, and
    // the route it produces is `self-serve`, never `discovery-call`. Structurally,
    // `customWorkOperatorEmail` is only ever reached from `fileCustomWorkLead`,
    // which only runs on a `discovery-call` route -- so this line is the proof
    // that stays true even if that wiring changes. `recordPolicyOutcome`
    // (`@/lib/policy/review`) does send its own "A brief needs your review"
    // email for this row now, which is the point of PR #191's second
    // follow-up: the row used to sit on the board silently.
    setScopeClassifier(async () =>
      classifierSaying({ scope: 'custom', confidence: 0.99 })
    );
    const result = await runScopeGate(
      {
        ...BRIEF,
        clarification: 'A site that presents my business',
        answerKey: 'site',
      },
      noNetwork
    );
    expect(result.operatorReview).toBe(true);
    expect(result.route).not.toBe('discovery-call');
    expect(
      sendEmail.mock.calls.some((call) =>
        call[0]?.subject?.startsWith('Custom work lead:')
      )
    ).toBe(false);
    const notification = sendEmail.mock.calls.find((call) =>
      call[0]?.subject?.startsWith('A brief needs your review:')
    );
    expect(notification).toBeDefined();
    expect(notification![0].to).toBe('ops@flowstarter.net');
  });

  it('lets a clarified standard answer through to the preview', async () => {
    setScopeClassifier(async () =>
      // Deliberately below the standard threshold: after the question, the
      // verdict is acted on at whatever confidence it carries.
      classifierSaying({ scope: 'standard', confidence: 0.1, evidence: [] })
    );
    const result = await runScopeGate(
      { ...BRIEF, clarification: 'A site that presents my business' },
      noNetwork
    );
    expect(result.route).toBe('self-serve');
    expect(insertedRows).toHaveLength(0);
  });
});

describe('readLinkTitle', () => {
  it('prefers the visitor’s own website over a social profile', async () => {
    const read = vi.fn(async (link: { url: string }) => ({
      status: 'exposed' as const,
      network: 'website' as const,
      url: link.url,
      title: link.url,
      description: null,
      imageUrl: null,
    }));
    const title = await readLinkTitle(
      {
        instagramUrl: 'https://instagram.com/acme',
        websiteUrl: 'https://acme.example.com',
      },
      { read }
    );
    expect(title).toBe('https://acme.example.com/');
  });

  it('is empty rather than fatal when the page will not load', async () => {
    const read = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(
      await readLinkTitle({ websiteUrl: 'https://acme.example.com' }, { read })
    ).toBe('');
  });

  it('reads nothing at all when the visitor gave no usable link', async () => {
    const read = vi.fn();
    expect(await readLinkTitle({ websiteUrl: 'not a url' }, { read })).toBe('');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('when the post is unreliable', () => {
  beforeEach(() => {
    setScopeClassifier(async () => classifierSaying({}));
  });

  it('does not claim the confirmation was sent when it was not', async () => {
    sendEmail.mockResolvedValue({ success: false, error: 'mailbox full' });
    const result = await runScopeGate(BRIEF, noNetwork);
    // The lead is still filed and the visitor still gets the calendar.
    expect(result.route).toBe('discovery-call');
    expect(insertedRows).toHaveLength(1);
    expect(updatedRows).toHaveLength(0);
  });

  it('still tells Darius when the visitor\u2019s address bounced', async () => {
    sendEmail.mockResolvedValue({ success: false, error: 'bounced' });
    await runScopeGate(BRIEF, noNetwork);
    expect(
      sendEmail.mock.calls.some((call) => call[0].to === 'ops@flowstarter.net')
    ).toBe(true);
  });

  it('still confirms to the visitor when no operator address is configured', async () => {
    operatorEmail.value = '';
    await runScopeGate(BRIEF, noNetwork);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe('sarah@example.com');
  });

  it('files the lead even when the visitor gave no address at all', async () => {
    await runScopeGate({ ...BRIEF, email: '' }, noNetwork);
    expect(insertedRows).toHaveLength(1);
    // Only the operator is written to: there is nobody else to write to.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe('ops@flowstarter.net');
  });

  it('records nothing about a brief with no link', async () => {
    await runScopeGate(
      {
        fullName: 'Sarah Smith',
        email: 'sarah@example.com',
        description: BRIEF.description,
      },
      noNetwork
    );
    expect(insertedRows[0]).toMatchObject({ link_url: null, link_title: null });
    expect(noNetwork.read).not.toHaveBeenCalled();
  });
});

describe('fileCustomWorkEnquiry', () => {
  it('files the same row the funnel does, marked as the form', async () => {
    const id = await fileCustomWorkEnquiry({
      name: 'Sarah Smith',
      email: 'sarah@example.com',
      description: 'A booking platform for three clinics',
      linkUrl: 'https://acme.example.com',
    });
    expect(id).toBe('lead-1');
    expect(insertedRows[0]).toMatchObject({
      source: 'contact_form',
      route: 'discovery-call',
      route_rule: 'contactForm',
      scope: 'custom',
      // The visitor said it themselves, so no model was asked to agree.
      classifier: 'visitor',
      booking_status: 'enquiry',
    });
  });

  it('sends the enquiry confirmation, never the booking one', async () => {
    await fileCustomWorkEnquiry({
      name: 'Sarah Smith',
      email: 'sarah@example.com',
      description: 'A booking platform for three clinics',
    });
    const visitor = sendEmail.mock.calls.find(
      (call) => call[0].to === 'sarah@example.com'
    )![0];
    expect(visitor.html).toContain('will write to you');
    expect(visitor.html).not.toContain('cal.flowstarter.dev');
  });
});
