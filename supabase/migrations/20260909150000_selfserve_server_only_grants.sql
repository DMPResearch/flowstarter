-- Re-run the selfserve_* server-only grant sweep, because migration order is
-- not guaranteed across environments.
--
-- 20260909143500_tenant_isolation_hardening.sql section 4 revokes anon and
-- authenticated from eight server-only tables, five of them selfserve_*,
-- guarded by to_regclass so a missing table is a no-op rather than a
-- failure. On any database where that migration's timestamp sorts before
-- 20260611000000_init_schema.sql but runs after it chronologically —
-- production is exactly this case, since the self-serve baseline is still
-- pending there and sorts ahead of eleven migrations already applied — the
-- five to_regclass checks for the not-yet-created selfserve_* tables pass as
-- no-ops, and init_schema later creates the tables with Supabase's default
-- grants, including UPDATE on selfserve_rate_limits for the anon key.
--
-- This migration re-applies exactly the same statements for exactly the same
-- five tables, unconditionally at the end of the migration list, so the
-- final state does not depend on the order the two migrations above ran in.

do $$
declare
  t text;
  server_only_tables text[] := array[
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
