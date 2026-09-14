/**
 * The friction budget.
 *
 * This file exists to stop the intake growing back. Every question in the
 * pre-preview form was defensible when it was added, and the sum of them was a
 * form people abandoned: seventeen questions between a visitor and the first
 * thing worth looking at. The number is now four, and four is a product
 * decision rather than an accident of which fields happened to seem important.
 *
 * So: a test that counts. Adding a fifth required question to the quick phase
 * fails here, by design, and the fix is to move it behind the deposit rather
 * than to edit the number. If the number genuinely should change, changing it
 * is a one-line diff that a reviewer will see and ask about, which is the
 * whole point.
 */
import { describe, expect, it } from 'vitest';

import en from '@/locales/en';
import {
  EMPTY_DISCOVERY,
  LAST_STEP,
  PREVIEW_STEP,
  STEPS,
  canProceed,
} from '../discovery.logic';
import {
  CONVERSATION_LAST_STEP,
  INTAKE_SCRIPT,
  applicableQuestions,
  briefQuestions,
  depositQuestions,
  nextQuestion,
  questionsInPhase,
  quickRequiredCount,
} from '../intake-script';

const t = (key: string): string =>
  (en as unknown as Record<string, string>)[key] ?? key;

describe('the friction budget', () => {
  it('asks exactly four questions before the preview', () => {
    // The number the product decision is about is how many questions somebody
    // MUST answer to get a preview, not how many appear on screen. A fifth
    // question with a Skip on it costs a visitor one tap and costs a visitor
    // who wants it a photograph of their own face, so the budget counts
    // `required` and this number stays at four.
    expect(quickRequiredCount()).toBe(4);
  });

  it('asks for who you are, where to send it, what you do, and one link, then offers the photo', () => {
    expect(questionsInPhase('quick').map((question) => question.id)).toEqual([
      'fullName',
      'email',
      'description',
      'links',
      'connectPortrait',
    ]);
  });

  it('allows exactly one optional question in front of the preview, and it is the photo', () => {
    // The ceiling that replaces "everything here is required". One skippable
    // offer is a feature; two is the beginning of a form, and the difference
    // between them is a number a reviewer can see change.
    const optional = questionsInPhase('quick').filter(
      (question) => !question.required
    );
    expect(optional.map((question) => question.id)).toEqual([
      'connectPortrait',
    ]);
  });

  it('makes every one of the four required, and the fifth skippable', () => {
    const quick = questionsInPhase('quick');
    for (const question of quick.filter(
      (entry) => entry.id !== 'connectPortrait'
    )) {
      expect(question.required).toBe(true);
    }
    // A portrait is worth asking for once, at the moment the visitor is
    // already thinking about their profiles. It is not something a preview
    // cannot be built without, so it never gates anything.
    expect(
      quick.find((entry) => entry.id === 'connectPortrait')?.required
    ).toBe(false);
  });

  it('keeps the rest of the script, behind the deposit', () => {
    // Nothing was deleted. Twelve questions moved to the dashboard's Brief and
    // two became the commercial pair asked against a finished preview.
    //
    // Derived from the quick phase's own length rather than written as a
    // literal, so adding or moving a quick question cannot leave this
    // arithmetic quietly wrong the way `- 4` did.
    expect(briefQuestions().length + depositQuestions().length).toBe(
      INTAKE_SCRIPT.length - questionsInPhase('quick').length
    );
    expect(depositQuestions().map((question) => question.id)).toEqual([
      'selectedTier',
      'subscription',
    ]);
    expect(briefQuestions().length).toBeGreaterThanOrEqual(10);
  });

  it('gives every question a phase, so nothing can sit in neither', () => {
    for (const question of INTAKE_SCRIPT) {
      expect(['quick', 'deposit', 'brief']).toContain(question.phase);
    }
  });

  it('cannot reach a moved question from the pre-preview conversation', () => {
    // `applicableQuestions` is the conversation's whole view of the script, so
    // a question behind the deposit is unreachable by construction rather than
    // by anybody remembering to skip it.
    const reachable = applicableQuestions(EMPTY_DISCOVERY).map((q) => q.id);
    for (const id of ['goal', 'commerceMode', 'pageCount', 'selectedTier']) {
      expect(reachable).not.toContain(id);
    }
  });
});

