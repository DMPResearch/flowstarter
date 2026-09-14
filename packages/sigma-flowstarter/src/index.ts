/**
 * @flowstarter/sigma-flowstarter — the two Flowstarter sigma heads.
 *
 *   classifyAcceptableUse(text) -> { acceptableUse: allow|review|refuse, ... }
 *   classifyScope(text)         -> { scope: standard|custom|unclear, ... }
 *
 * Call `warmSigma()` once at startup. See README.md.
 */

export * from './taxonomy.js';
export * from './gate.js';
export * from './costs.js';
export {
  loadPolicy,
  loadEvaluationConfig,
  loadCentroids,
  loadSemanticConfig,
  loadProvenance,
  resetConfigCache,
  CENTROIDS_PATH,
  SEMANTIC_CONFIG_PATH,
  PROVENANCE_PATH,
  PACKAGE_ROOT,
  type PolicyConfig,
  type EvaluationConfig,
  type Provenance,
} from './config.js';
