/**
 * @flowstarter/sigma-core — a sigma classifier with no taxonomy in it.
 *
 * Assemble one from four parts, none of which knows what your labels mean:
 *
 *   encoder   local multilingual embeddings, no network at inference
 *   scorer    centroids + an explicit abstention band
 *   cascade   one embedding, N heads, optional injected second tier
 *   policy    label -> action, through a mapping and numeric guards
 *
 * See README.md, and `test/toy-taxonomy.test.ts` for a complete working
 * classifier built from a taxonomy that exists only inside that test.
 */

export * from './types.js';
export * from './artifacts.js';
export * from './encoder.js';
export * from './semantic.js';
export * from './cascade.js';
export * from './policy.js';
export * from './evaluation.js';
export * from './training.js';
