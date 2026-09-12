/**
 * LangGraph intake: interrupt → resume, multi-extract, finish gate.
 * LLM deps are stubbed — this pins the graph, not the model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_DISCOVERY,
  type DiscoveryData,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import { nextQuestion } from '@/app/(dynamic-pages)/(main-pages)/components/discovery/intake-script';
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
      answerVisitorQuestion: async () => {
        throw new Error('not stubbed for this test');
      },
      phraseClarification: async () => {
        throw new Error('not stubbed for this test');
      },
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

  it('reports complete only once every applicable question is answered', async () => {
    const turn = await startIntakeGraph({
      data: FULLY_ANSWERED,
      answered: EVERY_QUESTION_ANSWERED,
    });
    expect(turn.status).toBe('complete');
    expect(turn.ask).toBeNull();
  });

  it('never reports complete while a required question is still open', async () => {
    // Everything else in, the last of the four (the link) deliberately left
    // out. There is no narrowed pool: the graph must still have something to
    // ask, and it must be that question rather than the next one along.
    const turn = await startIntakeGraph({
      data: FULLY_ANSWERED,
      answered: EVERY_QUESTION_ANSWERED.filter((id) => id !== 'links'),
    });
    expect(turn.status).not.toBe('complete');
    expect(turn.ask?.questionId).toBe('links');
    expect(turn.ask?.type).toBe('ask');
  });
});

// ── Fixtures shared by the fallback suites ────────────────────────────────

const ESSENTIALS_ANSWERED = [
  'fullName',
  'email',
  'businessName',
  'description',
  'offer',
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
  offer: 'Check-ups, whitening and emergency appointments.',
  industry: 'Therapy & wellness',
  goal: 'Take bookings or appointments',
  commerceMode: 'none',
};

const EVERY_QUESTION_ANSWERED = [
  ...ESSENTIALS_ANSWERED,
  'targetAudience',
  'links',
  // The connect-photo offer, which is optional but still a question the
  // script hands out, so "every question answered" has to include it or the
  // graph is right to say the intake is not finished.
  'connectPortrait',
  'brandTone',
  'pageCount',
  'timeline',
  'calComUrl',
  'customIntegrations',
  'selectedTier',
  'subscription',
];

const FULLY_ANSWERED: DiscoveryData = {
  ...ESSENTIALS_FILLED,
  targetAudience: 'Adults who avoided the dentist for years.',
  instagramUrl: '',
  linkedinUrl: '',
  brandTone: 'Calm, Trustworthy',
  pageCount: '5-7',
  timeline: 'asap',
  calComUrl: 'https://cal.com/ionescu-dental',
  customIntegrations: '',
  selectedTier: 'starter',
  subscription: 'pro',
};

describe('the scripted prompt, with no model in the picture', () => {
  it('reads the built-in dictionary rather than echoing a locale key', () => {
    resetIntakeGraphDeps();

    const english = scriptedPromptFor(EMPTY_DISCOVERY, []);
    expect(english).toBeTruthy();
    expect(english).not.toContain('landing.discovery');

    // Romanian has no discovery-chat lines yet, so it falls back to English
    // rather than showing the visitor a key.
    expect(scriptedPromptFor(EMPTY_DISCOVERY, [], 'ro')).toBe(english);
  });

  it('has nothing left to say once the script is spent', () => {
    resetIntakeGraphDeps();
    expect(
      scriptedPromptFor(FULLY_ANSWERED, EVERY_QUESTION_ANSWERED)
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
      data: FULLY_ANSWERED,
      answered: EVERY_QUESTION_ANSWERED,
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
      data: FULLY_ANSWERED,
      answered: EVERY_QUESTION_ANSWERED,
    });
    expect(finished.status).toBe('complete');
    expect(finished.skipped).toBe(true);
  });
});

/**
 * The pricing panels, and why the graph no longer sees them.
 *
 * The build package and the monthly plan used to be the last two turns of the
 * intake. They are the wizard's deposit step now, asked against a finished
 * preview, because a price shown before there is anything to price is a number
 * the visitor has no way to judge. The graph walks the script's applicable
 * questions, which are scoped to the quick phase, so it cannot reach either of
 * them -- enforced by construction rather than by the graph remembering to
 * stop at one.
 *
 * It can reach a panel, though, which it could not when this suite was
 * written: the connect-photo offer is a panel in the quick phase. So what is
 * asserted below is which panel, not whether there is one.
 *
 * That the two are still panels, still carry their cards and are still never
 * phrased by a model is pinned in `script-bridge.test.ts` (`scriptedAsk`) and,
 * for the question objects themselves, in the discovery suite's
 * `intake-brief-questions.test.ts`.
 */
