-- Portraits from the client's own social pages.
--
-- Darius asked for one thing: the portrait picture should be loaded by
-- Flowstarter from his social pages rather than asked for again. Measured on
-- 2026-09-13, the honest answer is that only two networks will hand over a
-- full-size picture, and only when the person themselves presses a button:
-- LinkedIn through "Sign In with LinkedIn using OpenID Connect", and Instagram
-- through the Instagram API with Instagram Login. Everything else is either
-- public by the publisher's own choice (a GitHub avatar, an image on the
-- client's own site, Instagram's 100x100 OpenGraph picture) or is behind a
-- login and therefore not ours to take.
--
-- This migration adds the three things that difference needs in the database.
--
--   1. PROVENANCE on the two asset tables. A picture we downloaded from a
--      provider is not the same object as a file a client uploaded, and six
--      months from now the only way anybody will be able to tell is if the row
--      says where it came from and when. `assets.source_url` already existed;
--      `funnel_assets` had no equivalent, and neither table recorded the time
--      of the fetch.
--
--   2. THE SOURCE VOCABULARY, widened. `funnel_assets.source` already knew
--      `instagram` and `linkedin`; it gains `github`. `assets.source` knew
--      none of the three and collapsed them all to `social` on claim, which
--      threw away exactly the fact a rights complaint would ask about. It now
--      accepts all three, so provenance survives the claim rather than being
--      rounded off at it.
--
--   3. THE CONNECTION ITSELF, in `portrait_connections`: one row per person
--      per provider, holding the picture we filed, their name, their headline
--      and the moment they authorised it. Kept separate from the asset row
--      because a connection is an event between us and a person, while an
--      asset is a file; a reconnect replaces the picture and must not lose the
--      record that the first authorisation happened.
--
-- SERVER-ONLY, deliberately, and the reasoning is the one `funnel_assets`
-- already carries. A connection is minted at the top of the funnel, where the
-- visitor is anonymous: there is no workspace, no membership row and no Clerk
-- session, so `workspace_id` is nullable and, when it is set, it is the
-- connection's eventual home rather than the thing that authorises reading it.
-- There is no tenant key a policy could usefully filter on for the anonymous
-- half, so the protection is the same one `funnel_previews` and `funnel_assets`
-- use and is enforced the same way: RLS on with zero policies, every grant to
-- `anon` and `authenticated` revoked, and the only reader is the service role
-- behind a route that already holds the connection id. Registered as such in
-- apps/flowstarter-main/scripts/verify-rls-local.mjs, which is what proves it.
--
-- Nothing here is loosened and nothing is destructive: every statement adds a
-- column, widens a check, or creates a table, and every one is guarded so a
-- re-run is a no-op.

-- ─── 1. Provenance on funnel_assets ────────────────────────────────────────

alter table public.funnel_assets
  add column if not exists source_url text;

alter table public.funnel_assets
  add column if not exists fetched_at timestamptz;

comment on column public.funnel_assets.source_url is
  'The provider URL the bytes were downloaded from, for a picture we fetched. Null for a file the visitor uploaded, which is the distinction a rights question turns on.';
comment on column public.funnel_assets.fetched_at is
  'When we downloaded it. Null for an upload. A provider picture URL expires, so this is the only record of what the account looked like at the time.';

-- `github` joins `instagram` and `linkedin` as a network a picture can be read
-- from. A GitHub avatar is public at 460px and needs no credential, which
-- makes it the best of the three automatic sources.
alter table public.funnel_assets
  drop constraint if exists funnel_assets_source_check;
alter table public.funnel_assets
  add constraint funnel_assets_source_check
  check (source in ('upload', 'generated', 'og', 'gbp', 'old_site', 'social',
                    'instagram', 'linkedin', 'github'));

-- ─── 2. Provenance on assets, and a source vocabulary that survives the claim ─

alter table public.assets
  add column if not exists fetched_at timestamptz;

comment on column public.assets.fetched_at is
  'When we downloaded the bytes, for an asset we fetched rather than one the client sent. Carried verbatim from funnel_assets on claim.';

