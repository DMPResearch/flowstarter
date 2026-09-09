/**
 * LangGraph intake: interrupt → resume, multi-extract, finish gate.
 * LLM deps are stubbed — this pins the graph, not the model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_DISCOVERY,
  type DiscoveryData,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import {
  resetIntakeGraphDeps,
  resumeIntakeGraph,
  scriptedPromptFor,
  setIntakeGraphDeps,
  startIntakeGraph,
} from '../graph';

describe('intake graph', () => {
  beforeEach(() => {
    setIntakeGraphDeps({
      phraseAsk: async ({ scriptedPrompt, question }) =>
        `Graph: ${question.id} — ${scriptedPrompt}`,
      extractAnswers: async () => [],
      translate: () => (key) => key,
    });
  });

  afterEach(() => {
    resetIntakeGraphDeps();
  });

  it('starts interrupted on the first scripted question', async () => {
    const turn = await startIntakeGraph({ locale: 'en' });
    expect(turn.status).toBe('ask');
    expect(turn.ask?.questionId).toBe('fullName');
    expect(turn.ask?.prompt).toContain('Graph: fullName');
    expect(turn.answered).toEqual([]);
  });

  it('resumes, applies the answer, and asks the next question', async () => {
    const start = await startIntakeGraph({ locale: 'en' });
    const next = await resumeIntakeGraph({
      threadId: start.threadId,
      resume: { kind: 'text', text: 'Maria Ionescu' },
      data: start.data,
      answered: start.answered,
    });
    expect(next.errorKey).toBeNull();
    expect(next.data.fullName).toBe('Maria Ionescu');
    expect(next.answered).toContain('fullName');
    expect(next.status).toBe('ask');
    expect(next.ask?.questionId).toBe('email');
  });

  it('rejects a bad email and re-asks without advancing', async () => {
    const start = await startIntakeGraph({
      data: { ...EMPTY_DISCOVERY, fullName: 'Maria' },
      answered: ['fullName'],
    });
    expect(start.ask?.questionId).toBe('email');

    const bad = await resumeIntakeGraph({
      threadId: start.threadId,
      resume: { kind: 'text', text: 'nope' },
      data: start.data,
      answered: start.answered,
    });
    expect(bad.reason).toBe('validation');
    expect(bad.errorKey).toBe('landing.discovery.chat.errors.email');
    expect(bad.ask?.questionId).toBe('email');
    expect(bad.answered).toEqual(['fullName']);

    const good = await resumeIntakeGraph({
      threadId: start.threadId,
      resume: { kind: 'text', text: 'maria@example.com' },
      data: bad.data,
      answered: bad.answered,
    });
    expect(good.errorKey).toBeNull();
    expect(good.data.email).toBe('maria@example.com');
    expect(good.answered).toContain('email');
  });

  it('applies multi-field extract from one utterance', async () => {
    setIntakeGraphDeps({
      phraseAsk: async ({ scriptedPrompt }) => scriptedPrompt,
      extractAnswers: async () => [
        { id: 'fullName', value: 'Maria Ionescu' },
        { id: 'email', value: 'maria@example.com' },
        { id: 'businessName', value: 'Ionescu Dental' },
      ],
      translate: () => (key) => key,
    });

    const start = await startIntakeGraph({ locale: 'en' });
    const next = await resumeIntakeGraph({
      threadId: start.threadId,
      resume: {
        kind: 'text',
        text: 'I am Maria Ionescu, maria@example.com, Ionescu Dental',
      },
    });
    expect(next.data.fullName).toBe('Maria Ionescu');
    expect(next.data.email).toBe('maria@example.com');
    expect(next.data.businessName).toBe('Ionescu Dental');
    expect(next.answered).toEqual(
      expect.arrayContaining(['fullName', 'email', 'businessName'])
    );
    expect(next.ask?.questionId).not.toBe('fullName');
    expect(next.ask?.questionId).not.toBe('email');
    expect(next.ask?.questionId).not.toBe('businessName');
  });

  it('reports complete when the script is already spent', async () => {
    // Essentials-only with everything required already answered.
    const turn = await startIntakeGraph({
      essentialsOnly: true,
      data: {
        ...EMPTY_DISCOVERY,
        fullName: 'Maria',
        email: 'maria@example.com',
        businessName: 'Clinic',
        description: 'A dental clinic in Cluj with evening appointments.',
        industry: 'Therapy & wellness',
        goal: 'Take bookings or appointments',
        commerceMode: 'none',
      },
      answered: [
        'fullName',
        'email',
        'businessName',
        'description',
        'industry',
        'goal',
        'commerceMode',
      ],
    });
    expect(turn.status).toBe('complete');
    expect(turn.ask).toBeNull();
  });
});

// ── Fixtures shared by the fallback suites ────────────────────────────────

const ESSENTIALS_ANSWERED = [
  'fullName',
  'email',
  'businessName',
  'description',
  'industry',
  'goal',
  'commerceMode',
];

const ESSENTIALS_FILLED: DiscoveryData = {
  ...EMPTY_DISCOVERY,
  fullName: 'Maria',
  email: 'maria@example.com',
  businessName: 'Clinic',
  description: 'A dental clinic in Cluj with evening appointments.',
  industry: 'Therapy & wellness',
  goal: 'Take bookings or appointments',
  commerceMode: 'none',
};

describe('the scripted prompt, with no model in the picture', () => {
  it('reads the built-in dictionary rather than echoing a locale key', () => {
    resetIntakeGraphDeps();

    const english = scriptedPromptFor(EMPTY_DISCOVERY, [], false);
    expect(english).toBeTruthy();
    expect(english).not.toContain('landing.discovery');

    // Romanian has no discovery-chat lines yet, so it falls back to English
    // rather than showing the visitor a key.
    expect(scriptedPromptFor(EMPTY_DISCOVERY, [], false, 'ro')).toBe(english);
  });

  it('has nothing left to say once the script is spent', () => {
    resetIntakeGraphDeps();
    expect(
      scriptedPromptFor(ESSENTIALS_FILLED, ESSENTIALS_ANSWERED, true)
    ).toBeNull();
  });
});

describe('resuming a conversation the server no longer remembers', () => {
  it('replays the answer against the client mirror and opens a fresh thread', async () => {
    const recovered = await resumeIntakeGraph({
      threadId: '00000000-0000-4000-8000-000000000000',
      resume: { kind: 'text', text: 'Maria Ionescu' },
      data: EMPTY_DISCOVERY,
      answered: [],
    });

    expect(recovered.skipped).toBe(true);
    expect(recovered.reason).toBe('error');
    expect(recovered.data.fullName).toBe('Maria Ionescu');
    expect(recovered.answered).toEqual(['fullName']);
    // The visitor keeps going: a new thread, on the next question.
    expect(recovered.status).toBe('ask');
    expect(recovered.ask?.questionId).toBe('email');
    expect(recovered.threadId).not.toBe('00000000-0000-4000-8000-000000000000');
  });

  it('still corrects a bad answer instead of accepting it', async () => {
    const recovered = await resumeIntakeGraph({
      threadId: '00000000-0000-4000-8000-000000000001',
      resume: { kind: 'text', text: 'nope' },
      data: { ...EMPTY_DISCOVERY, fullName: 'Maria' },
      answered: ['fullName'],
    });

    expect(recovered.reason).toBe('validation');
    expect(recovered.errorKey).toBe('landing.discovery.chat.errors.email');
    expect(recovered.ask?.questionId).toBe('email');
    expect(recovered.answered).toEqual(['fullName']);
    expect(recovered.skipped).toBe(true);
  });

  it('reports a finished intake rather than asking again', async () => {
    const recovered = await resumeIntakeGraph({
      threadId: '00000000-0000-4000-8000-000000000002',
      resume: { kind: 'text', text: 'anything' },
      data: ESSENTIALS_FILLED,
      answered: ESSENTIALS_ANSWERED,
      essentialsOnly: true,
    });

    expect(recovered.status).toBe('complete');
    expect(recovered.ask).toBeNull();
    expect(recovered.skipped).toBe(true);
  });

  it('falls back to the script when the client sends no thread at all', async () => {
    const blank = await resumeIntakeGraph({
      threadId: '   ',
      resume: { kind: 'text', text: 'Maria Ionescu' },
      data: EMPTY_DISCOVERY,
      answered: [],
    });

    // No checkpoint to resume, so the answer is not applied: the visitor is
    // simply asked the question again rather than losing the funnel.
    expect(blank.skipped).toBe(true);
    expect(blank.reason).toBe('error');
    expect(blank.status).toBe('ask');
    expect(blank.ask?.questionId).toBe('fullName');
    expect(blank.threadId).toBeTruthy();

    const finished = await resumeIntakeGraph({
      threadId: '',
      resume: { kind: 'text', text: 'anything' },
      data: ESSENTIALS_FILLED,
      answered: ESSENTIALS_ANSWERED,
      essentialsOnly: true,
    });
    expect(finished.status).toBe('complete');
    expect(finished.skipped).toBe(true);
  });
});

describe('the pricing panel', () => {
  it('pauses as a panel, not as something to type into', async () => {
    const start = await startIntakeGraph({
      data: ESSENTIALS_FILLED,
      answered: ESSENTIALS_ANSWERED,
    });

    // Whatever optional questions remain, the panel is never phrased by a
    // model: the tiers are priced by rules.
    let turn = start;
    for (let step = 0; step < 12 && turn.ask?.kind !== 'panel'; step += 1) {
      turn = await resumeIntakeGraph({
        threadId: turn.threadId,
        resume: { kind: 'skip' },
      });
    }

    expect(turn.status).toBe('panel');
    expect(turn.ask?.questionId).toBe('selectedTier');
    expect(turn.ask?.prompt).not.toContain('Graph:');
    expect(turn.ask?.options?.length).toBeGreaterThan(0);

    const chosen = await resumeIntakeGraph({
      threadId: turn.threadId,
      resume: { kind: 'panel', value: 'pro' },
    });
    expect(chosen.data.selectedTier).toBe('pro');
  });
});

describe('when the model misbehaves', () => {
  it('shows the scripted question if phrasing it throws', async () => {
    setIntakeGraphDeps({
      phraseAsk: async () => {
        throw new Error('provider unavailable');
      },
      extractAnswers: async () => [],
      translate: () => (key) => key,
    });

    const start = await startIntakeGraph({ locale: 'en' });
    expect(start.status).toBe('ask');
    expect(start.ask?.questionId).toBe('fullName');
    expect(start.ask?.prompt).toBeTruthy();
  });

  it('keeps the visitor’s own answer if extraction throws', async () => {
    setIntakeGraphDeps({
      phraseAsk: async ({ scriptedPrompt }) => scriptedPrompt,
      extractAnswers: async () => {
        throw new Error('provider unavailable');
      },
      translate: () => (key) => key,
    });

    const start = await startIntakeGraph({ locale: 'en' });
    const next = await resumeIntakeGraph({
      threadId: start.threadId,
      resume: { kind: 'text', text: 'Maria Ionescu' },
    });

    expect(next.errorKey).toBeNull();
    expect(next.data.fullName).toBe('Maria Ionescu');
    expect(next.ask?.questionId).toBe('email');
  });

  it('falls back to the script when the turn itself blows up', async () => {
    // A locale catalogue that fails once: the first ask cannot be built, and
    // the graph has to hand back a scripted question rather than an error.
    let failures = 1;
    setIntakeGraphDeps({
      phraseAsk: async ({ scriptedPrompt }) => scriptedPrompt,
      extractAnswers: async () => [],
      translate: () => (key) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('locale catalogue unavailable');
        }
        return key;
      },
    });
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      const start = await startIntakeGraph({ locale: 'en' });
      expect(start.skipped).toBe(true);
      expect(start.reason).toBe('error');
      expect(start.status).toBe('ask');
      expect(start.ask?.questionId).toBe('fullName');
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe('resume shapes the client may send', () => {
  it('understands a bare {text}, an unknown kind, and a raw value', async () => {
    for (const [resume, expected] of [
      [{ text: 'Maria Ionescu' }, 'Maria Ionescu'],
      ['Maria Ionescu', 'Maria Ionescu'],
      [{ kind: 'text', text: 'Maria Ionescu' }, 'Maria Ionescu'],
    ] as const) {
      const start = await startIntakeGraph({ locale: 'en' });
      const next = await resumeIntakeGraph({
        threadId: start.threadId,
        resume: resume as never,
      });
      expect(next.data.fullName).toBe(expected);
    }
  });

  it('treats an unrecognised shape as an empty answer, and re-asks', async () => {
    // `null` cannot get this far: the route parses the body first.
    for (const resume of [{ kind: 'nonsense' }, { kind: 'text' }]) {
      const start = await startIntakeGraph({ locale: 'en' });
      const next = await resumeIntakeGraph({
        threadId: start.threadId,
        resume: resume as never,
      });
      expect(next.errorKey).toBe('landing.discovery.chat.errors.required');
      expect(next.ask?.questionId).toBe('fullName');
      expect(next.answered).toEqual([]);
    }
  });
});

describe('finishing', () => {
  it('reports complete once the last essential question is answered', async () => {
    const start = await startIntakeGraph({
      essentialsOnly: true,
      data: { ...ESSENTIALS_FILLED, commerceMode: '' as const },
      answered: ESSENTIALS_ANSWERED.filter((id) => id !== 'commerceMode'),
    });
    expect(start.ask?.questionId).toBe('commerceMode');

    const done = await resumeIntakeGraph({
      threadId: start.threadId,
      resume: { kind: 'text', text: 'none' },
      essentialsOnly: true,
    });

    expect(done.status).toBe('complete');
    expect(done.ask).toBeNull();
    expect(done.data.commerceMode).toBe('none');
    expect(done.progress.done).toBe(done.progress.total);
  });
});
