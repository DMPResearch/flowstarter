// @vitest-environment node
/**
 * The adversarial set, driven through the whole gate.
 *
 * Read this first, because the shape of the suite is the design:
 *
 * There is no phrase matcher to assert against. Detection is a classifier, so
 * an adversarial phrasing is not something a unit test can pass or fail on its
 * own; it is an INPUT. Every fixture below is fed through the real subject
 * composition, the real adapter (with the model mocked at the `llm.ts`
 * boundary), the real rule layer and the real copy, and what is asserted is
 * that the gate does the right thing GIVEN a classifier that recognised it.
 * Whether the classifier does recognise it is a different question, measured
 * by `acceptable-use-live.test.ts` against the same fixture file.
 *
 * That split is deliberate and worth keeping: this file is fast, offline and
 * deterministic, and it is what stops a wiring regression. The live file is
 * slow, costs money and is skipped by default, and it is what stops a prompt
 * regression. Neither can do the other's job.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const callLlmObject = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/llm', () => ({ callLlmObject }));

const recordPolicyOutcome = vi.hoisted(() =>
  vi.fn(async (_input: unknown) => ({ reviewId: 'review-1', recorded: true }))
);
vi.mock('../review', () => ({ recordPolicyOutcome }));

import {
  PROHIBITED_CATEGORIES,
  REVIEW_CATEGORIES,
  categoryById,
} from '../acceptable-use';
import { clearAcceptableUseCache } from '../classifier';
import { screenAcceptableUse } from '../gate';
import fixtures from '../test/data/acceptable-use-eval.json';

interface Fixture {
  id: string;
  lang: string;
  text: string;
  expected: string;
  group: string;
}

const CASES = fixtures.cases as Fixture[];

/**
 * What a calibrated classifier would answer for a fixture of this group.
 *
 * The numbers are not arbitrary: they are the bands the prompt itself asks for
 * (see the CONFIDENCE section). A plainly stated trade lands high, a euphemism
 * or an obfuscation lands in the "strong signal, benign reading exists" band,
 * a lawful-but-sensitive business is named with `needs_human` because the
 * jurisdiction decides it, and a two-word submission abstains.
 */
function answerFor(fixture: Fixture) {
  const object = {
    category: fixture.expected,
    confidence: 0.95,
    evidence: `Recognised from the ${fixture.group} fixture ${fixture.id}.`,
    needs_human: false,
  };
  if (fixture.group === 'euphemism' || fixture.group === 'obfuscated') {
    object.confidence = 0.82;
  }
  if (fixture.group === 'sensitive_lawful') {
    object.confidence = 0.9;
    object.needs_human = true;
  }
  if (fixture.group === 'thin') {
    object.confidence = 0.2;
    object.needs_human = true;
  }
  return {
    object,
    usage: { tokensIn: 500, tokensOut: 40, cachedTokens: 0, totalTokens: 540 },
    model: 'openai/gpt-4o-mini',
    costEstimate: 0.00012,
  };
}

/** What the policy says should happen to a fixture of this group. */
function expectedDecision(fixture: Fixture): 'allow' | 'review' | 'refuse' {
  const category = categoryById(fixture.expected);
  if (!category)
    throw new Error(`fixture ${fixture.id} names no known category`);
  if (category.disposition === 'prohibited') return 'refuse';
  if (category.disposition === 'review') return 'review';
  // Clean, unless the classifier abstained, which is what `thin` models.
  return fixture.group === 'thin' ? 'review' : 'allow';
}

afterEach(() => {
  // Mandatory, not tidiness. `vi.stubEnv` mutates `process.env`, and vitest's
  // forks pool reuses one worker process across test FILES: without this, this
  // suite's `ACCEPTABLE_USE_CLASSIFIER=real` (and the `NODE_ENV=production`
  // one test sets) outlive the file and every later file in the same worker
  // runs with the gate stub off and production fail-closed on. Locally that is
  // invisible; in CI, where the Supabase placeholder vars are set, those
  // suites reach a real verdict and attempt a real network write.
  vi.unstubAllEnvs();
});

beforeEach(() => {
  // The embedding tier off, on purpose. See the file docblock: this suite
  // asserts what the gate DOES given a classifier that recognised a fixture,
  // which has to be deterministic. Whether the cascade recognises it is a
  // different question, answered by `sigma-cascade.test.ts` against the real
  // package and by `acceptable-use-live.test.ts` against the real model.
  // This suite is ABOUT the gate, so the shared stub comes off.
  vi.stubEnv('ACCEPTABLE_USE_CLASSIFIER', 'real');
  vi.stubEnv('ACCEPTABLE_USE_SIGMA', 'false');
  clearAcceptableUseCache();
  callLlmObject.mockReset();
  recordPolicyOutcome.mockClear();
});

