/**
 * The `CAL_PREVIEW_IN_PAID_BUILD` gate: the on-disk half of the rule
 * `injectCalCom` already enforces in memory (see `../integrations.ts`).
 *
 * `injectCalComPreviewDemo` blurs a static calendar mock into a funnel
 * preview — a teaser, and only a teaser. A paid `FULL_SITE_BUILD` and every
 * `SITE_REBUILD` seed their worktree from the approved preview manifest,
 * which carries that demo whenever the workspace had no booking link at
 * preview time: rule 5 of `page-set.ts` drops `book.astro` in that case, and
 * the demo injector's own fallback then lands the block on whichever
 * candidate page is left — typically `contact.astro`. `injectCalCom` is the
 * step responsible for taking it back out (or upgrading it to the live
 * embed) before that seed reaches a client. This is the check that it did.
 *
 * Modeled on `teaser-rule.ts` and its worker-side half,
 * `apps/build-worker/src/output-teaser.ts`: a pure marker check here, a
 * directory walk in `apps/build-worker/src/output-cal-preview.ts`, and the
 * validator gate wired in `apps/build-worker/src/validator.ts` right beside
 * the teaser one.
 */

/** The job fails with this when a paid build still carries the demo. */
export const CAL_PREVIEW_IN_PAID_BUILD = 'CAL_PREVIEW_IN_PAID_BUILD';

/** The attribute every preview-demo wrapper carries. */
export const CAL_PREVIEW_MARKER_ATTRIBUTE = 'data-flowstarter-cal-preview';

/** The HTML comment left inside the wrapper — a belt-and-braces match. */
export const CAL_PREVIEW_COMMENT = 'flowstarter:cal-preview';

/** True when this file's text still carries the funnel preview demo. */
export function hasCalPreviewMarker(content: string): boolean {
  return (
    content.includes(`${CAL_PREVIEW_MARKER_ATTRIBUTE}="true"`) ||
    content.includes(CAL_PREVIEW_COMMENT)
  );
}

/**
 * Paths in a compiled site that still carry the blurred booking demo. Empty
 * means the build is clean.
 */
export function findCalPreviewReferences(
  files: readonly { path: string; content: string }[],
): string[] {
  const hits: string[] = [];
  for (const file of files) {
    if (hasCalPreviewMarker(file.content)) hits.push(file.path);
  }
  return hits;
}

/** The gate's verdict, phrased once for the job log and for the agent. */
export function describeCalPreviewIssue(paths: readonly string[]): string {
  const listed = paths.slice(0, 10);
  const overflow =
    paths.length > listed.length
      ? `, and ${paths.length - listed.length} more`
      : '';
  return (
    `${CAL_PREVIEW_IN_PAID_BUILD}: the compiled site still carries the ` +
    "funnel preview's blurred demo calendar, which promises a booking " +
    'system the client either never connected or has already had upgraded ' +
    `to the real embed. Remove the "${CAL_PREVIEW_MARKER_ATTRIBUTE}" block ` +
    `from: ${listed.join(', ')}${overflow}.`
  );
}
