-- `waiting_brief`: a paid build that is parked on its client, said out loud.
--
-- The in-depth brief (20260912090000) made a FULL_SITE_BUILD conditional: the
-- worker refuses to claim one until `workspace_briefs.ready_at` is set or an
-- operator has waived it. It refused by returning from `claim()` and leaving
-- the row exactly as it found it, which is correct for the attempt budget and
-- invisible everywhere else. The row read `queued`, which is the same thing a
-- dropped dispatch reads, so:
--
--   * the operator board's stall detector reported a healthy build as "queued
--     for 15 minutes without being picked up: dispatch may have been dropped",
--     which is an alarm about our own system for a situation only the client
--     can end;
--   * nothing could find those jobs by query. "Which builds are waiting on a
--     brief" had no answer except reading every queued job and joining the
--     brief table by hand; and
--   * the end of the wait went nowhere. A client finishing their brief wrote
--     `ready_at` and nothing read it again, because the only thing that ever
--     asked the worker to look at a job was a dispatch at deposit time that
--     had already happened and already been refused.
--
-- A status makes all three answerable in the same place: the app enqueues into
-- it when the brief is not ready, the worker parks jobs into it, the readiness
-- transition and the worker's reconciliation sweep promote back out of it, and
-- the board and the client dashboard both read it directly.
--
-- It is a waiting state and not a terminal one: nothing here touches
-- `attempt_count`, because waiting is not an attempt, and a build whose budget
-- was burned one poll at a time is a build that can never run again.

alter table public.flowstarter_agent_jobs
  drop constraint if exists flowstarter_agent_jobs_status_check;
alter table public.flowstarter_agent_jobs
  add constraint flowstarter_agent_jobs_status_check
  check (status in (
    'queued', 'waiting_brief', 'running', 'succeeded', 'failed', 'canceled'
  ));

-- The reconciliation sweep's index. A worker asks "what should I be running"
-- once a minute per process, and that query must never become a sequential
-- scan of every job this platform has ever run.
create index if not exists flowstarter_agent_jobs_runnable_idx
  on public.flowstarter_agent_jobs (status, created_at)
  where status in ('queued', 'waiting_brief');

comment on column public.flowstarter_agent_jobs.status is
  'queued (due to run), waiting_brief (parked until the client brief is ready '
  'or an operator waives it), running, succeeded, failed, canceled.';
