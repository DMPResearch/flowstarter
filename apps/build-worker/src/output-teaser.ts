/**
 * The on-disk half of the `TEASER_IN_PAID_BUILD` gate.
 *
 * The funnel preview teaser blurs the lower half of every page and overlays a
 * chip offering to sell the visitor the rest of the site. It belongs to the
 * free preview and nowhere else. A paid build seeds from the approved preview
 * manifest, which carries the teaser, so the strip that removes it upstream is
 * one step in a chain and this is the check that the chain held.
 *
 * It reads the compiled output, not the source: the question is what the
 * client's browser would load, and a teaser reference can arrive through a
 * layout, a bundled stylesheet or a page the agent hand-wrote.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  isPreviewTeaserAsset,
  PREVIEW_TEASER_MARKER,
  PREVIEW_TEASER_OVERLAY_CLASSES,
} from '@flowstarter/agentic-codegen';

/** Never part of a deployable site, and never worth walking. */
const SKIPPED_DIRS = new Set([
  '.git',
  'node_modules',
  '.astro',
  '.cache',
  '.turbo',
  '.next',
  '.vercel',
  '.netlify',
]);

/** What a browser would actually parse. Images cannot carry an overlay. */
const TEXT_OUTPUT = /\.(html?|css|js|mjs|cjs|json|xml|txt|webmanifest)$/i;

/** A whole `dist/` of text is cheap; a runaway read of one file is not. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Every compiled path that still references the teaser, relative to `dir` and
 * in posix form. Empty means the build is clean.
 */
export async function findPreviewTeaserInDir(dir: string): Promise<string[]> {
  const hits: string[] = [];

  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      const rel = relative(dir, absolute).split(sep).join('/');
      // The teaser's own asset files are a hit by their name alone; their
      // contents do not have to be read to know they should not be here.
      if (isPreviewTeaserAsset(rel) || rel.includes(PREVIEW_TEASER_MARKER)) {
        hits.push(rel);
        continue;
      }
      if (!TEXT_OUTPUT.test(rel)) continue;

      let content: string;
      try {
        content = await readFile(absolute, 'utf8');
      } catch {
        continue;
      }
      if (content.length > MAX_FILE_BYTES) continue;
      if (
        content.includes(PREVIEW_TEASER_MARKER) ||
        PREVIEW_TEASER_OVERLAY_CLASSES.some((name) => content.includes(name))
      ) {
        hits.push(rel);
      }
    }
  };

  await walk(dir);
  return hits.sort();
}
