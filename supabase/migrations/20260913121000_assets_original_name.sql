-- ASSETS_ORIGINAL_NAME: the one thing about an upload we were throwing away.
--
-- An asset's `storage_path` is content-addressed
-- (`tenant/{workspaceId}/assets/{sha256}.{ext}`, from `assetObjectPath`), on
-- purpose: the same bytes always resolve to the same object, so a retried
-- upload can never fork. That is the right key for the object. It is the
-- wrong thing to show an operator, who was seeing a sha256 as a picture's
-- name in the Changes tab's asset picker (PR #119) whenever the client had
-- not typed a caption -- meaningless to someone ticking a box on a change
-- they are about to pay us to build.
--
-- The browser's own filename was never anywhere to fall back to, so this adds
-- it. It is display-only: nothing in storage-paths.ts reads it, nothing
-- builds a path from it, and it is sanitised to a bare name (no directory
-- component) before it ever reaches this column. A client naming their file
-- `../../etc/passwd.jpg` gets a label, not a path.
alter table public.assets
  add column if not exists original_name text;

comment on column public.assets.original_name is
  'The uploading browser''s own name for the file, kept for display only (e.g. the operator''s change-request asset picker). Never a path component and never trusted for anything but prose.';
