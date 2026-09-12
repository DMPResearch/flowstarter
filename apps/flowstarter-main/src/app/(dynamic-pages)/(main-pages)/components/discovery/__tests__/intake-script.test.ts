/**
 * The intake conversation's rules.
 *
 * This is the file that decides what the agent asks, in what order, what it
 * will accept, and when it stops asking. None of that is allowed to become a
 * model's opinion, so the whole of it is tested without rendering anything and
 * without a network in sight.
 *
 * What it does *not* cover is how many questions stand in front of the
 * preview, which stages there are, or that the quick phase lines up with
 * `canProceed`. Those are the friction budget, and `intake-friction.test.ts`
 * owns them: a number asserted in two files is a number that gets changed in
 * one of them. This file is the mechanics underneath -- validators, appliers,
 * option matching, reflections, interpolation -- for every question in the
 * script, including the ten the Brief now asks after the deposit.
 */
import { describe, expect, it } from 'vitest';
import en from '@/locales/en';
import {
  type DiscoveryData,
  type Step,
  EMPTY_DISCOVERY,
  PREVIEW_STEP,
  canProceed,
} from '../discovery.logic';
import {
  INTAKE_SCRIPT,
  answerText,
  answeredQuestions,
  conversationProgress,
  firstSentence,
  humanList,
  interpolate,
  nextQuestion,
  promptText,
  questionById,
  questionsInPhase,
  reflectionText,
  shortcutLetter,
  stepForConversation,
  websiteFrom,
} from '../intake-script';

const t = (key: string): string =>
  (en as unknown as Record<string, string>)[key] ?? key;

/** Answers a question the way the component would, and hands back both halves. */
function answer(
  data: DiscoveryData,
  answered: string[],
  id: string,
  raw: string
): { data: DiscoveryData; answered: string[] } {
  const question = questionById(id);
  if (!question) throw new Error(`no such question: ${id}`);
  return {
    data: question.apply(data, raw),
    answered: answered.includes(id) ? answered : [...answered, id],
  };
}

/**
 * Walks the pre-preview conversation, answering everything, collecting the
 * order asked. `nextQuestion` is scoped to the quick phase, so this reaches
 * exactly the questions a visitor is asked before they see anything.
 */
function walk(
  answers: Record<string, string>,
  start: DiscoveryData = EMPTY_DISCOVERY
): { data: DiscoveryData; asked: string[]; steps: Step[] } {
  let data = start;
  let answered: string[] = [];
  const asked: string[] = [];
  const steps: Step[] = [];
  for (let guard = 0; guard < INTAKE_SCRIPT.length + 2; guard += 1) {
    const question = nextQuestion(data, answered);
    if (!question) break;
    asked.push(question.id);
    steps.push(question.step);
    const applied = answer(
      data,
      answered,
      question.id,
      answers[question.id] ?? ''
    );
    data = applied.data;
    answered = applied.answered;
  }
  return { data, asked, steps };
}

const FULL_ANSWERS: Record<string, string> = {
  fullName: 'Maria Ionescu',
  email: 'maria@example.com',
  businessName: 'Ionescu Dental',
  description: 'A boutique dental clinic in Cluj doing cosmetic work.',
  offer: 'Whitening, veneers and a nervous-patient first visit.',
  industry: 'Therapy & wellness',
  targetAudience: 'Adults in Cluj who avoided the dentist for a decade.',
  links:
    'instagram.com/ionescudental, linkedin.com/company/ionescu, ionescu-dental.ro',
  goal: 'Take bookings or appointments',
  brandTone: 'Calm, Trustworthy',
  pageCount: '5-7',
  timeline: 'asap',
  calComUrl: 'https://cal.com/ionescu-dental/intro',
  customIntegrations: 'Mailchimp for newsletters',
  selectedTier: 'starter',
  subscription: 'pro',
};

