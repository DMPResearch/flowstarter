-- What a build failed with the *first* time, kept across its retries.
--
-- `markFailed` writes `error_code` on every attempt, which is the right answer
-- to "what is wrong with this job now" and the wrong one to "why did it fail".
-- Since #120 put `failed` on the sweep's list of claimable statuses, a job
-- with attempts left is retried by whichever worker boots next -- so on
-- 2026-09-13 five jobs in workspace c009105e-f8ec-42bf-bdcf-cf92bb500f45 ended
-- up reading CHANGE_REQUEST_BUILD_FAILED, the reason their *last* retry died.
-- The four PAGE_BUDGET_EXCEEDED verdicts and the one PLACEHOLDER_IMAGE_SHIPPED
-- that actually explained those builds survive only in a markdown file.
--
-- Two things stop that happening again. The retry rule itself
-- (apps/build-worker/src/failure-policy.ts) no longer re-queues a build a gate
-- refused, so most verdicts are never overwritten at all. And every attempt now
-- appends to a ledger on `payload.failures` -- attempt, code, detail, time --
-- of which this column is the first entry's code, in a column an operator can
-- read with a `select` instead of a JSON path.
--
-- Nullable with no default and never backfilled: a null here means a row that
-- has not failed since this migration, which is exactly what it looks like. The
-- codes lost before today are not recoverable from this table and are not
-- invented into it.

alter table public.flowstarter_agent_jobs
  add column if not exists error_code_first text;

comment on column public.flowstarter_agent_jobs.error_code_first is
  'The error_code of this job''s first recorded failure. error_code holds the latest; payload.failures holds every attempt in order.';
