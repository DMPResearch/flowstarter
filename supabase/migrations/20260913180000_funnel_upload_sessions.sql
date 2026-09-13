-- A server-issued, short-lived session for anonymous funnel uploads
-- (Codex audit F14).
--
-- Before this, an upload to `funnel_assets` was keyed only on a preview id
-- the client itself supplied — a v4 UUID it could generate and never use
-- again. Two problems followed:
--
--   1. `storeFunnelAsset`'s per-preview cap was a read-then-insert: a
--      `select count(*)` followed by a separate `insert`, which two
--      concurrent uploads for the same preview id can both pass before
--      either lands, exceeding the cap.
--   2. The reaper only ever swept previews that made it into
--      `funnel_previews`. An upload that never became a preview — the
--      visitor uploads a logo, then abandons the wizard — has no row there
--      to expire, so nothing ever reaped it. A fresh UUID per attempt makes
--      this unlimited: unclaimed pictures and their storage objects
--      accumulate forever.
--
-- This table is the fix for both. One row per preview id, created by the
-- server (via `reserve_funnel_upload_slot` below) the first time it sees an
-- upload for that id, carrying its own short TTL independent of whether a
-- `funnel_previews` row ever appears. The reaper sweeps rows whose TTL has
-- passed and, for any that never became a real preview, deletes the
-- `funnel_assets` rows and storage objects they were reserving quota for —
-- see `reapExpiredFunnelUploadSessions` in
-- apps/flowstarter-main/src/lib/flowstarter/funnel-assets.ts.

create table if not exists public.funnel_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  -- One session per preview id. No foreign key to `funnel_previews`, for the
  -- same reason `funnel_assets.preview_id` has none: this row is created
  -- specifically because the preview does not exist yet.
  preview_id uuid not null unique,
  -- How many of `max_assets` this session has reserved. Only ever advanced
  -- by `reserve_funnel_upload_slot`'s atomic update, never by application
  -- code reading and writing it directly.
  assets_reserved integer not null default 0,
  max_assets integer not null,
  created_at timestamptz not null default now(),
  -- Independent of `funnel_previews.expires_at`: this bounds how long an
  -- upload may sit with no preview built from it at all, which is meant to
  -- be a much shorter window than a generated preview's own TTL.
  expires_at timestamptz not null
);

-- The reaper's sweep: sessions whose TTL has passed, oldest first.
create index if not exists funnel_upload_sessions_expires_idx
  on public.funnel_upload_sessions (expires_at);

comment on table public.funnel_upload_sessions is
  'Server-issued quota session for anonymous funnel uploads, one per preview id, reaped independently of funnel_previews so an upload that never became a preview cannot accumulate forever.';
comment on column public.funnel_upload_sessions.assets_reserved is
  'Advanced only by reserve_funnel_upload_slot()''s atomic conditional update — the compare-and-set that replaces the old read-then-insert count check.';

alter table public.funnel_upload_sessions enable row level security;

-- No policies, same protection as funnel_assets and funnel_previews: RLS on
-- with nothing granted is the deny. A preview id is the capability; nobody
-- reads or writes this table except the service role behind a route that
-- already knows it.
revoke all on table public.funnel_upload_sessions from anon, authenticated;
grant all on table public.funnel_upload_sessions to service_role;

-- ─── Atomic reservation ─────────────────────────────────────────────────────
--
-- Finds or creates the session for `p_preview_id`, then attempts to advance
-- its `assets_reserved` counter, both inside one statement per step so two
-- concurrent callers for the same preview id cannot both observe room for a
-- slot that only one of them can actually have. `on conflict ... do update`
-- and the guarded `update` below each take Postgres's own row lock on the
-- session, which is what a `select count(*)` followed by a separate
-- `insert` never had.
create or replace function public.reserve_funnel_upload_slot(
  p_preview_id uuid,
  p_max_assets integer,
  p_ttl_seconds integer
) returns table (session_id uuid, reserved boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_reserved boolean;
begin
  insert into public.funnel_upload_sessions (preview_id, max_assets, expires_at)
  values (
    p_preview_id,
    p_max_assets,
    now() + make_interval(secs => p_ttl_seconds)
  )
  on conflict (preview_id) do update
    -- An active session's expiry moves out on every reservation attempt, so
    -- a visitor mid-upload does not have their session expire under them;
    -- `max_assets` is refreshed too, so a config change applies to a
    -- session already in flight rather than only to new ones.
    set expires_at = greatest(
          public.funnel_upload_sessions.expires_at,
          now() + make_interval(secs => p_ttl_seconds)
        ),
        max_assets = p_max_assets
  returning id into v_session_id;

  update public.funnel_upload_sessions
    set assets_reserved = assets_reserved + 1
    where id = v_session_id
      and assets_reserved < max_assets
  returning true into v_reserved;

  return query select v_session_id, coalesce(v_reserved, false);
end;
$$;

comment on function public.reserve_funnel_upload_slot is
  'Atomically finds-or-creates the upload session for a preview id and attempts to reserve one of its quota slots. Returns reserved=false without writing anything else when the session is already at max_assets.';

revoke all on function public.reserve_funnel_upload_slot(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_funnel_upload_slot(uuid, integer, integer) to service_role;