describe('the script itself', () => {
  it('asks one thing at a time, never twice, and never goes backwards', () => {
    // Which questions these are, and how many, belongs to the friction
    // budget. What is pinned here is the shape of the walk itself.
    const { asked, steps } = walk(FULL_ANSWERS);
    expect(new Set(asked).size).toBe(asked.length);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });

  it('keeps the transcript in the order the visitor dealt with it', () => {
    const { data, asked } = walk(FULL_ANSWERS);
    // `answeredQuestions` is the transcript's spine, so it follows the
    // visitor's own order rather than the script's.
    const backwards = [...asked].reverse();
    expect(answeredQuestions(data, backwards).map((q) => q.id)).toEqual(
      backwards
    );
    // And an id the conversation never had is not invented into it.
    expect(
      answeredQuestions(data, [...asked, 'pageCount']).map((q) => q.id)
    ).toEqual(asked);
  });

  it('hands the wizard on to the preview when it runs out of questions', () => {
    const { data, asked } = walk(FULL_ANSWERS);
    expect(stepForConversation(data, [], PREVIEW_STEP)).toBe(1);
    expect(stepForConversation(data, asked, PREVIEW_STEP)).toBe(PREVIEW_STEP);
  });

  it('every question in the script has copy in the catalogue', () => {
    INTAKE_SCRIPT.forEach((question) => {
      expect(t(question.promptKey)).not.toBe(question.promptKey);
      if (question.placeholderKey) {
        expect(t(question.placeholderKey)).not.toBe(question.placeholderKey);
      }
      (question.options ?? []).forEach((option) => {
        if (option.labelKey)
          expect(t(option.labelKey)).not.toBe(option.labelKey);
      });
    });
  });
});

describe('the required-answer gate', () => {
  // That the quick phase and `canProceed` agree stage by stage is asserted in
  // `intake-friction.test.ts`, which walks the two against each other. What is
  // pinned here is the validators themselves, including the ones that
  // travelled with a question to the Brief.
  it('will not accept an empty or malformed answer to a required question', () => {
    expect(questionById('fullName')?.validate?.('M')).toBe(
      'landing.discovery.chat.errors.fullName'
    );
    expect(questionById('fullName')?.validate?.('Maria')).toBeNull();
    expect(questionById('email')?.validate?.('maria at example')).toBe(
      'landing.discovery.chat.errors.email'
    );
    expect(questionById('email')?.validate?.('maria@example.com')).toBeNull();
    expect(questionById('description')?.validate?.('dentist')).toBe(
      'landing.discovery.chat.errors.description'
    );
    expect(
      questionById('description')?.validate?.('A dental clinic in Cluj.')
    ).toBeNull();
    expect(questionById('offer')?.validate?.('stuff')).toBe(
      'landing.discovery.chat.errors.offer'
    );
    expect(
      questionById('offer')?.validate?.('Whitening and veneers.')
    ).toBeNull();
    // One link, of any of the three kinds, and a line with none in it is
    // corrected rather than accepted.
    expect(questionById('links')?.validate?.('I am not online anywhere')).toBe(
      'landing.discovery.chat.errors.links'
    );
    expect(
      questionById('links')?.validate?.('instagram.com/ionescudental')
    ).toBeNull();
    expect(questionById('links')?.validate?.('ionescu-dental.ro')).toBeNull();
  });

  it('gates the what-you-do stage on the description alone, now the offer has moved', () => {
    const described = questionById('description')!.apply(
      EMPTY_DISCOVERY,
      'A boutique dental clinic in Cluj doing cosmetic work.'
    );
    expect(canProceed(3, EMPTY_DISCOVERY)).toBe(false);
    expect(canProceed(3, described)).toBe(true);
    // The offer used to gate this stage alongside it. It is asked on the
    // dashboard now, so it cannot hold a visitor up in front of the preview.
    expect(questionById('offer')!.phase).toBe('brief');
    expect(canProceed(3, { ...described, offer: '' })).toBe(true);
  });

  it('treats a draft saved before the offer existed as unfinished, not broken', () => {
    // `offer` is read with `?? ''` everywhere, so a stored draft from before
    // the question existed re-enters the conversation at its first unanswered
    // question rather than throwing.
    const legacy = { ...EMPTY_DISCOVERY } as Record<string, unknown>;
    delete legacy['offer'];
    const data = legacy as unknown as DiscoveryData;
    expect(() => questionById('offer')!.value(data)).not.toThrow();
    expect(questionById('offer')!.value(data)).toBe('');
    expect(nextQuestion(data, [])?.id).toBe('fullName');
  });

  it('keeps every required question required, whichever phase it moved to', () => {
    // Moving a question did not make it optional. The four in front of the
    // preview are gated by `canProceed`; `goal` is the Brief's own required
    // field (its former Brief-mate `commerceMode` was removed from the
    // script entirely -- see `intake-script.ts` -- rather than left as a
    // required question nothing ever asks), and the two panels are the
    // deposit's.
    const required = INTAKE_SCRIPT.filter((question) => question.required);
    expect(required.map((question) => question.id)).toEqual([
      'fullName',
      'email',
      'description',
      'links',
      'goal',
      'selectedTier',
      'subscription',
    ]);
    expect(required.map((question) => question.phase)).toEqual([
      'quick',
      'quick',
      'quick',
      'quick',
      'brief',
      'deposit',
      'deposit',
    ]);
  });

  it('counts progress over the questions this visitor is actually asked', () => {
    const start = conversationProgress(EMPTY_DISCOVERY, []);
    expect(start.done).toBe(0);
    expect(start.total).toBe(questionsInPhase('quick').length);

    const { data, asked } = walk(FULL_ANSWERS);
    const end = conversationProgress(data, asked);
    expect(end.done).toBe(end.total);
  });
});