describe('the pricing panel', () => {
  beforeEach(() => {
    setIntakeGraphDeps({
      phraseAsk: async ({ scriptedPrompt }) => scriptedPrompt,
      extractAnswers: async () => [],
      translate: () => (key) => key,
    });
  });

  afterEach(() => {
    resetIntakeGraphDeps();
  });

  // Real round trips through the compiled graph (invoke + getState each) are
  // occasionally slower than the suite's default budget once every fork is
  // under load from the rest of the suite running alongside it; the
  // assertions are what matters, not finishing inside the default.
  it('is never offered, because the conversation runs dry before it', async () => {
    let turn = await startIntakeGraph({
      data: ESSENTIALS_FILLED,
      answered: ESSENTIALS_ANSWERED,
    });

    const asked: string[] = [];
    const panels: string[] = [];
    for (let step = 0; step < 8 && turn.status !== 'complete'; step += 1) {
      asked.push(turn.ask!.questionId);
      if (turn.ask!.type === 'panel') panels.push(turn.ask!.questionId);
      turn = await resumeIntakeGraph({
        threadId: turn.threadId,
        resume: { kind: 'text', text: 'instagram.com/ionescudental' },
      });
    }

    expect(turn.status).toBe('complete');
    expect(asked).not.toContain('selectedTier');
    expect(asked).not.toContain('subscription');
    // The quick phase holds one panel now -- the connect-photo offer -- so
    // "no panel ever appears" is no longer the right guard and would pass for
    // the wrong reason if the two prices moved back. The guard is that the
    // only panel the pre-preview conversation can reach is that one.
    expect(panels).toEqual(['connectPortrait']);
  }, 60_000);
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
  beforeEach(() => {
    setIntakeGraphDeps({
      phraseAsk: async ({ scriptedPrompt }) => scriptedPrompt,
      extractAnswers: async () => [],
      translate: () => (key) => key,
    });
  });

  afterEach(() => {
    resetIntakeGraphDeps();
  });

  it('reports complete only once the very last required turn is answered', async () => {
    const start = await startIntakeGraph({
      data: FULLY_ANSWERED,
      answered: EVERY_QUESTION_ANSWERED.filter((id) => id !== 'links'),
    });
    expect(start.ask?.questionId).toBe('links');
    expect(start.status).not.toBe('complete');

    const done = await resumeIntakeGraph({
      threadId: start.threadId,
      resume: { kind: 'text', text: 'instagram.com/ionescudental' },
    });

    expect(done.status).toBe('complete');
    expect(done.ask).toBeNull();
    expect(done.data.instagramUrl).toBe('https://instagram.com/ionescudental');
    expect(done.progress.done).toBe(done.progress.total);
  });
});

