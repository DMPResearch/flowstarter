/**
 * Shared plumbing for the two evaluation suites.
 *
 * Runs the REAL semantic tier — the committed centroids, the calibrated band,
 * the pinned q8 ONNX encoder — over a committed dataset, with no LLM tier and
 * no network. If the model cache is missing this throws with the fetch
 * command, on purpose: a green suite that silently skipped the classifier
 * would be worse than a red one.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expandDataset,
  type EvalDataset,
  type EvalItem,
  type ScoredItem,
} from '@flowstarter/sigma-core';
import { classifyRequest, decide, warmSigma, type Decision } from '../src/gate.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadDataset(name: string): EvalDataset {
  return JSON.parse(readFileSync(join(HERE, 'data', name), 'utf8')) as EvalDataset;
}

export interface RunRow {
  item: EvalItem;
  decision: Decision;
}

/** One pass over a dataset, sequential so the reported latency means something. */
export async function runDataset(dataset: EvalDataset): Promise<RunRow[]> {
  await warmSigma();
  const items = expandDataset(dataset);
  const rows: RunRow[] = [];
  for (const item of items) {
    rows.push({ item, decision: decide(await classifyRequest(item.prompt)) });
  }
  return rows;
}

/** Reduce a run to what the scorer sees, for one head. */
export function scoreRows<L extends string, A extends string>(
  rows: readonly RunRow[],
  head: 'acceptable_use' | 'scope',
): ScoredItem<L, A>[] {
  return rows.map(({ item, decision }) => {
    const trace = decision.trace.heads[head];
    const expectations = item.expectations as { category?: string; action?: string };
    return {
      id: item.id,
      groupId: item.groupId,
      language: item.language,
      expectedLabel: (expectations.category ?? null) as L | null,
      expectedAction: expectations.action as A,
      actualLabel: ((head === 'acceptable_use'
        ? decision.category
        : decision.scopeCategory) ?? null) as L | null,
      actualAction: (head === 'acceptable_use'
        ? decision.acceptableUse
        : decision.scope) as A,
      abstained: trace?.label === null,
      ...(item.xfail ? { xfail: item.xfail } : {}),
    };
  });
}

/** Latency of the embedding pass, warm, over a run. */
export function latency(rows: readonly RunRow[]): {
  p50: number;
  p95: number;
  max: number;
} {
  const warmRows = rows.filter((row) => !row.decision.trace.embedCacheHit);
  const times = warmRows.map((row) => row.decision.trace.totalMs).sort((a, b) => a - b);
  const at = (fraction: number) =>
    times.length === 0 ? 0 : (times[Math.min(times.length - 1, Math.floor(fraction * times.length))] as number);
  return { p50: at(0.5), p95: at(0.95), max: at(1) };
}

/** A failure message a reviewer can act on: ids and labels, never a prompt. */
export function describeFailures(
  failures: ReadonlyArray<{ id: string; expectedAction: string; actualAction: string; expectedLabel: string | null; actualLabel: string | null; fired: readonly string[] }>,
  limit = 25,
): string {
  return failures
    .slice(0, limit)
    .map(
      (failure) =>
        `  ${failure.id}: expected ${failure.expectedAction}/${failure.expectedLabel ?? '*'}, ` +
        `got ${failure.actualAction}/${failure.actualLabel ?? 'abstain'} [${failure.fired.join(',')}]`,
    )
    .join('\n');
}