/** Applies every question in the script, whichever phase it now belongs to. */
function applyWholeScript(answers: Record<string, string>): DiscoveryData {
  let data = EMPTY_DISCOVERY;
  for (const question of INTAKE_SCRIPT) {
    data = question.apply(data, answers[question.id] ?? '');
  }
  return data;
}

describe('answers landing in DiscoveryData', () => {
  it('keeps the DiscoveryData shape the preview already reads', () => {
    // Applied directly rather than walked: the Brief asks ten of these on the
    // dashboard now (`commerceMode`/`catalogSize` were removed from the
    // script entirely -- see `intake-script.ts` -- rather than kept as
    // questions nothing asks), and they have to land in the same fields the
    // conversation used to write.
    const data = applyWholeScript(FULL_ANSWERS);
    expect(data).toMatchObject({
      fullName: 'Maria Ionescu',
      email: 'maria@example.com',
      businessName: 'Ionescu Dental',
      industry: 'Therapy & wellness',
      goal: 'Take bookings or appointments',
      brandTone: 'Calm, Trustworthy',
      pageCount: '5-7',
      timeline: 'asap',
      calComUrl: 'https://cal.com/ionescu-dental/intro',
      customIntegrations: 'Mailchimp for newsletters',
    });
    // Never asked by the script -- explicitly defaulted downstream by
    // `quick-defaults.ts`'s `DEFAULT_COMMERCE_MODE` instead.
    expect(data.commerceMode).toBe('');
    expect(data.catalogSize).toBe('na');
    expect(Object.keys(data).sort()).toEqual(
      Object.keys(EMPTY_DISCOVERY).sort()
    );
  });

  // `commerceMode`'s "matches a typed answer to a chip, however it was
  // capitalised" coverage lived here; the question is gone from the script
  // (see `intake-script.ts`), and `matchOption`'s case-insensitive matching
  // is still exercised via `pageCount` in intake-brief-questions.test.ts.

  it('takes an industry the chips do not cover, verbatim', () => {
    const industry = questionById('industry');
    expect(industry?.apply(EMPTY_DISCOVERY, 'Falconry').industry).toBe(
      'Falconry'
    );
    expect(industry?.validate).toBeUndefined();
  });

  it('pulls all three profile links out of one answer', () => {
    const links = questionById('links');
    const data = links?.apply(
      EMPTY_DISCOVERY,
      'here you go: instagram.com/ionescudental and https://www.linkedin.com/company/ionescu, site is ionescu-dental.ro'
    );
    expect(data?.instagramUrl).toBe('https://instagram.com/ionescudental');
    expect(data?.linkedinUrl).toBe('https://www.linkedin.com/company/ionescu');
    expect(data?.websiteUrl).toBe('https://ionescu-dental.ro');
  });

  it('does not mistake a social profile for their own website', () => {
    const data = questionById('links')?.apply(
      EMPTY_DISCOVERY,
      'just instagram.com/ionescudental'
    );
    expect(data?.instagramUrl).toBe('https://instagram.com/ionescudental');
    expect(data?.websiteUrl).toBe('');
  });

  it('reads a bare domain as the website, the way people write their own address', () => {
    expect(websiteFrom('ionescu-dental.ro')).toBe('https://ionescu-dental.ro');
    expect(websiteFrom('https://ionescu-dental.ro/about')).toBe(
      'https://ionescu-dental.ro/about'
    );
    expect(websiteFrom('no links at all here')).toBe('');
  });

  it('shows all three links back as the visitor bubble', () => {
    const data = questionById('links')!.apply(
      EMPTY_DISCOVERY,
      'instagram.com/a, linkedin.com/in/b, c.com'
    );
    expect(questionById('links')!.value(data)).toBe(
      'https://instagram.com/a · https://linkedin.com/in/b · https://c.com'
    );
  });

  // The catalog-size question and its `when` condition moved to the Brief with
  // the rest of the commerce vocabulary; `intake-brief-questions.test.ts`
  // exercises them where they now live.
});

