import 'server-only';

/**
 * Reading a live preview workspace off disk as a manifest.
 *
 * This used to live inside the live-preview route, which was the only caller.
 * It is shared now because the free-edit route needs the same read: after an
 * edit runner has changed the workspace, the *edited* files are what a claim —
 * and therefore the paid build — must be seeded from, and re-reading the
 * workspace is how they are captured.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { TemplateScaffoldFile } from '@flowstarter/agentic-codegen/src/flowstarter/types';

/**
 * Files that must never be read as text. Reading a JPEG as UTF-8 yields NUL
 * bytes, which Postgres jsonb refuses ("unsupported Unicode escape
 * sequence") — one image in the manifest lost the whole funnel_previews row,
 * and the tarball packed the same mangled bytes as the site's images.
 */
const BINARY_PREVIEW_EXTENSIONS = new Set([
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

export function isBinaryPreviewPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return (
    dot >= 0 && BINARY_PREVIEW_EXTENSIONS.has(path.slice(dot).toLowerCase())
  );
}

export async function readPreviewWorkspaceFiles(
  root: string
): Promise<TemplateScaffoldFile[]> {
  const files: TemplateScaffoldFile[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.git'))
        continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const path = relative(root, absolute).split(sep).join('/');
        if (isBinaryPreviewPath(path)) {
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
    }
  }
  await walk(root);
  return files;
}
