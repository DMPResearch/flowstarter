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
 *
 * Security audit 2026-09-13 (Claude H4; Codex F06) found two further
 * problems, both fixed at the database layer (see
 * supabase/migrations/20260913200000_funnel_budget_reservation.sql):
 *
 *   - {@link funnelBudgetState} used to sum `cost_eur` by fetching individual
 *     rows and adding them in JavaScript, which silently truncated once the
 *     ledger passed PostgREST's `max_rows` (1000) — the cap could report
 *     itself un-hit while genuinely exceeded. It now calls the
 *     `funnel_budget_spent_eur` SQL aggregate, which is one row regardless
 *     of how many source rows it summed.
 *   - The cap was read-then-act with no reservation: concurrent callers
 *     could all read the same pre-existing total, all see it under the cap,
 *     and all start a real, multi-minute, real-money run before any of
 *     their costs were ever written back. {@link reserveFunnelSpend} closes
 *     this by reserving the estimated cost against BOTH a global and a
 *     per-caller cap inside one atomic, lock-serialized database call,
 *     before the expensive work starts; {@link settleFunnelReservation} and
 *     {@link releaseFunnelReservation} reconcile it afterwards.
 */

export type FunnelBudgetState = 'ok' | 'degrade' | 'blocked';

/**
 * Why a `blocked` state was returned: over the real monthly cap, over the
 * one-caller-alone cap, or because the accounting query itself failed and
 * the cap could not be checked. The caller (`/api/discovery/preview/live`)
 * surfaces this in its own `reason` field so none of these are ever
 * confused with each other or with the unrelated `not-configured` skip.
 */
export type FunnelBudgetBlockedReason =
  | 'over-cap'
  | 'over-caller-cap'
  | 'accounting-error';

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

export type GenerationKind =
  | 'preview'
  | 'edit'
  | 'recommend'
  | 'codegen'
  | 'support_chat';

/** Monthly € cap. Safe-low default; raise via env once economics are known. */
function capEur(): number {
  const raw = Number(process.env.DISCOVERY_FUNNEL_BUDGET_EUR);
  return Number.isFinite(raw) && raw > 0 ? raw : 50;
}

/**
 * A second, per-caller (per-IP) cap so one visitor rotating requests cannot
 * alone exhaust the whole month's shared budget (security audit 2026-09-13,
 * H4: "burning €50 of budget stops every legitimate visitor's preview for
 * the rest of the month, which is a cheap way to take the funnel offline").
 * Safe-low default; raise via env once economics are known, same as
 * {@link capEur}.
 */
