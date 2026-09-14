-- The operator's half of "build entire features from the editor".
--
-- The client's half has been live for a while and is deliberately narrow: the
-- client editor offers Words and Pictures, EDITOR_POLICY refuses anything
-- structural, and everything larger escalates into a change request somebody
-- quotes. That is the right shape for a client. It is the wrong shape for us:
-- an operator asked for a new page, a booking integration or a whole section
-- has no way to do the work except to file a change request against
-- themselves and let one bounded agent pass try it.
--
-- `apps/flowstarter-editor` -- a coding agent with a real filesystem -- was
-- built for exactly this and then wired to nothing. It had no way to learn
-- which workspace's source to open (`workspaces.editor_repo_url` was added and
-- read by no code), no way to be opened from the operator board, and no way to
-- ship what it produced. An operator could not reach it, and if they had, the
-- result would have gone live without passing a single gate.
--
-- This migration adds the row that binds the three together: which operator,
-- which workspace, which version of the site the worktree was cut from, where
-- that worktree lives on the editor host, and which build shipped it. One row
-- per session, and the row is what the admin project page reads to show the
-- session and what the worker reads to find the bytes it must build.
--
-- The rule the whole design turns on: the operator's session may do anything
-- a coding agent can do, and the gates still decide what ships. Nothing an
-- operator writes in the editor reaches a client's site except through
-- OPERATOR_EDIT_BUILD, which runs the same output gates every paid build
-- passes and publishes down the same path.

-- ---------------------------------------------------------------------------
-- 1. The job kind
-- ---------------------------------------------------------------------------

-- A kind of its own, for the same reason CHANGE_REQUEST_BUILD is one. It is
-- not a rebuild: a rebuild publishes bytes the client themselves approved,
-- with no agent anywhere near them, and a rebuild's silence about gates is
-- earned by that fact. It is not a change request build: there is no paid
-- request to be answerable to, no client text to hold the output to, and the
-- agent pass already happened -- in an operator's hands, interactively, before
-- this job existed. And it is not a full build: the deposit is long settled
-- and the project is past DEPOSIT_PAID.
--
-- What it is: an operator's finished worktree, put through every output gate
-- and published. The distinction matters on the board, where an operator has
-- to be able to see at a glance that a change on a client's live site came
-- from one of us rather than from the client or from a paid request.
alter table public.flowstarter_agent_jobs
  drop constraint if exists flowstarter_agent_jobs_kind_check;
alter table public.flowstarter_agent_jobs
  add constraint flowstarter_agent_jobs_kind_check
  check (kind in (
    'FULL_SITE_BUILD', 'INLINE_EDIT',
    'ASSET_INGEST', 'PREVIEW_GENERATE', 'ASSET_REQUEST', 'REMINDER',
    'PREVIEW_REAP', 'SITE_REBUILD', 'CHANGE_REQUEST_BUILD',
    'OPERATOR_EDIT_BUILD'
  ));

-- Re-declared verbatim beside the kind check, as every migration that widened
-- that check has done: only a fleet-wide sweep may have no tenant.
alter table public.flowstarter_agent_jobs
  drop constraint if exists flowstarter_agent_jobs_workspace_required;
alter table public.flowstarter_agent_jobs
  add constraint flowstarter_agent_jobs_workspace_required
  check (workspace_id is not null or kind = 'PREVIEW_REAP');

-- One at a time per workspace, covering `running` as well as `queued` -- the
-- same rule CHANGE_REQUEST_BUILD has and for the same reason. Two operator
-- ships in flight would race for the site_versions sequence and the loser
-- would publish a site missing the winner's work. There is nothing useful a
-- second one could join either: each carries its own session's bytes.
create unique index if not exists flowstarter_agent_jobs_one_live_operator_edit
  on public.flowstarter_agent_jobs (workspace_id)
  where kind = 'OPERATOR_EDIT_BUILD' and status in ('queued', 'running');

-- ---------------------------------------------------------------------------
-- 2. The session
-- ---------------------------------------------------------------------------

