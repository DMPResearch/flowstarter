-- A per-workspace version for the Stripe webhook's money-state writes, so
-- they can be a compare-and-set instead of an unconditioned update.
--
-- The Stripe event ledger (`stripe_events`, see
-- 20260912163000_stripe_events.sql) deliberately allows two genuinely
-- concurrent deliveries of *different* events for the same Stripe object to
-- both run — it is not a lease. Both read the workspace's money state,
-- evaluate the pure transition rules in `lib/billing/money-state.ts` against
-- it, and used to write through an update filtered only by workspace id.
-- Whichever write reached Postgres last won, even when it was the
-- chronologically OLDER event, silently regressing state a moment newer.
--
-- `casUpdateWorkspaceMoneyState` (apps/flowstarter-main/src/lib/billing/
-- workspace-money-write.ts) closes that gap: every money-state write is
-- conditioned on `billing_version` still being what it was when the write's
-- decision was made, and bumps it. A concurrent write that landed first
-- makes the second one's compare-and-set match zero rows instead of
-- overwriting; that call rereads and re-evaluates against what is now
-- actually stored.

alter table public.workspaces
  add column if not exists billing_version integer not null default 0;

comment on column public.workspaces.billing_version is
  'Bumped by every write in casUpdateWorkspaceMoneyState. The Stripe webhook conditions each money-state update on this still matching the value it read, so two events for the same object cannot race an unconditioned write and let the older one overwrite the newer.';
