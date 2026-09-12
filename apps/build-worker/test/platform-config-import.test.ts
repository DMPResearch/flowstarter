import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/** `apps/build-worker`, the same directory `tsx watch src/index.ts` runs from. */
const WORKER_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * This worker's own pinned `tsx` -- the loader `dev`, `dev:local` and
 * `start` all run under. A plain `node -e` does *not* reproduce the bug:
 * Node's own auto-detection reparses the untyped `.ts` as ESM and succeeds
 * with only a warning. `tsx`'s loader is what actually misresolves the named
 * export, so the regression check has to run under it, not under bare node.
 */
const TSX_BIN = join(WORKER_ROOT, 'node_modules', '.bin', 'tsx');

/**
 * `config.ts` imports `resolvePlatformDomain` as a named export from
 * `@flowstarter/platform-config`:
 *
 *   import { resolvePlatformDomain } from '@flowstarter/platform-config';
 *
 * That package ships as raw TypeScript source with no build step (`main` /
 * `exports` point straight at `src/index.ts`). Its own `package.json` used
 * to omit `"type": "module"`, and Node's own ESM/CJS auto-detection then
 * misresolved the named export -- reproduced under plain `node`, under `tsx`
 * (the runtime `dev`, `dev:local` and `start` all use), on Node 22 and 25 --
 * so the worker crashed at boot with `resolvePlatformDomain is not a
 * function`.
 *
 * Vitest cannot reproduce this: it resolves and transforms every module
 * through Vite/esbuild, which sidesteps Node's own module-type detection
 * entirely, so a test that merely `import()`s the package in-process would
 * pass even on the broken `package.json`. This spawns a real `node` process
 * rooted at `apps/build-worker` instead -- the same directory `config.ts`
 * boots from -- so it exercises Node's own resolution and fails a
 * regression here rather than only at boot on a real host.
 */
describe('@flowstarter/platform-config import shape', () => {
  it('resolves resolvePlatformDomain as a callable named export under tsx, the way config.ts imports it at boot', async () => {
    const { stdout } = await execFileAsync(
      TSX_BIN,
      [
        '-e',
        "import('@flowstarter/platform-config').then(m => process.stdout.write(typeof m.resolvePlatformDomain))",
      ],
      { cwd: WORKER_ROOT },
    );
    expect(stdout).toBe('function');
  });
});
