-- Fixes two related problems in the public discovery funnel's spend guard
-- (security audit 2026-09-13, Claude H4 / Codex F06):
--
--   1. `funnelBudgetState()` summed month-to-date `cost_eur` by fetching
--      individual rows (`select cost_eur ... `) and adding them up in
--      JavaScript. `supabase/config.toml`'s `max_rows = 1000` caps every
--      PostgREST response, so once the ledger passed 1000 rows in a month
--      the computed total silently stopped growing while the real spend
--      kept climbing — the cap could report itself un-hit while genuinely
--      exceeded.
--   2. The cap was read-then-act with no reservation: N concurrent requests
--      could all read the same pre-existing total, all see it under the cap,
--      and all launch a real (multi-minute, real-money) generation run
--      before any of their costs were ever written back.
--
-- Both are fixed at the database layer, which is the only place a
-- concurrent-request race can actually be closed:
--
--   - `funnel_budget_spent_eur(since)` computes the month-to-date total with
--     a server-side aggregate (`sum()`), which is not subject to
--     PostgREST's row-count cap at all — an aggregate is one row regardless
--     of how many source rows it summed.
--   - `reserve_funnel_spend(...)` reads the same aggregate and, if the
--     estimated cost fits under the cap (and under a second, per-caller cap
--     — one visitor should not be able to exhaust the whole month's budget
--     alone), inserts a `'reserved'` row for that estimate IN THE SAME
--     transaction, serialized against every other concurrent call via a
--     transaction-scoped advisory lock. Two concurrent callers can no longer
--     both observe "under the cap" and both proceed past it: the second
--     call's aggregate read happens only after the first call's reservation
--     row is already visible inside the (serialized) transaction.
--   - `settle_funnel_reservation(...)` and `release_funnel_reservation(...)`
--     let the caller reconcile the reservation to the actual cost once the
--     run finishes, or release it entirely if the run failed before
--     spending anything real.

-- ─── 1. A reservation has a lifecycle ──────────────────────────────────────

alter table demo_generation_costs
  add column if not exists status text not null default 'settled';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'demo_generation_costs_status_check'
  ) then
    alter table demo_generation_costs
      add constraint demo_generation_costs_status_check
      check (status in ('reserved', 'settled', 'released'));
  end if;
end
$$;

comment on column demo_generation_costs.status is
  'reserved: an estimate held against the cap while a run is in progress. settled: reconciled to the (best-known) actual cost. released: the run never spent it; excluded from every budget aggregate. Existing rows default to settled, since every row written before this column existed was already a completed, non-reserved cost.';

create index if not exists idx_demo_generation_costs_status_created_at
  on demo_generation_costs (status, created_at);

create index if not exists idx_demo_generation_costs_ip_created_at
  on demo_generation_costs (ip, created_at)
  where ip is not null;

-- ─── 2. The DB-side aggregate (fixes F06 / the max_rows truncation) ───────

create or replace function public.funnel_budget_spent_eur(since timestamptz)
returns numeric
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce(sum(cost_eur), 0)
  from demo_generation_costs
  where created_at >= since
    and status <> 'released'
$$;

comment on function public.funnel_budget_spent_eur(timestamptz) is
  'Month-to-date (or any since-date) funnel spend, summed server-side so the total is never subject to a PostgREST row-count cap. Excludes released reservations. Read by src/lib/ai/funnel-cost.ts.';

revoke all on function public.funnel_budget_spent_eur(timestamptz) from public, anon, authenticated;
grant execute on function public.funnel_budget_spent_eur(timestamptz) to service_role;

-- ─── 3. Reserve-then-commit (fixes the H4/F06 concurrency race) ──────────

create or replace function public.reserve_funnel_spend(
  p_since timestamptz,
  p_cap_eur numeric,
  p_per_caller_cap_eur numeric,
  p_estimate_eur numeric,
  p_kind text,
  p_model text,
  p_demo_id uuid,
  p_ip text,
  p_lead_email text
)
returns table (
  reservation_id uuid,
  allowed boolean,
  spent_eur numeric,
  caller_spent_eur numeric,
  reason text
)
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_spent numeric;
  v_caller_spent numeric := 0;
  v_id uuid;
