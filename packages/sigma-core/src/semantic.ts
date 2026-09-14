/**
 * The centroid tier: cosine against per-label centroids, with an explicit
 * abstention band.
 *
 * A verdict is CONFIDENT only outside the band: the top cosine must reach
 * `min_sim` and lead the runner-up by `margin`. Inside the band the head
 * abstains and says so — abstention is a first-class outcome here, not a
 * low-confidence guess dressed up as an answer. Everything downstream is
 * built on that: the cascade only consults a second tier where this one
 * abstained, and the policy boundary turns an abstention into the safe
 * action rather than into a coin flip.
 *
 * Centring. Sentence-embedding spaces are anisotropic: two unrelated
 * business descriptions still sit at cosine ~0.85, which leaves the band
 * nothing to work with. When the centroid file says `centered`, each
 * decision's training mean is subtracted from the query and from the
 * centroids before scoring, which spreads the labels out and makes a margin
 * mean something. Training writes the mean; scoring subtracts the same one.
 * That is the whole contract — the moment they disagree the space is wrong,
 * which is why the mean travels inside the centroid file and not in code.
 */

import type { CentroidsFile, DecisionBand, SemanticConfigFile } from './artifacts.js';
import { MEAN_KEY, centroidKey } from './artifacts.js';
import type { SemanticResult } from './types.js';

/** One decision's scoring geometry, prepared once at load. */
export interface PreparedDecision {
  name: string;
  labels: string[];
  /** labels.length x dim, already centred and renormalised when applicable. */
  matrix: Float32Array[];
  mean: Float32Array | null;
  minSim: number;
  margin: number;
  dim: number;
}

export class CentroidScorer {
  private readonly decisions = new Map<string, PreparedDecision>();

  constructor(
    readonly centroids: CentroidsFile,
    readonly config: SemanticConfigFile,
  ) {
    for (const [name, band] of Object.entries(config.decisions)) {
      const spec = centroids.decisions[name];
      if (!spec) {
        throw new Error(
          `semantic config has decision "${name}" but the centroid file does not`,
        );
      }
      const configured = [...band.labels].sort().join(',');
      const trained = [...spec.labels].sort().join(',');
      if (configured !== trained) {
        // A silently-reordered or renamed label set is how a calibrated band
        // ends up applied to the wrong geometry. Refuse instead.
        throw new Error(
          `decision "${name}": config labels [${configured}] != centroid labels [${trained}]`,
        );
      }
      this.decisions.set(name, prepare(name, band, centroids));
    }
  }

  get decisionNames(): string[] {
    return [...this.decisions.keys()];
  }

  decision(name: string): PreparedDecision {
    const prepared = this.decisions.get(name);
    if (!prepared) {
      throw new Error(
        `no decision "${name}"; this scorer has: ${this.decisionNames.join(', ')}`,
      );
    }
    return prepared;
  }

  /** Score one already-embedded text against one decision. */
  score<L extends string = string>(name: string, vector: Float32Array): SemanticResult<L> {
    const prepared = this.decision(name);
    if (vector.length !== prepared.dim) {
      throw new Error(
        `decision "${name}" expects ${prepared.dim}-dim vectors, got ${vector.length}`,
      );
    }
    const query = prepared.mean ? normalize(subtract(vector, prepared.mean)) : vector;
    let topIndex = 0;
    let top = -Infinity;
    let second = -Infinity;
    for (let index = 0; index < prepared.matrix.length; index++) {
      const similarity = dot(query, prepared.matrix[index] as Float32Array);
      if (similarity > top) {
        second = top;
        top = similarity;
        topIndex = index;
      } else if (similarity > second) {
        second = similarity;
      }
    }
    const margin = top - second;
    const label = prepared.labels[topIndex] as L;
    const runnerUp = runnerUpLabel<L>(prepared, query, topIndex);
    if (top < prepared.minSim) {
      return { label, runnerUp, similarity: top, margin, abstained: true, reason: 'below_min_sim' };
    }
    if (margin < prepared.margin) {
      return { label, runnerUp, similarity: top, margin, abstained: true, reason: 'below_margin' };
    }
    return { label, runnerUp, similarity: top, margin, abstained: false, reason: 'confident' };
  }

  /** Every decision's full ranking; for calibration and debugging, not serving. */
  rank(name: string, vector: Float32Array): Array<{ label: string; similarity: number }> {
    const prepared = this.decision(name);
    const query = prepared.mean ? normalize(subtract(vector, prepared.mean)) : vector;
    return prepared.labels
      .map((label, index) => ({
        label,
        similarity: dot(query, prepared.matrix[index] as Float32Array),
      }))
      .sort((a, b) => b.similarity - a.similarity);
  }
}

function runnerUpLabel<L extends string>(
  prepared: PreparedDecision,
  query: Float32Array,
  topIndex: number,
): L | null {
  let best = -Infinity;
  let bestIndex = -1;
  for (let index = 0; index < prepared.matrix.length; index++) {
    if (index === topIndex) continue;
    const similarity = dot(query, prepared.matrix[index] as Float32Array);
    if (similarity > best) {
      best = similarity;
      bestIndex = index;
    }
  }
  return bestIndex === -1 ? null : (prepared.labels[bestIndex] as L);
}

function prepare(
  name: string,
  band: DecisionBand,
  centroids: CentroidsFile,
): PreparedDecision {
  const spec = centroids.decisions[name];
  if (!spec) throw new Error(`centroid file has no decision "${name}"`);
  const mean = centroids.centered
    ? Float32Array.from(centroids.vectors[centroidKey(name, MEAN_KEY)] as number[])
    : null;
  const matrix = spec.labels.map((label) => {
    const raw = centroids.vectors[centroidKey(name, label)];
    if (!raw) throw new Error(`centroid file is missing "${centroidKey(name, label)}"`);
    return Float32Array.from(raw);
  });
  return {
    name,
    labels: [...spec.labels],
    matrix,
    mean,
    minSim: band.min_sim,
    margin: band.margin,
    dim: centroids.dim,
  };
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index++) {
    sum += (a[index] as number) * (b[index] as number);
  }
  return sum;
}

export function subtract(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let index = 0; index < a.length; index++) {
    out[index] = (a[index] as number) - (b[index] as number);
  }
  return out;
}

export function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (let index = 0; index < vector.length; index++) {
    norm += (vector[index] as number) ** 2;
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-12) return vector;
  const out = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index++) {
    out[index] = (vector[index] as number) / norm;
  }
  return out;
}

/** The mean of a set of vectors, unnormalised. */
export function meanVector(vectors: readonly Float32Array[], dim: number): Float32Array {
  const out = new Float32Array(dim);
  for (const vector of vectors) {
    for (let index = 0; index < dim; index++) {
      out[index] = (out[index] as number) + (vector[index] as number);
    }
  }
  const count = Math.max(1, vectors.length);
  for (let index = 0; index < dim; index++) {
    out[index] = (out[index] as number) / count;
  }
  return out;
}
