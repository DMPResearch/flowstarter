-- Standalone reference, intentionally outside product migrations.
-- Apply once to a LOCAL Supabase database. See README.md for provisioning.
create schema dmpresearch_private;
revoke all on schema dmpresearch_private from public, anon, authenticated;
grant usage on schema dmpresearch_private to authenticated;

create table dmpresearch_private.workspaces (
  id uuid primary key,
  name text not null check (char_length(name) between 1 and 120)
);
create table dmpresearch_private.memberships (
  workspace_id uuid not null references dmpresearch_private.workspaces(id),
  -- JWT sub is text: compatible with Supabase Auth UUIDs and Clerk IDs.
  subject text not null check (char_length(subject) between 1 and 255),
  primary key (workspace_id, subject)
);
alter table dmpresearch_private.workspaces enable row level security;
alter table dmpresearch_private.memberships enable row level security;
revoke all on all tables in schema dmpresearch_private from public, anon, authenticated;

-- Only trusted provisioning creates memberships. Never infer authorization
-- from user_metadata, a client-selected UUID, an Origin, or a request header.
create function dmpresearch_private.has_workspace_access(workspace uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from dmpresearch_private.memberships m
    where m.workspace_id = workspace
      and m.subject = (select auth.jwt() ->> 'sub')
  );
$$;
revoke all on function dmpresearch_private.has_workspace_access(uuid) from public, anon;
grant execute on function dmpresearch_private.has_workspace_access(uuid) to authenticated;

-- PostgREST sets request.headers; this is a routing check, not authorization.
-- Compare as text so malformed/missing UUID context simply denies access.
create function dmpresearch_private.request_workspace()
returns text language sql stable
set search_path = ''
as $$
  select nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-tenant-id';
$$;
revoke all on function dmpresearch_private.request_workspace() from public, anon;
grant execute on function dmpresearch_private.request_workspace() to authenticated;

create table public.dmpresearch_submissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references dmpresearch_private.workspaces(id),
  created_by text not null default (auth.jwt() ->> 'sub'),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  email text not null check (
    char_length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  message text not null check (char_length(btrim(message)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index dmpresearch_submissions_workspace_author_created_idx
  on public.dmpresearch_submissions (workspace_id, created_by, created_at desc);
alter table public.dmpresearch_submissions enable row level security;
revoke all on public.dmpresearch_submissions from public, anon, authenticated;
grant select on public.dmpresearch_submissions to authenticated;
grant insert (workspace_id, name, email, message)
  on public.dmpresearch_submissions to authenticated;

create policy submissions_insert_own
  on public.dmpresearch_submissions for insert to authenticated
  with check (
    workspace_id::text = (select dmpresearch_private.request_workspace())
    and dmpresearch_private.has_workspace_access(workspace_id)
    and created_by = (select auth.jwt() ->> 'sub')
  );
create policy submissions_select_own
  on public.dmpresearch_submissions for select to authenticated
  using (
    workspace_id::text = (select dmpresearch_private.request_workspace())
    and dmpresearch_private.has_workspace_access(workspace_id)
    and created_by = (select auth.jwt() ->> 'sub')
  );
-- No browser UPDATE/DELETE, and no anon access. A service role bypasses RLS;
-- any future server handler must authorize and scope every query separately.
