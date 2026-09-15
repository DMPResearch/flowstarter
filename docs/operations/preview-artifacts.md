# Preview artifacts: the size budget, and the one change CI cannot make

A funnel preview is published by packing the compiled `dist/` into a gzipped
tarball, storing it in the `tenant-assets` Supabase Storage bucket, signing a
short-lived URL, and handing that URL to the previews deploy-agent. If the
object cannot be stored, the agent has nothing to fetch and no site is served —
the manifest stays claimable, but the visitor is told the build stopped.

## What went wrong on 2026-09-15

A generated portfolio preview built correctly and was never hosted. The
container log, verbatim:

```
[funnel-previews] could not upload artifact for 116965b1-…: The object exceeded the maximum allowed size
[Flowstarter] preview 116965b1-… was not hosted: the preview artifact could not be stored or signed, so the previews agent has nothing to fetch; the manifest is still claimable
```

Three facts, measured rather than guessed:

| | |
| --- | --- |
| `tenant-assets` bucket `file_size_limit` (before) | 10 MiB (`10485760`) |
| portfolio template family: `dist/` on disk | 11.35 MiB (`11904643` bytes) |
| portfolio template family: **packed artifact** | **11.05 MiB** (`11591766` bytes) |
| local-trade family (the preview that worked): `dist/` on disk | 1.34 MiB (`1407910` bytes) |

The whole difference was pictures. Astro compiles what is under `src/` and
copies what is under `public/` byte for byte, and none of the five site
templates use `astro:assets`, so every image they ship takes the copy path:

```
dist/_astro    120 KiB   the compiled site
dist/images   11.7 MiB   public/images/*.png, verbatim
```

2.7 MiB of that was one `hero.png`. 2.4 MiB was `hero-image-wrong.png`, which
no page references and which had shipped in every preview ever generated from
that template.

## What the product does now

- `optimisePreviewDistImages` (`lib/discovery/preview-dist-assets.ts`) runs
  between `astro build` and reading `dist/` back. It drops images nothing in
  the built site references, and re-encodes the remaining raster originals to
  WebP, rewriting every reference. `_astro/` is never touched — it is already
  Astro's optimised output — and SVG is never re-encoded.
- `previewArtifactBudgetBytes` (`lib/hosting/preview-artifact-budget.ts`) is a
  **16 MiB** ceiling, checked against the packed tarball **before** the upload.
  Over it, the preview is marked `failed` with a sentence naming the size, the
  budget and the env var; the manifest is still written, so the preview is
  still claimable; and a `preview_artifact_over_budget` ops alert fires, keyed
  by template slug.
- `FLOWSTARTER_PREVIEW_ARTIFACT_MAX_BYTES` overrides the budget, in bytes. A
  value at or above the bucket limit is refused and logged rather than honoured
  — obeying it would put the refusal back inside Supabase, where nothing can
  explain it.

Measured on the same template, by the real build in
`lib/discovery/__tests__/preview-real-build.test.ts`:

```
[funnel-previews] assets: 9 image(s) re-encoded to WebP, 2 unreferenced dropped,
                  dist 11906860 -> 1191632 bytes
[real-build] dorin-portfolio: 43 files, artifact 935.5 KiB (957953 bytes),
             budget 16.0 MiB
```

11.35 MiB of `dist/` becomes 1.14 MiB; the packed artifact goes from 11.05 MiB
to 935.5 KiB. Note that the artifact that broke would now fit under both the
budget and the raised bucket on its own — the optimiser is what stops it
getting there, and the budget is what catches the next order of magnitude.

## The bucket limit, and the change CI cannot make

`supabase/migrations/20260915143325_tenant_assets_preview_artifact_limit.sql`
raises `tenant-assets` to **32 MiB** (`33554432`). The gap over the 16 MiB
budget is the point: our own check has to fire first, so the failure is one we
can phrase.

That migration reaches every stack the Supabase CLI manages — a developer's
local stack and the fs-sites-01 box — through the normal CI sync. It does
**not** reach the hosted Supabase project behind the pinned Netlify deploy,
which is not run by the CLI migration runner.

**The hosted project needs the same value set by hand, once:**

1. Supabase dashboard → the production project → **Storage** → `tenant-assets`.
2. **Settings** (the bucket's own settings, not the project's) →
   **File size limit**.
3. Set it to `32 MiB`. Leave the allowed MIME types alone —
   `application/gzip` and `application/json` are already on the list and are
   what a packed preview needs.
4. Save, then confirm:
   ```sql
   select id, file_size_limit from storage.buckets where id = 'tenant-assets';
   -- expect 33554432
   ```

Until that is done, production previews are still capped at 10 MiB by the
object store. The 16 MiB budget check will not fire first there, so an
oversized preview in production fails with Supabase's own opaque sentence
rather than ours — which is the exact condition this page exists to close.

The per-file refusal on the client image upload route (8 MiB, matching
`assertSafeUploadedImage`) is unrelated and unchanged. A client photograph is
still bounded where it always was.
