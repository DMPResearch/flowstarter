/**
 * The containment rule for a build's output, proved against the four ways a
 * build can lie about where its output is.
 *
 * Every one of these is something generated code can do: `dist/` is produced
 * by the site's own Astro config and whatever the install resolved, and the
 * privileged worker opens it on the host after the container is gone. A
 * `stat()` was all that stood between an absolute symlink and the packager.
 */

import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_OUTPUT_EXPORT_LIMITS,
  exportBuiltSite,
  isContained,
  resolveContainedOutputDir,
  SiteOutputContainmentError,
} from '../src/flowstarter/site-export';

const execFileAsync = promisify(execFile);
const temporary: string[] = [];

afterEach(async () => {
  for (const dir of temporary.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'flowstarter-site-export-'));
  temporary.push(root);
  return root;
}

describe('resolveContainedOutputDir', () => {
  it('answers with the build output when the build produced one', async () => {
    const root = await workspace();
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist/index.html'), '<h1>built</h1>', 'utf8');
    expect(await resolveContainedOutputDir(root, 'dist')).toBe(
      join(root, 'dist'),
    );
  });

  it('answers null when nothing compiled, which is the plain-HTML path', async () => {
    const root = await workspace();
    expect(await resolveContainedOutputDir(root, 'dist')).toBeNull();
  });

  it('refuses an output root that is a symlink to an absolute host path', async () => {
    const root = await workspace();
    const elsewhere = await workspace();
    await writeFile(join(elsewhere, 'secret.txt'), 'another client', 'utf8');
    // The attack in the finding: the build replaces its own output directory
    // with a link, and the worker follows it on the host minutes later.
    await symlink(elsewhere, join(root, 'dist'), 'dir');

    await expect(
      resolveContainedOutputDir(root, 'dist'),
    ).rejects.toBeInstanceOf(SiteOutputContainmentError);
    await expect(resolveContainedOutputDir(root, 'dist')).rejects.toThrow(
      /symbolic link/,
    );
  });

  it('refuses a symlink on the way to the output, not only at the end of it', async () => {
    const root = await workspace();
    const elsewhere = await workspace();
    await mkdir(join(elsewhere, 'dist'));
    await writeFile(join(elsewhere, 'dist/index.html'), 'elsewhere', 'utf8');
    await symlink(elsewhere, join(root, 'build'), 'dir');

    await expect(
      resolveContainedOutputDir(root, 'build/dist'),
    ).rejects.toBeInstanceOf(SiteOutputContainmentError);
  });

  it('refuses an output name that walks out of the site root', async () => {
    const root = await workspace();
    await expect(
      resolveContainedOutputDir(root, '../neighbour/dist'),
    ).rejects.toBeInstanceOf(SiteOutputContainmentError);
    await expect(
      resolveContainedOutputDir(root, '/etc'),
    ).rejects.toBeInstanceOf(SiteOutputContainmentError);
  });
});

