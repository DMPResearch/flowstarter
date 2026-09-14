/**
 * The centroid tier and the cascade, on a stub encoder with hand-placed
 * vectors. Geometry we chose, so the abstention band is checked against
 * numbers rather than against whatever the model happened to produce.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CentroidScorer,
  classify,
  embedWithinBudget,
  meanVector,
  normalize,
  type CentroidsFile,
  type Encoder,
  type SemanticConfigFile,
  type Tier,
} from '../src/index.js';

/** Three unit vectors in a 3-space: as separable as it gets. */
const CENTROIDS: CentroidsFile = {
  version: 'v1',
  encoder: 'stub',
  encoder_revision: 'stub',
  built_at: '2026-01-01T00:00:00.000Z',
  dim: 3,
  centered: false,
  decisions: {
    colour: { labels: ['red', 'green', 'blue'], sample_counts: { red: 1, green: 1, blue: 1 } },
  },
  vectors: {
    'colour/red': [1, 0, 0],
    'colour/green': [0, 1, 0],
    'colour/blue': [0, 0, 1],
  },
};

const CONFIG: SemanticConfigFile = {
  version: 'v1',
  encoder: 'stub',
  decisions: { colour: { labels: ['red', 'green', 'blue'], min_sim: 0.5, margin: 0.2 } },
};

const ENCODER_CONFIG = { model: 'stub', revision: 'stub', budgetMs: 1000 };

function stubEncoder(vector: number[]): Encoder {
  return { embed: async () => [Float32Array.from(vector)] };
}

describe('CentroidScorer', () => {
  const scorer = new CentroidScorer(CENTROIDS, CONFIG);

  it('picks the nearest centroid when it is clearly nearest', () => {
    expect(scorer.score('colour', Float32Array.from([1, 0, 0]))).toMatchObject({
      label: 'red',
      runnerUp: 'green',
      similarity: 1,
      margin: 1,
      abstained: false,
      reason: 'confident',
    });
  });

  it('abstains below the similarity floor', () => {
    // Equidistant-ish and short: top similarity 0.45 < min_sim 0.5.
    const result = scorer.score('colour', Float32Array.from([0.45, 0.1, 0.1]));
    expect(result.abstained).toBe(true);
    expect(result.reason).toBe('below_min_sim');
  });

  it('abstains inside the margin, even when the top score is high', () => {
    const result = scorer.score('colour', Float32Array.from([0.9, 0.8, 0]));
    expect(result.similarity).toBeCloseTo(0.9);
    expect(result.abstained).toBe(true);
    expect(result.reason).toBe('below_margin');
    // The label is still reported: abstention is about confidence, not about
    // having nothing to say.
    expect(result.label).toBe('red');
  });

  it('refuses a config whose labels do not match the centroids', () => {
    expect(
      () =>
        new CentroidScorer(CENTROIDS, {
          ...CONFIG,
          decisions: { colour: { labels: ['red', 'green'], min_sim: 0.5, margin: 0.2 } },
        }),
    ).toThrow(/config labels .* != centroid labels/);
  });

  it('refuses a vector of the wrong width', () => {
    expect(() => scorer.score('colour', Float32Array.from([1, 0]))).toThrow(/expects 3-dim/);
  });
});

describe('centred scoring', () => {
  it('subtracts the training mean from the query as well as the centroids', () => {
    // Anisotropy in miniature: both centroids lean the same way, so raw
    // cosines are high and close. Centring restores a usable margin.
    const a = normalize(Float32Array.from([1, 0.9, 0]));
    const b = normalize(Float32Array.from([1, 0.9, 0.3]));
    const mean = meanVector([a, b], 3);
    const rawMargin = Math.abs(dot(a, a) - dot(a, b));

    const centred: CentroidsFile = {
      ...CENTROIDS,
      centered: true,
      decisions: { colour: { labels: ['a', 'b'], sample_counts: { a: 1, b: 1 } } },
      vectors: {
        'colour/a': [...centre(a, mean)],
        'colour/b': [...centre(b, mean)],
        'colour/__mean__': [...mean],
      },
    };
    const scorer = new CentroidScorer(centred, {
      ...CONFIG,
      decisions: { colour: { labels: ['a', 'b'], min_sim: -1, margin: 0 } },
    });
    const result = scorer.score('colour', a);
    expect(result.label).toBe('a');
    expect(result.margin).toBeGreaterThan(rawMargin);
  });
});

