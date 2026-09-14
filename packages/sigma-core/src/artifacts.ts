/**
 * The on-disk artifact formats, and the loaders for them.
 *
 * Shapes deliberately mirror Ereno sigma's (`apps/api/sigma/models/`), so a
 * centroid set or a threshold file can move between the two platforms:
 *
 *   - The threshold file is Ereno's `semantic_config.json` verbatim: a top
 *     level `encoder` string and a `decisions` map of
 *     `{ labels, min_sim, margin }`. Extra keys (`held_out`, `version`) are
 *     additive and ignored by a reader that does not know them.
 *   - The centroid file is the JSON form of Ereno's `semantic_centroids.npz`:
 *     the same flat `"<decision>/<label>"` key convention, with the arrays
 *     inline instead of in an npz member. `scripts/npz-to-json.md` in the
 *     README describes the one-line numpy conversion each way.
 *
 * Files are read with `readFileSync` rather than imported, so the same source
 * works under tsc, vitest, tsx and a Next server bundle without import
 * attributes.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** This package's own root, with an override for bundled deployments. */
export const CORE_ROOT: string = process.env.SIGMA_CORE_ROOT
  ? resolve(process.env.SIGMA_CORE_ROOT)
  : resolve(HERE, '..');

export interface EncoderFileEntry {
  path: string;
  /** Empty string means "size-checked only"; small config blobs. */
  sha256: string;
  bytes: number;
}

export interface EncoderConfig {
  /** Hugging Face repo id, exactly as Transformers.js resolves it. */
  model: string;
  /** Pinned commit sha of that repo. Fetching anything else is a defect. */
  revision: string;
  /** Transformers.js dtype key; `q8` selects onnx/model_quantized.onnx. */
  dtype: string;
  /** The instruction prefix the e5 family is trained with. */
  queryPrefix: string;
  maxLength: number;
  /** Where fetch-model.mjs writes and the runtime reads. `~`/`$VAR` expand. */
  cacheDir: string;
  /** Per-call budget for one embed. Over it, the tier fails open. */
  budgetMs: number;
  /** Entries in the content-hash embedding cache. */
  embeddingCacheSize: number;
  files: EncoderFileEntry[];
}

/** Ereno-compatible threshold file. */
export interface DecisionBand {
  labels: string[];
  min_sim: number;
  margin: number;
  /** Additive: what the sweep saw at this point, so the number is auditable. */
  held_out?: {
    cases: number;
    coverage: number;
    accuracy_on_covered: number;
    weighted_cost: number;
    /** Worst cost inside the platform-noise ball; what the sweep optimised. */
    robust_cost: number;
    counts?: Record<string, number>;
  };
}

export interface SemanticConfigFile {
  _comment?: string | string[];
  version?: string;
  encoder: string;
  encoder_revision?: string;
  calibrated_at?: string;
  /**
   * int8 kernels differ between ARM and x86 by roughly 0.006 on a cosine and
   * 0.004 on a margin for the SAME text. A band whose clearance from the data
   * is smaller than this flips verdicts per machine. Ereno learned this the
   * expensive way; the field is carried so the number is not folklore.
   */
  platform_noise_allowance?: number;
  decisions: Record<string, DecisionBand>;
}

/** JSON form of Ereno's `semantic_centroids.npz`. */
export interface CentroidsFile {
  _comment?: string | string[];
  format?: string;
  version: string;
  encoder: string;
  encoder_revision: string;
  built_at: string;
  dim: number;
  /**
   * When true, every vector below has already had its decision's training
   * mean subtracted and been renormalised, and the scorer must subtract the
   * same mean from the query. Train and serve agree or the space is wrong.
   */
  centered: boolean;
  decisions: Record<string, { labels: string[]; sample_counts: Record<string, number> }>;
  /**
   * Flat `"<decision>/<label>"` keys, Ereno's npz convention. The centred
   * mean of a decision lives under `"<decision>/__mean__"`.
   */
  vectors: Record<string, number[]>;
}

export const MEAN_KEY = '__mean__';

export function centroidKey(decision: string, label: string): string {
  return `${decision}/${label}`;
}

export function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function expandPath(raw: string, base: string = CORE_ROOT): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const withHome = raw.startsWith('~') ? join(home, raw.slice(1)) : raw;
  const expanded = withHome.replace(
    /\$\{?([A-Z_][A-Z0-9_]*)\}?/gi,
    (all, name: string) => process.env[name] ?? all,
  );
  return resolve(base, expanded);
}

let encoderConfig: EncoderConfig | undefined;

/** The pinned encoder shipped with the core. */
export function loadEncoderConfig(): EncoderConfig {
  encoderConfig ??= readJsonFile<EncoderConfig>(join(CORE_ROOT, 'config', 'encoder.json'));
  return encoderConfig;
}

/** The resolved on-disk model cache, env override first. */
export function resolveCacheDir(config: EncoderConfig = loadEncoderConfig()): string {
  return expandPath(process.env.SIGMA_MODEL_CACHE_DIR ?? config.cacheDir);
}

export function loadSemanticConfig(path: string): SemanticConfigFile {
  const file = readJsonFile<SemanticConfigFile>(path);
  if (!file.decisions || typeof file.decisions !== 'object') {
    throw new Error(`${path}: not a semantic config (no "decisions" map)`);
  }
  for (const [decision, band] of Object.entries(file.decisions)) {
    if (!Array.isArray(band.labels) || band.labels.length < 2) {
      throw new Error(`${path}: decision "${decision}" needs at least two labels`);
    }
    if (!Number.isFinite(band.min_sim) || !Number.isFinite(band.margin)) {
      throw new Error(`${path}: decision "${decision}" has a non-numeric band`);
    }
  }
  return file;
}

export function loadCentroids(path: string): CentroidsFile {
  const file = readJsonFile<CentroidsFile>(path);
  if (!file.decisions || !file.vectors) {
    throw new Error(`${path}: not a centroid file`);
  }
  for (const [decision, spec] of Object.entries(file.decisions)) {
    for (const label of spec.labels) {
      const key = centroidKey(decision, label);
      const vector = file.vectors[key];
      if (!vector) throw new Error(`${path}: missing centroid "${key}"`);
      if (vector.length !== file.dim) {
        throw new Error(
          `${path}: centroid "${key}" has ${vector.length} dims, file says ${file.dim}`,
        );
      }
    }
    if (file.centered && !file.vectors[centroidKey(decision, MEAN_KEY)]) {
      throw new Error(
        `${path}: decision "${decision}" is centred but has no "${MEAN_KEY}" vector`,
      );
    }
  }
  return file;
}
