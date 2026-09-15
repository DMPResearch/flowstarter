/**
 * POST /api/discovery/intake-graph — smoke the route doors without a model.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const startIntakeGraph = vi.fn();
const resumeIntakeGraph = vi.fn();
const setIntakeGraphDeps = vi.fn();
const resetIntakeGraphDeps = vi.fn();

vi.mock('@/lib/flowstarter/intake-graph', () => ({
  startIntakeGraph: (input: unknown) => startIntakeGraph(input),
  resumeIntakeGraph: (input: unknown) => resumeIntakeGraph(input),
  setIntakeGraphDeps: (input: unknown) => setIntakeGraphDeps(input),
  resetIntakeGraphDeps: () => resetIntakeGraphDeps(),
}));

const budgetState = { state: 'ok' as 'ok' | 'degrade' | 'blocked' };
vi.mock('@/lib/ai/funnel-cost', () => ({
  funnelBudgetState: async () => ({ state: budgetState.state }),
}));

/**
 * The gate, stubbed at the one place the intake now asks it.
 *
 * `screenAcceptableUse` and not `screenIntakeDescription`: stubbing the
 * guardrail module would test nothing, because the guardrail module IS the
 * thing under test here -- the narrowing it does, and the fact that it asks
 * `decideRoute` rather than restating it. So the classifier's answer is
 * faked and every rule between that answer and the response is real.
 */
const screenAcceptableUse = vi.fn();
vi.mock('@/lib/policy/gate', () => ({
  screenAcceptableUse: (input: unknown) => screenAcceptableUse(input),
}));

import { POST } from '../route';

const CLEAN = { id: 'none', label: 'No category', disposition: 'clean' };
const DRUGS = {
  id: 'illegal_drugs',
  label: 'Illegal drugs and controlled substances',
  disposition: 'prohibited',
};
const PHARMACY = {
  id: 'licensed_pharmacy',
  label: 'Licensed pharmacy',
  disposition: 'sensitive',
};

/** The four verdicts the gate can hand back, as `screenAcceptableUse` shapes them. */
function verdict(
  kind: 'refuse' | 'review' | 'hold' | 'allow',
  locale: 'en' | 'ro' = 'en'
) {
  const shapes = {
    refuse: {
      decision: 'refuse' as const,
      category: DRUGS,
      rule: 'tier_decided',
      notice: {
        title:
          locale === 'ro'
            ? 'Nu putem construi acest site'
            : 'We cannot build this one',
        message: 'policy message',
        next: 'policy next',
        termsHref: '/terms#acceptable-use',
        contactHref: '/contact',
        termsLabel: 'terms',
        contactLabel: 'contact',
        decision: 'refuse',
        categoryId: 'illegal_drugs',
        locale,
      },
    },
    review: {
      decision: 'review' as const,
      category: PHARMACY,
      rule: 'sensitive_lawful',
      notice: { title: 'One of us needs to look at this first', locale },
    },
    hold: {
      decision: 'review' as const,
      category: CLEAN,
      rule: 'classifier_unavailable',
      notice: { title: 'We are still checking this one', locale },
    },
    allow: {
      decision: 'allow' as const,
      category: CLEAN,
      rule: 'tier_decided',
      notice: null,
    },
  };
  const shape = shapes[kind];
  return {
    verdict: {
      decision: shape.decision,
      category: shape.category,
      confidence: 0.9,
      rule: shape.rule,
      tier: 'llm',
      needsHuman: shape.decision !== 'allow',
    },
    classification: {},
    notice: shape.notice,
    reviewId: null,
    blocked: shape.decision !== 'allow',
  };
}

let ipCounter = 0;

