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
/* eslint-disable @typescript-eslint/no-explicit-any */
const supabase = {
  from: vi.fn(() => ({
    insert: (values: Record<string, unknown>) => {
      insertedRows.push(values);
      return {
        select: () => ({
          single: async () => ({ data: { id: 'lead-1' }, error: null }),
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
    ...partial,
  };
}

const seen: string[] = [];

beforeEach(() => {
  insertedRows.length = 0;
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

  it('sends a sensitive-but-lawful brief to a person', async () => {
    policyDecision.value = 'review';
    const result = await runScopeGate(
      { ...BRIEF, description: 'A clinic offering medical cannabis' },
      noNetwork
    );
    expect(result.route).toBe('discovery-call');
    expect(result.rule).toBe('acceptableUseNeedsAHuman');
    expect(insertedRows[0]).toMatchObject({ acceptable_use: 'review' });
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

  it('is never asked twice: a still-unclear second pass goes to a person', async () => {
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
    expect(result.route).toBe('discovery-call');
    expect(result.rule).toBe('clarifiedStillUnclear');
    // The answer is part of the text the second classification sees.
    expect(seen[0]).toContain('Honestly I am not sure');
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