-- Before this, claiming a funnel picture rounded `instagram` down to `social`,
-- so the workspace kept the file and lost the answer to "where did this come
-- from". The check now accepts what funnel_assets already distinguished.
alter table public.assets
  drop constraint if exists assets_source_check;
alter table public.assets
  add constraint assets_source_check
  check (source in ('upload', 'generated', 'og', 'gbp', 'old_site', 'social',
                    'instagram', 'linkedin', 'github'));

-- ─── 3. portrait_connections ───────────────────────────────────────────────

create table if not exists public.portrait_connections (
  id uuid primary key default gen_random_uuid(),
  -- Which provider authorised us. Only the two that can be authorised: the
  -- automatic sources are not connections, they are requests we made.
  provider text not null check (provider in ('linkedin', 'instagram')),
  -- The provider's own id for the account, so a reconnect updates this row
  -- rather than leaving two rows disagreeing about one person.
  provider_account_id text not null,
  -- The funnel preview this belongs to, before anybody is anybody. No foreign
  -- key, for the same reason funnel_assets has none: the connection is
  -- frequently made at the links question, before the preview row exists.
  preview_id uuid,
  -- Set once there is a workspace. Exactly one of the two is meaningful at a
  -- time; the claim is what moves a connection from the first to the second.
  workspace_id uuid references public.workspaces(id) on delete cascade,
  -- What the provider told us about the person. Only these two: a picture, a
  -- name and a line of their own prose is the whole of what the site needs,
  -- and a token that could fetch more is a liability with no use.
  display_name text,
  headline text,
  -- The provider URL the picture was downloaded from, and when.
  picture_url text,
  picture_width integer,
  picture_height integer,
  fetched_at timestamptz,
  -- The picture as we filed it, in whichever half of the pipeline applied.
  funnel_asset_id uuid,
  asset_id uuid,
  -- The load-bearing column. A connection is consent: the person went to the
  -- provider, saw what we were asking for, and approved it, so the connect
  -- action itself writes this rather than waiting for a second question they
  -- have already answered. An automatic source writes nothing here and the
  -- client taps "Use this" on the brief instead.
  rights_confirmed_at timestamptz,
  rights_statement_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One connection per account per preview, and one per account per workspace.
-- Partial, because exactly one of the two keys is set on any given row.
create unique index if not exists portrait_connections_preview_account_unique
  on public.portrait_connections (preview_id, provider, provider_account_id)
  where preview_id is not null;

create unique index if not exists portrait_connections_workspace_account_unique
  on public.portrait_connections (workspace_id, provider, provider_account_id)
  where workspace_id is not null;

-- The callback's lookup: the row the signed state named.
create index if not exists portrait_connections_preview_idx
  on public.portrait_connections (preview_id, created_at desc)
  where preview_id is not null;

comment on table public.portrait_connections is
  'One row per person per provider who authorised Flowstarter to use their profile picture, through LinkedIn OpenID Connect or the Instagram API with Instagram Login. Server-only: minted while the visitor is still anonymous, so workspace_id is nullable and is the connection''s eventual home rather than the key that authorises reading it.';
comment on column public.portrait_connections.rights_confirmed_at is
  'Written by the connect action itself, because the person authorised it at the provider. An automatic source leaves this null until the client taps Use this on the brief.';
comment on column public.portrait_connections.headline is
  'The line of their own prose the provider returned. LinkedIn''s standard OpenID Connect claims do not include one and Instagram has none, so empty is the normal case.';

create or replace function public.touch_portrait_connections_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists portrait_connections_touch_updated_at
  on public.portrait_connections;
create trigger portrait_connections_touch_updated_at
  before update on public.portrait_connections
  for each row execute function public.touch_portrait_connections_updated_at();

alter table public.portrait_connections enable row level security;

-- No policies. RLS on with nothing granted is the deny, and it is the whole
-- protection for this table: see the note at the top for why there is no
-- tenant key to write a policy against for the anonymous half. A future policy
-- has to be paired with a deliberate grant; it cannot ride on one nobody meant
-- to leave open.
revoke all on table public.portrait_connections from anon, authenticated;
grant all on table public.portrait_connections to service_role;
