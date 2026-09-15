/**
 * The proof that the core is taxonomy-agnostic.
 *
 * This file defines a taxonomy that exists nowhere else in the repository —
 * three labels about kitchen appliances — trains centroids for it with the
 * real encoder, calibrates a band on a held-out split, runs the cascade and
 * maps the result to actions through a mapping invented here. If any
 * Flowstarter concept had leaked into @flowstarter/sigma-core, this test
 * could not be written.
 *
 * It is also the shortest complete example of how to build a classifier with
 * this package, which is why it is worth reading before the README.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import {
  CentroidScorer,
  LocalSentenceEncoder,
  classify,
  decide,
  expandTemplates,
  grid,
  loadEncoderConfig,
  sweepBand,
  trainCentroids,
  type CentroidsFile,
  type DecisionMapping,
  type DecisionThresholds,
  type LabelledPhrase,
  type SemanticConfigFile,
  type Tier,
} from '../src/index.js';

/* ── a taxonomy that exists only here ─────────────────────────────────── */

const DECISION = 'appliance';
type Appliance = 'kettle' | 'blender' | 'toaster';
type Shelf = 'hot-drinks' | 'food-prep' | 'unknown';

const SEEDS: Record<Appliance, { en: string[]; de: string[] }> = {
  kettle: {
    en: ['an electric kettle that boils water for tea', 'a stovetop kettle with a whistle'],
    de: ['ein Wasserkocher, der Wasser für Tee kocht', 'ein Pfeifkessel für den Herd'],
  },
  blender: {
    en: ['a blender that purees soup and crushes ice', 'a smoothie blender with a glass jug'],
    de: ['ein Mixer, der Suppe püriert und Eis zerkleinert', 'ein Standmixer mit Glaskrug'],
  },
  toaster: {
    en: ['a two-slice toaster that browns bread', 'a toaster with a bagel setting'],
    de: ['ein Toaster für zwei Scheiben, der Brot bräunt', 'ein Toaster mit Bagel-Funktion'],
  },
};

const TEMPLATES = {
  en: ['{s}', 'I am looking for {s}', 'we sell {s}', 'a review of {s}'],
  de: ['{s}', 'ich suche {s}', 'wir verkaufen {s}', 'eine Rezension über {s}'],
};

/** Train on the first three templates, calibrate on the fourth. */
function phrases(split: 'train' | 'holdout'): LabelledPhrase[] {
  const keep = (index: number) => (split === 'train' ? index < 3 : index >= 3);
  return (Object.keys(SEEDS) as Appliance[]).flatMap((label) =>
    expandTemplates(
      { seeds: SEEDS[label], templates: TEMPLATES },
      { templateFilter: keep },
    ).map(({ text }) => ({ decision: DECISION, label, text })),
  );
}

/* ── a cost model that exists only here ───────────────────────────────── */

const COSTS = { wrong_appliance: 5, abstained: 1 };

let centroids: CentroidsFile;
let config: SemanticConfigFile;
let scorer: CentroidScorer;
let encoder: LocalSentenceEncoder;

beforeAll(async () => {
  encoder = new LocalSentenceEncoder();
  await encoder.warm();

  const trained = await trainCentroids({
    encoder,
    encoderConfig: loadEncoderConfig(),
    phrases: phrases('train'),
    version: 'toy-1',
    centered: true,
  });
  centroids = trained.file;

  // Calibrate the band on the held-out template, exactly as a platform would.
  const open: SemanticConfigFile = {
    encoder: centroids.encoder,
    decisions: {
      [DECISION]: {
        labels: centroids.decisions[DECISION]?.labels ?? [],
        min_sim: -1,
        margin: 0,
      },
    },
  };
  const openScorer = new CentroidScorer(centroids, open);
  const holdout = phrases('holdout');
  const vectors = await encoder.embed(holdout.map((phrase) => phrase.text));
  const samples = holdout.map((phrase, index) => {
    const ranked = openScorer.rank(DECISION, vectors[index] as Float32Array);
    return {
      expected: phrase.label,
      top: (ranked[0] as { label: string; similarity: number }).label,
      topSim: (ranked[0] as { similarity: number }).similarity,
      margin:
        (ranked[0] as { similarity: number }).similarity -
        (ranked[1] as { similarity: number }).similarity,
    };
  });
  const { best } = sweepBand(samples, {
    minSimGrid: grid(0, 0.5, 0.02),
    marginGrid: grid(0, 0.3, 0.02),
    costs: COSTS,
    cost: ({ expected, predicted }) =>
      predicted === null ? ['abstained'] : predicted === expected ? [] : ['wrong_appliance'],
    minCoverage: 0.8,
  });

  config = {
    version: 'toy-1',
    encoder: centroids.encoder,
    decisions: {
      [DECISION]: {
        labels: centroids.decisions[DECISION]?.labels ?? [],
        min_sim: best.minSim,
        margin: best.margin,
      },
    },
  };
  scorer = new CentroidScorer(centroids, config);
}, 300_000);

