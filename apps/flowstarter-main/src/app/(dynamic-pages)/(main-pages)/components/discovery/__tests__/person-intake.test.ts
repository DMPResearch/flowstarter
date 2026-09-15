/**
 * The person block, walked by seven different people.
 *
 * The defect this suite exists for was not a wrong answer, it was a question
 * nobody asked. So the assertions are about WHO gets asked WHAT, in WHICH
 * order, and the control matters as much as the cases: `orchard-plumbing` is
 * in the fixture list precisely so that "a plumber is never asked what they
 * want people to feel" is a test rather than a claim in a comment.
 */
import { describe, expect, it } from 'vitest';
import { PERSONAS, persona } from '@/test/fixtures/personas';
import {
  ACTIVITY_QUESTION_IDS,
  PERSON_BLOCK_IDS,
  PERSON_BLOCK_SKIP_LIMIT,
  PERSON_QUESTION_IDS,
  asksPersonQuestions,
  consentedPersonLinkCount,
  intakeSiteKind,
  personBlockAnswered,
  visitorIsTheBusiness,
} from '../person-questions';
import {
  applicableQuestions,
  nextQuestion,
  quickRequiredCount,
  type IntakeQuestion,
} from '../intake-script';
import { deriveBusinessName } from '../quick-defaults';
import { EMPTY_DISCOVERY, type DiscoveryData } from '../discovery.logic';

/**
 * Walks the whole scripted conversation for one visitor, answering every
 * question with whatever their fixture already holds and skipping the ones it
 * does not. Returns the ids in the order they were actually asked.
 *
 * This is the conversation, not a list of question objects: `when` predicates
 * are re-evaluated after every answer, which is the only way the skip limit
 * and the already-answered rules can be observed at all.
 */
function askedOrder(data: DiscoveryData): string[] {
  const order: string[] = [];
  const answered: string[] = [];
  // A hard stop, so a `when` rule that never settles fails as a test rather
  // than as a hung suite.
  for (let turn = 0; turn < PERSON_BLOCK_IDS.length * 4; turn += 1) {
    const question: IntakeQuestion | null = nextQuestion(data, answered);
    if (!question) break;
    order.push(question.id);
    answered.push(question.id);
  }
  return order;
}

describe('who the intake asks about themselves', () => {
  it.each(PERSONAS.map((entry) => [entry.id, entry] as const))(
    '%s is classified and offered the block by rule',
    (_id, entry) => {
      expect(intakeSiteKind(entry.discovery)).toBe(entry.expect.siteKind);
      expect(asksPersonQuestions(entry.discovery)).toBe(
        entry.expect.asksPersonQuestions
      );
    }
  );

  it('never offers the person block to a plumbing company', () => {
    const plumber = persona('orchard-plumbing');
    const asked = applicableQuestions(plumber.discovery).map(
      (question) => question.id
    );
    for (const id of PERSON_BLOCK_IDS) {
      expect(asked).not.toContain(id);
    }
  });

  it('offers it to a freelancer whose trade is on no signal list', () => {
    // A family lawyer. `siteKindFor` has never heard of her trade; she is a
    // portfolio because she is the whole business.
    const maria = persona('maria-avocat');
    expect(visitorIsTheBusiness(maria.discovery)).toBe(true);
    const asked = applicableQuestions(maria.discovery).map((q) => q.id);
    expect(asked).toContain('personStory');
    expect(asked).toContain('activityKnownFor');
    // And the trimming rule fires on her too: she described her work
    // properly in the third required question, so the activity question that
    // would ask the same thing again is dropped rather than repeated.
    expect(asked).not.toContain('activityWhat');
  });

  it('asks the person questions before the activity questions', () => {
    const sam = persona('sam-ux');
    const asked = applicableQuestions(EMPTY_DISCOVERY, []).map((q) => q.id);
    expect(asked).toEqual(expect.any(Array));

    const order = applicableQuestions(sam.discovery).map((q) => q.id);
    const firstActivity = Math.min(
      ...ACTIVITY_QUESTION_IDS.map((id) => order.indexOf(id)).filter(
        (index) => index >= 0
      )
    );
    const lastPerson = Math.max(
      ...PERSON_QUESTION_IDS.map((id) => order.indexOf(id)).filter(
        (index) => index >= 0
      )
    );
    expect(lastPerson).toBeLessThan(firstActivity);
  });

  it('asks the whole block after the four required questions, never before', () => {
    // The friction rule. A visitor answering from nothing reaches the four
    // required questions first; the person block is behind all of them.
    const order = askedOrder({ ...EMPTY_DISCOVERY, fullName: 'Ada Lovelace' });
    const firstPerson = order.findIndex((id) =>
      (PERSON_BLOCK_IDS as readonly string[]).includes(id)
    );
    for (const required of ['fullName', 'email', 'description', 'links']) {
      expect(order.indexOf(required)).toBeLessThan(firstPerson);
    }
  });
});

