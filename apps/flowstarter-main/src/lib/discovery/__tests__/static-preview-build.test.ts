/**
 * The static build that replaced the Daytona sandbox as the publish step.
 *
 * No Astro is installed here and none is needed: the build is a FIXED command
 * at a fixed path inside the workspace, so a stub at that path exercises
 * exactly the contract the real one satisfies — cwd, arguments, environment,
 * exit code — and the assertions about the environment are the ones that
 * matter most, because this is the code path that runs generated code on the
 * app host.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildStaticPreview,
  collectDistFiles,
  StaticPreviewBuildError,
  templateRootDir,
} from '../static-preview-build';

const scratch: string[] = [];

afterEach(async () => {
  while (scratch.length) {
    await rm(scratch.pop() as string, { recursive: true, force: true });
  }
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * A workspace whose `node_modules/.bin/astro` is a shell script. `astro build`
 * writes `dist/`; anything else fails, which is how the fixed-command promise
 * is checked rather than asserted in a comment.
 */
async function workspaceWithStubAstro(script: string): Promise<string> {
  const root = await temp('fs-build-ws-');
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"site"}');
  const bin = join(root, 'node_modules', '.bin', 'astro');
  await writeFile(bin, script, 'utf8');
  await chmod(bin, 0o755);
  return root;
}

const WRITES_DIST = `#!/bin/sh
test "$1" = "build" || { echo "refused: $*" >&2; exit 3; }
mkdir -p dist/_astro
printf '<!doctype html><h1>Built</h1>' > dist/index.html
printf 'body{color:#111}' > dist/_astro/site.css
printf '\\x89PNG\\r\\n' > dist/hero.png
printf '%s' "$FLOWSTARTER_SECRET_PROBE" > dist/leaked.txt
printf '%s' "$NODE_ENV" > dist/node-env.txt
`;

