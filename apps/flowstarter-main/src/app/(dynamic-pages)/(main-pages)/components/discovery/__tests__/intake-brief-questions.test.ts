/**
 * The questions that moved behind the deposit.
 *
 * Cutting the pre-preview intake to four questions did not delete the other
 * fourteen. Twelve of them are asked on the dashboard as the Brief and two are
 * the commercial pair asked against a finished preview, and every one of them
 * still carries its own chips, validator, applier and reaction.
 *
 * The behaviours here used to be covered through the rendered conversation, in
 * `IntakeConversation.test.tsx`. They cannot be any more: `applicableQuestions`
 * is scoped to the quick phase, so a moved question is unreachable from the
 * pre-preview conversation by construction, which is the whole friction rule.
 * The mechanisms are still real and still worth protecting, so they are
 * exercised here against the question objects directly -- which is also where
 * they belong, because the Brief form and the deposit panels are the surfaces
 * that read them now.
 *
 * Nothing here renders anything and nothing here calls a model. The chips, the
 * letters, the reactions and the conditions are all rules.
 */
import { describe, expect, it } from 'vitest';
import en from '@/locales/en';
import {
  type DiscoveryData,
  DEPOSIT_STEP,
  EMPTY_DISCOVERY,
} from '../discovery.logic';
import {
  answerText,
  applicableQuestions,
  briefQuestions,
  depositQuestions,
  matchOption,
  optionLabel,
  questionById,
  reflectionText,
  shortcutLetter,
} from '../intake-script';

const t = (key: string): string =>
  (en as unknown as Record<string, string>)[key] ?? key;

const q = (id: string) => {
  const question = questionById(id);
  if (!question) throw new Error(`no such question: ${id}`);
  return question;
};

describe('the chips the Brief inherited', () => {
  it('takes a tapped industry chip as the value the preview reads', () => {
    const industry = q('industry');
    expect(industry.kind).toBe('choice');
    expect(industry.apply(EMPTY_DISCOVERY, 'Therapy & wellness').industry).toBe(
      'Therapy & wellness'
    );
  });

  it('keeps the industry chips a shortcut rather than a closed list', () => {
    // A business that does not fit one of the twelve is not an error, so the
    // question carries `freeText` and no validator at all.
    const industry = q('industry');
    expect(industry.freeText).toBe(true);
    expect(industry.validate).toBeUndefined();
    expect(industry.apply(EMPTY_DISCOVERY, '  Falconry ').industry).toBe(
      'Falconry'
    );
  });

  it('answers a typed word as the chip it names, whatever the capitals', () => {
    // The mechanism the conversation used to show by typing "not sure" at the
    // page-count question instead of tapping it.
    const pages = q('pageCount');
    expect(matchOption(pages.options, 'not sure')).toBe('unsure');
    expect(matchOption(pages.options, '  Not Sure ')).toBe('unsure');
    expect(pages.validate?.('not sure')).toBeNull();
  });

  it('corrects a word it does not know rather than guessing at it', () => {
    const pages = q('pageCount');
    expect(matchOption(pages.options, 'a dozen')).toBeNull();
    expect(pages.validate?.('a dozen')).toBe(
      'landing.discovery.chat.errors.choice'
    );
    // And nothing is written: a rejected answer leaves the field alone.
    expect(pages.apply(EMPTY_DISCOVERY, 'a dozen').pageCount).toBe('');
  });

  it('letters its quick replies in the order they are shown', () => {
    // "B" is the second option, and the second option is the one the letter
    // addresses -- the keyboard shortcut is index arithmetic over this list,
    // so the list's order is the thing that must not drift.
    const options = q('pageCount').options ?? [];
    expect(
      options.map((_, index) => shortcutLetter(index)).slice(0, 5)
    ).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(options[1]?.value).toBe('5-7');
    expect(optionLabel(options[1]!, t)).toBe('5 – 7');
  });

  it('reacts to a pick with the consequence of that pick, chosen by rule', () => {
    const commerce = q('commerceMode');
    const digital = commerce.apply(EMPTY_DISCOVERY, 'digital');
    expect(reflectionText(commerce, digital, t)).toBe(
      t('landing.discovery.chat.q.commerceMode.reflect.digital')
    );

    // Changed their mind: the reaction is rewritten from the stored value, so
    // there is no way for the old line to survive the new answer.
    const none = commerce.apply(digital, 'none');
    expect(reflectionText(commerce, none, t)).toBe(
      t('landing.discovery.chat.q.commerceMode.reflect.none')
    );
    expect(reflectionText(commerce, none, t)).not.toBe(
      t('landing.discovery.chat.q.commerceMode.reflect.digital')
    );
  });

  it('shows a pick back in the catalogue words, not the stored code', () => {
    const commerce = q('commerceMode');
    expect(
      answerText(commerce, commerce.apply(EMPTY_DISCOVERY, 'few-services'), t)
    ).toBe('A few paid offers');
  });
});

