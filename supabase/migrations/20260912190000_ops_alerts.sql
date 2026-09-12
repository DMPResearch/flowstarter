-- Operator alerting: a durable dedupe ledger for `src/lib/ops/alerts.ts`.
--
-- Three places raise an alert today: the build worker when a job ends
-- `failed`, `notifyClientOnce` when a client email fails to send, and the
-- production synthetic's health check (that last one files a GitHub issue
-- instead of writing here, see .depot/workflows/prod-synthetic.yml). Without
-- somewhere durable to remember "we already told the operator about this",
-- every one of those would resend on every occurrence: a build worker that
-- retries a doomed job every few minutes would page the operator every few
-- minutes, forever.
--
-- This table is that memory. One row per `dedupe_key` (see
-- `src/lib/ops/alerts.ts`'s `dedupeKey()`), upserted on every occurrence and
-- only ever emailed again once the event's dedupe window has elapsed.
--
-- SERVER-ONLY, same reasoning as `funnel_previews` and `discovery_leads`
-- above it: RLS is on with zero policies (an absent policy is a deny) and the
-- grants below make that deny explicit rather than inherited. `workspace_id`
-- is nullable because a `health_check_failed` alert belongs to no tenant at
-- all, and even a `build_job_failed` alert must still exist if the workspace
-- it names is later deleted — the alert is history, not a live pointer.

create table if not exists public.ops_alerts (
  id uuid primary key default gen_random_uuid(),

  -- `event:discriminator`, e.g. `build_job_failed:<job id>` or
  -- `client_email_failed:<workspace id>/<notification>/<dedupe key>`. The
  -- unique constraint is the dedupe: a second occurrence within the window
  -- updates this row instead of creating a new one.
  dedupe_key text not null unique,

  event text not null
    check (event in ('build_job_failed', 'client_email_failed', 'health_check_failed')),
  severity text not null
    check (severity in ('critical', 'warning')),

  title text not null,
  detail jsonb not null default '{}'::jsonb,

  -- Set for events with a tenant; null for a platform-wide event like
  -- `health_check_failed`. `on delete set null` because the alert is a record
  -- of what happened, which outlives the workspace it happened to.
  workspace_id uuid references public.workspaces(id) on delete set null,

  occurrence_count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_sent_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ops_alerts is
  'Dedupe ledger for operator alerts raised by src/lib/ops/alerts.ts (send-ops-alert.ts). One row per dedupe_key; last_sent_at is what the dedupe window in alerts.ts is measured against. Server-only.';
comment on column public.ops_alerts.dedupe_key is
  'event:discriminator, unique. A second occurrence within the event''s dedupe window updates this row rather than sending a second email.';
comment on column public.ops_alerts.last_sent_at is
  'When an email was last actually sent for this key. Occurrences inside the dedupe window still bump occurrence_count but do not move this.';

create index if not exists ops_alerts_workspace_id_idx
  on public.ops_alerts (workspace_id)
  where workspace_id is not null;

create index if not exists ops_alerts_event_idx
  on public.ops_alerts (event);

-- `updated_at` is maintained by the database, same pattern as
-- funnel_previews_set_updated_at in 20260830160000_funnel_previews.sql.
create or replace function public.ops_alerts_set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ops_alerts_set_updated_at on public.ops_alerts;
create trigger ops_alerts_set_updated_at
  before update on public.ops_alerts
  for each row
  execute function public.ops_alerts_set_updated_at();

alter table public.ops_alerts enable row level security;

revoke all on table public.ops_alerts from anon, authenticated;
grant all on table public.ops_alerts to service_role;
