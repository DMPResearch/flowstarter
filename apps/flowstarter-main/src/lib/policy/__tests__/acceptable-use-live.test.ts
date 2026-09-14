// @vitest-environment node
/**
 * The LIVE evaluation. Opt-in, skipped by default, and the only file in the
 * repository that calls a real model.
 *
 *   ACCEPTABLE_USE_LIVE_EVAL=1 OPENROUTER_API_KEY=... \
 *     pnpm --dir apps/flowstarter-main exec vitest --root src --run \
 *     lib/policy/__tests__/acceptable-use-live
 *
 * It exists because the offline suite cannot answer the question that actually
 * matters. `gate-fixtures.test.ts` proves the gate does the right thing GIVEN
 * a classifier that recognised a euphemism; only this file can tell you
 * whether it recognises one. The prompt is the artefact under test, and a
 * prompt with no measurement is a prompt that degrades quietly.
 *
 * It costs money (roughly one small-model call per fixture) and it is not
 * deterministic, so it is not in the quality gate. The rule is in
 * `PROMPT_CHANGELOG.md`: run it before and after any edit to `prompt.ts`, and
 * put both numbers in the pull request.
 *
 * TWO scores are reported, and the second is the one to read:
 *
 *   CATEGORY accuracy   the classifier named the exact fixture label.
 *   DECISION accuracy   the gate reached the right verdict.
 *
 * They differ on purpose. A submission the fixture labels `adult_content` that
 * comes back `sexual_services` is the same correct refusal reached by a
 * slightly different route, and treating that as a failure would tune the
 * prompt towards taxonomy rather than towards protecting anybody.
 *
 * When the sigma package lands, its held-out scorer reads the same fixture
 * file, which is why the ids and labels there are a contract.
 */
import { describe, expect, it } from 'vitest';

import { categoryById, decide } from '../acceptable-use';
import { classifyWithLlm } from '../llm-tier';
import { ACCEPTABLE_USE_PROMPT_VERSION } from '../prompt';
import fixtures from '../test/data/acceptable-use-eval.json';

interface Fixture {
  id: string;
  lang: string;
  text: string;
  expected: string;
  group: string;
}

const CASES = fixtures.cases as Fixture[];

const ENABLED =
  process.env.ACCEPTABLE_USE_LIVE_EVAL === '1' &&
  Boolean(process.env.OPENROUTER_API_KEY);

/** What the policy says should happen to a fixture. Mirrors the offline run. */
function expectedDecision(fixture: Fixture): 'allow' | 'review' | 'refuse' {
  const category = categoryById(fixture.expected);
  if (!category)
    throw new Error(`fixture ${fixture.id} names no known category`);
  if (category.disposition === 'prohibited') return 'refuse';
  if (category.disposition === 'review') return 'review';
  return 'allow';
}

/**
 * How wrong a miss is.
 *
 * A `review` where the policy wanted `refuse` is a near miss: a person still
 * sees it and nothing was built or charged. A `refuse` where the policy wanted
 * `allow` turns a customer away. An `allow` where the policy wanted `refuse`
 * is the only one that puts a prohibited site on our infrastructure, and it is
 * counted on its own line.
 */
type MissKind = 'held_instead' | 'over_refused' | 'let_through' | 'none';

function classifyMiss(
  wanted: 'allow' | 'review' | 'refuse',
  got: 'allow' | 'review' | 'refuse'
): MissKind {
  if (wanted === got) return 'none';
  if (got === 'allow' && wanted !== 'allow') return 'let_through';
  if (got === 'refuse' && wanted === 'allow') return 'over_refused';
  return 'held_instead';
}