describe('the graph never gets ahead of the script', () => {
  beforeEach(() => {
    setIntakeGraphDeps({
      phraseAsk: async ({ scriptedPrompt }) => scriptedPrompt,
      extractAnswers: async () => [],
      answerVisitorQuestion: async () => {
        throw new Error('unused in this walk');
      },
      phraseClarification: async () => {
        throw new Error('unused in this walk');
      },
      translate: () => (key) => key,
    });
  });

  it('is complete exactly when intake-script.nextQuestion says nothing is left — every real turn checked against it', async () => {
    const answers: Record<string, string> = {
      fullName: 'Maria Ionescu',
      email: 'maria@example.com',
      businessName: 'Ionescu Dental',
      description: 'A boutique dental clinic in Cluj doing cosmetic work.',
      offer: 'Whitening, veneers and a nervous-patient first visit.',
      industry: 'Therapy & wellness',
      targetAudience: 'Adults in Cluj who avoided the dentist for a decade.',
      links: 'instagram.com/ionescudental',
      goal: 'Take bookings or appointments',
      brandTone: 'Calm, Trustworthy',
      pageCount: '5-7',
      timeline: 'asap',
      commerceMode: 'none',
      calComUrl: 'https://cal.com/ionescu-dental/intro',
      customIntegrations: 'Mailchimp for newsletters',
      selectedTier: 'starter',
      subscription: 'pro',
    };

    let turn = await startIntakeGraph({ locale: 'en' });
    for (let guard = 0; guard < 20 && turn.status !== 'complete'; guard += 1) {
      // The invariant, checked on every turn: the graph's own script-derived
      // `nextQuestion` must agree the intake is not done yet.
      expect(nextQuestion(turn.data, turn.answered)).not.toBeNull();
      const id = turn.ask!.questionId;
      const raw = answers[id] ?? '';
      turn = await resumeIntakeGraph({
        threadId: turn.threadId,
        resume:
          turn.ask!.type === 'panel'
            ? { kind: 'panel', value: raw || 'confirmed' }
            : { kind: 'text', text: raw },
      });
    }

    expect(turn.status).toBe('complete');
    // And the reverse: complete only ever lines up with the script's own
    // verdict, never ahead of it.
    expect(nextQuestion(turn.data, turn.answered)).toBeNull();
  }, 60_000);
});

describe('reacting to what was just said', () => {
  it('feeds phraseAsk the visitor’s last answer, so it can react before asking the next thing', async () => {
    const seenLastAnswers: unknown[] = [];
    setIntakeGraphDeps({
      phraseAsk: async ({ scriptedPrompt, lastAnswer }) => {
        seenLastAnswers.push(lastAnswer);
        return scriptedPrompt;
      },
      extractAnswers: async () => [],
      answerVisitorQuestion: async () => {
        throw new Error('unused');
      },
      phraseClarification: async () => {
        throw new Error('unused');
      },
      translate: () => (key) => key,
    });

    const start = await startIntakeGraph({ locale: 'en' });
    expect(start.ask?.questionId).toBe('fullName');

    await resumeIntakeGraph({
      threadId: start.threadId,
      resume: { kind: 'text', text: 'Maria Ionescu' },
    });

    // No answer yet for the opening question — nothing to react to.
    expect(seenLastAnswers[0]).toBeNull();
    // The email ask was built with exactly what the visitor just said. (A
    // LangGraph resume replays the node body up to its newest interrupt, so
    // `phraseAsk` for `fullName` itself is called again first, with the same
    // `null` — the important thing pinned here is that the *next* question
    // is never phrased blind to the answer that unlocked it.)
    expect(seenLastAnswers).toContainEqual({
      questionId: 'fullName',
      text: 'Maria Ionescu',
    });
  });
});