begin
  -- Serializes every concurrent caller of this function against one
  -- another: the second caller's aggregate read (below) cannot start until
  -- the first caller's read-and-maybe-insert has fully committed or rolled
  -- back. This is what actually closes the TOCTOU race; the aggregate
  -- query alone does not, no matter how it is written.
  perform pg_advisory_xact_lock(hashtext('flowstarter_funnel_budget'));

  select coalesce(sum(cost_eur), 0) into v_spent
  from demo_generation_costs
  where created_at >= p_since
    and status <> 'released';

  if v_spent + p_estimate_eur > p_cap_eur then
    return query select null::uuid, false, v_spent, 0::numeric, 'over-cap'::text;
    return;
  end if;

  if p_ip is not null then
    select coalesce(sum(cost_eur), 0) into v_caller_spent
    from demo_generation_costs
    where created_at >= p_since
      and status <> 'released'
      and ip = p_ip;

    if v_caller_spent + p_estimate_eur > p_per_caller_cap_eur then
      return query select null::uuid, false, v_spent, v_caller_spent, 'over-caller-cap'::text;
      return;
    end if;
  end if;

  insert into demo_generation_costs (demo_id, kind, model, cost_eur, ip, lead_email, status)
  values (p_demo_id, p_kind, p_model, p_estimate_eur, p_ip, p_lead_email, 'reserved')
  returning id into v_id;

  return query select v_id, true, v_spent, v_caller_spent, null::text;
end;
$$;

comment on function public.reserve_funnel_spend(timestamptz, numeric, numeric, numeric, text, text, uuid, text, text) is
  'Atomically checks the global and per-caller month-to-date spend against their caps and, if both pass, reserves p_estimate_eur against them by inserting a status=reserved row. Serialized across concurrent callers with a transaction-scoped advisory lock. Read/written by src/lib/ai/funnel-cost.ts (reserveFunnelSpend).';

revoke all on function public.reserve_funnel_spend(timestamptz, numeric, numeric, numeric, text, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.reserve_funnel_spend(timestamptz, numeric, numeric, numeric, text, text, uuid, text, text) to service_role;

-- ─── 4. Reconciling a reservation ──────────────────────────────────────────

create or replace function public.settle_funnel_reservation(
  p_reservation_id uuid,
  p_actual_cost_eur numeric default null,
  p_tokens_in integer default null,
  p_tokens_out integer default null
)
returns void
language sql
set search_path = pg_catalog, public
as $$
  update demo_generation_costs
  set status = 'settled',
      cost_eur = coalesce(p_actual_cost_eur, cost_eur),
      tokens_in = coalesce(p_tokens_in, tokens_in),
      tokens_out = coalesce(p_tokens_out, tokens_out)
  where id = p_reservation_id
$$;

comment on function public.settle_funnel_reservation(uuid, numeric, integer, integer) is
  'Marks a reservation settled. A null p_actual_cost_eur keeps the reserved estimate rather than zeroing it out, so a run that spent real money but could not report an exact figure still counts against the cap for at least its estimate. Read/written by src/lib/ai/funnel-cost.ts (settleFunnelReservation).';

revoke all on function public.settle_funnel_reservation(uuid, numeric, integer, integer) from public, anon, authenticated;
grant execute on function public.settle_funnel_reservation(uuid, numeric, integer, integer) to service_role;

create or replace function public.release_funnel_reservation(p_reservation_id uuid)
returns void
language sql
set search_path = pg_catalog, public
as $$
  update demo_generation_costs
  set status = 'released'
  where id = p_reservation_id
$$;

comment on function public.release_funnel_reservation(uuid) is
  'Marks a reservation released: it never spent anything real (the run failed before starting, or before completing meaningfully) and is excluded from every budget aggregate from here on. Read/written by src/lib/ai/funnel-cost.ts (releaseFunnelReservation).';

revoke all on function public.release_funnel_reservation(uuid) from public, anon, authenticated;
grant execute on function public.release_funnel_reservation(uuid) to service_role;