describe('exportBuiltSite', () => {
  it('copies the build into a fresh directory the caller did not name', async () => {
    const root = await workspace();
    const exports = await workspace();
    await mkdir(join(root, 'dist/assets'), { recursive: true });
    await writeFile(join(root, 'dist/index.html'), '<h1>built</h1>', 'utf8');
    await writeFile(join(root, 'dist/assets/app.js'), 'console.log(1)', 'utf8');

    const exported = await exportBuiltSite({
      sourceDir: join(root, 'dist'),
      destinationParent: exports,
    });

    expect(isContained(exports, exported.path)).toBe(true);
    expect(exported.path).not.toBe(exports);
    expect(exported.files).toBe(2);
    expect(await readFile(join(exported.path, 'index.html'), 'utf8')).toBe(
      '<h1>built</h1>',
    );
    expect(await readdir(join(exported.path, 'assets'))).toEqual(['app.js']);
    // The copy is the worker's, not the build's: a site that is still writing
    // into its worktree cannot reach what the scanners are about to read.
    await writeFile(join(root, 'dist/index.html'), 'changed after', 'utf8');
    expect(await readFile(join(exported.path, 'index.html'), 'utf8')).toBe(
      '<h1>built</h1>',
    );
  });

  it('refuses a symlink inside the output rather than following it', async () => {
    const root = await workspace();
    const exports = await workspace();
    const elsewhere = await workspace();
    await writeFile(join(elsewhere, 'secret.txt'), 'another client', 'utf8');
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist/index.html'), 'ok', 'utf8');
    await symlink(join(elsewhere, 'secret.txt'), join(root, 'dist/leak.txt'));

    await expect(
      exportBuiltSite({
        sourceDir: join(root, 'dist'),
        destinationParent: exports,
      }),
    ).rejects.toBeInstanceOf(SiteOutputContainmentError);
  });

  it('refuses a special file, which no static site has a use for', async () => {
    const root = await workspace();
    const exports = await workspace();
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist/index.html'), 'ok', 'utf8');
    // A fifo blocks whoever opens it: a scanner reading one waits forever.
    await execFileAsync('mkfifo', [join(root, 'dist/pipe')]);

    await expect(
      exportBuiltSite({
        sourceDir: join(root, 'dist'),
        destinationParent: exports,
      }),
    ).rejects.toThrow(/special file/);
  });

  it('refuses an output replaced by a link after the build finished', async () => {
    const root = await workspace();
    const exports = await workspace();
    const elsewhere = await workspace();
    await writeFile(join(elsewhere, 'secret.txt'), 'another client', 'utf8');
    await mkdir(join(root, 'dist/pages'), { recursive: true });
    await writeFile(join(root, 'dist/index.html'), 'ok', 'utf8');

    // Resolved while the tree was honest, and swapped underneath before the
    // copy — the window between the check and the read.
    const output = await resolveContainedOutputDir(root, 'dist');
    expect(output).not.toBeNull();
    await rm(join(root, 'dist/pages'), { recursive: true, force: true });
    await symlink(elsewhere, join(root, 'dist/pages'), 'dir');

    await expect(
      exportBuiltSite({
        sourceDir: output as string,
        destinationParent: exports,
      }),
    ).rejects.toBeInstanceOf(SiteOutputContainmentError);
  });

  it('refuses a build past the configured file and byte budgets', async () => {
    const root = await workspace();
    const exports = await workspace();
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist/a.html'), 'a'.repeat(64), 'utf8');
    await writeFile(join(root, 'dist/b.html'), 'b'.repeat(64), 'utf8');

    await expect(
      exportBuiltSite({
        sourceDir: join(root, 'dist'),
        destinationParent: exports,
        limits: { maxFiles: 1 },
      }),
    ).rejects.toThrow(/more than 1 files/);
    await expect(
      exportBuiltSite({
        sourceDir: join(root, 'dist'),
        destinationParent: exports,
        limits: { maxBytes: 64 },
      }),
    ).rejects.toThrow(/exceeds 64 bytes/);
    // The defaults are budgets, not opinions: they are what the packager has
    // always enforced, one stage later.
    expect(DEFAULT_OUTPUT_EXPORT_LIMITS.maxFiles).toBeGreaterThan(0);
  });

  it('refuses a build nested deeper than the configured depth', async () => {
    const root = await workspace();
    const exports = await workspace();
    await mkdir(join(root, 'dist/a/b/c'), { recursive: true });
    await writeFile(join(root, 'dist/a/b/c/index.html'), 'deep', 'utf8');
    await chmod(join(root, 'dist'), 0o700);

    await expect(
      exportBuiltSite({
        sourceDir: join(root, 'dist'),
        destinationParent: exports,
        limits: { maxDepth: 2 },
      }),
    ).rejects.toThrow(/nests deeper than 2/);
  });
});
