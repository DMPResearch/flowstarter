-- Widen public.tenant_key_tables()'s inventory (security audit 2026-09-13,
-- Claude M4) — the function scripts/tenant-table-guard.mjs asks to find
-- every table that needs its tenant isolation proved.
--
-- The guard's own header makes the right argument for asking the database
-- instead of asking a list: "this script asks the database instead of
-- asking the list." The bug was that the question it asked the database
-- still had a list in it — three column names:
--
--   a.attname in ('workspace_id', 'project_id', 'claimed_workspace_id')
--
-- A table holding tenant-scoped or personal data under any other key -
-- `clerk_user_id`, `user_id`, `lead_capture_token`, `preview_id`, `site_id`,
-- `booking_id`, `email` - never appeared in the inventory, so the guard
-- could not report it unproved and CI stayed green regardless of whether
-- anyone had actually classified it. Several such tables exist today and
-- are only covered because somebody remembered to hand-add them to
-- SERVER_ONLY_TABLES (profiles, funnel_previews, funnel_assets,
-- stripe_events, discovery_leads, contact_submissions, leads, ...) - the
-- empty ALLOW_LIST read as "everything is proved" when it actually meant
-- "everything the inventory could see is proved".
--
-- This does not change the enforcement shape (still every table caught here
-- must land in TENANT_TABLES, SERVER_ONLY_TABLES or a reasoned ALLOW_LIST
-- entry, or the guard fails CI) - it only widens what the query can see.

create or replace function public.tenant_key_tables()
returns table (table_name text, tenant_columns text[])
language sql
stable
set search_path = pg_catalog, public
as $$
  select c.relname::text,
         array_agg(a.attname::text order by a.attname)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid
  where n.nspname = 'public'
    and c.relkind = 'r'
    and a.attnum > 0
    and not a.attisdropped
    and a.attname in (
      'workspace_id', 'project_id', 'claimed_workspace_id',
      -- Added 2026-09-13 (audit M4): the tenant/personal-data key shapes the
      -- original three missed entirely.
      'clerk_user_id', 'user_id', 'lead_capture_token', 'preview_id',
      'site_id', 'booking_id', 'email'
    )
  group by c.relname
$$;

comment on function public.tenant_key_tables() is
  'Every table in public carrying a tenant or personal-data key column (workspace_id, project_id, claimed_workspace_id, clerk_user_id, user_id, lead_capture_token, preview_id, site_id, booking_id, or email), with the columns it carries. Read by scripts/tenant-table-guard.mjs; returns catalog names only, never table data.';

revoke all on function public.tenant_key_tables() from public, anon, authenticated;
grant execute on function public.tenant_key_tables() to service_role;
