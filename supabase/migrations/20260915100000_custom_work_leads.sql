-- Custom work leads: the funnel's other exit.
--
-- After the four quick questions, `classifyScope` reads the answers and the
-- title of the link the visitor pasted, and `decideRoute` sends them to one of
-- three places (apps/flowstarter-main/src/lib/flowstarter/scope-route.ts). Two
-- of those places end here: a brief that is custom work rather than a site that
-- presents a business, and a brief that is still ambiguous after the one
-- clarifying question. Both are offered a discovery call with DMPResearch, and
-- both get a row in this table.
--
-- The row exists before the booking does, deliberately. A visitor who is shown
-- the calendar and then closes the tab is still a lead Darius wants, and a
-- table that only recorded confirmed bookings would lose every one of them.
-- `booking_status` is how the two are told apart.
--
-- SERVER-ONLY, same classification and the same reasoning as `funnel_previews`,
-- `discovery_leads` and `ops_alerts`: the visitor is anonymous -- there is no
-- workspace, no membership row and no Clerk session at this point in the funnel
-- by construction, since the whole purpose of the row is that no workspace will
-- ever be created for it. There is no tenant key a policy could filter on, so
-- the protection is RLS on with zero policies (an absent policy is a deny),
-- with every grant to anon and authenticated revoked explicitly rather than
-- inherited. The only readers are the intake route and the operator's pipeline
-- board, both behind the service role.
--
-- `email` puts this table in public.tenant_key_tables(), so it is classified in
-- apps/flowstarter-main/scripts/verify-rls-local.mjs (SERVER_ONLY_TABLES) and
-- the guard in scripts/tenant-table-guard.mjs proves it there.

create table if not exists public.custom_work_leads (
  id uuid primary key default gen_random_uuid(),

  -- Who. Both come from the first two quick questions; neither is verified,
  -- because verifying an address before a person has been offered anything is
  -- friction spent on the wrong side of the conversation.
  name text not null,
  email text not null,

  -- What they asked for: the third quick question, and the link from the
  -- fourth with whatever title the page behind it exposed.
  description text not null default '',
  link_url text,
  link_title text,
  -- The answer to the one clarifying question, when it was asked.
  clarification text,

  -- Why they are here. `scope`/`confidence`/`evidence` are the classifier's
  -- verdict verbatim, `classifier` is which implementation produced it
  -- (`llm:<prompt version>` today, `sigma:<model version>` later), and `route`
  -- and `route_rule` are the deterministic decision taken from it. Stored
  -- together so a routing decision made months ago can still be read back
  -- against the thing that made it.
  scope text not null
    check (scope in ('standard', 'custom', 'unclear')),
  scope_confidence numeric(4, 3) not null default 0
    check (scope_confidence >= 0 and scope_confidence <= 1),
  scope_evidence jsonb not null default '[]'::jsonb,
  classifier text not null default 'none',
  route text not null
    check (route in ('self-serve', 'discovery-call', 'ask-one-more-question')),
  route_rule text not null default '',
  -- The acceptable-use gate's verdict when one ran. Null means no gate ran,
  -- which is a different fact from `allowed` and worth keeping apart.
  acceptable_use text
    check (acceptable_use is null or acceptable_use in ('allowed', 'review', 'blocked')),

  -- How the lead arrived: the funnel's conversational offer, or the contact
  -- form on /discovery-call that stands in when no Cal.com is configured.
  source text not null default 'funnel'
    check (source in ('funnel', 'contact_form')),

  -- Where the booking got to. `offered` is a visitor who was shown the
  -- calendar; `enquiry` is one who used the form instead because there was no
  -- calendar to show. Neither is a failure and both want a reply.
  booking_status text not null default 'offered'
    check (booking_status in ('offered', 'enquiry', 'booked', 'contacted', 'closed')),
  -- Cal.com's own booking uid, when a webhook has told us there is one.
  booking_reference text,

  -- The operator's "Mark contacted" on the pipeline board.
  contacted_at timestamptz,
  contacted_by text,

  -- When the branded confirmation actually reached the visitor. Null means it
  -- did not, which an operator should be able to see rather than assume.
  confirmation_sent_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.custom_work_leads is
  'Visitors the intake routed away from generation and towards a DMPResearch discovery call, with the classification evidence and the deterministic route that produced the decision. Server-only: no workspace exists for these rows by construction.';
comment on column public.custom_work_leads.scope_evidence is
  'Short fragments quoted from the visitor''s own brief, as the classifier reported them. Read by the operator next to the brief; never generated prose.';
comment on column public.custom_work_leads.booking_status is
  'offered = shown the calendar, enquiry = filed through the contact form because no Cal.com is configured, booked = Cal.com confirmed it, contacted = an operator has replied, closed = done either way.';

create index if not exists custom_work_leads_created_idx
  on public.custom_work_leads (created_at desc);

create index if not exists custom_work_leads_status_idx
  on public.custom_work_leads (booking_status);

create index if not exists custom_work_leads_email_idx
  on public.custom_work_leads (lower(email));

-- `updated_at` is maintained by the database, same pattern as
-- ops_alerts_set_updated_at in 20260912190000_ops_alerts.sql.
create or replace function public.custom_work_leads_set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists custom_work_leads_set_updated_at on public.custom_work_leads;
create trigger custom_work_leads_set_updated_at
  before update on public.custom_work_leads
  for each row
  execute function public.custom_work_leads_set_updated_at();

alter table public.custom_work_leads enable row level security;

revoke all on table public.custom_work_leads from public, anon, authenticated;
grant all on table public.custom_work_leads to service_role;

revoke all on function public.custom_work_leads_set_updated_at() from public, anon, authenticated;