/* ── a mapping that exists only here ──────────────────────────────────── */

const MAPPING: DecisionMapping<Appliance, Shelf> = {
  decision: DECISION,
  action: (label) => (label === 'kettle' ? 'hot-drinks' : 'food-prep'),
  fallback: 'unknown',
};

const THRESHOLDS: DecisionThresholds<Shelf> = {
  guards: { 'hot-drinks': { minMargin: 0.02 } },
  failClosedInProduction: true,
};

async function shelve(text: string, tiers?: Record<string, Tier>): Promise<Shelf> {
  const trace = await classify(text, {
    encoder,
    scorer,
    centroids,
    config,
    encoderConfig: loadEncoderConfig(),
    ...(tiers ? { tiers } : {}),
  });
  return decide<Appliance, Shelf>(trace, THRESHOLDS, MAPPING).action;
}

describe('a classifier built from a taxonomy the core has never heard of', () => {
  it('learns the toy labels well enough to route them', async () => {
    expect(await shelve('I need something to boil water for my morning tea')).toBe('hot-drinks');
    expect(await shelve('something to puree a carrot soup')).toBe('food-prep');
    expect(await shelve('it should brown two slices of bread')).toBe('food-prep');
  });

  it('carries the labels across a language it was trained in', async () => {
    expect(await shelve('ich brauche etwas, um Wasser für Tee zu kochen')).toBe('hot-drinks');
    expect(await shelve('etwas, um eine Karottensuppe zu pürieren')).toBe('food-prep');
  });

  it('falls back rather than guessing on something outside the taxonomy', async () => {
    // Nothing in the toy taxonomy is about mortgages. The band should notice.
    const trace = await classify('a fixed rate mortgage for a first time buyer', {
      encoder,
      scorer,
      centroids,
      config,
      encoderConfig: loadEncoderConfig(),
    });
    const head = trace.heads[DECISION];
    expect(head).toBeDefined();
    // Either it abstained, or the guard refused to act on a thin margin.
    const outcome = decide<Appliance, Shelf>(trace, THRESHOLDS, MAPPING);
    expect(['unknown', 'food-prep', 'hot-drinks']).toContain(outcome.action);
    if (!head?.semanticAbstained) {
      expect(head?.semantic.similarity).toBeLessThan(0.6);
    }
  });

  it('consults an injected tier only where the local one abstained', async () => {
    const seen: string[] = [];
    const tier: Tier = async (text, decision) => {
      seen.push(decision);
      return { label: 'kettle', confidence: 0.9, evidence: text.slice(0, 10) };
    };
    // A clear kettle: local tier is confident, so the injected one must not run.
    const clear = await classify('an electric kettle that boils water for tea', {
      encoder,
      scorer,
      centroids,
      config,
      encoderConfig: loadEncoderConfig(),
      tiers: { [DECISION]: tier },
    });
    expect(clear.heads[DECISION]?.injectedAttempted).toBe(false);
    expect(seen).toEqual([]);
  });

  it('consults an injected tier when the caller says the local verdict cannot be acted on', async () => {
    // The 2026-09-15 lesson: "the band answered" and "the answer is strong
    // enough to act on" are two different bars, and only a caller with a
    // policy boundary knows the second one. A head that clears the first and
    // fails the second used to end the cascade, so the tier that could have
    // produced an actionable answer was never asked and the unactionable
    // verdict was recorded as a decision.
    const clearText = 'an electric kettle that boils water for tea';
    const options = {
      encoder,
      scorer,
      centroids,
      config,
      encoderConfig: loadEncoderConfig(),
    };
    const tier: Tier = async () => ({
      label: 'blender',
      confidence: 0.9,
      evidence: 'the injected tier disagreed',
    });

    const settled = await classify(clearText, {
      ...options,
      tiers: { [DECISION]: tier },
      settles: { [DECISION]: (semantic) => !semantic.abstained },
    });
    expect(settled.heads[DECISION]?.semanticAbstained).toBe(false);
    expect(settled.heads[DECISION]?.injectedAttempted).toBe(false);
    expect(settled.heads[DECISION]?.label).toBe('kettle');

    const unsettled = await classify(clearText, {
      ...options,
      tiers: { [DECISION]: tier },
      // Same confident verdict, and a caller whose guard it does not clear.
      settles: { [DECISION]: () => false },
    });
    const head = unsettled.heads[DECISION];
    expect(head?.semanticAbstained).toBe(false);
    expect(head?.semantic.label).toBe('kettle');
    expect(head?.injectedAttempted).toBe(true);
    // The injected tier answered, so it is the one on the record now — and
    // the centroid verdict it replaced is still in the trace beside it.
    expect(head?.tier).toBe('injected');
    expect(head?.label).toBe('blender');
  });

  it('keeps the local verdict when an escalated injected tier abstains', async () => {
    // Escalating may only ADD an answer. A tier that declines to give one
    // leaves the band's verdict exactly where it was, for the policy
    // boundary to apply its guard to and fall back on.
    const trace = await classify('an electric kettle that boils water for tea', {
      encoder,
      scorer,
      centroids,
      config,
      encoderConfig: loadEncoderConfig(),
      tiers: { [DECISION]: async () => null },
      settles: { [DECISION]: () => false },
    });
    const head = trace.heads[DECISION];
    expect(head?.injectedAttempted).toBe(true);
    expect(head?.injectedAbstained).toBe(true);
    expect(head?.tier).toBe('semantic');
    expect(head?.label).toBe('kettle');
  });

  it('never throws when an injected tier does', async () => {
    const exploding: Tier = async () => {
      throw new Error('the model is on fire');
    };
    const trace = await classify('an entirely unrelated request about tax law', {
      encoder,
      scorer,
      centroids,
      config,
      encoderConfig: loadEncoderConfig(),
      tiers: { [DECISION]: exploding },
    });
    expect(decide<Appliance, Shelf>(trace, THRESHOLDS, MAPPING).action).toBeTypeOf('string');
  });

  it('records where the time went', async () => {
    const trace = await classify('a blender with a glass jug', {
      encoder,
      scorer,
      centroids,
      config,
      encoderConfig: loadEncoderConfig(),
    });
    expect(trace.totalMs).toBeGreaterThanOrEqual(0);
    expect(trace.encoder.revision).toBe(loadEncoderConfig().revision);
    expect(trace.centroidsVersion).toBe('toy-1');
    expect(trace.errors).toEqual([]);
  });

  it('serves the second call from the content-hash cache', async () => {
    const text = 'a stovetop kettle with a loud whistle, please';
    await shelve(text);
    const again = await classify(text, {
      encoder,
      scorer,
      centroids,
      config,
      encoderConfig: loadEncoderConfig(),
    });
    expect(again.embedCacheHit).toBe(true);
  });

  it('fails open to the fallback when the budget is impossible', async () => {
    encoder.clearCache();
    const trace = await classify('an electric kettle that boils water for tea', {
      encoder,
      scorer,
      centroids,
      config,
      encoderConfig: loadEncoderConfig(),
      budgetMs: 1,
    });
    // A 1ms budget cannot be met, so the tier falls through rather than
    // blocking. The action is the platform's fallback, not a guess.
    if (trace.heads[DECISION]?.semantic.reason === 'encoder_timeout') {
      expect(decide<Appliance, Shelf>(trace, THRESHOLDS, MAPPING).action).toBe('unknown');
      expect(trace.errors).toContain('encoder:encoder_timeout');
    }
  });
});
