#!/usr/bin/env node
/**
 * prettier-workspace.mjs: `pnpm run prettier` at the repo root, without ever
 * running apps/flowstarter-main's files through the wrong Prettier major.
 *
 * The repo root pins Prettier `~3.6.2`; apps/flowstarter-main deliberately
 * stays on `^2.8.8` until a dedicated reformat commit migrates its ~800
 * files to 3's defaults (`trailingComma` changed from `"es5"` to `"all"` in
 * 3.0 -- see docs/dev-machine.md, "Prettier version pins", and
 * scripts/check-prettier-pin.mjs, which fails CI if these two facts ever go
 * out of sync). Running `pnpm exec prettier` from the repo root resolves the
 * root's 3.x even against an app path, because that is exactly what "run
 * from the root" means -- there is no scoping by path, only by cwd. This
 * wrapper adds that scoping: any positional path under
 * apps/flowstarter-main is formatted with that app's own pinned binary
 * (`apps/flowstarter-main/node_modules/.bin/prettier`), run with
 * apps/flowstarter-main as `cwd`; everything else goes to the root's,
 * unchanged. The `cwd` matters as much as the binary: Prettier resolves
 * `.prettierignore` relative to its own `cwd`, not to the file being
 * checked, so running the app's own binary from the repo root would still
 * silently stop honoring apps/flowstarter-main/.prettierignore (notably
 * `src/lib/database.types.ts`, a generated file that must never be
 * reformatted by hand).
 *
 * Usage (same flags/paths you'd pass straight to `prettier`):
 *   pnpm run prettier -- --check .
 *   pnpm run prettier -- --write apps/flowstarter-main/src/lib/foo.ts docs/
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

export const APP_WORKSPACE = 'apps/flowstarter-main';

/**
 * Splits a prettier argv into the flags (passed to every invocation) and
 * the positional paths, bucketed by whether each path falls under the app
 * workspace or not. A path "falls under" the app workspace when it equals
 * `apps/flowstarter-main` or starts with `apps/flowstarter-main/`, checked
 * against the path as written (relative or absolute) without touching the
 * filesystem -- this only decides which binary runs, not whether the path
 * exists.
 *
 * @param {string[]} argv
 * @returns {{ flags: string[], appPaths: string[], rootPaths: string[] }}
 */
export function partitionArgs(argv) {
  const flags = [];
  const appPaths = [];
  const rootPaths = [];
  for (const arg of argv) {
    if (arg.startsWith('-')) {
      flags.push(arg);
      continue;
    }
    const normalized = arg.replace(/^\.\//, '').replace(/^\/+/, '');
    if (normalized === APP_WORKSPACE || normalized.startsWith(`${APP_WORKSPACE}/`)) {
      appPaths.push(arg);
    } else {
      rootPaths.push(arg);
    }
  }
  return { flags, appPaths, rootPaths };
}

/**
 * Rewrites a path under the app workspace to be relative to that
 * workspace's own directory, so it can be passed to a prettier invocation
 * running with apps/flowstarter-main as `cwd` (see the header comment for
 * why that `cwd` is required, not cosmetic). Leaves the path untouched if
 * it is not actually under the app workspace, and `apps/flowstarter-main`
 * itself becomes `.`.
 *
 * @param {string} arg
 * @returns {string}
 */
export function relativeToAppWorkspace(arg) {
  const normalized = arg.replace(/^\.\//, '').replace(/^\/+/, '');
  if (normalized === APP_WORKSPACE) return '.';
  if (normalized.startsWith(`${APP_WORKSPACE}/`)) {
    return normalized.slice(APP_WORKSPACE.length + 1);
  }
  return arg;
}

function run(binary, args, cwd) {
  console.log(`▶ (cwd ${path.relative(REPO_ROOT, cwd) || '.'}) ${path.relative(cwd, binary)} ${args.join(' ')}`);
  const result = spawnSync(binary, args, { stdio: 'inherit', cwd });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main() {
  const argv = process.argv.slice(2);
  const { flags, appPaths, rootPaths } = partitionArgs(argv);

  // No positional paths at all (flags only, or nothing) -- there is no app
  // path to scope around, so just run the root's prettier unchanged.
  if (appPaths.length === 0 && rootPaths.length === 0) {
    process.exitCode = run(
      path.join(REPO_ROOT, 'node_modules/.bin/prettier'),
      flags,
      REPO_ROOT,
    );
    return;
  }

  let exitCode = 0;
  if (appPaths.length > 0) {
    const appDir = path.join(REPO_ROOT, APP_WORKSPACE);
    const code = run(
      path.join(appDir, 'node_modules/.bin/prettier'),
      [...flags, ...appPaths.map(relativeToAppWorkspace)],
      appDir,
    );
    exitCode = exitCode || code;
  }
  if (rootPaths.length > 0) {
    const code = run(
      path.join(REPO_ROOT, 'node_modules/.bin/prettier'),
      [...flags, ...rootPaths],
      REPO_ROOT,
    );
    exitCode = exitCode || code;
  }
  process.exitCode = exitCode;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
