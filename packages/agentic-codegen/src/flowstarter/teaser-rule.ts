/**
 * The teaser is a funnel device, and only a funnel device.
 *
 * `injectPreviewTeaser` exists to make a free preview taste like the site
 * without giving the build away: it blurs the lower sections and overlays an
 * "Unlock the full site" chip. Everything here is the rule that keeps it on
 * that side of the line.
 *
 * A paid FULL_SITE_BUILD seeds its worktree from the approved preview
 * manifest, and that manifest is the preview *after* the teaser was injected:
 * two asset files under `public/`, and a link/script pair in every layout.
 * Nothing ever removed them, so a client who had paid in full got a site that
 * blurred its own lower half and offered to sell them the rest. Ten pages of
 * it.
 *
 * So the rule, stated: the teaser is injected only for a funnel preview; it is
 * stripped from the seed of every paid build and every client rebuild; and a
 * gate on the compiled output fails the job if either of those ever fails.
 *
 * This lives beside `preview-teaser.ts` rather than inside it because the
 * injector is preview-only by definition and this is the half that the paid
 * path depends on. Both agree on one marker string, exported from here and
 * re-checked against the injector by test.
 */

/** The job fails with this when a paid build still carries the teaser. */
export const TEASER_IN_PAID_BUILD = 'TEASER_IN_PAID_BUILD';

/** The one string every teaser artefact carries in its name. */
export const PREVIEW_TEASER_MARKER = 'flowstarter-preview-teaser';

/** The files `injectPreviewTeaser` writes into the site's `public/` folder. */
export const PREVIEW_TEASER_ASSETS: readonly string[] = [
  `public/${PREVIEW_TEASER_MARKER}.css`,
  `public/${PREVIEW_TEASER_MARKER}.js`,
];

/**
 * Class names the teaser's own script puts into the DOM. A compiled page that
 * carries these was rendered with the overlay even if the asset was renamed,
 * so the gate looks for both.
 */
export const PREVIEW_TEASER_OVERLAY_CLASSES: readonly string[] = [
  'fs-teaser-locked',
  'fs-teaser-veil',
  'fs-teaser-gate',
  'fs-teaser-chip',
  'fs-teaser-cta',
];

/**
 * Removes the injected snippet from one file's text.
 *
 * Written as three narrow removals rather than one blunt "drop every line
 * mentioning the marker": the agent reformats layouts freely, and a rule that
 * deleted whole lines would take a neighbouring tag with it whenever the
 * snippet had been folded onto a shared line.
 */
export function stripPreviewTeaserFromText(source: string): string {
  const marker = PREVIEW_TEASER_MARKER;
  return source
    .replace(new RegExp(`[ \\t]*<!--\\s*${marker}\\s*-->\\n?`, 'gi'), '')
    .replace(
      new RegExp(`[ \\t]*<link\\b[^>]*${marker}\\.css[^>]*>\\n?`, 'gi'),
      '',
    )
    .replace(
      new RegExp(
        `[ \\t]*<script\\b[^>]*${marker}\\.js[^>]*>\\s*</script>\\n?`,
        'gi',
      ),
      '',
    );
}

/** True when this path is one of the teaser's own asset files. */
export function isPreviewTeaserAsset(path: string): boolean {
  const clean = path.replace(/^\.?\//, '');
  return (
    PREVIEW_TEASER_ASSETS.includes(clean) ||
    clean === `${PREVIEW_TEASER_MARKER}.css` ||
    clean === `${PREVIEW_TEASER_MARKER}.js`
  );
}

export interface StrippedTeaser<T> {
  files: T[];
  /** Teaser asset files dropped outright. */
  removedPaths: string[];
  /** Layouts and pages the link/script pair was cut out of. */
  cleanedPaths: string[];
}

/**
 * The seed a paid build actually gets: the approved preview with every trace
 * of the teaser taken back out.
 *
 * Base64 entries pass through untouched. The teaser is text, and decoding an
 * image to search it for a class name would be pointless and a way to corrupt
 * it.
 */
export function stripPreviewTeaserFromFiles<
  T extends { path: string; content: string; encoding?: 'base64' },
>(files: readonly T[]): StrippedTeaser<T> {
  const removedPaths: string[] = [];
  const cleanedPaths: string[] = [];
  const kept: T[] = [];

  for (const file of files) {
    if (isPreviewTeaserAsset(file.path)) {
      removedPaths.push(file.path);
      continue;
    }
    if (
      file.encoding === 'base64' ||
      !file.content.includes(PREVIEW_TEASER_MARKER)
    ) {
      kept.push(file);
      continue;
    }
    const content = stripPreviewTeaserFromText(file.content);
    if (content === file.content) {
      kept.push(file);
      continue;
    }
    cleanedPaths.push(file.path);
    kept.push({ ...file, content });
  }

  return { files: kept, removedPaths, cleanedPaths };
}

/**
 * Paths in a compiled site that still reference the teaser, by its asset name
 * or by the overlay markup its script leaves behind. Empty means clean.
 */
export function findPreviewTeaserReferences(
  files: readonly { path: string; content: string }[],
): string[] {
  const hits: string[] = [];
  for (const file of files) {
    if (isPreviewTeaserAsset(file.path)) {
      hits.push(file.path);
      continue;
    }
    if (file.content.includes(PREVIEW_TEASER_MARKER)) {
      hits.push(file.path);
      continue;
    }
    if (
      PREVIEW_TEASER_OVERLAY_CLASSES.some((name) => file.content.includes(name))
    ) {
      hits.push(file.path);
    }
  }
  return hits;
}

/** The gate's verdict, phrased once for the job log and for the agent. */
export function describePreviewTeaserIssue(paths: readonly string[]): string {
  const listed = paths.slice(0, 10);
  const overflow =
    paths.length > listed.length
      ? `, and ${paths.length - listed.length} more`
      : '';
  return (
    `${TEASER_IN_PAID_BUILD}: the compiled site still carries the funnel ` +
    'preview teaser, which blurs the lower half of every page and offers to ' +
    'sell the client a site they have already paid for. Remove the ' +
    `"${PREVIEW_TEASER_MARKER}" stylesheet and script and the fs-teaser-* ` +
    `overlay markup from: ${listed.join(', ')}${overflow}.`
  );
}
