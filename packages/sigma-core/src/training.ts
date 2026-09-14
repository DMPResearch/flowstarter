/**
 * Building centroids, and choosing the band that sits over them.
 *
 * Both jobs are library functions here, with the CLIs in `scripts/` doing
 * nothing but argument parsing and file writing, so a platform package can
 * retrain from its own seeds without shelling out and a test can train a
 * classifier in-process from a taxonomy that exists only inside the test.
 *
 * The one rule that matters: **the encoder that builds the centroids is the
 * encoder that serves them.** Train/serve skew in an embedding classifier is
 * silent — the numbers all look fine, they are just measured in a different
 * space — so the encoder identity and revision are written into the centroid
 * file and checked at load.
 */

import type { CentroidsFile, EncoderConfig } from './artifacts.js';
import { MEAN_KEY, centroidKey } from './artifacts.js';
import type { Encoder } from './encoder.js';
import { meanVector, normalize, subtract } from './semantic.js';

/* ── synthetic phrase generation ──────────────────────────────────────── */

/**
 * The generic half of a phrase generator: seeds crossed with templates.
 *
 * A seed is the thing being described, in one language. A template is a way
 * somebody might say it, in the same language, with `{s}` where the seed
 * goes. The cross product is what gets embedded — no LLM in the loop, so the
 * training set is reproducible from the repo and diffable in review.
 */
export interface PhraseSeedSet {
  /** language code -> phrasings of the same label in that language. */
  seeds: Record<string, string[]>;
  /** language code -> templates containing `{s}`. */
  templates: Record<string, string[]>;
}

export function expandTemplates(
  set: PhraseSeedSet,
  options: { languages?: string[]; templateFilter?: (index: number) => boolean } = {},
): Array<{ language: string; text: string; templateIndex: number; seedIndex: number }> {
  const out: Array<{
    language: string;
    text: string;
    templateIndex: number;
    seedIndex: number;
  }> = [];
  const languages = options.languages ?? Object.keys(set.seeds);
  for (const language of languages) {
    const seeds = set.seeds[language] ?? [];
    const templates = set.templates[language] ?? [];
    for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
      for (let templateIndex = 0; templateIndex < templates.length; templateIndex++) {
        if (options.templateFilter && !options.templateFilter(templateIndex)) continue;
        out.push({
          language,
          seedIndex,
          templateIndex,
          text: (templates[templateIndex] as string).replaceAll(
            '{s}',
            seeds[seedIndex] as string,
          ),
        });
      }
    }
  }
  return out;
}

/* ── centroid training ────────────────────────────────────────────────── */

export interface LabelledPhrase {
  decision: string;
  label: string;
  text: string;
}

