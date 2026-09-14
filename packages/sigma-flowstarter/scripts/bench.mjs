#!/usr/bin/env node
/**
 * What one classification costs, on this machine.
 *
 *   pnpm --filter @flowstarter/sigma-flowstarter bench
 *
 * Reports the cold load separately from the warm path, because they are
 * different problems: the cold load is a startup concern that `warmSigma()`
 * moves off the request path, and the warm path is what a request actually
 * pays. Both heads come out of one embedding, so the numbers below are for
 * the whole decision, not for one of them.
 */

import {
  classifyRequest,
  decide,
  loadCentroids,
  loadSemanticConfig,
  warmSigma,
} from '../src/index.ts';
import { loadEncoderConfig } from '@flowstarter/sigma-core';

const BRIEFS = [
  'A dental clinic in the old town, six dentists, we take new patients.',
  'We roast speciality coffee and want a small shop page plus our wholesale story.',
  'I photograph weddings and want a portfolio with galleries by season.',
  'Un site de prezentare pentru atelierul nostru de tamplarie, cu lucrari anterioare.',
  'Eine Seite fuer unsere Baeckerei mit Sortiment, Oeffnungszeiten und Kontaktformular.',
  'Un marketplace ou vendeurs et acheteurs ont un compte et nous prenons une commission.',
  'Una plataforma SaaS con planes mensuales y un panel de administracion.',
  'Un sistema di prenotazioni e pagamenti con turni del personale e rimborsi.',
  'Offshore casino, slots and live roulette, crypto deposits, no licence.',
  'We import 1:1 replica handbags and sell them as the real thing.',
];

const encoderConfig = loadEncoderConfig();
console.log(`encoder   : ${encoderConfig.model}@${encoderConfig.revision.slice(0, 12)} (${encoderConfig.dtype})`);
console.log(`centroids : ${loadCentroids().version}, band ${loadSemanticConfig().version}`);
console.log(`budget    : ${encoderConfig.budgetMs}ms per call`);

const coldStarted = performance.now();
await warmSigma();
console.log(`cold load : ${(performance.now() - coldStarted).toFixed(0)}ms (warmSigma, off the request path)`);

// A warm, uncached pass: every brief is new to the content-hash cache.
const warm = [];
for (const brief of BRIEFS) {
  const started = performance.now();
  const decision = decide(await classifyRequest(brief));
  warm.push(performance.now() - started);
  console.log(
    `  ${decision.acceptableUse.padEnd(6)} ${decision.scope.padEnd(8)} ` +
      `${String(decision.category ?? 'abstain').padEnd(36)} ${(warm.at(-1) ?? 0).toFixed(1)}ms`,
  );
}

// The same briefs again: every embedding now comes from the cache.
const cached = [];
for (const brief of BRIEFS) {
  const started = performance.now();
  await classifyRequest(brief);
  cached.push(performance.now() - started);
}

const stat = (times) => {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  return `p50 ${at(0.5).toFixed(1)}ms  p95 ${at(0.95).toFixed(1)}ms  max ${at(1).toFixed(1)}ms`;
};
console.log(`\nwarm, uncached : ${stat(warm)}  (n=${warm.length})`);
console.log(`warm, cached   : ${stat(cached)}  (n=${cached.length})`);
