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
import { PERSON_BLOCK_IDS, PERSON_BLOCK_SKIP_LIMIT } from '../person-questions';
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

  it('asks for who you are, where to send it, what you do, and one link, then offers the own-site check, the name disambiguation, the photo and the person block', () => {
    expect(questionsInPhase('quick').map((question) => question.id)).toEqual([
      'fullName',
      'email',
      'description',
      'links',
      'websiteIsOwnSite',
      'nameOnSite',
      'connectPortrait',
      ...PERSON_BLOCK_IDS,
    ]);
  });

  it('shows a visitor who is not a person exactly the six it always did', () => {
    // The ceiling that replaces "everything here is required", restated for
    // the person block. The block is eleven questions long and it is
    // invisible to anybody whose site is not about them: a plumbing company
    // sees the same six questions it saw before the block existed, and that
    // is what makes "the intake did not get longer" a fact rather than a
    // claim.
    const company = {
      ...EMPTY_DISCOVERY,
      fullName: 'Dave Sutton',
      businessName: 'Orchard Plumbing',
      description: 'Orchard Plumbing, a two van plumbing company in Leeds.',
    };
    expect(applicableQuestions(company).map((q) => q.id)).toEqual([
      'fullName',
      'email',
      'description',
      'links',
      'connectPortrait',
    ]);
    // And a visitor who has answered nothing yet, which is where every
    // conversation starts.
    expect(applicableQuestions(EMPTY_DISCOVERY).map((q) => q.id)).toEqual([
      'fullName',
      'email',
      'description',
      'links',
      'connectPortrait',
    ]);
  });

  it('makes every one of the four required, and everything else skippable', () => {
    const quick = questionsInPhase('quick');
    const skippable = [
      'websiteIsOwnSite',
      'nameOnSite',
      'connectPortrait',
      ...PERSON_BLOCK_IDS,
    ];
    for (const question of quick.filter(
      (entry) => !skippable.includes(entry.id as never)
    )) {
      expect(question.required).toBe(true);
    }
    // A portrait is worth asking for once, at the moment the visitor is
    // already thinking about their profiles. It is not something a preview
    // cannot be built without, so it never gates anything. Nor does the
    // own-site check: it only ever narrows a guess, and a visitor who skips
    // it gets the safe default (the hostname is not used) rather than a
    // blocked preview. The person block is the same bargain eleven times
    // over: every one of its questions makes the site better and not one of
    // them stands between anybody and a preview.
    for (const id of skippable) {
      expect(quick.find((entry) => entry.id === id)?.required).toBe(false);
    }
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

  it('has one quick question per quick stage, and the own-site check, the name disambiguation and the connect offer on the links stage', () => {
    // Four stages, seven questions, because the own-site check, the
    // name-on-site disambiguation and the connect offer all belong to the
    // links stage: every one of them is about the same link the visitor has
    // just pasted. A stage of its own for any of them would read as one more
    // thing standing between them and the preview, which is exactly what the
    // stage list exists to prevent.
    const quick = questionsInPhase('quick');
    expect(quick.map((question) => question.id)).toEqual([
      'fullName',
      'email',
      'description',
      'links',
      'websiteIsOwnSite',
      'nameOnSite',
      'connectPortrait',
      ...PERSON_BLOCK_IDS,
    ]);
    expect(quick.map((question) => question.step)).toEqual([
      1,
      2,
      3,
      4,
      4,
      4,
      4,
      // The person block shares the links stage for the same reason the other
      // three do: it follows from answers already given, and a stage of its
      // own would draw a progress bar that grows while the visitor answers it.
      ...PERSON_BLOCK_IDS.map(() => 4),
    ]);
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
    // Long enough to reach the end of the person block even if every rule in
    // it stopped trimming, so a runaway `when` fails as a test rather than
    // hanging the suite.
    for (let guard = 0; guard < INTAKE_SCRIPT.length * 2; guard += 1) {
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

  it('is spent after four answers and one offer for a business with a name', () => {
    const { data, answered } = walk({
      ...FOUR,
      description:
        'Ionescu Dental, a boutique clinic in Cluj doing cosmetic work.',
    });
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

  it('asks a person the block, and stops asking the moment they stop answering', () => {
    // The same walk, by somebody who named no business: the rule reads them
    // as the business, so the block is offered. `walk` answers nothing, which
    // is a skip every time, and the block gives up after the skip limit
    // rather than asking nine more. That bound is the friction budget for
    // this block and it is why eleven optional questions cost a disengaged
    // visitor two taps.
    const { data, answered } = walk(FOUR);
    const blockAsked = answered.filter((id) =>
      (PERSON_BLOCK_IDS as readonly string[]).includes(id)
    );
    expect(blockAsked.length).toBe(PERSON_BLOCK_SKIP_LIMIT);
    expect(nextQuestion(data, answered)).toBeNull();
  });

  it('lets a visitor who skips the connect offer reach the preview anyway', () => {
    // The whole of what "optional" has to mean. Nothing downstream waits on a
    // photograph, and somebody who declines gets to the preview at exactly
    // the same speed as somebody who connects. The person block is the same:
    // `canProceed` is the gate, and no optional question can close it.
    const { data } = walk(FOUR);
    // Skipped, so nothing about a portrait was ever written into the draft.
    expect(data.portraitConnect).toBeUndefined();
    expect(data.portraitPreviewId).toBeUndefined();
    expect(canProceed(4, data)).toBe(true);
  });

  it('matches canProceed exactly, stage by stage', () => {
    let data = EMPTY_DISCOVERY;
    let answered: string[] = [];
    for (let guard = 0; guard < INTAKE_SCRIPT.length * 2; guard += 1) {
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