describe('what the visitor sees', () => {
  it('says their own name back to them, without asking a model to', () => {
    const data: DiscoveryData = {
      ...EMPTY_DISCOVERY,
      fullName: 'Maria Ionescu',
      businessName: 'Ionescu Dental',
    };
    // The greeting is the reaction to their name: first name only, and never
    // the business, which they have not mentioned yet.
    expect(reflectionText(questionById('fullName')!, data, t)).toContain(
      'Maria'
    );
    expect(reflectionText(questionById('fullName')!, data, t)).not.toContain(
      'Ionescu'
    );
    expect(promptText(questionById('description')!, data, t)).toContain(
      'Ionescu Dental'
    );
    // Nothing typed yet: a stand-in, never a raw {token}.
    const blank = promptText(questionById('description')!, EMPTY_DISCOVERY, t);
    expect(blank).toContain('your business');
    expect(blank).not.toContain('{');
  });

  it('leaves an unknown token alone rather than printing "undefined"', () => {
    expect(interpolate('a {known} and a {mystery}', { known: 'cat' })).toBe(
      'a cat and a {mystery}'
    );
  });

  it("draws the visitor's bubble from the catalogue's words, not the stored code", () => {
    const data: DiscoveryData = {
      ...EMPTY_DISCOVERY,
      timeline: '4-weeks',
      selectedTier: 'commerce',
    };
    expect(answerText(questionById('timeline')!, data, t)).toBe(
      'Within 4 weeks'
    );
    // A Commerce build has no plan to choose — it has the store plan.
    expect(answerText(questionById('subscription')!, data, t)).toBe('Commerce');
    // A skipped question has no bubble text; the caller says "skipped".
    expect(answerText(questionById('brandTone')!, EMPTY_DISCOVERY, t)).toBe('');
  });
});

