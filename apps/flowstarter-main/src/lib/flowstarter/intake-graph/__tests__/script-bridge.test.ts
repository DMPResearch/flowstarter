/**
 * Deterministic half of the intake graph: apply / extract folding.
 * No LangGraph, no model — the script still decides what sticks.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_DISCOVERY,
  type DiscoveryData,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import { questionById } from '@/app/(dynamic-pages)/(main-pages)/components/discovery/intake-script';
import {
  applyResumeTurn,
  knownSnapshot,
  localeTag,
  openQuestionsForModel,
  sanitizeAnswered,
  scriptedAsk,
} from '../script-bridge';

describe('applyResumeTurn', () => {
  it('applies a primary text answer and marks the question answered', () => {
    const result = applyResumeTurn({
      data: EMPTY_DISCOVERY,
      answered: [],
      pendingId: 'fullName',
      resume: { kind: 'text', text: 'Maria Ionescu' },
    });
    expect(result.errorKey).toBeNull();
    expect(result.data.fullName).toBe('Maria Ionescu');
    expect(result.answered).toEqual(['fullName']);
  });

  it('fails open on a missing resume instead of throwing', () => {
    // `resumeIntakeGraph` reaches this function through
    // `recoverFromClientMirror`, which runs from a catch block and outside any
    // try of its own, so dereferencing `input.resume.kind` on null threw past
    // every handler. That is the one thing a recovery path must not do. The
    // type says it cannot happen and the route parses with zod first; the
    // guard is here because neither of those is what actually runs when the
    // checkpoint is already gone.
    for (const resume of [null, undefined]) {
      const result = applyResumeTurn({
        data: EMPTY_DISCOVERY,
        answered: [],
        pendingId: 'fullName',
        resume: resume as never,
      });
      expect(result.errorKey).toBe('landing.discovery.chat.errors.required');
      expect(result.applied).toEqual([]);
      expect(result.answered).toEqual([]);
      expect(result.data).toEqual(EMPTY_DISCOVERY);
    }
  });

  it('rejects an invalid email on the primary question', () => {
    const result = applyResumeTurn({
      data: { ...EMPTY_DISCOVERY, fullName: 'Maria' },
      answered: ['fullName'],
      pendingId: 'email',
      resume: { kind: 'text', text: 'not-an-email' },
    });
    expect(result.errorKey).toBe('landing.discovery.chat.errors.email');
    expect(result.answered).toEqual(['fullName']);
  });

  it('folds bonus extractions fields when they validate', () => {
    const result = applyResumeTurn({
      data: EMPTY_DISCOVERY,
      answered: [],
      pendingId: 'fullName',
      resume: {
        kind: 'text',
        text: 'Maria Ionescu, maria@example.com',
      },
      extracted: [
        { id: 'fullName', value: 'Maria Ionescu' },
        { id: 'email', value: 'maria@example.com' },
        { id: 'businessName', value: 'Ionescu Dental' },
      ],
    });
    expect(result.errorKey).toBeNull();
    expect(result.data.fullName).toBe('Maria Ionescu');
    expect(result.data.email).toBe('maria@example.com');
    expect(result.data.businessName).toBe('Ionescu Dental');
    expect(result.answered).toEqual(['fullName', 'email', 'businessName']);
  });

  it('allows skipping an optional question', () => {
    const result = applyResumeTurn({
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
      pendingId: 'targetAudience',
      resume: { kind: 'skip' },
    });
    expect(result.errorKey).toBeNull();
    expect(result.answered).toContain('targetAudience');
  });
});

describe('sanitizeAnswered', () => {
  it('drops unknown ids and de-dupes', () => {
    expect(sanitizeAnswered(['fullName', 'nope', 'fullName', 'email'])).toEqual(
      ['fullName', 'email']
    );
  });
});

describe('openQuestionsForModel', () => {
  it('lists the next few non-panel questions', () => {
    const t = (key: string) => key;
    const open = openQuestionsForModel(EMPTY_DISCOVERY, [], false, t);
    expect(open[0]?.id).toBe('fullName');
    expect(open.some((q) => q.id === 'selectedTier')).toBe(false);
  });
});

describe('packaging one question for the visitor', () => {
  const t = (key: string) => `t(${key})`;

  it('carries the chips, their words and the placeholder', () => {
    const ask = scriptedAsk(questionById('industry')!, EMPTY_DISCOVERY, t);

    expect(ask.type).toBe('ask');
    expect(ask.kind).toBe('choice');
    expect(ask.required).toBe(false);
    expect(ask.placeholder).toBe(
      't(landing.discovery.placeholders.industryOther)'
    );
    expect(ask.options?.length).toBeGreaterThan(0);
    // Every chip is translated, never shipped as a raw locale key.
    for (const option of ask.options ?? []) {
      expect(option.value).toBeTruthy();
      expect(option.label).toBeTruthy();
    }
  });

  it('leaves the placeholder out when the script has no hint for it', () => {
    const ask = scriptedAsk(questionById('pageCount')!, EMPTY_DISCOVERY, t);
    expect(ask.placeholder).toBeUndefined();
  });

  it('marks a pricing panel as a panel, not a question to type into', () => {
    const ask = scriptedAsk(questionById('selectedTier')!, EMPTY_DISCOVERY, t);
    expect(ask.type).toBe('panel');
    expect(ask.kind).toBe('panel');
  });
});

describe('knownSnapshot', () => {
  it('shows the model what is already on file, and nothing else', () => {
    const snapshot = knownSnapshot({
      ...EMPTY_DISCOVERY,
      fullName: 'Maria Ionescu',
      email: 'maria@example.com',
      selectedTier: 'pro',
    });

    expect(snapshot.fullName).toBe('Maria Ionescu');
    expect(snapshot.email).toBe('maria@example.com');
    expect(snapshot.selectedTier).toBe('pro');
    expect(snapshot.businessName).toBe('');
    // No stray fields: the prompt is a fixed catalogue, not the raw object.
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        'brandTone',
        'businessName',
        'calComUrl',
        'catalogSize',
        'commerceMode',
        'customIntegrations',
        'description',
        'email',
        'fullName',
        'goal',
        'industry',
        'pageCount',
        'selectedTier',
        'subscription',
        'targetAudience',
        'timeline',
      ].sort()
    );
  });
});

describe('what the model is never allowed to fill', () => {
  const t = (key: string) => key;
  const nearlyDone: DiscoveryData = {
    ...EMPTY_DISCOVERY,
    fullName: 'Maria',
    email: 'maria@example.com',
    businessName: 'Clinic',
    description: 'A dental clinic in Cluj with evening appointments.',
    industry: 'Therapy & wellness',
    goal: 'Take bookings or appointments',
    commerceMode: 'none',
  };
  const answeredAll = [
    'fullName',
    'email',
    'businessName',
    'description',
    'industry',
    'goal',
    'commerceMode',
  ];

  it('stops at the pricing panel rather than offering it as a field', () => {
    const open = openQuestionsForModel(nearlyDone, answeredAll, true, t);
    expect(open).toEqual([]);
  });

  it('runs dry when the script has nothing left', () => {
    expect(
      openQuestionsForModel(nearlyDone, answeredAll, true, t)
    ).toHaveLength(0);
  });
});

describe('folding a turn back into the wizard data', () => {
  const answeredEssentials = [
    'fullName',
    'email',
    'businessName',
    'description',
    'industry',
    'goal',
    'commerceMode',
  ];
  const filled: DiscoveryData = {
    ...EMPTY_DISCOVERY,
    fullName: 'Maria',
    email: 'maria@example.com',
    businessName: 'Clinic',
    description: 'A dental clinic in Cluj with evening appointments.',
    industry: 'Therapy & wellness',
    goal: 'Take bookings or appointments',
    commerceMode: 'none',
  };

  it('refuses a question the script has never heard of', () => {
    const result = applyResumeTurn({
      data: EMPTY_DISCOVERY,
      answered: [],
      pendingId: 'notAQuestion' as never,
      resume: { kind: 'text', text: 'anything' },
    });
    expect(result.errorKey).toBe('landing.discovery.chat.errors.required');
    expect(result.applied).toEqual([]);
    expect(result.data).toBe(EMPTY_DISCOVERY);
  });

  it('will not let a required question be skipped', () => {
    const result = applyResumeTurn({
      data: EMPTY_DISCOVERY,
      answered: [],
      pendingId: 'fullName',
      resume: { kind: 'skip' },
    });
    expect(result.errorKey).toBe('landing.discovery.chat.errors.required');
    expect(result.answered).toEqual([]);
  });

  it('will not let a required question be answered with whitespace', () => {
    const result = applyResumeTurn({
      data: EMPTY_DISCOVERY,
      answered: [],
      pendingId: 'fullName',
      resume: { kind: 'text', text: '   ' },
    });
    expect(result.errorKey).toBe('landing.discovery.chat.errors.required');
    expect(result.applied).toEqual([]);
  });

  it('accepts a panel choice by its value', () => {
    const result = applyResumeTurn({
      data: filled,
      answered: answeredEssentials,
      pendingId: 'selectedTier',
      resume: { kind: 'panel', value: 'pro' },
    });
    expect(result.errorKey).toBeNull();
    expect(result.data.selectedTier).toBe('pro');
    expect(result.applied).toEqual([{ id: 'selectedTier', raw: 'pro' }]);
  });

  it('lets an optional question be answered with nothing at all', () => {
    const result = applyResumeTurn({
      data: filled,
      answered: answeredEssentials,
      pendingId: 'targetAudience',
      resume: { kind: 'text', text: '  ' },
    });
    expect(result.errorKey).toBeNull();
    expect(result.answered).toContain('targetAudience');
    expect(result.applied).toEqual([{ id: 'targetAudience', raw: '' }]);
  });

  it('drops every bonus field the script would not have accepted', () => {
    const result = applyResumeTurn({
      data: EMPTY_DISCOVERY,
      answered: [],
      pendingId: 'fullName',
      resume: {
        kind: 'text',
        text: 'hi, maria ionescu here, we run a dental clinic in Cluj',
      },
      extracted: [
        // The model's reading of the pending field wins over the raw
        // utterance, and is still counted only once.
        { id: 'fullName', value: 'Maria Ionescu' },
        { id: 'invented', value: 'nonsense' }, // not a question
        { id: 'selectedTier', value: 'pro' }, // a panel, priced by a human
        { id: 'businessName', value: '   ' }, // nothing to store
        { id: 'email', value: 'not-an-email' }, // fails the script's validator
        { id: 'description', value: 'A dental clinic in Cluj.' },
      ],
    });

    expect(result.errorKey).toBeNull();
    expect(result.data.fullName).toBe('Maria Ionescu');
    expect(result.data.email).toBe('');
    expect(result.data.businessName).toBe('');
    expect(result.data.selectedTier).toBe('');
    expect(result.data.description).toBe('A dental clinic in Cluj.');
    expect(result.answered).toEqual(['fullName', 'description']);
    expect(result.applied).toEqual([
      { id: 'fullName', raw: 'Maria Ionescu' },
      { id: 'description', raw: 'A dental clinic in Cluj.' },
    ]);
  });

  it('never re-answers a question the visitor already dealt with', () => {
    const result = applyResumeTurn({
      data: { ...EMPTY_DISCOVERY, fullName: 'Maria' },
      answered: ['fullName'],
      pendingId: 'email',
      resume: { kind: 'text', text: 'maria@example.com' },
      extracted: [
        { id: 'email', value: 'maria@example.com' },
        { id: 'fullName', value: 'Someone Else' },
      ],
    });

    expect(result.data.fullName).toBe('Maria');
    expect(result.answered).toEqual(['fullName', 'email']);
  });
});

describe('localeTag', () => {
  it('knows exactly two locales and defaults to English', () => {
    expect(localeTag('ro')).toBe('ro');
    expect(localeTag('en')).toBe('en');
    expect(localeTag(undefined)).toBe('en');
    expect(localeTag('fr' as never)).toBe('en');
  });
});
