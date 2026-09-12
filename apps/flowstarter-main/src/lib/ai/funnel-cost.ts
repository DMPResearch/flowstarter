import 'server-only';

import { createClient } from '@supabase/supabase-js';

/**
 * Cost guard + kill-switch for the public discovery funnel's LLM spend.
 *
 * Every funnel model call records its cost to `demo_generation_costs`.
 * Before an expensive call the route asks {@link funnelBudgetState}:
 *   - `ok`       — proceed normally
 *   - `degrade`  — over the soft threshold; caller should use a cheaper model
 *   - `blocked`  — over the monthly cap, or the accounting itself is broken;
 *                  caller fails open to the deterministic template demo (the
 *                  funnel never dead-ends), and the response's `reason`
 *                  field says which of the two it was.
 *
 * MVP readiness review, "Security": this used to fail OPEN on any accounting
 * error (no service key, missing table, query error, a throw) — the cap
 * existed on paper but a broken query silently spent without limit. It now
 * fails CLOSED (`blocked`, `reason: 'accounting-error'`) outside development,
 * so a broken cost query stops spend instead of hiding it. In development —
 * where the local stack routinely has no `demo_generation_costs` row seeded,
 * or no service key at all — it still fails open, with a logged warning, so
 * a clean checkout is not blocked from ever seeing a live preview.
 */

export type FunnelBudgetState = 'ok' | 'degrade' | 'blocked';

/**
 * Why a `blocked` state was returned: over the real monthly cap, or because
 * the accounting query itself failed and the cap could not be checked. The
 * caller (`/api/discovery/preview/live`) surfaces this in its own `reason`
 * field so the two are never confused with each other or with the
 * unrelated `not-configured` skip.
 */
export type FunnelBudgetBlockedReason = 'over-cap' | 'accounting-error';

export interface FunnelBudgetResult {
  state: FunnelBudgetState;
  spentEur: number;
  capEur: number;
  reason?: FunnelBudgetBlockedReason;
}

/** `NODE_ENV=test` (CI, the unit suite) is deliberately NOT development here:
 * a test that wants fail-open behaviour mocks this module, same as every
 * existing caller already does. */
function isDevelopment(): boolean {
  return process.env.NODE_ENV === 'development';
}

let costLedgerWriteFailures = 0;

/** For the routes/observability surface that want to alert on this; see the
 * readiness review's "nothing tells anyone when something breaks". */
export function costLedgerWriteFailureCount(): number {
  return costLedgerWriteFailures;
}

/** Test-only reset — the counter is module-level so it survives across
 * tests in the same file otherwise. */
export function _resetCostLedgerWriteFailureCountForTests(): void {
  costLedgerWriteFailures = 0;
}

