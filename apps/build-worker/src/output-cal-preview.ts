/**
 * The on-disk half of the `CAL_PREVIEW_IN_PAID_BUILD` gate.
 *
 * The funnel preview's blurred calendar demo belongs to the free preview and
 * nowhere else. A paid build or client rebuild seeds from the approved
 * preview manifest, which carries the demo whenever the workspace had no
 * booking link at preview time, so `injectCalCom` is the step that removes it
 * (or upgrades it to the live embed) upstream; this is the check that it
 * held. Structured identically to `output-teaser.ts`, which the same defect
 * shape — a funnel-only artefact surviving into a paid site — already has a
 * gate for.
 *
 * It reads the compiled output, not the source: the question is what the
 * client's browser would load, and the marker can arrive through any page
 * the injector or its fallback touched.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  CAL_PREVIEW_COMMENT,
  CAL_PREVIEW_MARKER_ATTRIBUTE,
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

/** What a browser would actually parse. Images cannot carry a marker. */
const TEXT_OUTPUT = /\.(html?|css|js|mjs|cjs|json|xml|txt|webmanifest)$/i;

/** A whole `dist/` of text is cheap; a runaway read of one file is not. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Every compiled path that still references the blurred booking demo,
 * relative to `dir` and in posix form. Empty means the build is clean.
 */
export async function findCalPreviewInDir(dir: string): Promise<string[]> {
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
      if (!TEXT_OUTPUT.test(entry.name)) continue;

      const rel = relative(dir, absolute).split(sep).join('/');
      let content: string;
      try {
        content = await readFile(absolute, 'utf8');
      } catch {
        continue;
      }
      if (content.length > MAX_FILE_BYTES) continue;
      if (
        content.includes(`${CAL_PREVIEW_MARKER_ATTRIBUTE}="true"`) ||
        content.includes(CAL_PREVIEW_COMMENT)
      ) {
        hits.push(rel);
      }
    }
  };

  await walk(dir);
  return hits.sort();
}