function request(body: unknown): NextRequest {
  ipCounter += 1;
  return new NextRequest('http://localhost/api/discovery/intake-graph', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.1.0.${ipCounter}`,
    },
  });
}

describe('POST /api/discovery/intake-graph', () => {
  beforeEach(() => {
    startIntakeGraph.mockReset();
    resumeIntakeGraph.mockReset();
    setIntakeGraphDeps.mockReset();
    resetIntakeGraphDeps.mockReset();
    screenAcceptableUse.mockReset();
    screenAcceptableUse.mockResolvedValue(verdict('allow'));
    budgetState.state = 'ok';
    startIntakeGraph.mockResolvedValue({
      threadId: '11111111-1111-1111-1111-111111111111',
      status: 'ask',
      ask: {
        type: 'ask',
        questionId: 'fullName',
        kind: 'text',
        prompt: 'What should we call you?',
        required: true,
      },
      data: {},
      answered: [],
      progress: { done: 0, total: 10 },
    });
  });

  it('starts a thread', async () => {
    const response = await POST(request({ action: 'start', locale: 'en' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ask');
    expect(body.ask.questionId).toBe('fullName');
    expect(startIntakeGraph).toHaveBeenCalledOnce();
  });

  it('rejects a malformed body', async () => {
    const response = await POST(request({ action: 'resume' }));
    expect(response.status).toBe(400);
  });

  it('fails open when the funnel budget is blocked', async () => {
    budgetState.state = 'blocked';
    const response = await POST(request({ action: 'start' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe('budget');
    expect(setIntakeGraphDeps).toHaveBeenCalled();
    expect(resetIntakeGraphDeps).toHaveBeenCalled();
  });

  it('resumes an existing thread', async () => {
    resumeIntakeGraph.mockResolvedValue({
      threadId: '11111111-1111-1111-1111-111111111111',
      status: 'ask',
      ask: {
        type: 'ask',
        questionId: 'email',
        kind: 'text',
        prompt: 'And your email?',
        required: true,
      },
      data: { fullName: 'Maria' },
      answered: ['fullName'],
      progress: { done: 1, total: 10 },
    });

    const response = await POST(
      request({
        action: 'resume',
        threadId: '11111111-1111-1111-1111-111111111111',
        resume: { kind: 'text', text: 'Maria Ionescu' },
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ask.questionId).toBe('email');
    expect(resumeIntakeGraph).toHaveBeenCalledOnce();
  });
});

/**
 * The one guardrail, at the one moment it applies.
 *
 * Finding 1 of the 2026-09-15 showcase run, as a suite. The intake used to
 * carry its own moderator -- a list of regular expressions and a second LLM
 * taxonomy -- which ran before the acceptable-use gate and, on a hit, answered
 * `200 {"status":"complete","ask":null}` with the description blanked and
 * nothing said. Two prohibited briefs were filmed dead-ending on it, in
 * English and in Romanian, while the very same briefs POSTed to
 * `/api/discovery/scope` were refused correctly.
 *
 * Every case below asserts the same two properties from a different angle:
 * the response carries a notice, and it never carries `status: 'complete'`
 * with an empty description.
 */
describe('POST /api/discovery/intake-graph — the acceptable-use gate', () => {
  const THREAD = '11111111-1111-1111-1111-111111111111';
  const BRIEF =
    'I sell recreational drugs and unregistered firearms by post and I need a shop page.';

  /** A turn in which the graph has just settled the description. */
  function describedTurn(description = BRIEF) {
    return {
      threadId: THREAD,
      status: 'ask',
      ask: {
        type: 'ask',
        questionId: 'offer',
        kind: 'longtext',
        prompt: 'And what does someone actually buy from you?',
        required: true,
      },
      data: { fullName: 'Maria', description },
      answered: ['fullName', 'description'],
      progress: { done: 2, total: 5 },
    };
  }

  function resume(locale: 'en' | 'ro' = 'en') {
    return request({
      action: 'resume',
      threadId: THREAD,
      resume: { kind: 'text', text: BRIEF },
      locale,
    });
  }

  beforeEach(() => {
    // This describe is a sibling of the one above, so it resets for itself.
    resumeIntakeGraph.mockReset();
    screenAcceptableUse.mockReset();
    screenAcceptableUse.mockResolvedValue(verdict('allow'));
    budgetState.state = 'ok';
    resumeIntakeGraph.mockResolvedValue(describedTurn());
  });

  it("refuses in the gate's own words, and keeps what the visitor said", async () => {
    screenAcceptableUse.mockResolvedValue(verdict('refuse'));

    const body = await (await POST(resume())).json();

    expect(body.status).toBe('complete');
    expect(body.ask).toBeNull();
    expect(body.reason).toBe('policy');
    expect(body.policyStop).toBe('refused');
    expect(body.policy.title).toBe('We cannot build this one');
    expect(body.policy.categoryId).toBe('illegal_drugs');
    // The exact shape the old moderator produced, asserted as a negative:
    // complete, no ask, and the visitor's answer thrown away with nothing
    // said. A complete turn with an empty description is the bug.
    expect(body.data.description).toBe(BRIEF);
    // Nothing to book against and nothing to generate from.
    expect(body.bookingUrl).toBeUndefined();
  });

  it('refuses a Romanian visitor in Romanian', async () => {
    screenAcceptableUse.mockResolvedValue(verdict('refuse', 'ro'));

    const body = await (await POST(resume('ro'))).json();

    expect(body.policyStop).toBe('refused');
    expect(body.policy.locale).toBe('ro');
    expect(body.policy.title).toBe('Nu putem construi acest site');
    // The locale reaches the gate rather than being defaulted on the way in:
    // `@/lib/policy/copy` writes both languages and only ever sees the one
    // it is handed.
    expect(screenAcceptableUse.mock.calls[0][0].locale).toBe('ro');
  });

  it('holds when nothing could read the brief, exactly as the scope gate does', async () => {
    screenAcceptableUse.mockResolvedValue(verdict('hold'));

    const body = await (await POST(resume())).json();

    expect(body.policyStop).toBe('hold');
    expect(body.status).toBe('complete');
    expect(body.policy.title).toBe('We are still checking this one');
    expect(body.data.description).toBe(BRIEF);
  });

  it('carries on through a categorised review, exactly as the scope gate does', async () => {
    screenAcceptableUse.mockResolvedValue(verdict('review'));

    const body = await (await POST(resume())).json();

    // A tier named a category, an operator has a row to read, and the
    // conversation continues. Stopping here would make the review queue the
    // funnel; `decideRoute` answers `self-serve` for this verdict and the
    // intake honours the same answer.
    expect(body.policyStop).toBeUndefined();
    expect(body.status).toBe('ask');
    expect(body.ask.questionId).toBe('offer');
  });

  it('carries on when the brief is clean', async () => {
    screenAcceptableUse.mockResolvedValue(verdict('allow'));

    const body = await (await POST(resume())).json();

    expect(body.policyStop).toBeUndefined();
    expect(body.policy).toBeUndefined();
    expect(body.ask.questionId).toBe('offer');
  });

  it('screens the description the graph settled, not the raw keystrokes', async () => {
    // The visitor answered a different question; the graph extracted a
    // description out of it anyway. A guardrail reading the resume text alone
    // would never see this.
    resumeIntakeGraph.mockResolvedValue({
      ...describedTurn('We run an unlicensed pharmacy out of a lock-up'),
    });
    screenAcceptableUse.mockResolvedValue(verdict('allow'));

    await POST(
      request({
        action: 'resume',
        threadId: THREAD,
        resume: { kind: 'text', text: 'Maria' },
      })
    );

    expect(screenAcceptableUse.mock.calls[0][0].text).toContain(
      'We run an unlicensed pharmacy out of a lock-up'
    );
  });

  it('does not spend a classification on a turn that settled no description', async () => {
    resumeIntakeGraph.mockResolvedValue({
      threadId: THREAD,
      status: 'ask',
      ask: {
        type: 'ask',
        questionId: 'description',
        kind: 'longtext',
        prompt: 'What does your business do?',
        required: true,
      },
      data: { fullName: 'Maria' },
      answered: ['fullName'],
      progress: { done: 1, total: 5 },
    });

    await POST(
      request({
        action: 'resume',
        threadId: THREAD,
        resume: { kind: 'text', text: 'Maria Ionescu' },
      })
    );

    expect(screenAcceptableUse).not.toHaveBeenCalled();
  });

  it('screens a short brief too, which the old moderator would not look at', async () => {
    // `aiModerateContent` was only asked about prose of 80 characters or more,
    // because its regular expressions false-positived on short strings. A
    // classifier has no such problem, and "Escort agency, Cluj" is 19.
    resumeIntakeGraph.mockResolvedValue(describedTurn('Escort agency, Cluj'));
    screenAcceptableUse.mockResolvedValue(verdict('refuse'));

    const body = await (await POST(resume())).json();

    expect(screenAcceptableUse).toHaveBeenCalledOnce();
    expect(body.policyStop).toBe('refused');
  });
});
