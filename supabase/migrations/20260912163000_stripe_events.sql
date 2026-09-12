-- The Stripe event ledger: what the webhook has actually finished processing.
--
-- Before this table the webhook route was a fire-and-forget switch. It awaited
-- Supabase updates without reading `{ error }`, so a write that failed still
-- fell through to `NextResponse.json({ received: true })` — HTTP 200, which is
-- Stripe's signal to never deliver that event again. A paying customer could
-- therefore stay marked unpaid, or keep a subscription state that had already
-- moved on, with nothing but a log line to say so. Two further gaps came from
-- the same place: a redelivered event re-ran every handler from scratch, and
-- Stripe's at-least-once delivery is unordered, so an older
-- `customer.subscription.updated` could land after a newer one and overwrite
-- the newer state.
--
-- This table is the fix for all three. The route writes a row here BEFORE it
-- processes anything and stamps `processed_at` only after the handler has
-- durably written its state:
--
--   * a row with `processed_at` set  -> redelivery, skip, answer 200
--   * a row with `processed_at` null -> a previous attempt died mid-flight,
--                                       process it again (Stripe is retrying)
--   * no row                         -> first delivery
--
-- and `(object_id, created)` is the ordering record: before applying a
-- subscription or invoice event the route asks what the newest event already
-- applied to that same Stripe object was. Older than that, it is refused
-- ('superseded'). Exactly equal — Stripe's `created` has one-second
-- granularity, so two events in the same second cannot be ordered by it — the
-- route re-fetches the object from Stripe and applies the fetched state, which
-- is the only answer that is true regardless of delivery order.
--
-- NOT TENANT SCOPED, on purpose. Its key is Stripe's event id, and a Stripe
-- object maps to a workspace only through metadata that the event itself
-- carries; several event types (a booking deposit from an anonymous prospect,
-- an invoice for a workspace that was never created) legitimately have no
-- workspace at all, and the row still has to exist so the event is not
-- reprocessed. Adding a nullable `workspace_id` would buy nothing RLS could
-- act on — a null tenant key is not a tenant — and would put the table into
-- `public.tenant_key_tables()`, where the guard would rightly demand a
-- membership policy that cannot be written. It is classified server-only
-- instead, the same as `discovery_leads` and `funnel_previews`: RLS on, zero
-- policies, every grant to anon and authenticated revoked, and it is listed in
-- SERVER_ONLY_TABLES in apps/flowstarter-main/scripts/verify-rls-local.mjs so
-- that classification is proved on every CI run rather than asserted here.

create table if not exists public.stripe_events (
  -- Stripe's own event id (`evt_...`). Primary key: this is the dedup.
  id text primary key,
  type text not null,
  -- `event.created`, as Stripe sent it. The ordering key, not `received_at`:
  -- retries and redeliveries arrive in whatever order the network allows.
  created timestamptz not null,
  -- `event.data.object.id` — `sub_...`, `in_...`, `pi_...`, `cs_...`. The
  -- thing whose state is being changed, and what ordering is compared within.
  object_id text,
  received_at timestamptz not null default now(),
  -- Set only when the handler finished. Null means "not durably processed":
  -- either in flight or a crashed attempt Stripe will retry.
  processed_at timestamptz,
  outcome text,
  -- How many times this event has been delivered to us. A number climbing
  -- past a handful is an event Stripe cannot get us to accept.
  attempts integer not null default 1,
  last_error text
);

comment on table public.stripe_events is
  'Every Stripe webhook event this app has seen, and whether it was durably processed. Dedups redeliveries and orders events per Stripe object. Not tenant scoped: the key is Stripe''s event id and many events carry no workspace at all; classified server-only and proved as such by verify-rls-local.mjs.';
comment on column public.stripe_events.created is
  'event.created from Stripe. The ordering key for events about the same object.';
comment on column public.stripe_events.object_id is
  'event.data.object.id: the subscription, invoice, payment intent or checkout session the event is about.';
comment on column public.stripe_events.processed_at is
  'When the handler finished writing state. Null means the event is unprocessed and Stripe may retry it.';
comment on column public.stripe_events.outcome is
  'processed: state was written. ignored: no handler, or nothing to act on. superseded: a newer event for the same object had already been applied. failed: the handler threw and the route answered 500.';

alter table public.stripe_events
  drop constraint if exists stripe_events_outcome_check;
alter table public.stripe_events
  add constraint stripe_events_outcome_check
  check (outcome is null or outcome in ('processed', 'ignored', 'superseded', 'failed'));

-- A processed event must say when. A failed one must not claim it was.
alter table public.stripe_events
  drop constraint if exists stripe_events_processed_outcome_check;
alter table public.stripe_events
  add constraint stripe_events_processed_outcome_check
  check (
    (processed_at is null and (outcome is null or outcome = 'failed'))
    or (processed_at is not null and outcome in ('processed', 'ignored', 'superseded'))
  );

-- The ordering lookup: newest applied event for one Stripe object.
create index if not exists stripe_events_object_created_idx
  on public.stripe_events (object_id, created desc)
  where object_id is not null and processed_at is not null;

-- The operator's lookup: what is stuck.
create index if not exists stripe_events_unprocessed_idx
  on public.stripe_events (received_at desc)
  where processed_at is null;

-- Server-only: RLS on, no policies, and the deny made explicit at the grant
-- level too, exactly as 20260829090200_server_only_tables_explicit_grants.sql
-- does for the rest. A future policy on this table then has to be paired with
-- a deliberate grant; it cannot ride on one nobody meant to leave open.
alter table public.stripe_events enable row level security;
revoke all on table public.stripe_events from anon, authenticated;
grant all on table public.stripe_events to service_role;
