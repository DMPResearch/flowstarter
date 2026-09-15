#!/usr/bin/env node
/**
 * check-prettier-pin.mjs: catch an unpinned Prettier major before it
 * silently reformats files a commit never touched.
 *
 * apps/flowstarter-main pins Prettier `^2.8.8` (trailingComma defaults to
 * "es5"); the repo root pins Prettier `~3.6.2` (trailingComma has defaulted
 * to "all" since 3.0, for newer workspaces built against it). When something
 * in the dependency graph resolves the root's Prettier instead of the app's
 * own pinned binary -- a hoisted `.bin/prettier` under `shamefully-hoist`, a
 * tool that shells out to `prettier` by name instead of requiring the
 * package, an editor extension pointed at the workspace root -- every file
 * it reformats picks up trailing commas the app's own formatter would never
 * add, and a commit meant to touch one file reformats a dozen unrelated
 * ones. That is the defect this script, the pre-commit hook fix it shipped
 * alongside (scoping lint/format to staged files and pointing the hook at
 * `apps/flowstarter-main/node_modules/.bin/prettier` explicitly), and
 * docs/dev-machine.md ("Prettier version pins") all address together.
 *
 * A major-version difference between two package.json files is not
 * automatically a bug: flowstarter-main deliberately stays on Prettier 2
 * until a deliberate, single-commit reformat of its own tree migrates it to
 * 3's defaults. So this script does not demand every workspace match the
 * app's pin. It demands that a difference be on purpose: every workspace
 * (including the repo root) whose pinned Prettier major differs from the
 * app's must be named, with its exact version range, in
 * docs/dev-machine.md's "Prettier version pins" section. Bump either side
 * without updating that section and this fails -- the doc going stale is
 * exactly the state that produces an unreviewed reformat.
 *
 * Usage:
 *   node scripts/check-prettier-pin.mjs
 *   node scripts/check-prettier-pin.mjs --root path/to/repo   (tests only)
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

/** The workspace whose pin every other workspace is compared against. */
export const APP_WORKSPACE = 'apps/flowstarter-main';

const DOCS_PATH = 'docs/dev-machine.md';
const DOC_SECTION_MARKER = 'Prettier version pins';

/**
 * Extracts the major version number from a semver range string such as
 * `^2.8.8`, `~3.6.2`, or `2.8.8`. Returns null when no version number can be
 * found, rather than throwing -- an unparsable range is not this script's
 * problem to diagnose.
 *
 * @param {string} range
 * @returns {number | null}
 */
export function semverMajor(range) {
  const match = /(\d+)\.\d+\.\d+/.exec(range);
  if (!match) return null;
  return Number(match[1]);
}

/**
 * A minimal reader for the `packages:` list in pnpm-workspace.yaml. Only
 * handles what that file actually contains -- a flat list of `- pattern`
 * lines, each either a literal directory or a `dir/*` one-level glob -- and
 * is not a general YAML or glob parser. Good enough for this repo's
 * workspace layout; a pnpm-workspace.yaml that outgrows this shape should
 * switch this script (and check-migration-versions' siblings) to a real
 * YAML parser rather than have this function grow one field at a time.
 *
 * @param {string} repoRoot
 * @returns {string[]} package patterns, e.g. ["apps/*", "packages/*"]
 */
export function readWorkspacePatterns(repoRoot) {
  const raw = readFileSync(
    path.join(repoRoot, 'pnpm-workspace.yaml'),
    'utf8',
  );
  const lines = raw.split('\n');
  const patterns = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const match = /^\s*-\s*(\S+)\s*$/.exec(line);
      if (match) {
        patterns.push(match[1]);
        continue;
      }
      // Any non-list-item line ends the `packages:` block.
      break;
    }
  }
  return patterns;
}

/**
 * Expands this repo's two workspace pattern shapes -- a literal directory,
 * or `dir/*` for "every immediate subdirectory of dir" -- into concrete
 * directories that actually exist on disk.
 *
 * @param {string} repoRoot
 * @param {string[]} patterns
 * @returns {string[]} directories, relative to repoRoot
 */
export function expandWorkspacePatterns(repoRoot, patterns) {
  const dirs = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      const baseAbs = path.join(repoRoot, base);
      if (!existsSync(baseAbs)) continue;
      for (const entry of readdirSync(baseAbs, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(base, entry.name));
      }
    } else {
      dirs.push(pattern);
    }
  }
  return dirs;
}

/**
 * Reads the `prettier` version pinned in a package.json's dependencies or
 * devDependencies, if any.
 *
 * @param {string} packageJsonPath absolute path to a package.json
 * @returns {string | null}
 */
