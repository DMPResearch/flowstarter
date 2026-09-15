-- Raise the `tenant-assets` object ceiling above the preview artifact budget.
--
-- 20260830140000_tenant_assets_storage_bucket.sql set this bucket to 10 MiB
-- and said why: "The 10MB cap is the outer limit; the upload route refuses at
-- 8MB per file, matching `assertSafeUploadedImage`, so a client gets a clear
-- error from us rather than an opaque one from storage."
--
-- That reasoning is right and it was written for ONE KIND OF OBJECT: a client
-- photograph. The same bucket also holds the other kind the mime list names —
-- "packaged preview builds (previews/, a .tar.gz plus its json manifest)" —
-- and a packed site is not bounded by anything an image upload route knows
-- about. On 2026-09-15 a generated portfolio preview packed to 11.05 MiB,
-- Storage refused it with "The object exceeded the maximum allowed size", and
-- a correct site was never hosted. The visitor was told "the build stopped".
-- Exactly the opaque failure the original comment set out to avoid, arriving
-- through the door it did not have in mind.
--
-- 32 MiB, against a 16 MiB artifact budget
-- (`lib/hosting/preview-artifact-budget.ts`). The gap is deliberate and is the
-- point of the change: our own check has to be the one that fires first, so
-- the failure can name the size, the ceiling and the env var that moves it.
-- If the two were level, every artifact our check refused would also have been
-- refused by Storage, and an operator raising the budget would walk straight
-- back into the sentence above.
--
-- The 8 MiB per-file refusal on the image upload route is untouched. A client
-- photograph is still bounded where it always was; this only stops the object
-- store being the thing that decides how big a compiled site may be.
--
-- THE HOSTED PROJECT IS NOT MANAGED BY THIS MIGRATION RUNNER. The CLI stack
-- (a developer's machine, the fs-sites-01 box) picks this up from the repo on
-- the next sync. The hosted Supabase project behind the pinned Netlify deploy
-- needs the same value set by hand, once, in Storage → tenant-assets →
-- Settings. docs/operations/preview-artifacts.md carries the instruction.

update storage.buckets
set file_size_limit = 33554432 -- 32 MiB
where id = 'tenant-assets'
  and (file_size_limit is null or file_size_limit < 33554432);