describe('the block keeps the intake short', () => {
  it('does not change how many questions a visitor must answer', () => {
    // The commercial number. Every question in the block is optional, so this
    // is still four: name, email, what you do, one link.
    expect(quickRequiredCount()).toBe(4);
  });

  it('stops asking after two consecutive skips', () => {
    const sam = persona('sam-ux');
    // A visitor who answers nothing in the block: every stored value is ''
    // for the person fields, so each answered id reads as a skip.
    const blank: DiscoveryData = {
      ...sam.discovery,
      personStory: '',
      personHowIWork: '',
      personFeel: '',
      personProudest: '',
      personLinks: '',
      personToneWords: '',
      activityWhat: '',
      activityWho: '',
      activityTypical: '',
      activityKnownFor: '',
      activityYears: '',
    };
    const order = askedOrder(blank);
    const blockAsked = order.filter((id) =>
      (PERSON_BLOCK_IDS as readonly string[]).includes(id)
    );
    expect(blockAsked.length).toBe(PERSON_BLOCK_SKIP_LIMIT);
  });

  it('does not ask again for what the visitor already gave', () => {
    const sam = persona('sam-ux');
    // He pasted a LinkedIn and a GitHub at the links question, and picked
    // tone chips. Neither question is put to him a second time.
    const covered: DiscoveryData = {
      ...sam.discovery,
      linkedinUrl: 'https://linkedin.com/in/samokafor',
      websiteUrl: 'https://samokafor.example',
      brandTone: 'Plain, Direct',
      targetAudience: 'Small software teams with users already',
    };
    const asked = applicableQuestions(covered).map((q) => q.id);
    expect(asked).not.toContain('personLinks');
    expect(asked).not.toContain('personToneWords');
    expect(asked).not.toContain('activityWho');
    // His description is a real answer, so the activity question that would
    // repeat it is dropped as well.
    expect(asked).not.toContain('activityWhat');
    // What is left is still asked. The rule trims, it does not cancel.
    expect(asked).toContain('personStory');
  });

  it('asks the links question when the visitor gave only one', () => {
    const tom = persona('tom-trainer');
    const asked = applicableQuestions(tom.discovery).map((q) => q.id);
    expect(asked).toContain('personLinks');
  });
});

describe('consent is recorded, never assumed', () => {
  it('marks the pasted profiles as readable only when they were given', () => {
    const question = applicableQuestions(persona('sam-ux').discovery).find(
      (entry) => entry.id === 'personLinks'
    );
    expect(question).toBeDefined();
    const answered = question!.apply(
      EMPTY_DISCOVERY,
      'github.com/samokafor, linkedin.com/in/samokafor'
    );
    expect(answered.personLinksConsent).toBe('yes');
    expect(answered.personLinks).toContain('github.com/samokafor');
  });

  it('records a skip as a refusal rather than as silence', () => {
    const question = applicableQuestions(persona('sam-ux').discovery).find(
      (entry) => entry.id === 'personLinks'
    );
    const answered = question!.apply(
      { ...EMPTY_DISCOVERY, personLinksConsent: 'yes' },
      ''
    );
    expect(answered.personLinksConsent).toBe('no');
    expect(answered.personLinks).toBe('');
  });

  it('counts only the links a persona actually consented to', () => {
    expect(consentedPersonLinkCount(persona('sam-ux').person)).toBe(2);
    // Maria pasted a LinkedIn and did not agree we may read it.
    expect(consentedPersonLinkCount(persona('maria-avocat').person)).toBe(0);
  });
});

describe('what the site is called', () => {
  it.each(PERSONAS.map((entry) => [entry.id, entry] as const))(
    '%s is introduced by the right name',
    (_id, entry) => {
      // `personAnswered` computed the same way every real caller computes
      // it -- off the same `data` the naming rule reads -- rather than
      // reasoned about a second time per persona in this test.
      expect(
        deriveBusinessName(entry.discovery, {
          personAnswered: personBlockAnswered(entry.discovery),
        })
      ).toBe(entry.expect.businessName);
    }
  );

  it('outranks an owned hostname with a completed person section', () => {
    // The regression itself, isolated from the rest of the persona's
    // material: an owned site, a name, and a person section that has
    // answered even one question is enough to flip the naming rule.
    const owned: DiscoveryData = {
      ...EMPTY_DISCOVERY,
      fullName: 'Darius Mihai Popescu',
      websiteUrl: 'https://dmpresearch.flowstarter.dev',
      websiteIsOwnSite: 'yes',
      personStory: 'I write about the tools I build.',
    };
    expect(personBlockAnswered(owned)).toBe(true);
    expect(deriveBusinessName(owned, { personAnswered: true })).toBe(
      'Darius Mihai Popescu'
    );
    // And without that evidence, today's company reading is unchanged --
    // including `businessNameFromHostname`'s own quirk of capitalising only
    // the first label of a multi-part hostname.
    expect(deriveBusinessName(owned, { personAnswered: false })).toBe(
      'Dmpresearch flowstarter'
    );
  });

  it('never names a personal site after this platform', () => {
    // The incident. A visitor who mentions the tool they build with must not
    // end up with our brand on their website.
    const derived = deriveBusinessName({
      ...EMPTY_DISCOVERY,
      fullName: 'Darius Mihai',
      description:
        'Flowstarter, the thing I build websites with, plus my own client work.',
    });
    expect(derived).toBe('Darius Mihai');
  });

  it('keeps a real trading name the visitor stated themselves', () => {
    // Title-cased by `businessNameFromDescription`, which is how every other
    // stated name is normalised: the client corrects it on the brief if they
    // want their own capitalisation, and that answer then wins outright.
    expect(deriveBusinessName(persona('elena-ceramica').discovery)).toBe(
      'Lut Si Foc'
    );
  });

  it('answers a tone-word question with at most three words', () => {
    const question = applicableQuestions(persona('sam-ux').discovery).find(
      (entry) => entry.id === 'personToneWords'
    );
    const answered = question!.apply(
      EMPTY_DISCOVERY,
      'plain, direct, warm, exact, loud'
    );
    expect(answered.personToneWords?.split(',').length).toBe(3);
  });
});