function readPrettierPin(packageJsonPath) {
  if (!existsSync(packageJsonPath)) return null;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return null;
  }
  return (
    pkg.devDependencies?.prettier ?? pkg.dependencies?.prettier ?? null
  );
}

/**
 * Every workspace (repo root plus every directory pnpm-workspace.yaml
 * names) that pins its own `prettier`, with the version range it pins.
 *
 * @param {string} repoRoot
 * @returns {Array<{ workspace: string, version: string }>}
 */
export function collectPrettierPins(repoRoot) {
  const patterns = readWorkspacePatterns(repoRoot);
  const dirs = ['.', ...expandWorkspacePatterns(repoRoot, patterns)];
  const pins = [];
  for (const dir of dirs) {
    const version = readPrettierPin(
      path.join(repoRoot, dir, 'package.json'),
    );
    if (version) pins.push({ workspace: dir === '.' ? 'root' : dir, version });
  }
  return pins;
}

/**
 * Which pinned workspaces resolve a different Prettier major than the app.
 *
 * @param {Array<{ workspace: string, version: string }>} pins
 * @returns {{ app: { workspace: string, version: string, major: number } | null, drifting: Array<{ workspace: string, version: string, major: number }> }}
 */
export function findDrift(pins) {
  const app = pins.find((pin) => pin.workspace === APP_WORKSPACE);
  if (!app) {
    return { app: null, drifting: [] };
  }
  const appMajor = semverMajor(app.version);
  const drifting = pins
    .filter((pin) => pin.workspace !== APP_WORKSPACE)
    .map((pin) => ({ ...pin, major: semverMajor(pin.version) }))
    .filter((pin) => pin.major !== null && pin.major !== appMajor);
  return { app: { ...app, major: appMajor }, drifting };
}

/**
 * True when docs/dev-machine.md documents every drifting workspace's exact
 * pinned version, plus the app's own, under the "Prettier version pins"
 * section. A verbatim-string check rather than a "section exists" check on
 * purpose: bumping a version without touching the doc must fail this, and a
 * doc that only ever says "versions differ, see package.json" would never
 * catch that.
 *
 * @param {string} docsContent
 * @param {{ workspace: string, version: string, major: number }} app
 * @param {Array<{ workspace: string, version: string, major: number }>} drifting
 * @returns {{ documented: boolean, missing: string[] }}
 */
export function isDriftDocumented(docsContent, app, drifting) {
  const missing = [];
  if (!docsContent.includes(DOC_SECTION_MARKER)) {
    missing.push(`a "${DOC_SECTION_MARKER}" section`);
  }
  if (!docsContent.includes(app.version)) {
    missing.push(`${APP_WORKSPACE}'s pinned version (${app.version})`);
  }
  for (const pin of drifting) {
    if (!docsContent.includes(pin.version) || !docsContent.includes(pin.workspace)) {
      missing.push(`${pin.workspace}'s pinned version (${pin.version})`);
    }
  }
  return { documented: missing.length === 0, missing };
}

function parseArgs(argv) {
  const args = { root: REPO_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) {
      args.root = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const pins = collectPrettierPins(root);
  const { app, drifting } = findDrift(pins);

  if (!app) {
    console.log(
      `check-prettier-pin: ${APP_WORKSPACE} does not pin its own prettier -- nothing to check against.`,
    );
    return;
  }

  if (drifting.length === 0) {
    console.log(
      `check-prettier-pin: every workspace that pins prettier resolves major ${app.major}, matching ${APP_WORKSPACE}.`,
    );
    return;
  }

  const docsPath = path.join(root, DOCS_PATH);
  const docsContent = existsSync(docsPath) ? readFileSync(docsPath, 'utf8') : '';
  const { documented, missing } = isDriftDocumented(docsContent, app, drifting);

  const summary = drifting
    .map((pin) => `  ${pin.workspace}: prettier ${pin.version} (major ${pin.major})`)
    .join('\n');

  if (documented) {
    console.log(
      `check-prettier-pin: ${drifting.length} workspace(s) pin a different prettier major than ${APP_WORKSPACE} (prettier ${app.version}), and it is documented in ${DOCS_PATH}:\n${summary}`,
    );
    return;
  }

  console.error(
    `check-prettier-pin: ${drifting.length} workspace(s) resolve a different prettier major than ${APP_WORKSPACE} pins (prettier ${app.version}), and ${DOCS_PATH} does not document why:\n${summary}\n\nEither align the version so no workspace drifts, or record the intentional split in ${DOCS_PATH} under a "${DOC_SECTION_MARKER}" section naming each drifting workspace and its exact version range. Missing:\n${missing.map((m) => `  - ${m}`).join('\n')}\n`,
  );
  process.exitCode = 1;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
