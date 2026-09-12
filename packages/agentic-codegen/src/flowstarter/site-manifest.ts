/**
 * Reading a site workspace off disk as the manifest that represents it.
 *
 * `materializeScaffold` turns a manifest into a directory; this is the other
 * direction, and it is needed wherever an agent or an edit runner has changed
 * files and those changed files have to become the record: the funnel's free
 * edits, and a paid change request's build, which ends by saving what the
 * agents wrote as the site's next version.
 *
 * Two rules, both learned the hard way and both shared rather than re-typed
 * per caller:
 *
 *   - Tooling and build state is skipped, by the one rule in
 *     `preview-manifest.ts`. A dev server's `.astro/` scratch directory in the
 *     manifest of record is how a paid build came to be failed for not
 *     containing a process id.
 *   - Binary files are read as bytes and flagged `base64`. Reading a JPEG as
 *     UTF-8 yields NUL bytes, which Postgres jsonb refuses outright, and the
 *     half of it that survives is an image that is no longer an image.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isPreviewToolingPath } from './preview-manifest';
import type { TemplateScaffoldFile } from './types';

/**
 * Extensions whose bytes must never be decoded as text. Deliberately the same
 * list the deploy packer and the dropped-edit check use: a file that is binary
 * for one of them is binary for all of them.
 */
export const BINARY_MANIFEST_EXTENSIONS: ReadonlySet<string> = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.bmp',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.pdf',
  '.mp4',
  '.webm',
  '.mp3',
  '.zip',
  '.gz',
]);

export function isBinaryManifestPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return (
    dot >= 0 && BINARY_MANIFEST_EXTENSIONS.has(path.slice(dot).toLowerCase())
  );
}

/**
 * Every file under `root` that belongs to the client's site, as a manifest.
 *
 * A pruned directory is never walked, so a `node_modules` nobody needs is not
 * read at all rather than read and discarded.
 */
export async function readSiteWorkspaceFiles(
  root: string,
): Promise<TemplateScaffoldFile[]> {
  const files: TemplateScaffoldFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      if (isPreviewToolingPath(path)) continue;
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isBinaryManifestPath(path)) {
        files.push({
          path,
          content: (await readFile(absolute)).toString('base64'),
          encoding: 'base64',
          type: 'file',
        });
      } else {
        files.push({
          path,
          content: await readFile(absolute, 'utf8'),
          type: 'file',
        });
      }
    }
  };
  await walk(root);
  return files;
}
