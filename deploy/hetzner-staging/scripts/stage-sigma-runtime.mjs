#!/usr/bin/env node
/**
 * Stages the sigma classifier's real runtime dependency chain —
 * @flowstarter/sigma-flowstarter, @flowstarter/sigma-core,
 * @huggingface/transformers, onnxruntime-node/-common, and sharp (+ its
 * platform binary) — into a directory the Dockerfile's `runner` stage
 * merges into `node_modules`, at TWO locations per package: a flat
 * `node_modules/<name>` AND, for every leaf npm package, a copy mirrored
 * at the exact `node_modules/.pnpm/<name>@<version>/node_modules/<name>`
 * path pnpm itself would use. Both are load-bearing for different reasons
 * (see deploy/hetzner-staging/README.md, "Shipping the sigma model", for
 * the full story with dates and exact errors observed):
 *
 *   - `.next/standalone` does not reliably carry @flowstarter/
 *     sigma-flowstarter or @flowstarter/sigma-core into the image at all —
 *     Turbopack's output-file tracing never follows the one code path that
 *     reaches them (a dynamic import inside a function only called from
 *     `src/instrumentation.ts`, which is not route-traced). The FLAT copy
 *     fixes this: it is what plain Node module resolution — and, per the
 *     next point, Turbopack's own external-module loader — finds by name.
 *   - @huggingface/transformers and its own dependencies (onnxruntime-node,
 *     onnxruntime-common, sharp) ARE traced into `.next/standalone`, but
 *     incompletely (a native binding with no shared library beside it) —
 *     and, once made complete, Turbopack's production "external module"
 *     wrapper still resolves ITS requires of them against the pnpm
 *     virtual-store path it saw AT BUILD TIME, not wherever the files
 *     land at runtime. The MIRRORED copy fixes this: it puts complete
 *     files at the exact path Turbopack already baked in.
 *
 * Every package is resolved relative to the one before it in the chain,
 * never from this script's own location or a generic workspace root: this
 * repo has two different `onnxruntime-node` versions installed for
 * unrelated reasons (see packages/sigma-core/config/encoder.json's
 * `_comment`), and resolving from the wrong anchor silently grabs the
 * wrong one.
 *
 * Deliberately excludes `onnxruntime-web` (~130MB, @huggingface/
 * transformers' browser/WASM backend, never imported by the
 * `transformers.node.mjs` entry point Node actually loads).
 *
 *   node stage-sigma-runtime.mjs <anchor-package.json> <output-dir>
 *
 * <anchor-package.json> is where resolution of @flowstarter/sigma-flowstarter
 * itself starts — apps/flowstarter-main/package.json in the Dockerfile,
 * since that is the real dependency edge being reproduced.
 */

import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [, , anchorArg, outArg] = process.argv;
if (!anchorArg || !outArg) {
  console.error('usage: stage-sigma-runtime.mjs <anchor-package.json> <output-dir>');
  process.exit(1);
}
const OUT = outArg;

/**
 * Resolve `name`'s real, on-disk root directory using `fromRequire` (a
 * require() already anchored inside some specific package's own directory)
 * — never this script's own location, and never a generic workspace root.
 * That distinction is the entire point: it is what guarantees each package
 * staged below is the EXACT version the one before it in the chain
 * actually resolves at runtime, not merely a same-named package that
 * happens to be reachable from somewhere else in the pnpm store.
 *
 * Does not rely on `name` exporting "./package.json" (several of these
 * packages restrict their `exports` map and do not): resolves the main
 * entry point instead, then walks up to the nearest directory holding a
 * package.json whose "name" matches.
 */
