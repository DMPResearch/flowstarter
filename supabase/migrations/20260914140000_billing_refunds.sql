-- The refund ledger, and the workspace state a refund moves.
--
-- The terms page and the landing hero have promised since launch that an
-- unhappy client gets half the setup fee back within thirty days of going
-- live. No refund code existed: `src/lib/billing/stripe.ts` said only that
-- "refunds [are] handled separately by the team via Stripe dashboard", and
-- the operator console's cancel dialog said the same. Honouring the published
-- guarantee meant an operator opening Stripe, finding the charge, typing an
-- amount, and leaving no record anywhere this product could read. The webhook
-- already ingested `charge.refunded` and did nothing with it, so even the
-- money going back was invisible to the workspace it went back on.
--
-- Two things here.
--
-- `billing_refunds` is the record: who asked, why, on what basis, against
-- which payment intent, and what Stripe said. The reason column is the whole
-- point of the table — a refund outside the guarantee (before launch, after
-- the window, for a different amount) is allowed, and the only thing that
-- makes it allowed is an operator writing down why.
--
-- The unique index on `payment_intent_id` is the idempotency. The operator
-- action inserts the row BEFORE it calls Stripe, so a double-clicked button,
-- a retried POST or a second operator loses the insert on the index and never
-- reaches the refund call. Stripe's own idempotency key (`refund:<intent>`)
-- is the second belt: even a request that somehow got past the row would
-- return the first refund rather than issue a second. One payment intent, one
-- refund, forever — a partial refund followed by a second partial refund on
-- the same intent is deliberately not expressible, because "how much has
-- already gone back on this charge" is exactly the question a hand-run Stripe
-- dashboard could not answer and this table exists to.
--
-- The two workspace columns are what the `charge.refunded` webhook writes, so
-- the operator console and the client dashboard can both see that money went
-- back without either of them calling Stripe.
--
-- NOT tenant readable. The table carries `workspace_id`, so
-- public.tenant_key_tables() sees it and scripts/tenant-table-guard.mjs
-- demands it be classified. It is classified server-only, the same as
-- `stripe_events` and `workspace_billing_profiles`: RLS on, zero policies,
-- every grant to anon and authenticated revoked, service_role only. A client
-- reads their refund in the email we send and on their dashboard, both of
-- which are rendered server-side; nothing needs a browser to reach this row,
-- and an operator's free-text reason is not something a client's session
-- should be able to select. It is listed in SERVER_ONLY_TABLES in
-- apps/flowstarter-main/scripts/verify-rls-local.mjs, which proves the
-- classification on every CI run rather than asserting it here.

create table if not exists public.billing_refunds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Which milestone the money came from. A guarantee refund can span both,
  -- and then it is two rows, one per payment intent.
  milestone text not null,
  -- Stripe's payment intent. The idempotency key and the join key.
  payment_intent_id text not null,
  stripe_refund_id text,
  amount_minor integer not null,
  currency text not null,
  -- The operator's sentence. The audit trail the dashboard never produced.
  reason text not null,
  -- Set only when the refund went outside the published guarantee.
  override_reason text,
  basis text not null,
  -- Clerk user id of whoever pressed the button.
  requested_by text not null,
  status text not null default 'pending',
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.billing_refunds is
  'Every refund this product has issued, why, and on whose authority. One row per Stripe payment intent, enforced by a unique index: that is the idempotency that keeps a retried operator action from refunding twice. Server-only, proved by verify-rls-local.mjs.';
comment on column public.billing_refunds.reason is
  'The operator''s own words. Required for every refund, and the only record of why money went back.';
comment on column public.billing_refunds.override_reason is
  'Set when the refund went outside the published guarantee: before launch, after the window, or for an amount other than the guaranteed percentage.';
comment on column public.billing_refunds.basis is
  'guarantee: the published no-questions-asked refund, inside its window, for its percentage. override: anything else, which requires override_reason.';
comment on column public.billing_refunds.status is
  'pending: the row was claimed and Stripe has not answered yet. succeeded: Stripe issued it. failed: Stripe refused, and failure_reason says what it said.';

alter table public.billing_refunds
  drop constraint if exists billing_refunds_milestone_check;
alter table public.billing_refunds
  add constraint billing_refunds_milestone_check
  check (milestone in ('deposit', 'final'));

alter table public.billing_refunds
  drop constraint if exists billing_refunds_basis_check;
alter table public.billing_refunds
  add constraint billing_refunds_basis_check
  check (basis in ('guarantee', 'override'));

-- An override is only an override if somebody wrote down why.
alter table public.billing_refunds
  drop constraint if exists billing_refunds_override_reason_check;
alter table public.billing_refunds
  add constraint billing_refunds_override_reason_check
  check (
    basis <> 'override'
    or (override_reason is not null and length(btrim(override_reason)) > 0)
  );

alter table public.billing_refunds
  drop constraint if exists billing_refunds_status_check;
alter table public.billing_refunds
  add constraint billing_refunds_status_check
  check (status in ('pending', 'succeeded', 'failed'));

alter table public.billing_refunds
  drop constraint if exists billing_refunds_amount_check;
alter table public.billing_refunds
  add constraint billing_refunds_amount_check
  check (amount_minor > 0);

alter table public.billing_refunds
  drop constraint if exists billing_refunds_reason_check;
alter table public.billing_refunds
  add constraint billing_refunds_reason_check
  check (length(btrim(reason)) >= 8);

-- The idempotency. One refund per payment intent, whatever the caller does.
create unique index if not exists billing_refunds_payment_intent_unique
  on public.billing_refunds (payment_intent_id);

-- The operator's lookup: what has been refunded on this workspace.
create index if not exists billing_refunds_workspace_idx
  on public.billing_refunds (workspace_id, created_at desc);

alter table public.billing_refunds enable row level security;
revoke all on table public.billing_refunds from anon, authenticated;
grant all on table public.billing_refunds to service_role;

-- ─── What the charge.refunded webhook writes on the workspace ──────────────
--
-- The webhook has ingested `charge.refunded` since the ledger was added and
-- has never done anything with it: the switch fell through to `ignored`. With
-- these two columns it has somewhere to put the news, and the operator
-- console and the client dashboard can both see that money went back without
-- either of them calling Stripe.
--
-- `refunded_amount_minor` is monotonic by rule, not by constraint: the
-- handler in the webhook route refuses to write a total lower than the one
-- already stored, the same way `paymentStatusAdvances` refuses to walk a paid
-- deposit back to overdue. A constraint here would turn an out-of-order
-- Stripe delivery into a 500 loop instead of a no-op.

alter table public.workspaces
  add column if not exists refunded_amount_minor integer not null default 0,
  add column if not exists refund_status text not null default 'none';

alter table public.workspaces
  drop constraint if exists workspaces_refund_status_check;
alter table public.workspaces
  add constraint workspaces_refund_status_check
  check (refund_status in ('none', 'partial', 'full'));

comment on column public.workspaces.refunded_amount_minor is
  'Total refunded across every milestone, in minor units, as Stripe''s charge.refunded events report it. Monotonic: the webhook refuses to write a smaller total than the one stored.';
comment on column public.workspaces.refund_status is
  'none: nothing refunded. partial: some of the agreed price went back. full: all of it did. Derived from refunded_amount_minor against the workspace quote by refundStatusFor() in lib/billing/money-state.ts.';
