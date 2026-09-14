-- The acceptable-use review queue.
--
-- The gate in front of the funnel has three answers: allow, review, refuse.
-- `allow` writes nothing. `refuse` and `review` both land here, because both
-- are decisions a person may have to explain later and neither is recoverable
-- from the logs: the submission itself is never written down, only its hash.
--
-- `review` is the row that matters. A lingerie shop, a licensed pharmacy and a
-- bookmaker with a real licence number all reach the gate looking, to a
-- classifier, close enough to a prohibited category to stop. Refusing them by
-- reflex would turn paying customers away, so the policy parks them here and
-- an operator says yes or no with the category and the evidence in front of
-- them. An open row is a hold: the brief does not dispatch a build and the
-- workspace does not move on until someone resolves it.
--
-- Why the submission is not in this table: the evidence column holds ONE
-- sentence the classifier wrote about what it saw, capped upstream at 200
-- characters, and `evidence_hash` identifies the exact text that produced it.
-- That is enough for an operator to act and not enough for this table to
-- become a copy of everything strangers have ever typed into the funnel. The
-- hash is truncated to 16 hex characters for the same reason: it correlates a
-- verdict with a submission somebody already holds, and it does not let anyone
-- confirm a guess about one they do not.
--
-- Server-only, like `llm_usage` and `discovery_leads`. Most rows are written
-- before a workspace exists at all (the quick intake is anonymous), the client
-- is told the outcome through the funnel's own copy rather than by reading a
-- row, and the operator's own sentence about why they approved a firearms
-- range is not client-facing text. So: RLS on, zero policies, every grant to
-- anon and authenticated revoked, service role only. Registered in
-- SERVER_ONLY_TABLES in apps/flowstarter-main/scripts/verify-rls-local.mjs.

create table if not exists public.policy_reviews (
  id uuid primary key default gen_random_uuid(),

  -- Null until the submission belongs to a workspace. The quick intake and the
  -- guest checkout both run before one exists, and a refusal there still has
  -- to be recorded.
  workspace_id uuid references public.workspaces(id) on delete cascade,

  -- Which enforcement point stopped: 'preview', 'claim', 'guest_deposit',
  -- 'brief', 'change_request', 'operator_quote', 'built_site'. Free text
  -- rather than a check constraint, because adding a seventh gate must not
  -- need a migration to record its own refusals.
  surface text not null,

  decision text not null check (decision in ('review', 'refuse')),

  -- The stable id from src/lib/policy/acceptable-use.ts. Not a foreign key and
  -- not an enum: the policy lists live in code where they are reviewed in a
  -- pull request, and a row written under an id that was later renamed must
  -- still read back as what it was at the time.
  category_id text not null,
  confidence numeric(4, 3) not null default 0,

  -- Why the rule layer landed here (PolicyRule), which tier answered, and the
  -- prompt version that produced the answer. Together these make a verdict
  -- explainable months later without re-running anything.
  rule text not null,
  tier text not null,
  prompt_version text not null default '',

  evidence_hash text not null,
  evidence text not null default '',

  status text not null default 'open'
    check (status in ('open', 'approved', 'refused')),
  resolved_by text,
  resolved_at timestamptz,
  resolution_note text,

  created_at timestamptz not null default now()
);

-- The board's read: everything open, newest first.
create index if not exists policy_reviews_open_idx
  on public.policy_reviews (status, created_at desc);

create index if not exists policy_reviews_workspace_idx
  on public.policy_reviews (workspace_id, created_at desc);

-- One open row per workspace, surface and content hash. A client who saves the
-- same brief four times gets one review, not four, and the queue stays a queue.
-- Partial on `status = 'open'` so a resolved row never blocks a later, genuine
-- re-submission of the same text.
create unique index if not exists policy_reviews_open_unique_idx
  on public.policy_reviews (workspace_id, surface, evidence_hash)
  where status = 'open' and workspace_id is not null;

alter table public.policy_reviews enable row level security;
alter table public.policy_reviews force row level security;

revoke all on public.policy_reviews from anon, authenticated;
grant all on public.policy_reviews to service_role;

comment on table public.policy_reviews is
  'Acceptable-use holds and refusals. Server-only: written by the gate, read by the operator board. Carries the category, the classifier''s one-sentence evidence and the evidence hash, never the submission.';
comment on column public.policy_reviews.evidence_hash is
  'Truncated SHA-256 of the exact text classified. The only identifier for a submission that appears in a log line.';
comment on column public.policy_reviews.status is
  'open holds the workspace; approved lets the work proceed; refused is final. An open row blocks the brief from dispatching a build.';