describe('what the agent says back', () => {
  const q = (id: string) => {
    const question = questionById(id);
    if (!question) throw new Error(`no such question: ${id}`);
    return question;
  };

  it('picks the reaction to a chip by the stored value, never by a model', () => {
    const asap = q('timeline').apply(EMPTY_DISCOVERY, 'asap');
    expect(reflectionText(q('timeline'), asap, t)).toBe(
      t('landing.discovery.chat.q.timeline.reflect.asap')
    );
    const flexible = q('timeline').apply(EMPTY_DISCOVERY, 'flexible');
    expect(reflectionText(q('timeline'), flexible, t)).toBe(
      t('landing.discovery.chat.q.timeline.reflect.flexible')
    );
  });

  it("folds the visitor's own words into the reaction", () => {
    const named = q('fullName').apply(EMPTY_DISCOVERY, 'Maria Ionescu');
    expect(reflectionText(q('fullName'), named, t)).toBe(
      'Hey Maria, good to meet you.'
    );
    const described = q('description').apply(
      named,
      'A boutique dental clinic in Cluj. We do cosmetic work, mostly veneers.'
    );
    expect(reflectionText(q('description'), described, t)).toContain(
      '"A boutique dental clinic in Cluj."'
    );
    const goals = q('goal').apply(
      named,
      'Take bookings or appointments, Grow an email list'
    );
    expect(reflectionText(q('goal'), goals, t)).toContain(
      'take bookings or appointments and grow an email list'
    );
  });

  it('has a line for a skip, specific where it matters and rotating where it does not', () => {
    expect(reflectionText(q('businessName'), EMPTY_DISCOVERY, t)).toBe(
      t('landing.discovery.chat.q.businessName.reflect.skipped')
    );
    // Timeline has no skip line of its own: a generic one, decided by index.
    const generic = reflectionText(q('timeline'), EMPTY_DISCOVERY, t);
    expect(generic.length).toBeGreaterThan(0);
    expect(
      [0, 1, 2].map((i) => t(`landing.discovery.chat.reflect.skipped.${i}`))
    ).toContain(generic);
  });

  it('every question either reacts or deliberately stays quiet, and no reaction leaks a key', () => {
    const full: Record<string, string> = {
      fullName: 'Maria Ionescu',
      email: 'maria@example.com',
      businessName: 'Ionescu Dental',
      description: 'A boutique dental clinic in Cluj doing cosmetic work.',
      industry: 'Therapy & wellness',
      targetAudience: 'Adults in Cluj who want a better smile.',
      links: 'instagram.com/ionescudental',
      goal: 'Take bookings or appointments',
      brandTone: 'Warm, Premium / elegant',
      pageCount: '5-7',
      timeline: 'asap',
      calComUrl: 'https://cal.com/maria',
      customIntegrations: 'A newsletter',
      selectedTier: 'pro',
      subscription: 'pro',
    };
    let data = EMPTY_DISCOVERY;
    for (const [id, raw] of Object.entries(full)) data = q(id).apply(data, raw);
    const quiet: string[] = [];
    for (const question of INTAKE_SCRIPT) {
      const line = reflectionText(question, data, t);
      expect(line).not.toMatch(/landing\.discovery/);
      expect(line).not.toContain('{');
      if (!line) quiet.push(question.id);
    }
    // The monthly plan is the last decision there is; nothing follows it to
    // react to, so it deliberately says nothing back.
    expect(quiet).toEqual(['subscription']);
  });

  it('reads back a first sentence, cut to a quote', () => {
    expect(firstSentence('Short and sweet. Then more.')).toBe(
      'Short and sweet'
    );
    expect(firstSentence('No full stop at all')).toBe('No full stop at all');
    const long = `${'word '.repeat(40)}end.`;
    const cut = firstSentence(long);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(112);
  });

  it('turns a comma list into a sentence, and letters the quick replies', () => {
    expect(humanList('Warm', t)).toBe('warm');
    expect(humanList('Warm, Calm, Bold', t)).toBe('warm, calm and bold');
    expect(humanList('', t)).toBe('');
    expect([0, 1, 25, 26].map(shortcutLetter)).toEqual(['A', 'B', 'Z', 'A']);
  });
});
