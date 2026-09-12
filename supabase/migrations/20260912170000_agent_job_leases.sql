-- Leases on the build ledger, so a worker that dies mid-build cannot strand a
-- paid job.
--
-- Until now the build queue was entirely process-local: an array in
-- apps/build-worker/src/queue.ts, plus a `running` row that nothing ever
-- revisited. A worker killed after claiming left that row at `running`
-- forever. A restarted worker would not claim it (the claim rule excluded
-- `running` outright) and the operator board refused to re-dispatch it for the
-- same reason. The client had paid, and nothing on the system was going to
-- build their site.
--
-- A lease is the smallest thing that fixes it. A claim writes who holds the
-- job and until when; a heartbeat pushes that deadline forward while the build
-- is genuinely running; and everything that reads the ledger asks "is this
-- held?" rather than "does this say running?". A held lease is still refused —
-- two workers on one worktree is the failure this prevents. An expired one is
-- recoverable, by a restarted worker's startup reconciliation or by an
-- operator's re-dispatch.
--
-- Both columns are nullable with no default, deliberately. A null lease on a
-- `running` row means a worker from before this migration: the rule in
-- apps/build-worker/src/leases.ts dates those from `started_at` instead, so
-- nothing in flight during the deploy is either stranded or stolen.

alter table public.flowstarter_agent_jobs
  add column if not exists leased_by text,
  add column if not exists lease_expires_at timestamptz;

comment on column public.flowstarter_agent_jobs.leased_by is
  'The worker process holding this job (host:pid:nonce). Null when nobody holds it.';
comment on column public.flowstarter_agent_jobs.lease_expires_at is
  'When the holder''s claim runs out. A running row past this is recoverable; heartbeats push it forward.';

-- Startup reconciliation''s query: running rows whose lease has died. Partial,
-- because `running` is a small minority of this table and the whole point of
-- this index is to make recovery cheap enough to run on every boot.
create index if not exists flowstarter_agent_jobs_expired_lease_idx
  on public.flowstarter_agent_jobs (lease_expires_at)
  where status = 'running';
