/**
 * Flowstarter's committed artifacts: where they are and how they load.
 *
 * Read with `readFileSync` rather than imported, so the same source works
 * under tsc, vitest, tsx and a Next server bundle without import attributes.
 * Bundlers that trace only imports need the package left external — see
 * README, "Consuming it from the app".
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  loadCentroids as loadCentroidsFile,
  loadSemanticConfig as loadSemanticConfigFile,
  readJsonFile,
  type CentroidsFile,
  type SemanticConfigFile,
} from '@flowstarter/sigma-core';

const HERE = dirname(fileURLToPath(import.meta.url));

export const PACKAGE_ROOT: string = process.env.SIGMA_FLOWSTARTER_ROOT
  ? resolve(process.env.SIGMA_FLOWSTARTER_ROOT)
  : resolve(HERE, '..');

export const CONFIG_DIR: string = join(PACKAGE_ROOT, 'config');
export const MODELS_DIR: string = join(PACKAGE_ROOT, 'models');
export const CENTROIDS_PATH: string = join(MODELS_DIR, 'centroids.json');
export const SEMANTIC_CONFIG_PATH: string = join(MODELS_DIR, 'semantic-config.json');
export const PROVENANCE_PATH: string = join(MODELS_DIR, 'provenance.json');

export interface PolicyConfig {
  version: string;
  acceptableUse: {
    refuseMinSimilarity: number;
    refuseMinMargin: number;
    refuseMinLlmConfidence: number;
    allowMinSimilarity: number;
    allowMinMargin: number;
  };
  scope: {
    customMinSimilarity: number;
    customMinMargin: number;
    customMinLlmConfidence: number;
    standardMinSimilarity: number;
    standardMinMargin: number;
  };
  failClosedInProduction: boolean;
}

export interface EvaluationConfig {
  version: string;
  acceptableUse: Record<string, number>;
  scope: Record<string, number>;
  calibration: { minCoverage: number; scopeMinCoverage: number };
  gates: {
    acceptableUseMaxWeightedCost: number;
    scopeMaxWeightedCost: number;
    minCoverage: number;
    scopeMinCoverage: number;
  };
}

export interface Provenance {
  built_at: string;
  encoder: string;
  encoder_revision: string;
  encoder_sha256: Record<string, string>;
  languages: string[];
  splits: {
    train: { phrases: number; counts: Record<string, number> };
    holdout: { phrases: number; counts: Record<string, number> };
  };
  generator: string;
  authors: string[];
}

let policy: PolicyConfig | undefined;
export function loadPolicy(): PolicyConfig {
  policy ??= readJsonFile<PolicyConfig>(join(CONFIG_DIR, 'policy.json'));
  return policy;
}

let evaluation: EvaluationConfig | undefined;
export function loadEvaluationConfig(): EvaluationConfig {
  evaluation ??= readJsonFile<EvaluationConfig>(join(CONFIG_DIR, 'evaluation.json'));
  return evaluation;
}

let semantic: SemanticConfigFile | undefined;
export function loadSemanticConfig(): SemanticConfigFile {
  semantic ??= loadSemanticConfigFile(SEMANTIC_CONFIG_PATH);
  return semantic;
}

let centroids: CentroidsFile | undefined;
export function loadCentroids(): CentroidsFile {
  centroids ??= loadCentroidsFile(CENTROIDS_PATH);
  return centroids;
}

export function loadProvenance(): Provenance {
  return readJsonFile<Provenance>(PROVENANCE_PATH);
}

/** Tests only. */
export function resetConfigCache(): void {
  policy = undefined;
  evaluation = undefined;
  semantic = undefined;
  centroids = undefined;
}