describe.skipIf(!ENABLED)('acceptable-use classifier, live', () => {
  // One small-model call per fixture, run sequentially.
  it(
    'scores the adversarial fixture set',
    { timeout: 15 * 60 * 1000 },
    async () => {
      const rows: Array<{
        id: string;
        group: string;
        lang: string;
        wantedCategory: string;
        gotCategory: string;
        confidence: number;
        needsHuman: boolean;
        wanted: string;
        got: string;
        miss: MissKind;
      }> = [];

      // Sequential, not parallel. Sixty-five concurrent calls is a rate limit,
      // and this harness is run by a person watching the output.
      for (const fixture of CASES) {
        const classification = await classifyWithLlm({
          surface: 'evaluation',
          text: fixture.text,
        });
        const verdict = decide(classification);
        const wanted = expectedDecision(fixture);
        rows.push({
          id: fixture.id,
          group: fixture.group,
          lang: fixture.lang,
          wantedCategory: fixture.expected,
          gotCategory: classification.categoryId,
          confidence: Number(classification.confidence.toFixed(2)),
          needsHuman: classification.needsHuman,
          wanted,
          got: verdict.decision,
          miss: classifyMiss(wanted, verdict.decision),
        });
      }

      const total = rows.length;
      const categoryHits = rows.filter(
        (row) => row.gotCategory === row.wantedCategory
      ).length;
      const decisionHits = rows.filter((row) => row.miss === 'none').length;
      const letThrough = rows.filter((row) => row.miss === 'let_through');
      const overRefused = rows.filter((row) => row.miss === 'over_refused');

      const byGroup = new Map<string, { n: number; ok: number }>();
      for (const row of rows) {
        const entry = byGroup.get(row.group) ?? { n: 0, ok: 0 };
        entry.n += 1;
        if (row.miss === 'none') entry.ok += 1;
        byGroup.set(row.group, entry);
      }

      const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(1)}%`;
      const lines: string[] = [
        '',
        `acceptable-use live evaluation, prompt ${ACCEPTABLE_USE_PROMPT_VERSION}`,
        `fixtures: ${total}`,
        `category accuracy: ${categoryHits}/${total} (${pct(
          categoryHits,
          total
        )})`,
        `decision accuracy: ${decisionHits}/${total} (${pct(
          decisionHits,
          total
        )})`,
        `let through (the one that matters): ${letThrough.length}`,
        `over-refused a lawful business: ${overRefused.length}`,
        'by group:',
      ];
      byGroup.forEach((entry, group) => {
        lines.push(
          `  ${group}: ${entry.ok}/${entry.n} (${pct(entry.ok, entry.n)})`
        );
      });
      if (letThrough.length > 0) {
        lines.push('let through:');
        for (const row of letThrough) {
          lines.push(
            `  ${row.id} [${row.lang}/${row.group}] wanted ${row.wantedCategory}, got ${row.gotCategory} @ ${row.confidence}`
          );
        }
      }
      if (overRefused.length > 0) {
        lines.push('over-refused:');
        for (const row of overRefused) {
          lines.push(
            `  ${row.id} [${row.lang}/${row.group}] wanted ${row.wantedCategory}, got ${row.gotCategory} @ ${row.confidence}`
          );
        }
      }
      // Printed rather than asserted on: this is a measurement, and a
      // threshold here would either be so low it proves nothing or so high it
      // fails on a model provider's off day. The number goes in the pull
      // request and in PROMPT_CHANGELOG.md, where a human reads it.
      console.log(lines.join('\n'));

      // The one hard assertion: the harness itself ran. A silent zero would
      // look exactly like a perfect score.
      expect(rows).toHaveLength(CASES.length);
      expect(rows.every((row) => row.gotCategory.length > 0)).toBe(true);
    }
  );
});

describe('the live harness is opt-in', () => {
  it('is skipped without ACCEPTABLE_USE_LIVE_EVAL and a key', () => {
    // A guard on the guard: if this file ever starts calling a provider during
    // an ordinary `pnpm test`, the quality gate becomes slow, flaky and
    // expensive, and somebody deletes it.
    expect(typeof ENABLED).toBe('boolean');
    if (!process.env.OPENROUTER_API_KEY) expect(ENABLED).toBe(false);
  });
});
