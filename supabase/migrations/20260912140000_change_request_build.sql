-- CHANGE_REQUEST_BUILD: the job that actually does a change request somebody
-- paid for.
--
-- The escalation path was complete except for the work. A client filed a
-- request their editor correctly refused (a layout change is not theirs to
-- make), an operator quoted it, the client accepted and paid it in Stripe,
-- and then the operator's Changes tab offered exactly one button: "Mark
-- done", which moved a status and shipped nothing. There was no route in the
-- product that could run an agent over a delivered site. FULL_SITE_BUILD
-- refuses unless the project is DEPOSIT_PAID, and by the time a change request
-- exists the project is HUMAN_QA or LIVE_SUBSCRIPTION; SITE_REBUILD runs no
-- agents at all, so an operator note on one reaches nobody.
--
-- This kind is that missing route. It seeds from the manifest the client's own
-- editor last wrote (the same column a rebuild reads), runs one bounded agent
-- pass whose prompt states the request verbatim and lists the client's own
-- rights-confirmed pictures by the path they have on disk, puts the result
-- through the same gates a paid build passes, saves a new site version,
-- publishes it down the existing deploy path, and only then moves the request
-- from paid to done.
--
-- It is a separate kind rather than a flag on either of the other two because
-- it differs from both in the ways an operator reads off a board: agents do
-- run (unlike a rebuild), the deposit is long since settled and the project is
-- past DEPOSIT_PAID (unlike a full build), and it is answerable to one row in
-- flowstarter_change_requests rather than to the whole engagement.

alter table public.flowstarter_agent_jobs
  drop constraint if exists flowstarter_agent_jobs_kind_check;
alter table public.flowstarter_agent_jobs
  add constraint flowstarter_agent_jobs_kind_check
  check (kind in (
    'FULL_SITE_BUILD', 'INLINE_EDIT',
    'ASSET_INGEST', 'PREVIEW_GENERATE', 'ASSET_REQUEST', 'REMINDER',
    'PREVIEW_REAP', 'SITE_REBUILD', 'CHANGE_REQUEST_BUILD'
  ));

-- Re-declared verbatim so the two checks stay readable side by side: only a
-- fleet-wide sweep may have no tenant, and a change request is always
-- somebody's.
alter table public.flowstarter_agent_jobs
  drop constraint if exists flowstarter_agent_jobs_workspace_required;
alter table public.flowstarter_agent_jobs
  add constraint flowstarter_agent_jobs_workspace_required
  check (workspace_id is not null or kind = 'PREVIEW_REAP');

-- A workspace may buy many changes over the life of a site, so the history is
-- kept. What must not happen is two of them in flight at once: they would race
-- for the same worktree and for the same site_versions sequence, and the loser
-- would publish a site missing the winner's change. Unlike SITE_REBUILD the
-- constraint covers 'running' as well as 'queued', because there is nothing
-- useful a second change build could join: a rebuild waiting behind a running
-- one will publish the same manifest either way, while a change build carries
-- its own request and has to start from what the previous one produced.
create unique index if not exists flowstarter_agent_jobs_one_live_change_build
  on public.flowstarter_agent_jobs (workspace_id)
  where kind = 'CHANGE_REQUEST_BUILD' and status in ('queued', 'running');

-- What the build did, on the request itself.
--
-- `build_job_id` is the link the operator's card follows to show the build
-- conversation inline, and the link the deploy callback follows to send the
-- client "your change is live". `built_version` is the site version the work
-- landed in, which is what the client's own card reads back to them. Both are
-- null for a request that was never built.
--
-- `completed_via` and `completion_note` exist because "Mark done" survives as
-- a manual override and must be distinguishable from work a build shipped. A
-- manual override now requires a typed reason, stored here, so a request that
-- reads `done` always answers the question "done how, and who says so".
alter table public.flowstarter_change_requests
  add column if not exists build_job_id uuid
    references public.flowstarter_agent_jobs(id) on delete set null,
  add column if not exists built_version integer,
  add column if not exists completed_via text,
  add column if not exists completion_note text;

alter table public.flowstarter_change_requests
  drop constraint if exists flowstarter_change_requests_completed_via_check;
alter table public.flowstarter_change_requests
  add constraint flowstarter_change_requests_completed_via_check
  check (completed_via is null or completed_via in ('build', 'manual'));

alter table public.flowstarter_change_requests
  drop constraint if exists flowstarter_change_requests_built_version_check;
alter table public.flowstarter_change_requests
  add constraint flowstarter_change_requests_built_version_check
  check (built_version is null or built_version > 0);

create index if not exists flowstarter_change_requests_build_job_idx
  on public.flowstarter_change_requests (build_job_id)
  where build_job_id is not null;

comment on column public.flowstarter_change_requests.build_job_id is
  'The CHANGE_REQUEST_BUILD that is delivering, or delivered, this request.';
comment on column public.flowstarter_change_requests.built_version is
  'site_versions.version the finished change went live in.';
comment on column public.flowstarter_change_requests.completed_via is
  'build when a CHANGE_REQUEST_BUILD shipped it; manual when an operator overrode it by hand.';
comment on column public.flowstarter_change_requests.completion_note is
  'Why an operator marked this done by hand. Required for a manual override.';
