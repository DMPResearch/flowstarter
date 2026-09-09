-- Tenant isolation hardening - closing the gap between what a policy allows
-- and what a grant allows.
--
-- The audit behind this migration walked every table in `public`, every
-- policy, every grant held by `anon`, `authenticated` and `service_role`, and
-- every EXECUTE privilege on the helper functions the policies call. Row level
-- security is on everywhere, and no table was found where a member of one
-- workspace could read another workspace's rows. What was found instead is a
-- second, quieter class of defect: tables and functions whose PostgreSQL
-- privileges are far wider than the policy set that is actually meant to
-- govern them.
--
-- That matters because a grant is what a future policy rides on. Today
-- `selfserve_projects` has RLS on and zero policies, so the `all privileges`
-- that `anon` holds on it buys nothing: an absent policy is a deny. The day
-- somebody adds a single `select` policy to that table for a good reason, the
-- insert, update and delete grants that nobody meant to leave open become
-- live. The deny has to be explicit at the grant level too, which is the same
-- argument 20260829090200_server_only_tables_explicit_grants.sql made, applied
-- to the tables that migration did not name and the ones created since.
--
-- Nothing here is loosened. Every statement either removes a privilege or
-- narrows a policy's role list. The patterns are the ones already in use:
-- membership through public.is_workspace_member(uuid), server-only tables
-- revoked from anon and authenticated and granted to service_role.
--
-- Guarded with to_regclass throughout so a table absent from a given
-- environment is a no-op rather than a failure.

-- ─── 1. Helper functions: anon keeps EXECUTE it was never granted ──────────
--
-- 20260829090100 wrote `revoke all on function ... from public` and then
-- granted EXECUTE to `authenticated, service_role`. That reads like a
-- lock-down and is not one. Supabase's bootstrap runs
--
--   alter default privileges in schema public grant execute on functions
--     to anon, authenticated, service_role;
--
-- so `anon` holds EXECUTE in its own right, as a named grantee. Revoking from
-- PUBLIC does not touch a named grantee's grant, so anon kept it, on all
-- three helpers, in every environment.
--
-- No row leaks through this. public.current_clerk_user_id() reads the `sub`
-- claim, which an anon key does not carry, so public.is_workspace_member()
-- answers false for every workspace an anon caller can name. What anon loses
-- here is the ability to call the membership oracle at all: without the
-- revoke, an anon key can ask "is anybody a member of this workspace id"
-- once per guessed uuid, and the shape of the answer is a probe surface that
-- has no reason to exist.

revoke execute on function public.current_clerk_user_id() from anon;
revoke execute on function public.is_workspace_member(uuid) from anon;
revoke execute on function public.tenant_path_workspace_id(text) from anon;

-- The two `set_updated_at` triggers are called by the trigger machinery, never
-- by a client, and they still carry the default PUBLIC EXECUTE they were
-- created with. A trigger function does not need to be callable to fire.
revoke all on function public.funnel_previews_set_updated_at() from public, anon, authenticated;
revoke all on function public.custom_inquiries_set_updated_at() from public, anon, authenticated;

-- ─── 2. flowstarter_change_requests: a policy for PUBLIC, and anon's grant ─
--
-- 20260908130000 created change_requests_select_members without a `to` clause.
-- Postgres defaults that to PUBLIC, so the policy's role list is `{}` where
-- every sibling policy written the same day reads `{authenticated}`. Paired
-- with the SELECT that `anon` holds from the default privileges, an anon key
-- reaches the table and is evaluated against the policy rather than being
-- refused at the door.
--
-- It returns nothing today, for the same reason as above: no `sub` claim, no
-- membership, no rows. But "the policy happens to be false for anon" is a
-- weaker guarantee than "anon has no grant and the policy does not apply to
-- it", and the table holds quotes, Stripe session ids and payment intent ids.
-- Recreated `to authenticated`, matching its siblings exactly.

do $$
begin
  if to_regclass('public.flowstarter_change_requests') is not null then
    drop policy if exists change_requests_select_members on public.flowstarter_change_requests;
    create policy change_requests_select_members
      on public.flowstarter_change_requests for select to authenticated
      using (public.is_workspace_member(workspace_id));

    revoke all on table public.flowstarter_change_requests from anon, authenticated;
    grant select on table public.flowstarter_change_requests to authenticated;
    grant all on table public.flowstarter_change_requests to service_role;
  end if;
end
$$;

-- ─── 3. workspaces / workspace_memberships: read-only policies, all-verb grants
--
-- Both carry exactly one policy, both `for select`. Both also carry the full
-- default grant set for `anon` and `authenticated`: INSERT, UPDATE, DELETE,
-- TRUNCATE and REFERENCES as well as SELECT. RLS denies the writes today,
-- because there is no insert, update or delete policy to permit them, so this
-- is the same shape as everything else in this migration: a deny that rests on
-- an absence rather than on a privilege.
--
-- `workspaces` is the tenant itself and `workspace_memberships` is what
-- membership means. A write grant on either is the one grant that must never
-- be able to ride on a future policy: an authenticated caller who could insert
-- a workspace_memberships row would be granting themselves membership, and
-- every policy in the schema is keyed on that table.
--
-- Narrowed to exactly what the policies allow: SELECT for authenticated,
-- nothing at all for anon.