export interface TrainOptions {
  encoder: Encoder;
  encoderConfig: Pick<EncoderConfig, 'model' | 'revision' | 'dtype'>;
  phrases: readonly LabelledPhrase[];
  version: string;
  /** Subtract each decision's training mean before scoring. Strongly advised. */
  centered?: boolean;
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface TrainedCentroids {
  file: CentroidsFile;
  /** Every training vector, kept in memory for an immediate sweep. */
  vectors: Map<string, Float32Array[]>;
}

/**
 * Average the embeddings of each label's phrases into one unit centroid.
 *
 * A centroid is a mean of unit vectors renormalised — deliberately the
 * simplest thing that works. Anything trained (a head, a linear probe) would
 * have to be retrained whenever a label moves, and the whole point of this
 * tier is that a category can be added by writing phrases.
 */
export async function trainCentroids(options: TrainOptions): Promise<TrainedCentroids> {
  const batchSize = options.batchSize ?? 32;
  const centered = options.centered ?? true;
  const byKey = new Map<string, Float32Array[]>();
  const perDecision = new Map<string, Float32Array[]>();
  let dim = 0;
  let done = 0;

  for (let start = 0; start < options.phrases.length; start += batchSize) {
    const batch = options.phrases.slice(start, start + batchSize);
    const vectors = await options.encoder.embed(batch.map((phrase) => phrase.text));
    batch.forEach((phrase, index) => {
      const vector = vectors[index] as Float32Array;
      dim ||= vector.length;
      const key = centroidKey(phrase.decision, phrase.label);
      const bucket = byKey.get(key) ?? [];
      bucket.push(vector);
      byKey.set(key, bucket);
      const all = perDecision.get(phrase.decision) ?? [];
      all.push(vector);
      perDecision.set(phrase.decision, all);
    });
    done += batch.length;
    options.onProgress?.(done, options.phrases.length);
  }

  if (dim === 0) throw new Error('no phrases to train on');

  const decisions: CentroidsFile['decisions'] = {};
  const vectorsOut: Record<string, number[]> = {};
  for (const [decision, all] of perDecision) {
    const mean = centered ? meanVector(all, dim) : null;
    const labels = [...byKey.keys()]
      .filter((key) => key.startsWith(`${decision}/`))
      .map((key) => key.slice(decision.length + 1))
      .sort();
    const sampleCounts: Record<string, number> = {};
    for (const label of labels) {
      const bucket = byKey.get(centroidKey(decision, label)) as Float32Array[];
      sampleCounts[label] = bucket.length;
      const centroid = meanVector(
        mean ? bucket.map((vector) => normalize(subtract(vector, mean))) : bucket,
        dim,
      );
      vectorsOut[centroidKey(decision, label)] = [...normalize(centroid)];
    }
    if (mean) vectorsOut[centroidKey(decision, MEAN_KEY)] = [...mean];
    decisions[decision] = { labels, sample_counts: sampleCounts };
  }

  return {
    file: {
      _comment: [
        'Per-label centroids in the JSON form of Ereno sigma’s',
        'semantic_centroids.npz: flat "<decision>/<label>" keys, plus the',
        'decision’s training mean under "<decision>/__mean__" when centred.',
        'Built by scripts/train-centroids.mjs. Never hand-edit: the band in',
        'semantic-config.json is calibrated against these exact vectors.',
      ],
      format: 'sigma-centroids/1',
      version: options.version,
      encoder: `${options.encoderConfig.model}@${options.encoderConfig.dtype}`,
      encoder_revision: options.encoderConfig.revision,
      built_at: new Date().toISOString(),
      dim,
      centered,
      decisions,
      vectors: vectorsOut,
    },
    vectors: byKey,
  };
}

/* ── calibration ──────────────────────────────────────────────────────── */

/**
 * One held-out row reduced to the only three numbers a band can see: what it
 * should have been, what came top, and how far ahead the top was.
 */
export interface CalibrationSample {
  expected: string;
  top: string;
  topSim: number;
  margin: number;
}

export interface SweepPoint {
  minSim: number;
  margin: number;
  coverage: number;
  accuracyOnCovered: number;
  weightedCost: number;
  /**
   * The worst weighted cost this point reaches when both thresholds are
   * nudged by ±`noiseAllowance`.
   *
   * This is the number the sweep actually optimises, and it is the point of
   * the whole exercise. int8 kernels differ between an ARM dev Mac and an x86
   * CI box by a few thousandths of a cosine on the SAME text, so a band
   * chosen for its cost at exactly one pair of thresholds is a band chosen
   * for one CPU. Ereno shipped one of those once — a safety question that
   * drew a confident verdict on x86 and abstained on ARM — and spent a PR
   * cycle finding it. Optimising the worst case inside the noise ball picks a
   * band that sits on a plateau instead of on a cliff.
   */
  robustCost: number;
  counts: Record<string, number>;
}

export interface SweepOptions {
  minSimGrid: readonly number[];
  marginGrid: readonly number[];
  /**
   * The asymmetric cost of one outcome. Returns counter names; the table
   * prices them. `predicted` is null when the band abstains.
   */
  cost: (outcome: { expected: string; predicted: string | null }) => readonly string[];
  costs: Readonly<Record<string, number>>;
  /**
   * How far a threshold may move between platforms, in cosine units.
   * Defaults to 0.006, measured between ARM and x86 int8 kernels.
   */
  noiseAllowance?: number;
  /**
   * Reject points that answer less often than this.
   *
   * Without it the sweep will happily buy safety with abstention, because an
   * abstention is the cheapest line in any sensible cost table — and a
   * classifier that sends a fifth of your customers to a human is technically
   * excellent and commercially useless. How often we are willing to ask a
   * person is a product decision, so it is a CONSTRAINT here rather than
   * another term in the objective: minimise risk subject to answering enough.
   */
  minCoverage?: number;
}

export interface SweepResult {
  best: SweepPoint;
  points: SweepPoint[];
  /** How much worse the chosen point gets inside the noise ball. */
  robustnessPenalty: number;
  /** Grid points rejected only for answering too rarely. */
  rejectedForCoverage: number;
}

/**
 * Sweep (min_sim, margin) over a held-out split and pick the point that is
 * cheapest IN THE WORST CASE across the platform-noise ball.
 *
 * Ties break toward the lower nominal cost, then toward higher coverage:
 * between two equally robust bands prefer the cheaper one, and between two
 * equally cheap ones prefer the one that answers more often.
 */
export function sweepBand(
  samples: readonly CalibrationSample[],
  options: SweepOptions,
): SweepResult {
  if (samples.length === 0) throw new Error('nothing to calibrate on');
  const noise = options.noiseAllowance ?? 0.006;
  const minCoverage = options.minCoverage ?? 0;
  const points: SweepPoint[] = [];
  let rejectedForCoverage = 0;

  const evaluate = (minSim: number, margin: number) => {
    let covered = 0;
    let correct = 0;
    let weightedCost = 0;
    const counts: Record<string, number> = {};
    for (const sample of samples) {
      const abstained = sample.topSim < minSim || sample.margin < margin;
      const predicted = abstained ? null : sample.top;
      if (!abstained) {
        covered += 1;
        if (predicted === sample.expected) correct += 1;
      }
      for (const name of options.cost({ expected: sample.expected, predicted })) {
        const price = options.costs[name];
        if (price === undefined) throw new Error(`cost table has no entry for "${name}"`);
        counts[name] = (counts[name] ?? 0) + 1;
        weightedCost += price;
      }
    }
    return { covered, correct, weightedCost, counts };
  };

  for (const minSim of options.minSimGrid) {
    for (const margin of options.marginGrid) {
      const nominal = evaluate(minSim, margin);
      // Four corners of the noise ball. The cost is monotone in neither
      // threshold, so checking corners rather than one direction matters.
      let robustCost = nominal.weightedCost;
      for (const simShift of [-noise, noise]) {
        for (const marginShift of [-noise, noise]) {
          const shifted = evaluate(
            Math.max(-1, minSim + simShift),
            Math.max(0, margin + marginShift),
          );
          robustCost = Math.max(robustCost, shifted.weightedCost);
        }
      }
      const point: SweepPoint = {
        minSim,
        margin,
        coverage: nominal.covered / samples.length,
        accuracyOnCovered: nominal.covered === 0 ? 0 : nominal.correct / nominal.covered,
        weightedCost: nominal.weightedCost,
        robustCost,
        counts: nominal.counts,
      };
      if (minCoverage > 0 && point.coverage < minCoverage) {
        rejectedForCoverage += 1;
        continue;
      }
      points.push(point);
    }
  }

  if (points.length === 0) {
    throw new Error(
      `no grid point reached ${minCoverage} coverage; the centroids are not ` +
        'separating this holdout, and a band cannot fix that',
    );
  }
  const best = [...points].sort(
    (a, b) =>
      a.robustCost - b.robustCost ||
      a.weightedCost - b.weightedCost ||
      b.coverage - a.coverage,
  )[0] as SweepPoint;
  return {
    best,
    points,
    robustnessPenalty: best.robustCost - best.weightedCost,
    rejectedForCoverage,
  };
}

/** A grid of evenly spaced thresholds, rounded to avoid float dust. */
export function grid(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let value = from; value <= to + 1e-9; value += step) {
    out.push(Number(value.toFixed(4)));
  }
  return out;
}
