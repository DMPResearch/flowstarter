-- The client's own page-count answer, asked on the brief itself.
--
-- Rule 8 of packages/agentic-codegen/src/flowstarter/page-set.ts: an explicit
-- answer wins, and the brief's answer beats the intake's. Since the
-- four-question intake moved the page-count question behind the deposit,
-- every quick brief carries the intake's 'unsure' default, which buys six
-- pages regardless of what the client actually asked for. The brief is later,
-- it is written after the client has seen a preview, and it is the only place
-- the question is still asked -- so this is the column that lets them answer
-- it, and the one the rule reads first.
--
-- Null means the client has not touched the control yet. It is not the same
-- as 'unsure': the dashboard pre-selects whatever `deriveBriefPages` works out
-- from the rest of the brief and shows that as the default, but a null column
-- means nobody confirmed it, and `resolvePageCountAnswer` falls through to the
-- intake and then to the derivation, exactly as it did before this column
-- existed.

alter table public.workspace_briefs
  add column if not exists page_count text;

alter table public.workspace_briefs
  drop constraint if exists workspace_briefs_page_count_check;
alter table public.workspace_briefs
  add constraint workspace_briefs_page_count_check
  check (page_count is null or page_count in ('lt-5', '5-7', '8-15', '15+', 'unsure'));

comment on column public.workspace_briefs.page_count is
  'The client''s own page-count answer, asked on the brief. Rule 8 of page-set.ts: this beats the intake''s answer, because the brief is later and it is the only place the question is still asked. Null means the client has not confirmed one yet, and the derived count (deriveBriefPages) is what the form pre-selects and what the rule falls back to.';

-- The defining migration grants SELECT to `authenticated` on an explicit
-- column list rather than the whole row, so a column added since is invisible
-- to a member until it is granted here too.
grant select (page_count) on table public.workspace_briefs to authenticated;
