-- The per-workspace public lead capture token.
--
-- A site we build for a client has to be able to say which tenant a contact
-- form submission belongs to, and it has to say it from static HTML that any
-- visitor can read. The obvious value to print there is the workspace id, and
-- it is the wrong one: the id is the key half the schema is addressed by, it
-- appears in dashboard URLs and event payloads, and it cannot be changed. A
-- string printed on every page of a public website has to be rotatable.
--
-- So each workspace carries a token instead. It is public by nature - it ships
-- in the HTML - and it grants exactly one thing: create one lead for this
-- workspace, through POST /api/leads/capture/{token}. It is accepted nowhere
-- else, it reads nothing, and rotating it costs the client one rebuild of
-- their site rather than a new workspace.
--
-- NOT NULL with a default, so "every workspace has a token" is true by
-- construction rather than by whichever code path happened to create the row.
-- The unique index is what lets the endpoint resolve a tenant from the token
-- in one indexed lookup, and what makes a collision impossible rather than
-- unlikely.

create extension if not exists pgcrypto;

-- 32 random bytes in base64url: 43 characters, safe in a path segment, in an
-- HTML attribute and in a query string, with no padding to strip.
--
-- `translate` with a shorter target deletes the leftovers, so '=' is dropped
-- rather than mapped. Not exposed to anon or authenticated: nothing outside
-- the platform's own writes has any reason to mint one.
create or replace function public.new_lead_capture_token()
returns text
language sql
volatile
as $$
  select translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');
$$;

comment on function public.new_lead_capture_token() is
  'A fresh base64url lead capture token (32 random bytes). Used as the default for workspaces.lead_capture_token and by the rotate action.';

revoke all on function public.new_lead_capture_token() from public;
grant execute on function public.new_lead_capture_token() to service_role;

alter table public.workspaces
  add column if not exists lead_capture_token text;

-- Existing workspaces first, so the NOT NULL below has nothing to refuse.
update public.workspaces
   set lead_capture_token = public.new_lead_capture_token()
 where lead_capture_token is null;

alter table public.workspaces
  alter column lead_capture_token set default public.new_lead_capture_token();

alter table public.workspaces
  alter column lead_capture_token set not null;

-- The shape the endpoint will accept. A token that cannot survive being put in
-- a URL is a bug we would rather find on the write than on the read, and the
-- 43 floor is what keeps a canonical UUID - 36 characters of hex and hyphens,
-- which is valid base64url - from ever being a well-formed token.
alter table public.workspaces
  drop constraint if exists workspaces_lead_capture_token_shape;
alter table public.workspaces
  add constraint workspaces_lead_capture_token_shape
  check (lead_capture_token ~ '^[A-Za-z0-9_-]{43,128}$');

create unique index if not exists idx_workspaces_lead_capture_token
  on public.workspaces (lead_capture_token);

comment on column public.workspaces.lead_capture_token is
  'Public, rotatable token that identifies this workspace on POST /api/leads/capture/{token}. Ships in the generated site HTML. Grants nothing but creating one lead for this workspace.';
