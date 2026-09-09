/**
 * The static file table the screenshot server serves from.
 *
 * A request URL never becomes a filesystem path here. The table is built once
 * by walking the build output, so every path that can be read came from a
 * directory listing; a request can only pick a key that is already in the
 * table. `..`, an encoded separator or an absolute path have nothing to
 * escape into, because nothing joins them to anything.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Maps `/index.html`, `/_astro/app.css`, ... to the absolute file that serves
 * them. Symlinks are skipped: only regular files under `root` are servable.
 *
 * @param {string} root absolute path of the build output
 * @param {string} [prefix] URL prefix of the directory being walked
 * @param {Map<string, string>} [files] accumulator
 * @returns {Promise<Map<string, string>>}
 */
export async function collectServableFiles(
  root,
  prefix = '',
  files = new Map(),
) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = join(root, entry.name);
    const urlPath = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectServableFiles(absolute, urlPath, files);
    } else if (entry.isFile()) {
      files.set(urlPath, absolute);
    }
  }
  return files;
}

/**
 * The file a request URL serves, or null when the table has no such entry.
 * A directory request falls back to its `index.html`, the way a static host
 * serves `/about` and `/about/`.
 *
 * @param {Map<string, string>} files table from {@link collectServableFiles}
 * @param {string | undefined} requestUrl `req.url`
 * @returns {string | null}
 */
export function lookupServableFile(files, requestUrl) {
  let key;
  try {
    key = decodeURIComponent((requestUrl ?? '/').split('?')[0].split('#')[0]);
  } catch {
    // A malformed percent escape is not a file we serve.
    return null;
  }
  if (!key.startsWith('/')) return null;

  const direct = files.get(key);
  if (direct !== undefined) return direct;

  const withoutTrailingSlash = key.endsWith('/') ? key.slice(0, -1) : key;
  return files.get(`${withoutTrailingSlash}/index.html`) ?? null;
}
