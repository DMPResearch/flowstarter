/**
 * The two model calls the intake graph makes, with the model itself replaced.
 *
 * Rules decide, models phrase: neither of these may become the thing that
 * chooses what to ask or what counts as an answer. So what is pinned here is
 * the deterministic scaffolding around the call — which questions the model is
 * even allowed to fill, and what happens to an answer it invents.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_DISCOVERY,
  type DiscoveryData,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import { questionById } from '@/app/(dynamic-pages)/(main-pages)/components/discovery/intake-script';

vi.mock('@/lib/ai/llm', () => ({ callLlmObject: vi.fn() }));
import { callLlmObject, type LlmObjectResult } from '@/lib/ai/llm';

const llm = vi.mocked(callLlmObject);

/**
 * What `callLlmObject` resolves with. The accounting fields are part of its
 * contract, so the fixture carries them rather than being cast away.
 */
function answered(object: unknown): LlmObjectResult<unknown> {
  return {
    object,
    usage: { tokensIn: 120, tokensOut: 30, cachedTokens: 0, totalTokens: 150 },
    model: 'test-model',
    finishReason: 'stop',
    costEstimate: 0,
  };
}

import { extractAnswers, phraseAsk } from '../llm-turns';

const t = (key: string) => key;

function ask(overrides: Record<string, unknown> = {}) {
  return {
    question: questionById('fullName')!,
    scriptedPrompt: 'What is your name?',
    data: EMPTY_DISCOVERY,
    answered: [] as readonly string[],
    essentialsOnly: false,
    locale: 'en' as const,
    t,
    ...overrides,
  };
}

function extract(overrides: Record<string, unknown> = {}) {
  return {
    pendingId: 'fullName',
    userText: 'I am Maria Ionescu and you can reach me at maria@example.com',
    data: EMPTY_DISCOVERY,
    answered: [] as readonly string[],
    essentialsOnly: false,
    locale: 'en' as const,
    t,
    ...overrides,
  };
}

beforeEach(() => llm.mockReset());

describe('phrasing one scripted question', () => {
  it('uses the model line and books it against the intake budget', async () => {
    llm.mockResolvedValue(
      answered({ prompt: '  Lovely to meet you. What should I call you?  ' })
    );

    expect(await phraseAsk(ask())).toBe(
      'Lovely to meet you. What should I call you?'
    );

    const options = llm.mock.calls[0]![0];
    expect(options.action).toBe('intake_graph');
    // Funnel traffic has no workspace yet; spending must not be booked to one.
    expect(options.workspaceId).toBeNull();

    const sent = JSON.parse(String(options.prompt));
    expect(sent).toMatchObject({
      locale: 'en',
      pendingId: 'fullName',
      scriptedPrompt: 'What is your name?',
    });
    // The model sees what else is coming, but never the question it is
    // rephrasing, and never more than a glimpse ahead.
    expect(sent.alsoOpenSoon.map((q: { id: string }) => q.id)).not.toContain(
      'fullName'
    );
    expect(sent.alsoOpenSoon.length).toBeLessThanOrEqual(3);
    expect(sent.known.fullName).toBe('');
  });

  it('falls back to the script when the model returns nothing usable', async () => {
    llm.mockResolvedValue(answered({ prompt: '   ' }));
    expect(await phraseAsk(ask())).toBe('What is your name?');

    llm.mockResolvedValue(answered({}));
    expect(await phraseAsk(ask())).toBe('What is your name?');
  });
});

describe('extracting the fields one message already answered', () => {
  it('keeps only answers with a value', async () => {
    llm.mockResolvedValue(
      answered({
        answers: [
          { id: 'fullName', value: 'Maria Ionescu' },
          { id: 'email', value: '   ' },
          { id: 'businessName', value: 42 },
          { id: 7, value: 'Ionescu Dental' },
        ],
      })
    );

    expect(await extractAnswers(extract())).toEqual([
      { id: 'fullName', value: 'Maria Ionescu' },
    ]);
  });

  it('returns nothing when the model answers with no list at all', async () => {
    llm.mockResolvedValue(answered({}));
    expect(await extractAnswers(extract())).toEqual([]);
  });

  it('tells the model which ids it may use, and at what temperature', async () => {
    llm.mockResolvedValue(answered({ answers: [] }));

    await extractAnswers(extract());

    const options = llm.mock.calls[0]![0];
    // Extraction is a reading task, not a writing one.
    expect(options.temperature).toBe(0);
    const sent = JSON.parse(String(options.prompt));
    expect(sent.allowed.map((q: { id: string }) => q.id)).toContain('fullName');
    expect(sent.userText).toContain('Maria Ionescu');
  });

  it('does not call the model at all for an empty message', async () => {
    expect(await extractAnswers(extract({ userText: '   ' }))).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it('does not call the model when the script has nothing left to fill', async () => {
    const done = {
      ...EMPTY_DISCOVERY,
      fullName: 'Maria',
      email: 'maria@example.com',
      businessName: 'Clinic',
      description: 'A dental clinic in Cluj with evening appointments.',
      industry: 'Therapy & wellness',
      goal: 'Take bookings or appointments',
      commerceMode: 'none',
    };
    const answered = [
      'fullName',
      'email',
      'businessName',
      'description',
      'industry',
      'goal',
      'commerceMode',
    ];

    expect(
      await extractAnswers(
        extract({ data: done, answered, essentialsOnly: true })
      )
    ).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });
});