describe('a question asked back', () => {
  it('answers it and puts the same pending question back, never validating the question itself as an answer', async () => {
    setIntakeGraphDeps({
      phraseAsk: async ({ scriptedPrompt }) => scriptedPrompt,
      extractAnswers: async () => [],
      answerVisitorQuestion: async () =>
        'We use it to send your preview link, nothing else.',
      phraseClarification: async () => {
        throw new Error('unused');
      },
      translate: () => (key) => key,
    });

    const start = await startIntakeGraph({
      data: { ...EMPTY_DISCOVERY, fullName: 'Maria' },
      answered: ['fullName'],
    });
    expect(start.ask?.questionId).toBe('email');

    const asked = await resumeIntakeGraph({
      threadId: start.threadId,
      resume: { kind: 'text', text: 'why do you need my email?' },
      data: start.data,
      answered: start.answered,
    });

    // Still on email — "why do you need my email?" never ran through the
    // email validator as if it were an attempted address.
    expect(asked.ask?.questionId).toBe('email');
    expect(asked.errorKey).toBeNull();
    expect(asked.ask?.note).toBe(
      'We use it to send your preview link, nothing else.'
    );
    expect(asked.data.email).toBe('');
    expect(asked.answered).toEqual(['fullName']);

    const answered = await resumeIntakeGraph({
      threadId: start.threadId,
      resume: { kind: 'text', text: 'maria@example.com' },
      data: asked.data,
      answered: asked.answered,
    });
    expect(answered.data.email).toBe('maria@example.com');
    expect(answered.ask?.questionId).not.toBe('email');
  });

  it('attaches the answer to the next ask when a question arrives bundled with a real answer', async () => {
    setIntakeGraphDeps({
      phraseAsk: async ({ scriptedPrompt }) => scriptedPrompt,
      extractAnswers: async () => [{ id: 'email', value: 'maria@example.com' }],
      answerVisitorQuestion: async () => 'We use it to send your preview link.',
      phraseClarification: async () => {
        throw new Error('unused');
      },
      translate: () => (key) => key,
    });

    const start = await startIntakeGraph({
      data: { ...EMPTY_DISCOVERY, fullName: 'Maria' },
      answered: ['fullName'],
    });

    const next = await resumeIntakeGraph({
      threadId: start.threadId,
      resume: {
        kind: 'text',
        text: "it's maria@example.com — why do you need it though?",
      },
      data: start.data,
      answered: start.answered,
    });

    expect(next.data.email).toBe('maria@example.com');
    expect(next.ask?.questionId).not.toBe('email');
    expect(next.ask?.note).toBe('We use it to send your preview link.');
  });

  it('never calls the model for an ordinary answer with no question mark in it', async () => {
    const answerVisitorQuestion = vi.fn();
    setIntakeGraphDeps({
      phraseAsk: async ({ scriptedPrompt }) => scriptedPrompt,
      extractAnswers: async () => [],
      answerVisitorQuestion,
      phraseClarification: async () => {
        throw new Error('unused');
      },
      translate: () => (key) => key,
    });

    const start = await startIntakeGraph({ locale: 'en' });
    await resumeIntakeGraph({
      threadId: start.threadId,
      resume: { kind: 'text', text: 'Maria Ionescu' },
    });

    expect(answerVisitorQuestion).not.toHaveBeenCalled();
  });
});

describe('a validation failure', () => {
  it('shows a model-phrased clarification instead of the raw scripted error, but keeps the same errorKey', async () => {
    setIntakeGraphDeps({
      phraseAsk: async ({ scriptedPrompt }) => scriptedPrompt,
      extractAnswers: async () => [],
      answerVisitorQuestion: async () => {
        throw new Error('unused');
      },
      phraseClarification: async ({ scriptedError }) =>
        `Let's try that again — ${scriptedError.toLowerCase()}`,
      translate: () => (key) => key,
    });

    const start = await startIntakeGraph({
      data: { ...EMPTY_DISCOVERY, fullName: 'Maria' },
      answered: ['fullName'],
    });

    const bad = await resumeIntakeGraph({
      threadId: start.threadId,
      resume: { kind: 'text', text: 'nope' },
      data: start.data,
      answered: start.answered,
    });

    expect(bad.errorKey).toBe('landing.discovery.chat.errors.email');
    expect(bad.ask?.note).toContain("Let's try that again");
  });

  it('fails open to the raw scripted error when the clarification call itself throws', async () => {
    setIntakeGraphDeps({
      phraseAsk: async ({ scriptedPrompt }) => scriptedPrompt,
      extractAnswers: async () => [],
      answerVisitorQuestion: async () => {
        throw new Error('unused');
      },
      phraseClarification: async () => {
        throw new Error('provider unavailable');
      },
      translate: () => (key) => key,
    });

    const start = await startIntakeGraph({
      data: { ...EMPTY_DISCOVERY, fullName: 'Maria' },
      answered: ['fullName'],
    });

    const bad = await resumeIntakeGraph({
      threadId: start.threadId,
      resume: { kind: 'text', text: 'nope' },
      data: start.data,
      answered: start.answered,
    });

    expect(bad.errorKey).toBe('landing.discovery.chat.errors.email');
    expect(bad.ask?.note).toBeUndefined();
  });
});
