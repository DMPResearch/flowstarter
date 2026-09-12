/**
 * The on-disk half of the `PLACEHOLDER_IMAGE_SHIPPED` gate.
 *
 * `findPlaceholderImageIssue` in `@flowstarter/agentic-codegen` runs during
 * the agent pass and can only read text, so it catches a placeholder by the
 * path a page points at. This is the gate of record: it reads the compiled
 * `dist/` directly, so it catches a placeholder by the bytes it actually is —
 * by content hash regardless of what the file was renamed to, and by the
 * `placeholder-` naming convention a future template follows before this
 * repository's manifest is ever updated for it. Structured like
 * `output-teaser.ts` and `output-assets.ts`, which read the same directory
 * for the same reason: the question is what the client's browser would load.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  findPlaceholderImageByFilename,
  findPlaceholderImageByHash,
  findPlaceholderImageMarkersInText,
  isGatedPlaceholderImageRole,
  type PlaceholderImageFinding,
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

/** What a browser would actually parse for the marker attribute. */
const TEXT_OUTPUT = /\.(html?|css|js|mjs|cjs|json|xml)$/i;

/** Image extensions worth hashing. */
const IMAGE_OUTPUT = /\.(svg|png|jpe?g|webp|gif)$/i;

/** A whole `dist/` of text is cheap; a runaway read of one file is not. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

/**
 * None of the known placeholders exceed a few megabytes; a raster file past
 * this is almost certainly real photography, not a stand-in, and hashing a
 * multi-hundred-megabyte hero video some future template ships would be a
 * pointless read on every build.
 */
const MAX_IMAGE_HASH_BYTES = 8 * 1024 * 1024;

/**
 * Every gated placeholder-image finding under `dir`, relative to it and in
 * posix form. Empty means the build is clean.
 */
export async function findPlaceholderImagesInDir(
  dir: string,
): Promise<PlaceholderImageFinding[]> {
  const findings: PlaceholderImageFinding[] = [];

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

      const byName = findPlaceholderImageByFilename(rel);
      if (byName) findings.push(byName);

      if (IMAGE_OUTPUT.test(rel)) {
        try {
          const info = await stat(absolute);
          if (info.size <= MAX_IMAGE_HASH_BYTES) {
            const bytes = await readFile(absolute);
            const byHash = findPlaceholderImageByHash(rel, bytes);
            // Do not double-count a file already caught by its filename.
            if (byHash && !byName) findings.push(byHash);
          }
        } catch {
          // An unreadable file cannot be a shipped placeholder either.
        }
        continue;
      }

      if (!TEXT_OUTPUT.test(rel)) continue;
      let content: string;
      try {
        content = await readFile(absolute, 'utf8');
      } catch {
        continue;
      }
      if (content.length > MAX_TEXT_BYTES) continue;
      for (const marker of findPlaceholderImageMarkersInText(rel, content)) {
        if (isGatedPlaceholderImageRole(marker.role)) findings.push(marker);
      }
    }
  };

  await walk(dir);
  findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return findings;
}
