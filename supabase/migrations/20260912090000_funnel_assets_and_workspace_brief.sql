-- The two halves of the in-depth brief.
--
-- The intake was one long conversation that ended in a preview. It now has a
-- seam in it: a short conversation before the preview, and the real material
-- after the deposit. That seam is why there are two tables here rather than
-- one, and why only one of them is tenant scoped.
--
--   funnel_assets      a picture a visitor uploaded before any workspace
--                      existed. There is no tenant to scope it to yet, so it
--                      is keyed on the preview id and is server-only.
--   workspace_briefs   everything the client fills in after paying. A
--                      workspace exists by then, so this is an ordinary
--                      tenant table with the house RLS on it.
--
-- The bridge between them is the claim: a funnel asset is copied into `assets`
-- under the new workspace, rights confirmation and all, and the funnel row is
-- marked claimed. See `claim.ts`.

-- ─── funnel_assets ─────────────────────────────────────────────────────────
-- A visitor can hand us one picture before the preview: a logo, or a profile
-- photo, for when Instagram and LinkedIn will not show us anything and the
-- palette would otherwise come from tone chips alone.
--
-- WHY THIS TABLE IS NOT TENANT SCOPED, deliberately and with the same reason
-- `funnel_previews` carries: at upload time the visitor is anonymous. There is
-- no workspace, no membership row and no Clerk user to check, so there is no
-- tenant key to filter on and nothing RLS could usefully say. The protection
-- is therefore the same one `funnel_previews` uses and is enforced the same
-- way: RLS is on with zero policies, every grant to `anon` and `authenticated`
-- is revoked, and the only reader is the service role behind a route that
-- knows the preview id. A preview id is a v4 UUID that is never listed
-- anywhere, so holding one is the capability.
--
-- The shape mirrors `assets` on purpose. On claim the row is copied across
-- field for field, so a divergence here is a lossy claim later.

create table if not exists public.funnel_assets (
  id uuid primary key default gen_random_uuid(),
  -- The funnel preview this upload belongs to. No foreign key: the picture is
  -- frequently uploaded before the preview row exists (the visitor answers the
  -- links question, we fail to read Instagram, they upload, and only then does
  -- generation start and write `funnel_previews`).
  preview_id uuid not null,
  -- Mirrors assets.source, plus the two networks a picture can be read from.
  -- `instagram` and `linkedin` are kept distinct from the generic `social`
  -- because provenance is the whole question for these: a picture we fetched
  -- from somebody's public profile is not a picture they handed us, and the
  -- claim page has to be able to name which one it is asking about.
  source text not null default 'upload'
    check (source in ('upload', 'generated', 'og', 'gbp', 'old_site', 'social',
                      'instagram', 'linkedin')),
  -- `logo` or `photo`. The visitor tells us which, or we read it from a
  -- profile; it decides whether the picture is read for a palette only or may
  -- also be placed on the site.
  kind text check (kind in ('logo', 'photo')),
  storage_path text,
  sha256 text,
  mime text,
  width integer,
  height integer,
  dominant_colors text[],
  usable_for text[] not null default '{}',
  -- The rights half, carried over verbatim on claim. A picture without a
  -- confirmation is readable for a palette and publishable nowhere.
  rights_confirmed_at timestamptz,
  rights_statement_version text,
  rights_ip text,
  rights_user_agent text,
  -- Set when the claim has copied this row into `assets`. Kept rather than
  -- deleted so a redelivered claim is idempotent instead of duplicating.
  claimed_workspace_id uuid references public.workspaces(id) on delete set null,
  claimed_asset_id uuid,
  created_at timestamptz not null default now()
);

-- One row per identical file per preview: a visitor who uploads the same
-- picture twice gets one row, the same way `assets` dedupes per workspace.
create unique index if not exists funnel_assets_preview_sha256_unique
  on public.funnel_assets (preview_id, sha256)
  where sha256 is not null;

create index if not exists funnel_assets_preview_idx
  on public.funnel_assets (preview_id, created_at desc);

-- The reaper's sweep: unclaimed rows, oldest first.
create index if not exists funnel_assets_unclaimed_idx
  on public.funnel_assets (created_at)
  where claimed_workspace_id is null;

