-- A fencing token on the build ledger, so an attempt that lost its lease
-- cannot finish the job that was taken from it.
--
-- The lease added in 20260912170000 answers "is anybody running this?". It
-- does not answer "is this the run that is allowed to finish?", and those are
-- different questions the moment a build outlives its own lease. A worker that
-- misses its heartbeats for longer than the TTL is legitimately overtaken: the
-- row is reclaimed, another worker starts the build again. The first one is
-- still going. It finishes, publishes a site from a worktree nobody is waiting
-- for, and marks the job succeeded -- over the top of the attempt that is
-- genuinely running. Every one of those writes was keyed on the job id alone.
--
-- The token is the smallest thing that fences them. It is bumped by one on
-- every claim, so it is a name for *which run* holds the job, and every write
-- a run makes carries the token it claimed with. The database compares, and an
-- overtaken attempt updates zero rows -- which is how it finds out, since
-- there is no other moment at which it would.
--
-- It starts at zero and is never null: a row that has never been claimed has a
-- token, so the compare-and-set in the claim has something to guard on rather
-- than a null it would have to special-case.

alter table public.flowstarter_agent_jobs
  add column if not exists lease_fence bigint not null default 0;

comment on column public.flowstarter_agent_jobs.lease_fence is
  'Monotonic fencing token, bumped on every claim. Every write an attempt makes must match it, so a worker that lost its lease cannot publish, finish or fail the job that was reclaimed from it.';