describe('buildStaticPreview', () => {
  it('builds a copy and hands back the compiled site', async () => {
    const source = await workspaceWithStubAstro(WRITES_DIST);
    const build = await buildStaticPreview({
      projectId: 'e1d1c7a1-0000-4000-8000-000000000001',
      templateSlug: 'nowhere',
      workspaceRoot: source,
      timeoutMs: 20_000,
    });
    scratch.push(build.workspaceRoot);

    expect(build.workspaceRoot).not.toBe(source);
    expect(build.files.map((file) => file.path)).toContain('index.html');
    expect(
      build.files.find((file) => file.path === 'index.html')?.content
    ).toContain('Built');
    // Binary output is base64, not UTF-8. Reading a PNG as text is how every
    // image on a generated site is silently corrupted.
    expect(build.files.find((file) => file.path === 'hero.png')?.encoding).toBe(
      'base64'
    );
    // The source tree is untouched: the build never runs where the pipeline
    // or the edit loop is still working.
    expect(existsSync(join(source, 'dist'))).toBe(false);
  });

  it('leaves the app’s secrets out of tenant code', async () => {
    process.env.FLOWSTARTER_SECRET_PROBE = 'this-must-not-reach-the-build';
    try {
      const source = await workspaceWithStubAstro(WRITES_DIST);
      const build = await buildStaticPreview({
        projectId: 'e1d1c7a1-0000-4000-8000-000000000002',
        templateSlug: 'nowhere',
        workspaceRoot: source,
        timeoutMs: 20_000,
      });
      scratch.push(build.workspaceRoot);
      expect(
        build.files.find((file) => file.path === 'leaked.txt')?.content
      ).toBe('');
      expect(
        build.files.find((file) => file.path === 'node-env.txt')?.content
      ).toBe('production');
    } finally {
      delete process.env.FLOWSTARTER_SECRET_PROBE;
    }
  });

  it('runs `astro build` and nothing the generated manifest asks for', async () => {
    const source = await workspaceWithStubAstro(WRITES_DIST);
    // The stub exits 3 for any argument other than `build`; a pass proves the
    // command is fixed rather than read off the site's own package.json.
    await writeFile(
      join(source, 'package.json'),
      '{"scripts":{"build":"rm -rf /"}}'
    );
    const build = await buildStaticPreview({
      projectId: 'e1d1c7a1-0000-4000-8000-000000000003',
      templateSlug: 'nowhere',
      workspaceRoot: source,
      timeoutMs: 20_000,
    });
    scratch.push(build.workspaceRoot);
    expect(build.files.some((file) => file.path === 'index.html')).toBe(true);
  });

  it('cleans up the copy when the build fails, and says why', async () => {
    const source = await workspaceWithStubAstro(
      '#!/bin/sh\necho "Cannot find package \'astro-icon\'" >&2\nexit 1\n'
    );
    let copyRoot = '';
    await expect(
      buildStaticPreview({
        projectId: 'e1d1c7a1-0000-4000-8000-000000000004',
        templateSlug: 'nowhere',
        workspaceRoot: source,
        timeoutMs: 20_000,
      }).catch((error: Error) => {
        copyRoot = join(tmpdir(), 'flowstarter-preview-builds');
        expect(error).toBeInstanceOf(StaticPreviewBuildError);
        expect(error.message).toContain('did not build');
        expect(error.message).toContain('astro-icon');
        throw error;
      })
    ).rejects.toThrow(StaticPreviewBuildError);
    expect(
      existsSync(join(copyRoot, 'e1d1c7a1-0000-4000-8000-000000000004'))
    ).toBe(false);
  });

  it('kills a build that will not finish', async () => {
    const source = await workspaceWithStubAstro('#!/bin/sh\nsleep 30\n');
    await expect(
      buildStaticPreview({
        projectId: 'e1d1c7a1-0000-4000-8000-000000000005',
        templateSlug: 'nowhere',
        workspaceRoot: source,
        timeoutMs: 400,
      })
    ).rejects.toThrow(StaticPreviewBuildError);
  });

  it('reports a workspace with no build command rather than hanging', async () => {
    const source = await temp('fs-build-empty-');
    await writeFile(join(source, 'package.json'), '{}');
    await expect(
      buildStaticPreview({
        projectId: 'e1d1c7a1-0000-4000-8000-000000000006',
        templateSlug: 'nowhere',
        workspaceRoot: source,
        timeoutMs: 5_000,
      })
    ).rejects.toThrow(StaticPreviewBuildError);
  });

  it('rebuilds in place when handed a copy it already owns', async () => {
    const source = await workspaceWithStubAstro(WRITES_DIST);
    const first = await buildStaticPreview({
      projectId: 'e1d1c7a1-0000-4000-8000-000000000007',
      templateSlug: 'nowhere',
      workspaceRoot: source,
      timeoutMs: 20_000,
    });
    scratch.push(first.workspaceRoot);
    // What a free edit does: change the tree, then rebuild the same copy.
    await writeFile(
      join(first.workspaceRoot, 'node_modules', '.bin', 'astro'),
      WRITES_DIST.replace('<h1>Built</h1>', '<h1>Edited</h1>'),
      'utf8'
    );
    await chmod(
      join(first.workspaceRoot, 'node_modules', '.bin', 'astro'),
      0o755
    );

    const second = await buildStaticPreview({
      projectId: 'e1d1c7a1-0000-4000-8000-000000000007',
      templateSlug: 'nowhere',
      workspaceRoot: first.workspaceRoot,
      existingWorkspaceRoot: first.workspaceRoot,
      timeoutMs: 20_000,
    });
    expect(second.workspaceRoot).toBe(first.workspaceRoot);
    expect(
      second.files.find((file) => file.path === 'index.html')?.content
    ).toContain('Edited');
  });

  it('removes the copy when the caller cleans up, twice over', async () => {
    const source = await workspaceWithStubAstro(WRITES_DIST);
    const build = await buildStaticPreview({
      projectId: 'e1d1c7a1-0000-4000-8000-000000000008',
      templateSlug: 'nowhere',
      workspaceRoot: source,
      timeoutMs: 20_000,
    });
    await build.cleanup();
    await build.cleanup();
    expect(existsSync(build.workspaceRoot)).toBe(false);
  });
});

describe('collectDistFiles', () => {
  it('refuses a build with no root index.html', async () => {
    const dist = await temp('fs-dist-');
    await writeFile(join(dist, 'about.html'), '<h1>About</h1>');
    await expect(collectDistFiles(dist)).rejects.toThrow(/no root index\.html/);
  });

  it('sorts, so the same tree always packs to the same bytes', async () => {
    const dist = await temp('fs-dist-');
    await mkdir(join(dist, 'z'), { recursive: true });
    await writeFile(join(dist, 'index.html'), '<h1>x</h1>');
    await writeFile(join(dist, 'z', 'a.css'), 'a{}');
    await writeFile(join(dist, 'a.css'), 'b{}');
    const files = await collectDistFiles(dist);
    expect(files.map((file) => file.path)).toEqual([
      'a.css',
      'index.html',
      'z/a.css',
    ]);
  });

  it('refuses a tree nested deeper than the archive allows', async () => {
    const dist = await temp('fs-dist-');
    await writeFile(join(dist, 'index.html'), '<h1>x</h1>');
    const deep = join(dist, ...Array.from({ length: 22 }, (_, i) => `d${i}`));
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'x.txt'), 'deep');
    await expect(collectDistFiles(dist)).rejects.toThrow(/nested deeper/);
  });
});

describe('templateRootDir', () => {
  it('takes the configured root, and falls back to the sibling checkout', () => {
    expect(
      templateRootDir({ FLOWSTARTER_TEMPLATE_ROOT: '/srv/templates' })
    ).toBe('/srv/templates');
    expect(templateRootDir({})).toContain('flowstarter-templates');
  });
});
