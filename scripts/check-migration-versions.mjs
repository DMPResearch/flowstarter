#!/usr/bin/env node
/**
 * check-migration-versions.mjs: refuse two migrations that share a version.
 *
 * `supabase_migrations.schema_migrations` (the Supabase CLI's own tracking
 * table, on every stack — staging's shared box, a developer's local stack,
 * eventually the hosted project) keys an applied migration by its filename's
 * version prefix alone, not by name or content. Two files under
 * `supabase/migrations/` sharing a version is therefore a real defect, not a
 * cosmetic one: whichever the CLI processes second either fails to record
 * (silently re-running forever) or clobbers the first's tracking row,
 * depending on the CLI version and ordering — and both were observed on
 * fs-sites-01 for the collision this script exists to catch
 * (`20260913120000_assets_original_name.sql` vs
 * `20260913120000_workspaces_cal_provisioning.sql`, see
 * docs/release-process.md, "Migration versions").
 *
 * A migration's version is everything before the first underscore in its
 * filename — `supabase migrations new` always writes a UTC timestamp there,
 * but this script does not care about the format, only that it is unique.
 * Two pull requests opened at once can each mint a file stamped with
 * whatever second they wrote it, so a collision is easy to introduce and
 * easy to miss in review; this makes it a build failure instead of a
 * production incident.
 *
 * Usage:
 *   node scripts/check-migration-versions.mjs
 *   node scripts/check-migration-versions.mjs --dir path/to/migrations
 *
 * Exits non-zero and lists every colliding group when two or more files
 * share a version. Exits zero, silently, otherwise.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Groups migration filenames by version (everything before the first `_`).
 * Only `.sql` files are considered; anything else in the directory (a
 * README, `.gitkeep`) is ignored rather than flagged.
 *
 * @param {string[]} filenames
 * @returns {Map<string, string[]>} version -> filenames sharing it
 */
export function groupByVersion(filenames) {
  const groups = new Map();
  for (const filename of filenames) {
    if (!filename.endsWith('.sql')) continue;
    const underscore = filename.indexOf('_');
    const version = underscore === -1 ? filename : filename.slice(0, underscore);
    const existing = groups.get(version);
    if (existing) {
      existing.push(filename);
    } else {
      groups.set(version, [filename]);
    }
  }
  return groups;
}

/**
 * @param {Map<string, string[]>} groups
 * @returns {Array<{ version: string, filenames: string[] }>} groups with more than one file, version-sorted
 */
export function findCollisions(groups) {
  return [...groups.entries()]
    .filter(([, filenames]) => filenames.length > 1)
    .map(([version, filenames]) => ({ version, filenames: [...filenames].sort() }))
    .sort((a, b) => a.version.localeCompare(b.version));
}

function parseArgs(argv) {
  const args = { dir: path.join(__dirname, '..', 'supabase', 'migrations') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir' && argv[i + 1]) {
      args.dir = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

function main() {
  const { dir } = parseArgs(process.argv.slice(2));
  const filenames = readdirSync(dir);
  const collisions = findCollisions(groupByVersion(filenames));

  if (collisions.length === 0) {
    console.log(`check-migration-versions: ${filenames.length} file(s) in ${path.relative(process.cwd(), dir)}, every version is unique.`);
    return;
  }

  console.error('check-migration-versions: two or more migrations share a version. supabase_migrations.schema_migrations keys by version, so this is not cosmetic — see docs/release-process.md, "Migration versions".\n');
  for (const { version, filenames: group } of collisions) {
    console.error(`  ${version}:`);
    for (const filename of group) {
      console.error(`    - ${filename}`);
    }
  }
  console.error('\nRename the later-merged file to a free version with identical content, and confirm its DDL is idempotent (if not exists) so re-applying it on a stack that already ran it under the old version is harmless.');
  process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