describe('the optional questions the Brief kept', () => {
  it('still has some, now that every quick question is required', () => {
    expect(
      briefQuestions().filter((question) => !question.required).length
    ).toBeGreaterThan(0);
  });

  it('accepts nothing at all, and says so rather than leaving a hole', () => {
    const businessName = q('businessName');
    expect(businessName.required).toBe(false);
    expect(businessName.validate).toBeUndefined();
    const skipped = businessName.apply(EMPTY_DISCOVERY, '');
    expect(skipped.businessName).toBe('');
    // Empty means skipped -- the caller draws that as "skipped", and the
    // question has a line of its own for it.
    expect(answerText(businessName, skipped, t)).toBe('');
    expect(reflectionText(businessName, skipped, t)).toBe(
      t('landing.discovery.chat.q.businessName.reflect.skipped')
    );
  });
});

describe('the catalog size, asked only of a business that sells', () => {
  it('turns on with the commerce answer and off again with it', () => {
    const commerce = q('commerceMode');
    const catalog = q('catalogSize');

    const selling = commerce.apply(EMPTY_DISCOVERY, 'physical');
    expect(selling.catalogSize).toBe('1-5');
    expect(catalog.when?.(selling)).toBe(true);

    const sized = catalog.apply(selling, '26-100');
    expect(sized.catalogSize).toBe('26-100');

    // Changed their mind: the catalog size goes with it, and the question
    // stops applying rather than lingering as a wrong answer.
    const reversed = commerce.apply(sized, 'none');
    expect(reversed.catalogSize).toBe('na');
    expect(catalog.when?.(reversed)).toBe(false);
    expect(catalog.value(reversed)).toBe('');
  });
});

describe('the commercial panels', () => {
  it('is the build package and then the monthly plan, in that order', () => {
    expect(depositQuestions().map((question) => question.id)).toEqual([
      'selectedTier',
      'subscription',
    ]);
  });

  it('is shown as a panel rather than something to type into', () => {
    // A price comparison is not something a chat bubble does well, so both
    // keep their cards and neither is phrased by a model.
    for (const question of depositQuestions()) {
      expect(question.kind).toBe('panel');
      expect(question.required).toBe(true);
      expect(question.step).toBe(DEPOSIT_STEP);
      expect((question.options ?? []).length).toBeGreaterThan(0);
      for (const option of question.options ?? []) {
        expect(optionLabel(option, t)).not.toBe(option.labelKey);
      }
    }
  });

  it('files the value the wizard gates on', () => {
    const tier = q('selectedTier').apply(EMPTY_DISCOVERY, 'pro');
    expect(tier.selectedTier).toBe('pro');
    const both = q('subscription').apply(tier, 'pro');
    expect(both.subscription).toBe('pro');
  });

  it('leaves the plan alone for a Commerce build, which has no plan to pick', () => {
    // `choiceApplier` ignores a value that is not one of the three plans,
    // which is right: that build has a dedicated store subscription.
    const commerce: DiscoveryData = {
      ...EMPTY_DISCOVERY,
      selectedTier: 'commerce',
    };
    expect(q('subscription').apply(commerce, 'commerce').subscription).toBe('');
    expect(answerText(q('subscription'), commerce, t)).toBe('Commerce');
  });

  it('is unreachable from the pre-preview conversation', () => {
    // The panels are the wizard's deposit step now, not the last two turns of
    // the intake. Nothing the visitor can say before the preview reaches them.
    const reachable = applicableQuestions(EMPTY_DISCOVERY).map(
      (question) => question.id
    );
    for (const question of depositQuestions()) {
      expect(reachable).not.toContain(question.id);
    }
  });
});
