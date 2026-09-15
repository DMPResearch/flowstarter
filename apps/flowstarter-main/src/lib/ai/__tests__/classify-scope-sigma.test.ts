/**
 * The local classifier, and the three ways it is allowed to not be there.
 *
 * The real package is mocked: loading it would pull an ONNX runtime and read a
 * model directory, which is exactly the thing the env switch exists to avoid
 * doing by accident.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const llmClassifyScope = vi.fn();
vi.mock('../classify-scope', () => ({
  llmClassifyScope: (...args: unknown[]) => llmClassifyScope(...args),
  SCOPE_PROMPT_VERSION: 'test-version',
}));

const sigmaClassifyScope = vi.fn();
vi.mock('@flowstarter/sigma-flowstarter', () => ({
  classifyScope: (...args: unknown[]) => sigmaClassifyScope(...args),
}));

import {
  __resetSigmaScopeForTest,
  sigmaScopeClassifier,
  sigmaScopeEnabled,
} from '../classify-scope-sigma';

/** What `llmClassifyScope` gives back when it could not classify. */
const UNCLASSIFIED = {
  scope: 'unclear' as const,
  confidence: 0,
  evidence: [],
  classifier: 'none',
};

function sigmaSaysCustom(confidence = 0.91) {
  sigmaClassifyScope.mockResolvedValue({
    scope: 'custom',
    acceptableUse: 'allow',
    reasons: { scope: 'semantic:custom-work', acceptableUse: 'semantic:clean' },
    trace: { heads: { scope: { confidence } } },
  });
}