create table if not exists public.operator_editor_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null
    references public.workspaces(id) on delete cascade,
  -- Clerk user id of the operator who opened it. Never 'system': a session is
  -- always somebody's, and "who opened the editor on a client's site" is the
  -- first question anyone asks when a change nobody remembers shows up.
  operator_id text not null,

  -- The site_versions.version the worktree was cut from. 0 when the workspace
  -- has no version yet and the seed came from the delivered artifact manifest.
  -- Recorded because it is the honest answer to "what was this change made
  -- against", and because a session opened against version 4 and shipped after
  -- the client published version 5 is a session whose base is stale -- the ship
  -- path reads this to say so rather than silently overwriting their edit.
  base_version integer not null default 0 check (base_version >= 0),

  -- Where the editor host put the worktree (`/workspaces/<slug>`), and which
  -- container served it. Both are free text from the host's own answer: this
  -- table records what happened, it does not dictate a layout the host must
  -- follow.
  worktree_path text,
  container_id text,
  -- The origin the operator was handed over to, recorded so the board can
  -- offer the same link again without re-deriving it, and so an audit can say
  -- where the credentials went.
  editor_url text,
  -- The commit the editor host made when it materialised the worktree, i.e.
  -- the exact bytes the session started from.
  base_commit_sha text,

  status text not null default 'opening'
    check (status in ('opening', 'ready', 'shipping', 'shipped', 'failed', 'closed')),

  -- What the operator's worktree held when they pressed Ship, in the same
  -- {files:[{path,content,encoding?}]} shape as
  -- flowstarter_project_artifacts.preview_manifest. This is what the build
  -- worker materialises and builds; it is deliberately NOT the client's live
  -- manifest, and the worker never reads the editor host's filesystem.
  --
  -- Null until the session ships. Kept afterwards, because a build that failed
  -- a gate has to be diagnosable from the bytes it was given rather than from
  -- a worktree an idle-stop may already have reaped.
  result_manifest jsonb,
  result_commit_sha text,
  shipped_at timestamptz,

  build_job_id uuid
    references public.flowstarter_agent_jobs(id) on delete set null,
  -- site_versions.version the shipped work landed in. Null until it is live.
  shipped_version integer check (shipped_version is null or shipped_version > 0),
  -- The plain-words reason the last attempt to ship failed, as the gate wrote
  -- it. The operator reads this on the project page next to the session, which
  -- is where they are already standing when they have to go fix it.
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

-- One open session per workspace. Two operators in two editors on one client's
-- site would each be working against the other's stale base, and whichever
-- shipped second would quietly undo the first. The board offers "join the open
-- session" instead, which is the honest answer.
create unique index if not exists operator_editor_sessions_one_open
  on public.operator_editor_sessions (workspace_id)
  where status in ('opening', 'ready', 'shipping');

create index if not exists operator_editor_sessions_workspace_idx
  on public.operator_editor_sessions (workspace_id, created_at desc);
create index if not exists operator_editor_sessions_build_job_idx
  on public.operator_editor_sessions (build_job_id)
  where build_job_id is not null;

comment on table public.operator_editor_sessions is
  'One operator working on a workspace''s site in the Flowstarter editor. Records who, from which version, where the worktree lives, what they shipped and which build put it live. Service role only: an operator reaches it through the admin API, a client never sees it.';
comment on column public.operator_editor_sessions.result_manifest is
  'The worktree the operator shipped, as {files:[{path,content,encoding?}]}. The build worker materialises this; it never reads the editor host''s disk.';
comment on column public.operator_editor_sessions.base_version is
  'site_versions.version the worktree was cut from, or 0 for a workspace with no version yet.';
comment on column public.operator_editor_sessions.last_error is
  'The gate''s own plain-words message from the last failed ship, shown on the project page.';

-- ---------------------------------------------------------------------------
-- 3. Access
-- ---------------------------------------------------------------------------

-- Service role only, and the absence of any policy is the deny. A member must
-- not be able to enumerate the times we opened a coding agent on their site,
-- and an operator never talks to this table directly: they go through
-- /api/admin/projects/[id]/editor, which runs requireTeamAuth first. The one
-- thing a client is told -- that a change was made by us, and in which version
-- -- reaches them through site_versions.created_by, which they already read.
alter table public.operator_editor_sessions enable row level security;
revoke all on table public.operator_editor_sessions from anon, authenticated;
grant all on table public.operator_editor_sessions to service_role;

-- ---------------------------------------------------------------------------
-- 4. The editor's source binding, put to use
-- ---------------------------------------------------------------------------

-- `workspaces.editor_repo_url` / `editor_repo_ref` were added by
-- 20260520000001 for a design where the editor host cloned a per-client repo.
-- That repo never came to exist, and the columns have been read by no code
-- since. They stay -- a workspace whose source really does live in a git
-- remote is a thing we may still want -- but the comment now says what the
-- default actually is, so the next person does not go looking for a clone step
-- that was never written.
comment on column public.workspaces.editor_repo_url is
  'Optional git remote holding this workspace''s editable source. NULL -- the normal case -- means the editor host materialises the worktree from the workspace''s latest published site_versions manifest instead, exactly as the build worker seeds from it. Set this only for a workspace whose source genuinely lives in a remote.';
