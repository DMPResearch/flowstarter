/**
 * How big a preview artifact is allowed to be, and what happens when it isn't.
 *
 * On 2026-09-15 a generated portfolio preview was built, was correct, and was
 * never hosted. The container log said only:
 *
 *   [funnel-previews] could not upload artifact for 116965b1-…:
 *     The object exceeded the maximum allowed size
 *
 * That sentence is Supabase Storage's, not ours. The `tenant-assets` bucket
 * carries `file_size_limit = 10 MiB` (20260830140000_tenant_assets_storage_bucket.sql),
 * the portfolio template family's `dist/` was 11.35 MiB and packed to 11.05
 * MiB, and the upload was refused by the object store after the whole build
 * had been paid for. Nothing upstream knew a ceiling existed, so nothing could say which
 * ceiling it was, by how much, or that raising it was the fix. The visitor was
 * told "the build stopped".
 *
 * Three rules come out of that, and they are all here so they cannot drift:
 *
 *  - THE BUDGET IS OURS, NOT THE OBJECT STORE'S. A limit discovered by being
 *    refused is not a limit, it is an outage. The artifact is measured against
 *    {@link PREVIEW_ARTIFACT_BUDGET_BYTES} *before* the upload, so the failure
 *    is ours to phrase and ours to alert on.
 *  - THE BUCKET SITS ABOVE THE BUDGET, never level with it. If the two were
 *    equal, every artifact that failed our check would also have failed
 *    theirs, and the first thing an operator raising the budget would hit is
 *    the bucket — with the same opaque sentence. The headroom is what makes
 *    "raise FLOWSTARTER_PREVIEW_ARTIFACT_MAX_BYTES" a complete instruction.
 *  - THE BUDGET IS A CEILING, NOT A TARGET. A preview that reaches it is a
 *    bug somewhere else: `optimisePreviewDistImages` turns the template's
 *    unoptimised `public/` originals into WebP before anything is packed, and
 *    the real numbers after that step are under 1 MiB, not 11. The budget exists
 *    to catch the day that stops being true, loudly, before a visitor does.
 */

/**
 * 16 MiB.
 *
 * Seventeen times the largest artifact the optimiser actually produces today
 * (the portfolio family — the heaviest of the five — packs to 935.5 KiB once
 * its images are WebP), which is the point: a preview that gets anywhere near
 * this has gone wrong in a way worth being told about, and a preview carrying
 * a legitimate pile of client photographs still fits with room to spare.
 */
export const PREVIEW_ARTIFACT_BUDGET_BYTES = 16 * 1024 * 1024;

/**
 * 32 MiB — what `storage.buckets.file_size_limit` for `tenant-assets` is set
 * to by `20260915…_tenant_assets_bucket_limit.sql`.
 *
 * Exported so a test can assert the invariant this module exists to protect
 * (bucket > budget) rather than leaving it as a fact about two files nobody
 * reads together. The hosted Supabase project is NOT managed by the CLI and
 * needs the same value set by hand; see docs/operations/preview-artifacts.md.
 */
export const PREVIEW_ARTIFACT_BUCKET_LIMIT_BYTES = 32 * 1024 * 1024;

/** The env var an operator raises the budget with, in bytes. */
export const PREVIEW_ARTIFACT_BUDGET_ENV_VAR =
  'FLOWSTARTER_PREVIEW_ARTIFACT_MAX_BYTES';

/**
 * The budget in force, {@link PREVIEW_ARTIFACT_BUDGET_BYTES} unless
 * {@link PREVIEW_ARTIFACT_BUDGET_ENV_VAR} names a positive number of bytes.
 *
 * A value at or above the bucket limit is refused rather than honoured: an
 * operator who raises this past the object store has not raised anything, they
 * have moved the opaque failure back to where it was. Clamping silently would
 * hide that; so would obeying it.
 */
export function previewArtifactBudgetBytes(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[PREVIEW_ARTIFACT_BUDGET_ENV_VAR]?.trim();
  if (!raw) return PREVIEW_ARTIFACT_BUDGET_BYTES;
  const configured = Number(raw);
  if (!Number.isFinite(configured) || configured <= 0) {
    console.warn(
      `[funnel-previews] ${PREVIEW_ARTIFACT_BUDGET_ENV_VAR}="${raw}" is not a ` +
        `positive number of bytes; using the ${formatBytes(
          PREVIEW_ARTIFACT_BUDGET_BYTES
        )} default`
    );
    return PREVIEW_ARTIFACT_BUDGET_BYTES;
  }
  if (configured >= PREVIEW_ARTIFACT_BUCKET_LIMIT_BYTES) {
    console.warn(
      `[funnel-previews] ${PREVIEW_ARTIFACT_BUDGET_ENV_VAR}=${configured} is at ` +
        `or above the ${formatBytes(
          PREVIEW_ARTIFACT_BUCKET_LIMIT_BYTES
        )} storage bucket limit, which would put the refusal back inside ` +
        `Supabase where nothing can explain it; using ` +
        `${formatBytes(PREVIEW_ARTIFACT_BUDGET_BYTES)} instead. Raise the ` +
        `bucket first (docs/operations/preview-artifacts.md).`
    );
    return PREVIEW_ARTIFACT_BUDGET_BYTES;
  }
  return Math.floor(configured);
}

/** `11.35 MiB`. One decimal, because the difference that matters is tenths. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} bytes`;
  if (bytes < 1024) return `${bytes} bytes`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

export interface PreviewArtifactBudgetVerdict {
  withinBudget: boolean;
  bytes: number;
  budget: number;
  /**
   * Null when it fits. Otherwise the sentence the preview row, the container
   * log and the operator alert all carry — one string, so an operator reading
   * any of the three is reading the same fact.
   */
  detail: string | null;
}

/**
 * Measures one packed artifact against the budget.
 *
 * The failure sentence names three things on purpose: the actual size (so the
 * gap is visible), the budget (so the ceiling is not a mystery), and the env
 * var (so the next action does not have to be looked up). It never names the
 * bucket limit — an operator who needs it is already in the doc the alert
 * points at, and a number in a visitor-adjacent string is a number that will
 * be wrong one day.
 */
export function checkPreviewArtifactBudget(input: {
  bytes: number;
  budget?: number;
}): PreviewArtifactBudgetVerdict {
  const budget = input.budget ?? previewArtifactBudgetBytes();
  if (input.bytes <= budget) {
    return { withinBudget: true, bytes: input.bytes, budget, detail: null };
  }
  return {
    withinBudget: false,
    bytes: input.bytes,
    budget,
    detail:
      `the preview artifact is ${formatBytes(input.bytes)}, over the ` +
      `${formatBytes(budget)} artifact budget, so it was not uploaded; ` +
      `the manifest is still claimable. Raise ` +
      `${PREVIEW_ARTIFACT_BUDGET_ENV_VAR} if this size is legitimate ` +
      `(docs/operations/preview-artifacts.md)`,
  };
}