beforeEach(() => {
  __resetSigmaScopeForTest();
  llmClassifyScope.mockReset();
  sigmaClassifyScope.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

describe('sigmaScopeEnabled', () => {
  it('is off unless the switch is explicitly on', () => {
    for (const value of [undefined, '', '0', 'no', 'off', 'yes', 'TRUE ']) {
      expect(sigmaScopeEnabled({ SCOPE_SIGMA: value })).toBe(
        value?.trim().toLowerCase() === 'true'
      );
    }
    expect(sigmaScopeEnabled({})).toBe(false);
  });

  it('accepts 1 and true', () => {
    expect(sigmaScopeEnabled({ SCOPE_SIGMA: '1' })).toBe(true);
    expect(sigmaScopeEnabled({ SCOPE_SIGMA: 'true' })).toBe(true);
    expect(sigmaScopeEnabled({ SCOPE_SIGMA: 'TRUE' })).toBe(true);
  });
});

describe('sigmaScopeClassifier', () => {
  it('reports sigma’s verdict in the shape the routing rule reads', async () => {
    sigmaSaysCustom(0.91);
    const result = await sigmaScopeClassifier('A portal my customers log into');
    expect(result).toEqual({
      scope: 'custom',
      confidence: 0.91,
      // The embedding tier decided on its own here (no injected tier ran --
      // `sigmaSaysCustom`'s mock trace carries no `evidence`), and centroid
      // geometry has no sentence to report, so there is no fragment to quote.
      // The reason string moves to `trace`, never `evidence` -- see #191.
      evidence: [],
      classifier: 'sigma',
      // The cascade's own mapping can only reach `custom`/`standard` through
      // the guard that action's calibration passed (its fallback is always
      // `unclear`), so this is always decided when it is not `unclear`.
      decided: true,
      trace: 'semantic:custom-work',
    });
    expect(llmClassifyScope).not.toHaveBeenCalled();
  });

  it('never puts sigma’s reason code in evidence, however confident the verdict', async () => {
    // The exact bug from #191: an operator email quoted
    // `confident:scope:custom-work:semantic` -- sigma's own reason string,
    // never the visitor's text -- as though it were a clause from the brief.
    sigmaClassifyScope.mockResolvedValue({
      scope: 'custom',
      reasons: { scope: 'confident:scope:custom-work:semantic' },
      trace: { heads: { scope: { confidence: 0.91 } } },
    });
    const result = await sigmaScopeClassifier('A portal my customers log into');
    expect(result.evidence).toEqual([]);
    expect(result.evidence).not.toContain(
      'confident:scope:custom-work:semantic'
    );
    // The reason code is not lost, only moved: it is still readable for
    // diagnostics, just never as evidence a person is shown.
    expect(result.trace).toBe('confident:scope:custom-work:semantic');
  });

  it('quotes the injected tier’s own evidence when it actually occurs in the brief', async () => {
    sigmaClassifyScope.mockResolvedValue({
      scope: 'custom',
      reasons: { scope: 'confident:scope:custom-work:injected' },
      trace: {
        heads: {
          scope: {
            confidence: 0.8,
            tier: 'injected',
            evidence: 'customers log into',
          },
        },
      },
    });
    const result = await sigmaScopeClassifier(
      'A portal my customers log into their account'
    );
    expect(result.evidence).toEqual(['customers log into']);
  });

  it('drops the injected tier’s evidence when it is not actually in the brief', async () => {
    // A model can paraphrase instead of quoting. A paraphrase in quotation
    // marks reads exactly like the #191 bug to an operator who cannot tell
    // the difference without opening the brief, so it is dropped the same way.
    sigmaClassifyScope.mockResolvedValue({
      scope: 'custom',
      reasons: { scope: 'confident:scope:custom-work:injected' },
      trace: {
        heads: {
          scope: {
            confidence: 0.8,
            tier: 'injected',
            evidence: 'a client login area',
          },
        },
      },
    });
    const result = await sigmaScopeClassifier(
      'A portal my customers log into their account'
    );
    expect(result.evidence).toEqual([]);
  });

  it('reports decided even when the raw margin is nowhere near the LLM adapter’s bars', async () => {
    // The defect this fix exists for: a confident sigma verdict can carry a
    // cosine margin around 0.07, which never clears `SCOPE_STANDARD_CONFIDENCE`
    // (0.6 by default). `decided` must still be true, because it comes from
    // the cascade's own calibration, not from comparing this number to that
    // bar.
    sigmaClassifyScope.mockResolvedValue({
      scope: 'standard',
      reasons: { scope: 'confident:scope:standard-site:semantic' },
      trace: { heads: { scope: { confidence: 0.07 } } },
    });
    const result = await sigmaScopeClassifier('A bakery in Cluj');
    expect(result).toMatchObject({
      scope: 'standard',
      confidence: 0.07,
      decided: true,
    });
  });

  it('reports not decided when the cascade abstains', async () => {
    sigmaClassifyScope.mockResolvedValue({
      scope: 'unclear',
      reasons: { scope: 'abstained:scope:below_min_sim' },
      trace: { heads: { scope: { confidence: 0 } } },
    });
    const result = await sigmaScopeClassifier('something vague');
    expect(result).toMatchObject({ scope: 'unclear', decided: false });
  });

  it('hands the model call down as the injected second tier', async () => {
    sigmaSaysCustom();
    await sigmaScopeClassifier('something');
    const options = sigmaClassifyScope.mock.calls[0][1] as {
      tiers: { scope: unknown };
    };
    expect(typeof options.tiers.scope).toBe('function');
  });

  it('the injected tier reports the model’s verdict', async () => {
    sigmaSaysCustom();
    await sigmaScopeClassifier('something');
    const tier = (
      sigmaClassifyScope.mock.calls[0][1] as {
        tiers: {
          scope: (
            t: string,
            d: string,
            s: AbortSignal
          ) => Promise<{
            label: string;
            confidence: number;
            evidence: string;
          } | null>;
        };
      }
    ).tiers.scope;

    llmClassifyScope.mockResolvedValue({
      scope: 'standard',
      confidence: 0.8,
      evidence: ['a bakery'],
      classifier: 'llm:test-version',
    });
    await expect(
      tier('a brief', 'scope', new AbortController().signal)
    ).resolves.toEqual({
      label: 'standard',
      confidence: 0.8,
      evidence: 'a bakery',
    });
  });

  it('the injected tier abstains rather than inventing a verdict', async () => {
    sigmaSaysCustom();
    await sigmaScopeClassifier('something');
    const tier = (
      sigmaClassifyScope.mock.calls[0][1] as {
        tiers: {
          scope: (
            t: string,
            d: string,
            s: AbortSignal
          ) => Promise<unknown | null>;
        };
      }
    ).tiers.scope;

    // `llmClassifyScope` swallows its own failures into this exact shape, and
    // passing it on as a verdict would launder a failure into a decision.
    llmClassifyScope.mockResolvedValue(UNCLASSIFIED);
    await expect(
      tier('a brief', 'scope', new AbortController().signal)
    ).resolves.toBeNull();

    // An already-aborted call never reaches the model at all.
    const aborted = new AbortController();
    aborted.abort();
    llmClassifyScope.mockClear();
    await expect(tier('a brief', 'scope', aborted.signal)).resolves.toBeNull();
    expect(llmClassifyScope).not.toHaveBeenCalled();
  });

  it('degrades to the model call when sigma throws', async () => {
    sigmaClassifyScope.mockRejectedValue(new Error('no model directory'));
    llmClassifyScope.mockResolvedValue({
      scope: 'standard',
      confidence: 0.9,
      evidence: [],
      classifier: 'llm:test-version',
    });
    const result = await sigmaScopeClassifier('A bakery in Cluj');
    expect(result.scope).toBe('standard');
    expect(result.classifier).toBe('llm:test-version');
  });

  it('treats a scope action it does not recognise as unclear', async () => {
    sigmaClassifyScope.mockResolvedValue({
      scope: 'something-new',
      reasons: { scope: 'semantic:?' },
      trace: { heads: { scope: { confidence: 0.99 } } },
    });
    const result = await sigmaScopeClassifier('x');
    expect(result.scope).toBe('unclear');
    // An unrecognised action is never decided, whatever confidence the raw
    // trace carried: `scopeFrom` already turned it into `unclear`.
    expect(result.decided).toBe(false);
  });

  it('clamps a confidence sigma did not report', async () => {
    sigmaClassifyScope.mockResolvedValue({
      scope: 'standard',
      reasons: { scope: '' },
      trace: { heads: {} },
    });
    const result = await sigmaScopeClassifier('x');
    expect(result.confidence).toBe(0);
    expect(result.evidence).toEqual([]);
    expect(result.decided).toBe(true);
  });
});
