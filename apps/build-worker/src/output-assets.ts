/**
 * The on-disk half of the `ASSET_NOT_BINARY` gate.
 *
 * The predicate lives in `@flowstarter/agentic-codegen` so the worker and
 * flowstarter-main's client publish route apply the same rule to the same
 * bytes. This walks a finished build directory and reads only the leading
 * bytes of the files whose names claim a raster format, which keeps a 60 MiB
 * `dist/` gate cheap: an image that is really an image is never read past its
 * header.
 *
 * A file that is *not* a raster asset is never opened at all.
 */

import { open, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  ASSET_SNIFF_BYTES,
  inspectRasterAsset,
  rasterExtension,
  type AssetProblem,
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

/**
 * A base64 payload is longer than any header, so a short read is enough to
 * decide: the signature check needs 12 bytes and the printable-ASCII verdict
 * is exact on a prefix (one non-printable byte anywhere in the prefix already
 * rules the file out of being text).
 */
const SNIFF_BYTES = Math.max(ASSET_SNIFF_BYTES, 64);

async function leadingBytes(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return new Uint8Array(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/**
 * Every raster asset under `dir` that is not the format its name claims, with
 * posix-relative paths so the message reads the way the site serves it.
 */
export async function findNonBinaryAssetsInDir(
  dir: string,
): Promise<AssetProblem[]> {
  const problems: AssetProblem[] = [];

  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }
      // Symlinks are skipped for the same reason the packager skips them:
      // the target may sit outside the tree and never reaches the artifact.
      if (!entry.isFile()) continue;
      if (!rasterExtension(entry.name)) continue;

      const rel = relative(dir, absolute).split(sep).join('/');
      const problem = inspectRasterAsset(rel, await leadingBytes(absolute));
      if (problem) problems.push(problem);
    }
  };

  await walk(dir);
  problems.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return problems;
}
