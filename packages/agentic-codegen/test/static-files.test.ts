/**
 * The screenshot server's file table (`test/lib/static-files.mjs`).
 *
 * The server used to join the request path onto the dist directory and then
 * check the result had not escaped. It now serves from a table built by
 * walking the build output, so the traversal payloads below cannot resolve to
 * anything: there is no key for them.
 */
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  collectServableFiles,
  lookupServableFile,
} from './lib/static-files.mjs';

let root = '';
let files = new Map<string, string>();

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'shoot-static-'));
  const secret = join(base, 'secret.txt');
  await writeFile(secret, 'not servable');

  root = join(base, 'dist');
  await mkdir(join(root, '_astro'), { recursive: true });
  await mkdir(join(root, 'about'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<h1>home</h1>');
  await writeFile(join(root, '_astro', 'app.css'), 'body{}');
  await writeFile(join(root, 'about', 'index.html'), '<h1>about</h1>');
  await symlink(secret, join(root, 'leak.txt'));

  files = await collectServableFiles(root);
});

describe('collectServableFiles', () => {
  it('lists every regular file under the build output', () => {
    expect([...files.keys()].sort()).toEqual([
      '/_astro/app.css',
      '/about/index.html',
      '/index.html',
    ]);
  });

  it('never points outside the build output', () => {
    const inside = resolve(root);
    for (const value of files.values()) {
      expect(value.startsWith(inside)).toBe(true);
    }
  });
});

describe('lookupServableFile', () => {
  it('serves the pages and assets the screenshots need', () => {
    expect(lookupServableFile(files, '/')).toBe(join(root, 'index.html'));
    expect(lookupServableFile(files, '/index.html')).toBe(
      join(root, 'index.html'),
    );
    expect(lookupServableFile(files, '/_astro/app.css')).toBe(
      join(root, '_astro', 'app.css'),
    );
    expect(lookupServableFile(files, '/about')).toBe(
      join(root, 'about', 'index.html'),
    );
    expect(lookupServableFile(files, '/about/')).toBe(
      join(root, 'about', 'index.html'),
    );
    expect(lookupServableFile(files, '/index.html?v=2#top')).toBe(
      join(root, 'index.html'),
    );
  });

  it.each([
    ['dot-dot traversal', '/../secret.txt'],
    ['nested dot-dot traversal', '/_astro/../../secret.txt'],
    ['encoded dot-dot traversal', '/%2e%2e/secret.txt'],
    ['encoded separator', '/..%2fsecret.txt'],
    ['an absolute path', '//etc/passwd'],
    ['a symlink out of the tree', '/leak.txt'],
    ['a file that does not exist', '/nope.html'],
    ['a malformed escape', '/%zz'],
    ['a path with no leading slash', 'index.html'],
  ])('refuses %s', (_label, requestUrl) => {
    expect(lookupServableFile(files, requestUrl)).toBeNull();
  });

  it('treats a request with no URL as the root page', () => {
    expect(lookupServableFile(files, undefined)).toBe(join(root, 'index.html'));
    expect(lookupServableFile(new Map(), undefined)).toBeNull();
  });
});