describe('the fixture set itself', () => {
  it('is the contract the sigma scorer will read', () => {
    // packages/sigma-classifier scores against these same rows, so the ids and
    // the labels are a contract rather than a convenience.
    expect(CASES.length).toBeGreaterThanOrEqual(55);
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const fixture of CASES) {
      expect(categoryById(fixture.expected)).not.toBeNull();
      expect(fixture.text.trim().length).toBeGreaterThan(0);
      expect(['en', 'ro']).toContain(fixture.lang);
    }
  });

  it('covers every prohibited category in English and in Romanian', () => {
    for (const category of PROHIBITED_CATEGORIES) {
      const mine = CASES.filter((c) => c.expected === category.id);
      expect(
        mine.some((c) => c.lang === 'en'),
        `no English fixture for ${category.id}`
      ).toBe(true);
      expect(
        mine.some((c) => c.lang === 'ro'),
        `no Romanian fixture for ${category.id}`
      ).toBe(true);
    }
  });

  it('covers every lawful-but-sensitive category', () => {
    for (const category of REVIEW_CATEGORIES) {
      expect(
        CASES.some((c) => c.expected === category.id),
        `no fixture for ${category.id}`
      ).toBe(true);
    }
  });

  it('carries the adversarial groups the gate exists for', () => {
    const groups = new Set(CASES.map((c) => c.group));
    for (const group of [
      'plain',
      'euphemism',
      'obfuscated',
      'sensitive_lawful',
      'clean',
      'injection',
      'thin',
    ]) {
      expect(groups.has(group), `no ${group} fixtures`).toBe(true);
    }
  });
});

describe('every fixture, through the gate', () => {
  it.each(CASES.map((fixture) => [fixture.id, fixture] as const))(
    '%s',
    async (_id, fixture) => {
      callLlmObject.mockResolvedValue(answerFor(fixture));

      const screening = await screenAcceptableUse({
        surface: 'preview',
        text: fixture.text,
      });

      expect(screening.verdict.decision).toBe(expectedDecision(fixture));

      // The adversarial phrasing reaches the classifier VERBATIM. Nothing
      // between the visitor and the model normalises, strips or folds it,
      // because every such step is a place a matcher used to lose.
      const user = callLlmObject.mock.calls[0][0].messages[1].content as string;
      expect(user).toContain(fixture.text);
    }
  );
});

describe('what a blocked visitor is told', () => {
  it('names the policy, links the clause and offers a person, on a refusal', async () => {
    const fixture = CASES.find((c) => c.expected === 'sexual_services')!;
    callLlmObject.mockResolvedValue(answerFor(fixture));

    const screening = await screenAcceptableUse({
      surface: 'preview',
      text: fixture.text,
    });

    expect(screening.verdict.decision).toBe('refuse');
    const notice = screening.notice!;
    expect(notice.message).toContain('acceptable-use policy');
    expect(notice.message).toContain('prostitution and escort services');
    expect(notice.message).toContain('nothing has been charged');
    expect(notice.termsHref).toBe('/terms#acceptable-use');
    expect(notice.contactHref).toBe('/contact');
    // House rules on copy.
    const dashes = new RegExp('[\\u2014\\u2013]');
    expect(notice.message).not.toMatch(dashes);
    expect(notice.next).not.toMatch(dashes);
  });

  it('does not read like a refusal when a lawful business is held', async () => {
    const fixture = CASES.find((c) => c.expected === 'licensed_pharmacy')!;
    callLlmObject.mockResolvedValue(answerFor(fixture));

    const screening = await screenAcceptableUse({
      surface: 'preview',
      text: fixture.text,
    });

    expect(screening.verdict.decision).toBe('review');
    // A pharmacy is a customer. The word "cannot" belongs in the other notice.
    expect(screening.notice!.message).not.toContain('cannot');
    expect(screening.notice!.title).toBe(
      'One of us needs to look at this first'
    );
  });

  it('answers a refusal in Romanian when the caller passes locale: ro', async () => {
    const fixture = CASES.find((c) => c.expected === 'sexual_services')!;
    callLlmObject.mockResolvedValue(answerFor(fixture));

    const screening = await screenAcceptableUse({
      surface: 'preview',
      text: fixture.text,
      locale: 'ro',
    });

    expect(screening.verdict.decision).toBe('refuse');
    const notice = screening.notice!;
    expect(notice.locale).toBe('ro');
    expect(notice.title).toBe('Nu putem construi acest site');
    expect(notice.message).toContain('utilizare acceptabilă');
    expect(notice.message).toContain('nu s-a taxat nimic');
  });

  it('answers a review in Romanian when the caller passes locale: ro', async () => {
    const fixture = CASES.find((c) => c.expected === 'licensed_pharmacy')!;
    callLlmObject.mockResolvedValue(answerFor(fixture));

    const screening = await screenAcceptableUse({
      surface: 'preview',
      text: fixture.text,
      locale: 'ro',
    });

    expect(screening.verdict.decision).toBe('review');
    expect(screening.notice!.locale).toBe('ro');
    expect(screening.notice!.title).toBe('Trebuie mai întâi să verificăm');
  });

  it('defaults to English when a caller does not pass a locale', async () => {
    const fixture = CASES.find((c) => c.expected === 'sexual_services')!;
    callLlmObject.mockResolvedValue(answerFor(fixture));

    const screening = await screenAcceptableUse({
      surface: 'preview',
      text: fixture.text,
    });

    expect(screening.notice!.locale).toBe('en');
  });

  it('never quotes the visitor back at them', async () => {
    const fixture = CASES.find((c) => c.expected === 'illegal_drugs')!;
    callLlmObject.mockResolvedValue(answerFor(fixture));
    const screening = await screenAcceptableUse({
      surface: 'preview',
      text: fixture.text,
    });
    const rendered = JSON.stringify(screening.notice);
    expect(rendered).not.toContain(fixture.text.slice(0, 40));
  });
});

