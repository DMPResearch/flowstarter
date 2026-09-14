// @vitest-environment node
/**
 * The real cascade, over the real fixtures, with no model behind it.
 *
 * Opt-in. The encoder is a 135 MB artefact that is fetched rather than
 * committed, so this suite skips itself when the cache is absent and a clean
 * checkout stays green:
 *
 *   pnpm --filter @flowstarter/sigma-core fetch-model
 *
 * It is the third of three ways the fixture set is used, and each answers a
 * question the others cannot:
 *
 *   gate-fixtures.test.ts   what the gate DOES, given a classifier that
 *                           recognised the fixture. Deterministic, mocked.
 *   this file               what `@flowstarter/sigma-flowstarter` decides on
 *                           its own, offline, with its committed centroids.
 *                           No network, no tokens.
 *   acceptable-use-live     what the LLM tier adds. Costs money.
 *
 * What is asserted is deliberately NOT an accuracy score. Centroids get
 * retrained (#167 retrained them for lawful clinics), and a suite that pinned
 * "54 of 65" would go red on an improvement and teach everyone to edit the
 * number. What is pinned is the property that must hold whatever the geometry
 * says:
 *
 *   NOTHING PROHIBITED IS EVER ALLOWED.
 *
 * Everything the cascade may otherwise get wrong lands on `review`, which is a
 * person looking at it. That is a cost we are happy to pay a hundred times a
 * day, and a site we refuse being live is not.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { categoryById, decide } from '../acceptable-use';
import { classifyAcceptableUse, clearAcceptableUseCache } from '../classifier';
import fixtures from '../test/data/acceptable-use-eval.json';

interface Fixture {
  id: string;
  lang: string;
  text: string;
  expected: string;
  group: string;
}

const CASES = fixtures.cases as Fixture[];

/** Whether the package and its encoder are usable here. Probed once. */
let ready = false;

beforeAll(async () => {
  try {
    const sigma = await import('@flowstarter/sigma-flowstarter');
    await sigma.warmSigma();
    ready = true;
  } catch {
    // A missing encoder cache is the ordinary case on a clean checkout and in
    // CI. `warmSigma` throwing is exactly how the package reports it.
    ready = false;
  }
}, 180_000);

afterEach(() => {
  // See gate-fixtures.test.ts: vitest's forks pool reuses a worker process
  // across files, so a stub that is not restored leaks into every later file.
  vi.unstubAllEnvs();
});

/** What the policy wants for a fixture, ignoring which category got there. */
function wanted(fixture: Fixture): 'allow' | 'review' | 'refuse' {
  const category = categoryById(fixture.expected);
  if (!category) {
    throw new Error(`fixture ${fixture.id} names no known category`);
  }
  if (category.disposition === 'prohibited') return 'refuse';
  if (category.disposition === 'review') return 'review';
  return 'allow';
}

async function verdictFor(text: string) {
  clearAcceptableUseCache();
  return decide(await classifyAcceptableUse({ surface: 'preview', text }));
}

describe('the sigma cascade, offline', () => {
  it(
    'never allows a prohibited business, with no LLM tier behind it',
    { timeout: 300_000 },
    async () => {
      if (!ready) {
        console.log(
          '[policy] sigma encoder not fetched, skipping. Run ' +
            '`pnpm --filter @flowstarter/sigma-core fetch-model`.'
        );
        return;
      }
      // No API key here, so the injected tier fails and abstains: what is
      // measured is the embedding tier alone, the worst case the gate runs in.
      vi.stubEnv('ACCEPTABLE_USE_CLASSIFIER', 'real');
      vi.stubEnv('ACCEPTABLE_USE_SIGMA', 'true');

      const letThrough: string[] = [];
      const overRefused: string[] = [];
      let agreed = 0;

      for (const fixture of CASES) {
        const verdict = await verdictFor(fixture.text);
        const want = wanted(fixture);
        if (verdict.decision === want) agreed += 1;
        if (verdict.decision === 'allow' && want !== 'allow') {
          letThrough.push(`${fixture.id} (${fixture.group}/${fixture.lang})`);
        }
        if (verdict.decision === 'refuse' && want === 'allow') {
          overRefused.push(`${fixture.id} (${fixture.group}/${fixture.lang})`);
        }
      }

      // Reported, not asserted: the number moves when centroids are retrained,
      // and pinning it would make an improvement look like a regression.
      console.log(
        `[policy] sigma alone: ${agreed}/${CASES.length} decisions agree, ` +
          `${letThrough.length} let through, ${overRefused.length} over-refused` +
          (overRefused.length > 0 ? `: ${overRefused.join(', ')}` : '')
      );

      // The one hard rule.
      expect(letThrough, letThrough.join(', ')).toEqual([]);
    }
  );

  it(
    'routes a clean business to allow or review, never to a refusal',
    { timeout: 300_000 },
    async () => {
      if (!ready) return;
      vi.stubEnv('ACCEPTABLE_USE_CLASSIFIER', 'real');
      vi.stubEnv('ACCEPTABLE_USE_SIGMA', 'true');

      // A lawful business told no by a machine is the expensive mistake. A
      // review is fine; a refusal is not. #167 retrained the centroids after
      // this suite caught a licensed dermatology clinic (au-060) being refused
      // as `unlicensed_medical_financial_claims`, so this now asserts the whole
      // clean set with no exemptions.
      const refused: string[] = [];
      for (const fixture of CASES.filter((c) => c.group === 'clean')) {
        const verdict = await verdictFor(fixture.text);
        if (verdict.decision === 'refuse') {
          refused.push(`${fixture.id}: ${verdict.category.id}`);
        }
      }
      expect(refused, refused.join(', ')).toEqual([]);
    }
  );
});