function perCallerCapEur(): number {
  const raw = Number(process.env.DISCOVERY_FUNNEL_PER_CALLER_BUDGET_EUR);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/**
 * A full `preview/live` generation run's estimated cost, reserved against
 * both caps BEFORE the run starts (see {@link reserveFunnelSpend}) rather
 * than only recorded after — the run itself does not report fine-grained
 * token usage back to this module (its cost accounting happens inside
 * `packages/agentic-codegen`), so this is deliberately a conservative
 * per-run estimate, not a computed one. Safe-low default; raise via env once
 * economics are known, same as {@link capEur}.
 */
export function previewLiveEstimatedCostEur(): number {
  const raw = Number(process.env.DISCOVERY_PREVIEW_LIVE_ESTIMATED_COST_EUR);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.5;
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

/** The first instant of the current UTC month — the window every funnel
 * budget query (state, reservation) sums from. */
function startOfMonthUtc(): Date {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  return since;
}

/**
 * Month-to-date funnel state.
 *
 * Fails OPEN only in development (see the module doc comment above); every
 * other environment fails CLOSED so a broken query cannot silently remove
 * the spend cap.
 *
 * This is the read-only, informational check (used for the soft-threshold
 * `degrade` signal and by callers that do not commit a spend of their own).
 * A caller about to spend money should reserve it with
 * {@link reserveFunnelSpend} instead, which checks the same total but
 * commits atomically rather than merely reading it.
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
    const since = startOfMonthUtc();
    // A server-side aggregate, not a row fetch: `select cost_eur ...` here
    // used to be capped by PostgREST's `max_rows` (1000) once the ledger
    // grew past it, silently truncating the total (audit F06). `sum()` is
    // one row regardless of how many source rows it summed.
    const { data: spentRaw, error } = await sb.rpc('funnel_budget_spent_eur', {
      since: since.toISOString(),
    });
    if (error) return accountingUnavailable(cap, error);
    if (spentRaw === null || spentRaw === undefined)
      return accountingUnavailable(cap, 'query returned no data');
    const spent = Number(spentRaw);
    if (!Number.isFinite(spent))
      return accountingUnavailable(cap, `non-numeric total: ${spentRaw}`);
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

// ─── Reserve-then-commit ────────────────────────────────────────────────
//
// The read-then-act shape above (`funnelBudgetState`) is fine for a soft,
// informational signal, but it is exactly the shape that let concurrent
// callers all observe "under the cap" and all proceed (audit H4). A caller
// that is about to actually spend money reserves its estimated cost first;
// the database — not this process, and not a lock only this process would
// see — decides whether that reservation fits under both the global and the
// per-caller cap, atomically, before the expensive work ever starts.

export type FunnelReservationResult =
  | { allowed: true; reservationId: string; spentEur: number }
  | { allowed: false; reason: FunnelBudgetBlockedReason; spentEur: number };

/** The one place a failed reservation query decides open vs. closed — same
 * policy as {@link accountingUnavailable}, shaped for a reservation result
 * instead of a budget-state result. The `dev-unreserved` id is never a real
 * row; {@link settleFunnelReservation}/{@link releaseFunnelReservation}
 * against it are harmless no-op updates (0 rows affected). */
function reservationAccountingUnavailable(
  detail: unknown
): FunnelReservationResult {
  if (isDevelopment()) {
    console.warn(
      '[funnel-cost] reservation accounting unavailable in development; failing open',
      detail
    );
    return { allowed: true, reservationId: 'dev-unreserved', spentEur: 0 };
  }
  console.error(
    '[funnel-cost] reservation accounting unavailable; failing closed',
    detail
  );
  return { allowed: false, reason: 'accounting-error', spentEur: 0 };
}

/**
 * Reserve `estimateEur` against both the global monthly cap and the
 * per-caller cap, atomically, before starting an expensive run. See
 * `supabase/migrations/20260913200000_funnel_budget_reservation.sql`'s
 * `reserve_funnel_spend` for the transaction/locking detail.
 *
 * On success, the caller MUST eventually call {@link settleFunnelReservation}
 * (the run produced a real, billable result) or {@link releaseFunnelReservation}
 * (it did not) — never leave a reservation hanging, or it stays counted
 * against the cap forever.
 */
export async function reserveFunnelSpend(input: {
  estimateEur: number;
  kind: GenerationKind;
  model?: string;
  demoId?: string | null;
  ip?: string | null;
  leadEmail?: string | null;
}): Promise<FunnelReservationResult> {
  try {
    const sb = serviceClient();
    if (!sb)
      return reservationAccountingUnavailable(
        'no Supabase service client configured'
      );
    const since = startOfMonthUtc();
    const { data, error } = await sb.rpc('reserve_funnel_spend', {
      p_since: since.toISOString(),
      p_cap_eur: capEur(),
      p_per_caller_cap_eur: perCallerCapEur(),
      p_estimate_eur: input.estimateEur,
      p_kind: input.kind,
      p_model: input.model ?? null,
      p_demo_id: input.demoId ?? null,
      p_ip: input.ip ?? null,
      p_lead_email: input.leadEmail ?? null,
    });
    if (error) return reservationAccountingUnavailable(error);
    const row = (
      data as
        | {
            reservation_id: string | null;
            allowed: boolean;
            spent_eur: number;
            caller_spent_eur: number;
            reason: string | null;
          }[]
        | null
    )?.[0];
    if (!row) return reservationAccountingUnavailable('rpc returned no row');
    if (!row.allowed) {
      return {
        allowed: false,
        reason: (row.reason as FunnelBudgetBlockedReason) ?? 'over-cap',
        spentEur: Number(row.spent_eur),
      };
    }
    if (!row.reservation_id)
      return reservationAccountingUnavailable(
        'rpc reported allowed with no reservation_id'
      );
    return {
      allowed: true,
      reservationId: row.reservation_id,
      spentEur: Number(row.spent_eur),
    };
  } catch (err) {
    return reservationAccountingUnavailable(err);
  }
}

/**
 * Reconcile a reservation to its actual cost once the run it paid for has
 * finished. Passing neither `costUsd` nor `usage` keeps the reservation at
 * its original estimate rather than zeroing it out — a run that spent real
 * money but cannot report an exact figure back to this module (the
 * `preview/live` pipeline does not, today; its cost accounting happens
 * inside `packages/agentic-codegen`) still counts against the cap for at
 * least its estimate, which is the conservative direction to be wrong in.
 *
 * Never throws, matching {@link recordGenerationCost} — a reconciliation
 * failure must not fail the run it is billing for, but it is logged and
 * counted via {@link costLedgerWriteFailureCount}.
 */
export async function settleFunnelReservation(
  reservationId: string,
  input: { model?: string; usage?: FunnelUsage; costUsd?: number } = {}
): Promise<void> {
  try {
    const sb = serviceClient();
    if (!sb) {
      costLedgerWriteFailures += 1;
      console.error(
        '[funnel-cost] reservation settle skipped: no Supabase service client configured'
      );
      return;
    }
    let actualCostEur: number | null = null;
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    if (typeof input.costUsd === 'number' && input.costUsd > 0) {
      actualCostEur = input.costUsd;
    } else if (input.usage) {
      const normalized = normalizeUsage(input.usage);
      tokensIn = normalized.tokensIn;
      tokensOut = normalized.tokensOut;
      actualCostEur = estimateCostEur(input.model, input.usage);
    }
    const { error } = await sb.rpc('settle_funnel_reservation', {
      p_reservation_id: reservationId,
      p_actual_cost_eur: actualCostEur,
      p_tokens_in: tokensIn,
      p_tokens_out: tokensOut,
    });
    if (error) {
      costLedgerWriteFailures += 1;
      console.error('[funnel-cost] reservation settle failed', error);
    }
  } catch (err) {
    costLedgerWriteFailures += 1;
    console.error('[funnel-cost] reservation settle threw', err);
  }
}

/**
 * Release a reservation that never spent anything real — the run failed
 * before starting, or before producing a billable result. Excluded from
 * every budget aggregate from here on. Never throws, same reasoning as
 * {@link settleFunnelReservation}.
 */
export async function releaseFunnelReservation(
  reservationId: string
): Promise<void> {
  try {
    const sb = serviceClient();
    if (!sb) return;
    const { error } = await sb.rpc('release_funnel_reservation', {
      p_reservation_id: reservationId,
    });
    if (error) {
      console.error('[funnel-cost] reservation release failed', error);
    }
  } catch (err) {
    console.error('[funnel-cost] reservation release threw', err);
  }
}