describe('the audit row', () => {
  it('is written for a block, with the hash and never the text', async () => {
    const fixture = CASES.find((c) => c.expected === 'weapons_sales')!;
    callLlmObject.mockResolvedValue(answerFor(fixture));

    await screenAcceptableUse({
      surface: 'claim',
      text: fixture.text,
      workspaceId: '00000000-0000-4000-8000-000000000001',
    });

    expect(recordPolicyOutcome).toHaveBeenCalledTimes(1);
    const written = recordPolicyOutcome.mock.calls[0]?.[0] as {
      surface: string;
      classification: { evidenceHash: string; evidence: string };
      briefText: string;
    };
    expect(written.surface).toBe('claim');
    expect(written.classification.evidenceHash).toHaveLength(16);
    // `briefText` is `recordPolicyOutcome`'s one deliberate exception to
    // "never the text" -- its own module doc explains why: it exists only to
    // reach the operator email, and that function never writes it to the row
    // or the event payload. This asserts the exception is exactly that one
    // named field and nothing else on the call: strip it out and the rest of
    // what crosses this boundary must still never contain the fixture text.
    expect(written.briefText).toBe(fixture.text);
    const { briefText: _briefText, ...everythingElse } = written;
    expect(JSON.stringify(everythingElse)).not.toContain(
      fixture.text.slice(0, 40)
    );
  });

  it('is not written for a clean business', async () => {
    const fixture = CASES.find((c) => c.group === 'clean')!;
    callLlmObject.mockResolvedValue(answerFor(fixture));
    const screening = await screenAcceptableUse({
      surface: 'preview',
      text: fixture.text,
    });
    expect(screening.verdict.decision).toBe('allow');
    expect(screening.notice).toBeNull();
    expect(recordPolicyOutcome).not.toHaveBeenCalled();
  });
});

describe('a clean business is not re-billed', () => {
  it('classifies once however many gates it passes', async () => {
    const fixture = CASES.find((c) => c.group === 'clean')!;
    callLlmObject.mockResolvedValue(answerFor(fixture));

    // The original brief asked for "a clean business allowed with no LLM
    // call". Under the classifier-only design every submission is classified
    // once; the property that survives, and the one that actually costs money,
    // is that passing the preview, the claim and the checkout on the same
    // answers costs ONE call, not three.
    await screenAcceptableUse({ surface: 'preview', text: fixture.text });
    await screenAcceptableUse({ surface: 'claim', text: fixture.text });
    await screenAcceptableUse({ surface: 'guest_deposit', text: fixture.text });

    expect(callLlmObject).toHaveBeenCalledTimes(1);
  });
});

describe('a post-payment surface holds instead of refusing', () => {
  it('turns a refusal into a review on the brief and the change request', async () => {
    const fixture = CASES.find((c) => c.expected === 'illegal_drugs')!;
    callLlmObject.mockResolvedValue(answerFor(fixture));

    const screening = await screenAcceptableUse({
      surface: 'brief',
      text: fixture.text,
      workspaceId: '00000000-0000-4000-8000-000000000002',
      refusalBecomesReview: true,
    });

    // The deposit is already paid. A machine writing the final no on work
    // somebody has paid for is worse than a person writing it today.
    expect(screening.verdict.decision).toBe('review');
    expect(screening.verdict.category.id).toBe('illegal_drugs');
    expect(screening.blocked).toBe(true);
  });
});

describe('a classifier outage', () => {
  it('holds in production and never allows', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    callLlmObject.mockRejectedValue(new Error('provider is down'));

    const screening = await screenAcceptableUse({
      surface: 'preview',
      text: 'What the business does: a dental clinic in Cluj.',
    });

    expect(screening.verdict.decision).toBe('review');
    expect(screening.verdict.rule).toBe('classifier_failed_closed');
    expect(screening.blocked).toBe(true);
  });
});
