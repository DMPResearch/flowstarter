/**
 * The static build that replaced the Daytona sandbox as the publish step.
 *
 * No Astro is installed here and none is needed: the build is a FIXED command
 * at a fixed path inside the workspace, so a stub at that path exercises
 * exactly the contract the real one satisfies — cwd, arguments, environment,
 * exit code — and the assertions about the environment are the ones that
 * matter most, because this is the code path that runs generated code on the
 * app host.
 *
 * The stub lives under a `FLOWSTARTER_TEMPLATE_ROOT` of its own, not inside
 * the workspace passed in as `workspaceRoot` — deliberately, because
 * `buildStaticPreview` never installs into the workspace it's handed, it
 * symlinks `node_modules` in from the configured template root exactly like
 * production does. A stub placed directly inside the workspace would let a
 * regression where the build re-derives the CLI's path from the workspace
 * copy (rather than the template root) pass anyway — see 'invokes the CLI
 * at its own real path' below for the test that exists precisely because
 * that regression already shipped once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
const TEMPLATE_SLUG = 'nowhere';
let templateRoot = '';
let previousTemplateRootEnv: string | undefined;

beforeEach(async () => {
  const shallow = await mkdtemp(join(tmpdir(), 'fs-template-root-'));
  scratch.push(shallow);
  // Nested a fixed two levels deeper than a bare mkdtemp dir, so this is
  // never, even by coincidence, the same depth from `/` as
  // `join(tmpdir(), PREVIEW_BUILD_PARENT, projectId)` — the workspace
  // copy's own depth. The regression this file guards against (see
  // 'invokes the CLI at its own real path' below) is specifically a
  // depth-dependent one; a template root that happened to match the
  // workspace copy's depth would let it pass by accident.
  templateRoot = join(shallow, 'nested', 'deeper');
  await mkdir(templateRoot, { recursive: true });
  previousTemplateRootEnv = process.env.FLOWSTARTER_TEMPLATE_ROOT;
  process.env.FLOWSTARTER_TEMPLATE_ROOT = templateRoot;
});

afterEach(async () => {
  if (previousTemplateRootEnv === undefined) {
    delete process.env.FLOWSTARTER_TEMPLATE_ROOT;
  } else {
    process.env.FLOWSTARTER_TEMPLATE_ROOT = previousTemplateRootEnv;
  }
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
 * Writes `astro` as a shell script at TEMPLATE_SLUG's own `node_modules/.bin`
 * under this test's `FLOWSTARTER_TEMPLATE_ROOT` — never inside a workspace
 * copy, which is the whole point (see the file header).
 */
async function stubAstro(script: string): Promise<void> {
  const binDir = join(templateRoot, TEMPLATE_SLUG, 'node_modules', '.bin');
  await mkdir(binDir, { recursive: true });
  const bin = join(binDir, 'astro');
  await writeFile(bin, script, 'utf8');
  await chmod(bin, 0o755);
}

/**
 * A plain workspace (no `node_modules` of its own — `buildStaticPreview`
 * symlinks that in from the stub above) whose `astro build` writes `dist/`;
 * anything else fails, which is how the fixed-command promise is checked
 * rather than asserted in a comment.
 */