do $$
begin
  if to_regclass('public.workspaces') is not null then
    revoke all on table public.workspaces from anon, authenticated;
    grant select on table public.workspaces to authenticated;
    grant all on table public.workspaces to service_role;
  end if;

  if to_regclass('public.workspace_memberships') is not null then
    revoke all on table public.workspace_memberships from anon, authenticated;
    grant select on table public.workspace_memberships to authenticated;
    grant all on table public.workspace_memberships to service_role;
  end if;
end
$$;

-- ─── 4. Server-only tables the earlier sweep did not name ──────────────────
--
-- Every table below has RLS enabled and zero policies, which is the definition
-- of server-only in this schema, and every one of them still holds the full
-- default grant set for `anon` and `authenticated`. Three of them carry a
-- tenant key and were simply missed by 20260829090200's hand-written list;
-- the five selfserve_* tables were created afterwards, by
-- 20260611000000_init_schema.sql, whose own header says they are "accessed
-- exclusively with the service role from the selfserve app's server routes".
-- This makes that sentence true at the privilege level.
--
--   client_constraint_profiles  workspace_id, the editor's per-tenant guardrails
--   workspace_hosts             workspace_id, which Hetzner host serves a site
--   workspace_billing_profiles  workspace_id, company name, VAT id, address
--   selfserve_projects          clerk_user_id, email, client_ip
--   selfserve_builds            project_id, agent build feed
--   selfserve_payments          project_id, Stripe session and intent ids
--   selfserve_leads             email, business description
--   selfserve_rate_limits       the demo cap buckets
--
-- The selfserve set has no tenant model at all: there is no workspace and no
-- membership behind any of it, only a clerk_user_id on selfserve_projects that
-- nothing keys on. Until that changes there is no policy to write, and
-- service-role-only is the honest classification rather than an interim one.
--
-- selfserve_rate_limits earns the revoke twice over: an anon key with UPDATE
-- on it could reset a bucket's count and defeat the demo cap that
-- public.selfserve_bump_rate_limit() exists to enforce.

do $$
declare
  t text;
  server_only_tables text[] := array[
    'client_constraint_profiles',
    'workspace_hosts',
    'workspace_billing_profiles',
    'selfserve_projects',
    'selfserve_builds',
    'selfserve_payments',
    'selfserve_leads',
    'selfserve_rate_limits'
  ];
begin
  foreach t in array server_only_tables loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on table public.%I from anon, authenticated', t);
      execute format('grant all on table public.%I to service_role', t);
    end if;
  end loop;
end
$$;

-- ─── 5. Re-run the earlier sweep, so a table added to it later still lands ─
--
-- 20260829090200 revoked from a fixed list of fourteen tables. Every one of
-- them is still server-only and still revoked; this repeats the statements so
-- that a table created between then and now under the same classification
-- cannot be left behind by a migration that has already run everywhere.

do $$
declare
  t text;
  server_only_tables text[] := array[
    'demo_generation_costs',
    'demo_edit_counters',
    'discovery_leads',
    'custom_inquiries',
    'leads',
    'contact_submissions',
    'ai_audit_logs',
    'hosting_servers',
    'deployments',
    'editor_sessions',
    'setup_payment_milestones',
    'vault_encrypted_secrets',
    'commerce_products',
    'profiles',
    'llm_usage',
    'flowstarter_agent_jobs',
    'flowstarter_agent_job_events',
    'flowstarter_project_artifacts',
    'funnel_previews'
  ];
begin
  foreach t in array server_only_tables loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on table public.%I from anon, authenticated', t);
      execute format('grant all on table public.%I to service_role', t);
    end if;
  end loop;
end
$$;

-- ─── 6. The inventory the static guard reads ──────────────────────────────
--
-- apps/flowstarter-main/scripts/tenant-table-guard.mjs fails CI when a table
-- in `public` carries a tenant key and is named by neither list at the top of
-- scripts/verify-rls-local.mjs. To do that it has to enumerate the schema, and
-- PostgREST does not expose information_schema. This function is how it asks.
--
-- It reads pg_catalog, which every role can read anyway, and returns nothing
-- but relation and column names: no row of any table passes through it. It is
-- not security definer, and EXECUTE is granted to service_role alone, so the
-- guard runs with the same key the verifier's fixture uses and no browser
-- session can call it.

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
    and a.attname in ('workspace_id', 'project_id', 'claimed_workspace_id')
  group by c.relname
$$;

comment on function public.tenant_key_tables() is
  'Every table in public carrying workspace_id, project_id or claimed_workspace_id, with the columns it carries. Read by scripts/tenant-table-guard.mjs; returns catalog names only, never table data.';

revoke all on function public.tenant_key_tables() from public, anon, authenticated;
grant execute on function public.tenant_key_tables() to service_role;