describe('the stages', () => {
  it('is four quick stages, then the preview, then the deposit', () => {
    expect(STEPS.map((stage) => stage.key)).toEqual([
      'name',
      'contact',
      'business',
      'links',
      'preview',
      'deposit',
    ]);
    expect(CONVERSATION_LAST_STEP).toBe(4);
    expect(PREVIEW_STEP).toBe(5);
    expect(LAST_STEP).toBe(6);
  });

  it('has one quick question per quick stage, and the connect offer on the links stage', () => {
    // Four stages, five questions, because the connect offer belongs to the
    // links stage: it is about the same link the visitor has just pasted. A
    // stage of its own would read as a fifth thing standing between them and
    // the preview, which is exactly what the stage list exists to prevent.
    const quick = questionsInPhase('quick');
    expect(quick.map((question) => question.step)).toEqual([1, 2, 3, 4, 4]);
  });

  it('names every stage in the catalogue', () => {
    for (const stage of STEPS) {
      const key = `landing.discovery.stepper.${stage.key}`;
      expect(t(key)).not.toBe(key);
    }
  });
});

describe('the quick gate', () => {
  /** Walks the four questions, answering each, and reports the stage reached. */
  function walk(answers: Record<string, string>) {
    let data = EMPTY_DISCOVERY;
    let answered: string[] = [];
    for (let guard = 0; guard < 8; guard += 1) {
      const question = nextQuestion(data, answered);
      if (!question) break;
      data = question.apply(data, answers[question.id] ?? '');
      answered = [...answered, question.id];
    }
    return { data, answered };
  }

  const FOUR = {
    fullName: 'Maria Ionescu',
    email: 'maria@example.com',
    description: 'A boutique dental clinic in Cluj doing cosmetic work.',
    links: 'instagram.com/ionescudental',
  };

  it('is spent after four answers and one offer, and only then', () => {
    const { data, answered } = walk(FOUR);
    expect(answered).toEqual([
      'fullName',
      'email',
      'description',
      'links',
      'connectPortrait',
    ]);
    expect(nextQuestion(data, answered)).toBeNull();
    expect(nextQuestion(data, answered.slice(0, -1))).not.toBeNull();
  });

  it('lets a visitor who skips the connect offer reach the preview anyway', () => {
    // The whole of what "optional" has to mean. Four answers and a skipped
    // fifth is a spent script: nothing downstream waits on a photograph, and
    // somebody who declines gets there at exactly the same speed as somebody
    // who connects.
    const { data } = walk(FOUR);
    const answered = [
      'fullName',
      'email',
      'description',
      'links',
      'connectPortrait',
    ];
    // Skipped, so nothing about a portrait was ever written into the draft.
    expect(data.portraitConnect).toBeUndefined();
    expect(data.portraitPreviewId).toBeUndefined();
    expect(nextQuestion(data, answered)).toBeNull();
    expect(canProceed(4, data)).toBe(true);
  });

  it('matches canProceed exactly, stage by stage', () => {
    let data = EMPTY_DISCOVERY;
    let answered: string[] = [];
    for (let guard = 0; guard < 8; guard += 1) {
      const question = nextQuestion(data, answered);
      if (!question) break;
      const leaving = question.step;
      // A required question's stage must not be passable before it is
      // answered. The connect offer is exempt and must be: it shares stage 4
      // with the link, which is already answered by the time it is asked, and
      // a gate on an optional question is a gate nothing can open.
      if (question.required) expect(canProceed(leaving, data)).toBe(false);
      data = question.apply(data, FOUR[question.id as keyof typeof FOUR] ?? '');
      answered = [...answered, question.id];
      // And must be passable the moment it is.
      expect(canProceed(leaving, data)).toBe(true);
    }
  });

  it('will not pass the link stage on a line with no link in it', () => {
    const { data } = walk({ ...FOUR, links: 'I do not have anything online' });
    expect(canProceed(4, data)).toBe(false);
  });

  it('passes the link stage on any one of the three kinds', () => {
    for (const line of [
      'instagram.com/ionescudental',
      'linkedin.com/in/maria',
      'ionescu-dental.ro',
    ]) {
      expect(canProceed(4, walk({ ...FOUR, links: line }).data)).toBe(true);
    }
  });

  it('never gates the preview stage', () => {
    expect(canProceed(PREVIEW_STEP, EMPTY_DISCOVERY)).toBe(true);
  });
});