function resolvePackageDir(fromRequire, name) {
  // Packages differ in how (or whether) they let you reach anything at
  // all: a plain package with no `exports` map resolves `<name>/
  // package.json` directly; @huggingface/transformers restricts its
  // `exports` map to real entry points, so only `resolve(name)` (its "."
  // export) works; the platform-specific @img/sharp-* binary packages
  // restrict theirs to `"./sharp.node"` and, oddly, `"./package"` (not
  // `"./package.json"`) — nothing but a prebuilt binary, never required by
  // bare name. Try each in turn; the first one that resolves wins.
  let entry;
  let lastError;
  for (const attempt of [`${name}/package.json`, `${name}/package`, name]) {
    try {
      entry = fromRequire.resolve(attempt);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!entry) throw lastError;
  let dir = dirname(realpathSync(entry));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
      if (pkg.name === name) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find package.json for "${name}" above ${dir}`);
}

/**
 * `@flowstarter/sigma-flowstarter` and `@flowstarter/sigma-core` are
 * WORKSPACE PACKAGES, resolved to their real `packages/<name>` directory
 * in the monorepo (not a `node_modules/@scope/<name>` symlink) — that
 * directory carries its own local `node_modules` (pnpm gives every
 * workspace package one, populated with symlinks to exactly its own
 * declared dependencies) plus dev-tool scratch dirs (`.vite`,
 * `.vite-temp`). Copying those along is actively wrong, not merely extra
 * weight: Node's resolution algorithm always checks the NEAREST
 * `node_modules` first, so a stray `packages/sigma-core/node_modules/
 * onnxruntime-node` symlink sitting next to the staged package would win
 * over the correct, complete, pruned copy this script stages separately at
 * the top level — reproduced 2026-09-15 (`createRequire` anchored at the
 * staged sigma-core's package.json resolved `onnxruntime-node` straight
 * back to the ORIGINAL pnpm store path this whole script exists to get
 * away from, `.so` file and all, because `dereference: true` copies a
 * symlink's real, unpruned target rather than making the stray entry
 * disappear). `skipNodeModules` drops any `node_modules` (or `.vite`/
 * `.vite-temp`) directory encountered while copying a workspace package's
 * own source; it is not applied to the leaf dependencies staged below,
 * whose entire real content is exactly what is wanted.
 */
function skipNodeModules(src) {
  const base = src.split('/').pop();
  return base !== 'node_modules' && base !== '.vite' && base !== '.vite-temp';
}

/**
 * Turbopack does not just bundle-or-external-require a package market
 * `serverExternalPackages` — for at least @huggingface/transformers,
 * onnxruntime-node/-common and sharp/@img/*, its production "external
 * module" wrapper bakes in the package's pnpm virtual-store path AT BUILD
 * TIME (`node_modules/.pnpm/<name>@<version>/node_modules/<name>`,
 * pnpm's own real, on-disk layout) rather than re-resolving it fresh at
 * runtime — reproduced 2026-09-15: even with the flat copy this script
 * stages at the top level fully present and independently verified
 * resolvable, the real server still failed with "Failed to load external
 * module @huggingface/transformers-...: libonnxruntime.so.1: cannot open
 * shared object file", tracing back into
 * `node_modules/.pnpm/onnxruntime-node@1.24.3/...` — the exact path
 * Next's own (incomplete) tracing had already partially populated, not
 * this script's flat copy. `.next/standalone` ships that partial `.pnpm`
 * skeleton (real JS files, missing native binaries) for exactly these
 * packages already, which is what makes the trick below work: this
 * script's own resolution runs inside the SAME `/app` the Docker build
 * used, so `realDir` for a leaf npm package is already that literal
 * `.../node_modules/.pnpm/<name>@<version>/...` path — mirroring it under
 * `OUT` at the identical relative position and merging it into the
 * runner's `node_modules` on top of Next's partial copy fills in exactly
 * the files tracing missed, without needing to compute or guess pnpm's
 * directory-naming convention (scope-as-`+`, peer-dependency suffixes,
 * etc.) by hand.
 */
function mirrorPnpmRelativePath(realDir) {
  const marker = '/node_modules/.pnpm/';
  const at = realDir.indexOf(marker);
  return at === -1 ? null : realDir.slice(at + '/node_modules/'.length);
}

function stage(name, realDir, { filter } = {}) {
  const dest = join(OUT, 'node_modules', ...name.split('/'));
  mkdirSync(dirname(dest), { recursive: true });
  // dereference: true follows every symlink it meets while copying, so
  // nothing in the destination points back at a pnpm store this directory
  // will be copied away from.
  cpSync(realDir, dest, { recursive: true, dereference: true, filter });
  console.log(`staged ${name} <- ${realDir}`);

  const mirrorRelative = mirrorPnpmRelativePath(realDir);
  if (mirrorRelative) {
    const mirrorDest = join(OUT, 'node_modules', mirrorRelative);
    mkdirSync(dirname(mirrorDest), { recursive: true });
    cpSync(realDir, mirrorDest, { recursive: true, dereference: true, filter });
    console.log(`  + mirrored at node_modules/${mirrorRelative}`);
  }

  return dest;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'node_modules'), { recursive: true });

const requireFromAnchor = createRequire(realpathSync(anchorArg));
const sigmaFlowstarterDir = resolvePackageDir(requireFromAnchor, '@flowstarter/sigma-flowstarter');
stage('@flowstarter/sigma-flowstarter', sigmaFlowstarterDir, { filter: skipNodeModules });

const requireFromSigmaFlowstarter = createRequire(join(sigmaFlowstarterDir, 'package.json'));
const sigmaCoreDir = resolvePackageDir(requireFromSigmaFlowstarter, '@flowstarter/sigma-core');
stage('@flowstarter/sigma-core', sigmaCoreDir, { filter: skipNodeModules });

const requireFromSigmaCore = createRequire(join(sigmaCoreDir, 'package.json'));
const transformersDir = resolvePackageDir(requireFromSigmaCore, '@huggingface/transformers');
stage('@huggingface/transformers', transformersDir);

// dist/transformers.node.mjs statically imports `sharp` at the top of the
// file (grepped 2026-09-14) — this text-embedding pipeline never actually
// calls into it, but a static ESM import has to resolve before the module
// can be evaluated at all, so a missing `sharp` is a hard failure here
// regardless of whether anything downstream uses it. Confirmed missing
// from the real image 2026-09-15 despite apps/flowstarter-main's own
// direct dependency on it for next/image — whatever lets Next find it for
// its own bundle apparently does not extend to this second resolution
// path, so it gets the same explicit treatment as everything else here.
// sharp itself ships no native code; the actual binary lives in one of
// several `optionalDependencies` split by platform+arch (`@img/sharp-
// <platform>-<arch>`) plus its libvips counterpart
// (`@img/sharp-libvips-<platform>-<arch>`) — resolved from sharp's own
// directory, matching the naming convention its own install script uses.
// This assumes glibc (`<platform>`, not the musl variant): correct for
// this Dockerfile's `node:${NODE_VERSION}` base (Debian), wrong for an
// Alpine one.
const requireFromTransformers = createRequire(join(transformersDir, 'package.json'));
const sharpDir = resolvePackageDir(requireFromTransformers, 'sharp');
stage('sharp', sharpDir);
const requireFromSharp = createRequire(join(sharpDir, 'package.json'));
for (const name of [
  `@img/sharp-${process.platform}-${process.arch}`,
  `@img/sharp-libvips-${process.platform}-${process.arch}`,
  // sharp's own plain (non-optional) dependencies — needed for `require('sharp')`
  // to load at all, not just for the native binary.
  '@img/colour',
  'detect-libc',
  'semver',
]) {
  stage(name, resolvePackageDir(requireFromSharp, name));
}

const onnxruntimeNodeDir = resolvePackageDir(requireFromSigmaCore, 'onnxruntime-node');

// onnxruntime-common is not a direct dependency of either sigma-core or
// @huggingface/transformers — both resolve it as a transitive sibling —
// but onnxruntime-node's OWN package.json pins an exact version, and that
// is the one its compiled addon was built and tested against. Resolve it
// from onnxruntime-node's SOURCE directory (before staging moves anything)
// so the version staged here cannot silently drift from the one
// onnxruntime-node expects.
const requireFromOnnxruntimeNode = createRequire(join(onnxruntimeNodeDir, 'package.json'));
const onnxruntimeCommonDir = resolvePackageDir(requireFromOnnxruntimeNode, 'onnxruntime-common');

const stagedOnnxruntimeNode = stage('onnxruntime-node', onnxruntimeNodeDir);
stage('onnxruntime-common', onnxruntimeCommonDir);

// onnxruntime-node ships prebuilt binaries for every platform/arch it
// supports (linux x64 + arm64, darwin arm64, win32 x64 + arm64) — over
// 200MB together. Exactly one is ever loaded by this process, so keep only
// it. `process.platform`/`process.arch` here are the platform THIS SCRIPT
// is running on, which is correct because it only ever runs inside the
// Dockerfile's `sigma-runtime-deps` build stage (linux, whatever arch the
// image targets) — see that stage for the CI-vs-local-arm64 caveat this
// implies. `stage()` above may have written onnxruntime-node's content
// twice (the flat copy, plus a `.pnpm`-mirrored copy — see its own doc
// comment for why both exist), so prune every `bin/napi-v6` this run
// produced, not just the flat one.
function pruneOnnxruntimeNodeBin(binRoot) {
  if (!existsSync(binRoot)) return;
  for (const platform of readdirSync(binRoot)) {
    if (platform !== process.platform) {
      rmSync(join(binRoot, platform), { recursive: true, force: true });
      continue;
    }
    for (const arch of readdirSync(join(binRoot, platform))) {
      if (arch !== process.arch) {
        rmSync(join(binRoot, platform, arch), { recursive: true, force: true });
      }
    }
  }
}
pruneOnnxruntimeNodeBin(join(stagedOnnxruntimeNode, 'bin', 'napi-v6'));
const mirroredOnnxruntimeNodeRelative = mirrorPnpmRelativePath(onnxruntimeNodeDir);
if (mirroredOnnxruntimeNodeRelative) {
  pruneOnnxruntimeNodeBin(join(OUT, 'node_modules', mirroredOnnxruntimeNodeRelative, 'bin', 'napi-v6'));
}
console.log(`pruned onnxruntime-node/bin to ${process.platform}/${process.arch} only`);