comment on table public.funnel_assets is
  'Pictures uploaded during the funnel, before a workspace exists. Keyed on the preview id because there is no tenant to scope them to yet; server-only for exactly that reason. Copied into public.assets on claim and deleted with the preview by the reaper.';
comment on column public.funnel_assets.claimed_workspace_id is
  'Set once the row has been copied into public.assets. Makes a repeated claim idempotent rather than duplicating the asset.';

alter table public.funnel_assets enable row level security;

-- No policies. RLS on with nothing granted is the deny, and it is the whole
-- protection for this table: see the note above on why there is no tenant key
-- to write a policy against.
revoke all on table public.funnel_assets from anon, authenticated;
grant all on table public.funnel_assets to service_role;

-- ─── workspace_briefs ──────────────────────────────────────────────────────
-- The in-depth brief, filled in on the client dashboard after the deposit.
--
-- One row per workspace. `projects` is jsonb rather than a child table because
-- it is a small ordered list that is always read and written whole, by one
-- form, and a child table would buy a join and a second set of policies for
-- no query anyone runs.

create table if not exists public.workspace_briefs (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  -- What they sell, in their own words. The pre-preview intake collects a
  -- sentence or two; this is where the longer version lands.
  offer text not null default '',
  -- [{ name, line, link, screenshotAssetIds: [uuid] }]. Validated in the API
  -- route before it is written; the column is jsonb, not a schema.
  projects jsonb not null default '[]'::jsonb,
  -- True when the client has said, explicitly, that they have no past work to
  -- show. This is not the same as an empty `projects` array, which only means
  -- they have not filled it in yet, and the difference is the whole reason the
  -- readiness rule can tell "not asked" from "asked and answered".
  no_projects boolean not null default false,
  -- assets.id lists. Screens they like, and their own photographs.
  design_reference_asset_ids uuid[] not null default '{}',
  photo_asset_ids uuid[] not null default '{}',
  -- The derived palette and tone, as the brand step produced them.
  palette jsonb not null default '{}'::jsonb,
  tone jsonb not null default '{}'::jsonb,
  -- Set by the readiness rule when nothing blocking is outstanding. The build
  -- worker will not start an agent pass while this is null.
  ready_at timestamptz,
  -- An operator saying "build it anyway". Read by the worker as an override of
  -- `ready_at`, and recorded with who and why in project_events.
  override_at timestamptz,
  override_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workspace_briefs_ready_idx
  on public.workspace_briefs (ready_at)
  where ready_at is null;

comment on table public.workspace_briefs is
  'The in-depth brief a client fills in after the deposit: offer, real projects, design references and photographs. ready_at is written by the deterministic readiness rule in lib/flowstarter/brief-readiness.ts and is what the build worker waits on.';
comment on column public.workspace_briefs.no_projects is
  'Explicitly "I have no past work to show". Distinct from an empty projects array, which only means the question has not been answered.';
comment on column public.workspace_briefs.override_at is
  'An operator started the build without a complete brief. Overrides ready_at for the worker.';

create or replace function public.workspace_briefs_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists workspace_briefs_set_updated_at on public.workspace_briefs;
create trigger workspace_briefs_set_updated_at
  before update on public.workspace_briefs
  for each row execute function public.workspace_briefs_set_updated_at();

alter table public.workspace_briefs enable row level security;

drop policy if exists workspace_briefs_select_members on public.workspace_briefs;
create policy workspace_briefs_select_members
  on public.workspace_briefs for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- Writes stay with the service role behind /api/client/brief/[workspaceId],
-- which does the validation the jsonb columns cannot. The absence of an
-- insert/update/delete policy is the deny, and `ready_at` / `override_at` are
-- kept out of a member's reach by the column grant below: a client who could
-- write their own readiness flag could start a build on an empty brief.
revoke all on table public.workspace_briefs from anon, authenticated;
grant select (
  workspace_id, offer, projects, no_projects,
  design_reference_asset_ids, photo_asset_ids, palette, tone,
  ready_at, created_at, updated_at
) on table public.workspace_briefs to authenticated;
grant all on table public.workspace_briefs to service_role;
