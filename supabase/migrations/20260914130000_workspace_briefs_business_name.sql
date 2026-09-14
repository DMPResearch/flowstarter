-- The client's own business name, asked on the brief.
--
-- `deriveBusinessName` (apps/flowstarter-main/.../quick-defaults.ts) has
-- always checked for this answer first, at `phase: 'brief'` in
-- `intake-script.ts`, but nothing ever rendered or accepted it: BriefForm.tsx
-- has no business-name field and this route did not read one, so the check
-- was unreachable from day one, the same class of gap the retired
-- `commerceMode` question left. That is what let a visitor's pasted
-- reference site outrank an unaskable "what is it actually called" -- the
-- Onyx incident this column exists to close.
--
-- Null means the client has not set one on the brief. The prefill the form
-- shows is the workspace's current name (already the value `deriveBusinessName`
-- produced at claim time, or whatever the client has since typed here), which
-- is why the column itself does not need a derived default: there is nothing
-- to derive that `workspaces.name` does not already hold.

alter table public.workspace_briefs
  add column if not exists business_name text not null default '';

comment on column public.workspace_briefs.business_name is
  'The client''s own business name, given on the brief. Empty means unset -- the form prefills the input with the workspace''s current name, but nothing is written here until the client saves. Saving a non-empty, different name renames the workspace and, unless the site has already been published once, reslugs it through the same rule a claim uses (see applyBusinessNameToWorkspace in /api/client/brief/[workspaceId]/route.ts).';

-- The defining migration grants SELECT to `authenticated` on an explicit
-- column list rather than the whole row, so a column added since is invisible
-- to a member until it is granted here too.
grant select (business_name) on table public.workspace_briefs to authenticated;