export interface FunnelUsage {
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export type GenerationKind = 'preview' | 'edit' | 'recommend' | 'codegen';

/** Monthly € cap. Safe-low default; raise via env once economics are known. */
function capEur(): number {
  const raw = Number(process.env.DISCOVERY_FUNNEL_BUDGET_EUR);
  return Number.isFinite(raw) && raw > 0 ? raw : 50;
}

const SOFT_FRACTION = 0.7;

/** €/1M tokens [in, out]. Conservative; unknown models use a safe-high default. */
const RATE_PER_MTOK: Array<[match: string, inEur: number, outEur: number]> = [
  ['claude-sonnet-4', 3, 15],
  ['claude-3.7-sonnet', 3, 15],
  ['claude-haiku', 0.8, 4],
  ['llama-3.1-70b', 0.3, 0.4],
  ['gpt-4o', 2.5, 10],
];
const DEFAULT_RATE: [number, number] = [5, 15];

function rateFor(model: string | undefined): [number, number] {
  if (model) {
    for (const [m, i, o] of RATE_PER_MTOK) {
      if (model.includes(m)) return [i, o];
    }
  }
  return DEFAULT_RATE;
}

export function normalizeUsage(u: FunnelUsage | undefined): {
  tokensIn: number;
  tokensOut: number;
} {
  return {
    tokensIn: u?.inputTokens ?? u?.promptTokens ?? 0,
    tokensOut: u?.outputTokens ?? u?.completionTokens ?? 0,
  };
}

export function estimateCostEur(
  model: string | undefined,
  usage: FunnelUsage | undefined
): number {
  const { tokensIn, tokensOut } = normalizeUsage(usage);
  const [inRate, outRate] = rateFor(model);
  return (tokensIn / 1_000_000) * inRate + (tokensOut / 1_000_000) * outRate;
}

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Cost write. Never throws — a write failure must not fail the generation it
 * is billing for — but unlike before, a failure is no longer silent: it is
 * logged and counted via {@link costLedgerWriteFailureCount} so an operator
 * (or an alert, once one exists) can see the ledger is unreliable instead of
 * the cap quietly going blind.
 */
export async function recordGenerationCost(input: {
  kind: GenerationKind;
  model?: string;
  usage?: FunnelUsage;
  /**
   * Actual cost (USD) reported by the provider. When given, it's used verbatim
   * (treated ~1:1 with EUR for the kill-switch rail — slightly conservative)
   * instead of the token-rate estimate. Pass this whenever the provider
   * returns real cost so the cap tracks true spend, not a guess.
   */
  costUsd?: number;
  demoId?: string | null;
  ip?: string | null;
  leadEmail?: string | null;
}): Promise<void> {
  try {
    const sb = serviceClient();
    if (!sb) {
      costLedgerWriteFailures += 1;
      console.error(
        '[funnel-cost] cost ledger write skipped: no Supabase service client configured'
      );
      return;
    }
    const { tokensIn, tokensOut } = normalizeUsage(input.usage);
    const cost =
      typeof input.costUsd === 'number' && input.costUsd > 0
        ? input.costUsd
        : estimateCostEur(input.model, input.usage);
    const { error } = await sb.from('demo_generation_costs').insert({
      demo_id: input.demoId ?? null,
      kind: input.kind,
      model: input.model ?? null,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_eur: cost,
      ip: input.ip ?? null,
      lead_email: input.leadEmail ?? null,
    });
    if (error) {
      costLedgerWriteFailures += 1;
      console.error('[funnel-cost] cost ledger write failed', error);
    }
  } catch (err) {
    costLedgerWriteFailures += 1;
    console.error('[funnel-cost] cost ledger write threw', err);
  }
}

/** The one place a failed accounting query decides open vs. closed. */
function accountingUnavailable(
  cap: number,
  detail: unknown
): FunnelBudgetResult {
  if (isDevelopment()) {
    console.warn(
      '[funnel-cost] budget accounting unavailable in development; failing open',
      detail
    );
    return { state: 'ok', spentEur: 0, capEur: cap };
  }
  console.error(
    '[funnel-cost] budget accounting unavailable; failing closed',
    detail
  );
  return {
    state: 'blocked',
    spentEur: 0,
    capEur: cap,
    reason: 'accounting-error',
  };
}

/**
 * Month-to-date funnel state.
 *
 * Fails OPEN only in development (see the module doc comment above); every
 * other environment fails CLOSED so a broken query cannot silently remove
 * the spend cap.
 */
export async function funnelBudgetState(): Promise<FunnelBudgetResult> {
  const cap = capEur();
  try {
    const sb = serviceClient();
    if (!sb)
      return accountingUnavailable(
        cap,
        'no Supabase service client configured'
      );
    const since = new Date();
    since.setUTCDate(1);
    since.setUTCHours(0, 0, 0, 0);
    const { data, error } = await sb
      .from('demo_generation_costs')
      .select('cost_eur')
      .gte('created_at', since.toISOString());
    if (error) return accountingUnavailable(cap, error);
    if (!data) return accountingUnavailable(cap, 'query returned no data');
    const spent = data.reduce(
      (s, r) => s + Number((r as { cost_eur: number }).cost_eur || 0),
      0
    );
    const state: FunnelBudgetState =
      spent >= cap
        ? 'blocked'
        : spent >= cap * SOFT_FRACTION
        ? 'degrade'
        : 'ok';
    return {
      state,
      spentEur: spent,
      capEur: cap,
      ...(state === 'blocked' ? { reason: 'over-cap' as const } : {}),
    };
  } catch (err) {
    return accountingUnavailable(cap, err);
  }
}