async function workspaceWithStubAstro(script: string): Promise<string> {
  await stubAstro(script);
  const root = await temp('fs-build-ws-');
  await writeFile(join(root, 'package.json'), '{"name":"site"}');
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

  it('keeps a distinguishing marker near the front AND the back of a long build failure', async () => {
    // A synthetic failure well over both the head and tail byte budgets: a
    // real `[ERROR] ...` message at the very start, ~200 padding lines that
    // a naive `.slice(-N)` tail would let bury it, then the stack frame that
    // shows where the build actually died at the very end.
    const script = `#!/bin/sh
{
  echo "[ERROR] TypeError: Cannot read properties of undefined (reading 'image')"
  echo "    at renderImage (/workspace/src/components/Hero.astro:42:18)"
  i=0
  while [ $i -lt 200 ]; do
    echo "padding line $i to push the real message out of a naive tail slice"
    i=$((i+1))
  done
  echo "    at AstroComponentInstance.render (.../server_abc123.mjs:6652:28)"
} >&2
exit 1
`;
    const source = await workspaceWithStubAstro(script);
    let thrown: StaticPreviewBuildError | undefined;
    await buildStaticPreview({
      projectId: 'e1d1c7a1-0000-4000-8000-00000000000a',
      templateSlug: 'nowhere',
      workspaceRoot: source,
      timeoutMs: 20_000,
    }).catch((error: StaticPreviewBuildError) => {
      thrown = error;
    });
    expect(thrown).toBeInstanceOf(StaticPreviewBuildError);
    expect(thrown?.message.length).toBeGreaterThan(2_600);
    expect(thrown?.message).toContain(
      "[ERROR] TypeError: Cannot read properties of undefined (reading 'image')"
    );
    expect(thrown?.message).toContain(
      'at AstroComponentInstance.render (.../server_abc123.mjs:6652:28)'
    );
  });

  it('respects a configured head budget, cutting off before the front marker when it is set small', async () => {
    const script = `#!/bin/sh
{
  echo "[ERROR] TypeError: Cannot read properties of undefined (reading 'image')"
  i=0
  while [ $i -lt 200 ]; do
    echo "padding line $i to push the real message out of a naive tail slice"
    i=$((i+1))
  done
  echo "    at AstroComponentInstance.render (.../server_abc123.mjs:6652:28)"
} >&2
exit 1
`;
    const source = await workspaceWithStubAstro(script);
    let thrown: StaticPreviewBuildError | undefined;
    await buildStaticPreview({
      projectId: 'e1d1c7a1-0000-4000-8000-00000000000b',
      templateSlug: 'nowhere',
      workspaceRoot: source,
      timeoutMs: 20_000,
      headBytes: 10,
    }).catch((error: StaticPreviewBuildError) => {
      thrown = error;
    });
    expect(thrown).toBeInstanceOf(StaticPreviewBuildError);
    // A 10-byte head cannot contain the whole marker.
    expect(thrown?.message).not.toContain(
      "TypeError: Cannot read properties of undefined (reading 'image')"
    );
    // The tail budget is untouched, so the back of the failure still shows.
    expect(thrown?.message).toContain(
      'at AstroComponentInstance.render (.../server_abc123.mjs:6652:28)'
    );
  });

  it('respects FLOWSTARTER_PREVIEW_BUILD_ERROR_HEAD_BYTES when no explicit override is given', async () => {
    const script = `#!/bin/sh
{
  echo "[ERROR] TypeError: Cannot read properties of undefined (reading 'image')"
  i=0
  while [ $i -lt 200 ]; do
    echo "padding line $i to push the real message out of a naive tail slice"
    i=$((i+1))
  done
  echo "    at AstroComponentInstance.render (.../server_abc123.mjs:6652:28)"
} >&2
exit 1
`;
    const source = await workspaceWithStubAstro(script);
    const previous = process.env.FLOWSTARTER_PREVIEW_BUILD_ERROR_HEAD_BYTES;
    process.env.FLOWSTARTER_PREVIEW_BUILD_ERROR_HEAD_BYTES = '10';
    let thrown: StaticPreviewBuildError | undefined;
    try {
      await buildStaticPreview({
        projectId: 'e1d1c7a1-0000-4000-8000-00000000000c',
        templateSlug: 'nowhere',
        workspaceRoot: source,
        timeoutMs: 20_000,
      }).catch((error: StaticPreviewBuildError) => {
        thrown = error;
      });
    } finally {
      if (previous === undefined) {
        delete process.env.FLOWSTARTER_PREVIEW_BUILD_ERROR_HEAD_BYTES;
      } else {
        process.env.FLOWSTARTER_PREVIEW_BUILD_ERROR_HEAD_BYTES = previous;
      }
    }
    expect(thrown).toBeInstanceOf(StaticPreviewBuildError);
    expect(thrown?.message).not.toContain(
      "TypeError: Cannot read properties of undefined (reading 'image')"
    );
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

  it('invokes the CLI at its own real path, not through the workspace copy’s node_modules symlink', async () => {
    // A stand-in for pnpm's own generated CLI shim, not a hand-written test
    // double: real `.bin/astro` is a shell script that finds `dirname "$0"`
    // and hands `node` a path built from a fixed number of literal `..`
    // segments — computed once, at install time, from how deep the package
    // sits under wherever `pnpm install` ran. Node resolves that argument
    // with `path.resolve`, plain string arithmetic that never touches the
    // filesystem, before it opens anything. So climbing from the path this
    // script was actually invoked at (`$0`) only lands on the real sibling
    // file when that invocation path sits at the SAME depth the shim was
    // built for. Invoked directly at its own path under `templateRoot`, the
    // climb is correct; invoked the old way — `join(cwd, 'node_modules',
    // '.bin', 'astro')`, through the symlink `buildStaticPreview` plants in
    // the workspace copy — `$0` is the copy's own (differently nested) path
    // and the climb lands on a file that was never real anywhere. This is
    // the exact shape of the bug shipped in #132 and reproduced with
    // `docker build --target templates` on 2026-09-13.
    const shim = `#!/bin/sh
basedir=$(dirname "$0")
exec node "$basedir/../../sibling.cjs"
`;
    await stubAstro(shim);
    await writeFile(
      join(templateRoot, TEMPLATE_SLUG, 'sibling.cjs'),
      `const fs = require('fs');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', '<!doctype html><h1>Built</h1>');
`,
      'utf8'
    );
    const source = await temp('fs-build-ws-');
    await writeFile(join(source, 'package.json'), '{"name":"site"}');

    const build = await buildStaticPreview({
      projectId: 'e1d1c7a1-0000-4000-8000-000000000009',
      templateSlug: TEMPLATE_SLUG,
      workspaceRoot: source,
      timeoutMs: 20_000,
    });
    scratch.push(build.workspaceRoot);
    expect(build.files.some((file) => file.path === 'index.html')).toBe(true);
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