describe('classify', () => {
  const scorer = new CentroidScorer(CENTROIDS, CONFIG);
  const base = { scorer, centroids: CENTROIDS, config: CONFIG, encoderConfig: ENCODER_CONFIG };

  it('scores every head from one embedding', async () => {
    const encoder = { embed: vi.fn(async () => [Float32Array.from([1, 0, 0])]) };
    await classify('anything', { ...base, encoder });
    expect(encoder.embed).toHaveBeenCalledTimes(1);
  });

  it('records an encoder failure without throwing', async () => {
    const encoder: Encoder = {
      embed: async () => {
        throw new Error('no model here');
      },
    };
    const trace = await classify('anything', { ...base, encoder });
    expect(trace.heads.colour?.label).toBeNull();
    expect(trace.heads.colour?.semantic.reason).toBe('encoder_error');
    expect(trace.errors[0]).toMatch(/^encoder:/);
  });

  it('consults an injected tier only after an abstention', async () => {
    const tier = vi.fn<Tier>(async () => ({ label: 'blue', confidence: 0.8, evidence: 'x' }));
    const confident = await classify('anything', {
      ...base,
      encoder: stubEncoder([1, 0, 0]),
      tiers: { colour: tier },
    });
    expect(confident.heads.colour?.injectedAttempted).toBe(false);

    const uncertain = await classify('anything', {
      ...base,
      encoder: stubEncoder([0.9, 0.8, 0]),
      tiers: { colour: tier },
    });
    expect(uncertain.heads.colour).toMatchObject({
      tier: 'injected',
      label: 'blue',
      confidence: 0.8,
      evidence: 'x',
    });
  });

  it('lets an injected tier abstain', async () => {
    const trace = await classify('anything', {
      ...base,
      encoder: stubEncoder([0.9, 0.8, 0]),
      tiers: { colour: async () => null },
    });
    expect(trace.heads.colour).toMatchObject({
      injectedAttempted: true,
      injectedAbstained: true,
      label: null,
    });
  });

  it('drops a malformed verdict rather than trusting it', async () => {
    const trace = await classify('anything', {
      ...base,
      encoder: stubEncoder([0.9, 0.8, 0]),
      tiers: { colour: async () => ({ label: 42, confidence: 'high' }) as never },
    });
    expect(trace.heads.colour?.label).toBeNull();
    expect(trace.errors).toContain('tier:colour:malformed_verdict');
  });

  it('abandons an injected tier that runs past its budget', async () => {
    const slow: Tier = () => new Promise((resolve) => setTimeout(() => resolve(null), 200));
    const trace = await classify('anything', {
      ...base,
      encoder: stubEncoder([0.9, 0.8, 0]),
      tiers: { colour: slow },
      tierBudgetMs: 10,
    });
    expect(trace.heads.colour?.injectedAbstained).toBe(true);
  });

  it('never puts the text into an error string', async () => {
    const secret = 'a very identifying sentence about a named person';
    const encoder: Encoder = {
      embed: async () => {
        throw new Error(secret);
      },
    };
    const trace = await classify(secret, { ...base, encoder });
    expect(JSON.stringify(trace)).not.toContain(secret);
  });
});

describe('embedWithinBudget', () => {
  it('returns null rather than throwing when the budget is blown', async () => {
    const slow: Encoder = {
      embed: () => new Promise((resolve) => setTimeout(() => resolve([new Float32Array(3)]), 200)),
    };
    const outcome = await embedWithinBudget(slow, 'text', 10);
    expect(outcome.vector).toBeNull();
    expect(outcome.error).toBe('encoder_timeout');
  });

  it('swallows an encoder that throws', async () => {
    const broken: Encoder = {
      embed: async () => {
        throw new TypeError('bad');
      },
    };
    const outcome = await embedWithinBudget(broken, 'text', 1000);
    expect(outcome.vector).toBeNull();
    expect(outcome.error).toBe('TypeError');
  });
});

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += (a[index] as number) * (b[index] as number);
  return sum;
}

function centre(vector: Float32Array, mean: Float32Array): Float32Array {
  const out = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index++) {
    out[index] = (vector[index] as number) - (mean[index] as number);
  }
  return normalize(out);
}
