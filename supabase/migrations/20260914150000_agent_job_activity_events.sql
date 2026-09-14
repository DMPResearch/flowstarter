-- The agent's activity timeline, as a kind of job event.
--
-- A build already writes three kinds into this table: `phase` (a heading),
-- `log` (batched narration) and `reply` (what the agents said). The fourth,
-- `activity`, is the structured one. Its `body` is the phase the step belongs
-- to and its `payload.activity` is an AgentActivityEvent -- `{ at, phase,
-- kind, subject, detail?, chips? }` -- produced by deterministic rules in
-- packages/agentic-codegen/src/flowstarter/activity, never by a model.
--
-- It is a kind of its own rather than a `log` row with a flag in its payload
-- because three readers have to be able to ask for it, or refuse it, by name:
-- the operator conversation (which wants phases and replies, not this), the
-- log download (which wants everything) and the client-facing timeline (which
-- wants only this, with `payload.activity.detail` stripped, since that field
-- carries file paths and raw gate verdicts).
--
-- `note` stays in the list untouched: it is the operator's own message and is
-- written by flowstarter-main, not by the worker.

alter table public.flowstarter_agent_job_events
  drop constraint if exists flowstarter_agent_job_events_kind_check;

alter table public.flowstarter_agent_job_events
  add constraint flowstarter_agent_job_events_kind_check
  check (kind in ('phase', 'log', 'note', 'reply', 'activity'));

-- The client timeline reads one job's activity, oldest first, and nothing
-- else. Without this it shares the job-wide index with the log batches, which
-- outnumber it by two orders of magnitude on a long build.
create index if not exists flowstarter_agent_job_events_activity_idx
  on public.flowstarter_agent_job_events (job_id, created_at)
  where kind = 'activity';
