/**
 * Getting a finished build off the tree an agent could write to, and into a
 * directory only this process has ever owned.
 *
 * Everything under a job's worktree is generated: the site's Astro config, its
 * integrations, and — because `astro build` runs all of that for real — the
 * shape of `dist/` itself. So `dist/` is not a directory this worker found, it
 * is a directory tenant code produced, and until now every reader of it took
 * the name at face value. `stat()` follows symlinks: a build step that replaced
 * `dist` with a link to `/etc`, or to the neighbouring client's worktree, got
 * the privileged worker to open that path on the host, scan it, pack it and
 * publish what it found. The container the build ran in never had to be able
 * to reach the target — the worker follows the link after the container is
 * gone.
 *
 * Two rules close that, and both live here so that every reader — the
 * validator's scanners, the packager, and the content gates in `workflows.ts`
 * — shares one implementation rather than three similar-looking ones:
 *
 *  - {@link resolveContainedOutputDir} decides *which* directory is the build
 *    output. It walks the path one segment at a time with `lstat()`, refuses a
 *    symbolic link anywhere along it, and canonicalises the result to prove it
 *    is still inside the root it was resolved from. A link is refused, not
 *    followed and not silently ignored: a build that produced one is a build
 *    that tried something, and the honest answer to the operator is that this
 *    job failed.
 *  - {@link exportBuiltSite} copies that directory into a fresh directory this
 *    process creates, owns and can delete, taking only regular files and real
 *    directories, and refusing to exceed the configured file, byte and depth
 *    budgets. Files are opened with `O_NOFOLLOW` and their kind confirmed on
 *    the open descriptor, so a path swapped between the walk and the read is
 *    refused rather than followed. What the scanners and the publisher then
 *    read is the copy, which no generated code has ever been able to touch.
 *
 * The limits are budgets, not opinions: they arrive from the worker's own
 * configuration (see `apps/build-worker/src/config.ts`), and the defaults here
 * exist so a caller with nothing to say still gets a bounded copy.
 */

import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * A build output that could not be proven to be inside the job's own tree, or
 * that carried something a static site cannot contain. Separate from a build
 * failure on purpose: this is not the site failing to compile, it is the site
 * reaching for something outside itself.
 */
export class SiteOutputContainmentError extends Error {}

/** How much of a build this worker will carry, and how deep it will walk. */
export interface OutputExportLimits {
  /** Entries copied; a build with more is refused rather than truncated. */
  maxFiles: number;
  /** Uncompressed bytes across all of them. */
  maxBytes: number;
  /** Directory nesting, counted from the output root. */
  maxDepth: number;
}

/**
 * The budgets a caller gets for saying nothing. They match what the packager
 * has always enforced (`collectSiteFiles` in the worker), because the point of
 * the export is to be the same bounded thing one step earlier — at the moment
 * the bytes leave the tree the agent could write to.
 */
export const DEFAULT_OUTPUT_EXPORT_LIMITS: OutputExportLimits = {
  maxFiles: 5_000,
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 32,
};

/** The conventional name of a built site, and the prefix gates read paths under. */
export const BUILT_OUTPUT_DIR = 'dist';

/** True when `candidate` is `root` itself or something underneath it. */
export function isContained(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return (
    rel.length > 0 &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Which directory holds the build output, proven rather than assumed.
 *
 * `root` is host-created — the worker makes the worktree and the site root
 * inside it before any agent runs — so it is canonicalised once and then used
 * as the containment boundary. Everything below it is the build's work and is
 * checked segment by segment: each one must exist, must not be a symbolic
 * link, and the final one must be a directory.
 *
 * Returns null when the output directory simply is not there. That is not an
 * attack, it is the deterministic dry path and the hand-authored templates
 * that never produce a `dist/`, and the callers have always treated the site
 * root itself as the answer for those. A link, an escape, or a `dist` that is
 * a file are all refused loudly instead.
 */
export async function resolveContainedOutputDir(
  root: string,
  outputDir: string,
): Promise<string | null> {
  if (isAbsolute(outputDir)) {
    throw new SiteOutputContainmentError(
      `Build output directory must be named relative to the site root, got ${outputDir}`,
    );
  }
  const canonicalRoot = await realpath(root);
  const segments = outputDir
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new SiteOutputContainmentError(
      `Build output directory may not walk out of the site root, got ${outputDir}`,
    );
  }

  let current = canonicalRoot;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    const last = index === segments.length - 1;
    current = join(current, segment);
    if (!isContained(canonicalRoot, current)) {
      throw new SiteOutputContainmentError(
        `Build output ${outputDir} resolves outside the site root`,
      );
    }
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new SiteOutputContainmentError(
        `Build output path ${outputDir} is a symbolic link at "${segment}"; ` +
          'a build that replaces its own output directory with a link is ' +
          'reaching for something outside its worktree, and this worker will ' +
          'not follow it',
      );
    }
    if (info.isDirectory()) continue;
    // A `dist` that is a plain file is a build that produced no output
    // directory, which the validator reports in its own words. Anything that
    // is neither a directory nor a regular file — a fifo, a socket, a device
    // — is refused here, whether it is the last segment or on the way to it.
    if (!info.isFile()) {
      throw new SiteOutputContainmentError(
        `Build output path ${outputDir} contains a special file at "${segment}"`,
      );
    }
    if (!last) {
      throw new SiteOutputContainmentError(
        `Build output path ${outputDir} passes through "${segment}", which is not a directory`,
      );
    }
    return null;
  }

  if (current === canonicalRoot) return root;
  // Belt and braces: a canonical path that still reads as contained after the
  // walk is the statement the callers actually rely on.
  const canonical = await realpath(current);
  if (!isContained(canonicalRoot, canonical)) {
    throw new SiteOutputContainmentError(
      `Build output ${outputDir} resolves outside the site root`,
    );
  }
  // Answered in the caller's own namespace rather than the canonical one. No
  // segment below the root is a link — that was just proved, segment by
  // segment — so the two name the same directory, and handing back a path the
  // caller did not pass in only makes its logs harder to read.
  return resolve(root, ...segments);
}

export interface ExportedSiteOutput {
  /** The fresh directory this process created, owns, and may delete. */
  path: string;
  files: number;
  bytes: number;
}

/**
 * Copies a proven-contained build output into a fresh host-owned directory.
 *
 * Nothing here follows a link and nothing here copies anything that is not a
 * regular file or a real directory: a socket, a fifo or a device node has no
 * place in a static site, and each is a way to make a later reader block or
 * read something it never asked for. The budgets are checked as the copy runs
 * rather than after it, so an oversized build costs the cap and not the whole
 * disk.
 */
export async function exportBuiltSite(input: {
  /** The directory {@link resolveContainedOutputDir} returned. */
  sourceDir: string;
  /** Where the fresh directory is created; owned by this worker, never by a build. */
  destinationParent: string;
  limits?: Partial<OutputExportLimits>;
}): Promise<ExportedSiteOutput> {
  const limits: OutputExportLimits = {
    ...DEFAULT_OUTPUT_EXPORT_LIMITS,
    ...input.limits,
  };
  const sourceRoot = await realpath(input.sourceDir);
  await mkdir(input.destinationParent, { recursive: true, mode: 0o700 });
  const destination = await mkdtemp(
    join(input.destinationParent, 'site-output-'),
  );

  let files = 0;
  let bytes = 0;

  const copyDirectory = async (
    from: string,
    to: string,
    depth: number,
  ): Promise<void> => {
    if (depth > limits.maxDepth) {
      throw new SiteOutputContainmentError(
        `Build output nests deeper than ${limits.maxDepth} directories; refusing to export it`,
      );
    }
    // The directory being walked has to still be the directory that was
    // checked: a build that swaps one for a link between the walk and the read
    // is exactly the race this export exists to lose safely.
    const canonical = await realpath(from);
    if (!isContained(sourceRoot, canonical)) {
      throw new SiteOutputContainmentError(
        `Build output directory ${from} moved outside the build output while it was being exported`,
      );
    }

    for (const entry of await readdir(from, { withFileTypes: true })) {
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      if (entry.isSymbolicLink()) {
        throw new SiteOutputContainmentError(
          `Build output contains a symbolic link (${relative(sourceRoot, source) || entry.name}); ` +
            'a static site has no use for one and this worker will not follow it',
        );
      }
      if (entry.isDirectory()) {
        await mkdir(target, { mode: 0o700 });
        await copyDirectory(source, target, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        throw new SiteOutputContainmentError(
          `Build output contains a special file (${relative(sourceRoot, source) || entry.name}); ` +
            'only regular files and directories are carried out of a build',
        );
      }

      files += 1;
      if (files > limits.maxFiles) {
        throw new SiteOutputContainmentError(
          `Build output has more than ${limits.maxFiles} files; refusing to export it`,
        );
      }
      // O_NOFOLLOW is the half of this rule the directory entry cannot give:
      // the entry was a regular file when it was listed, and the open refuses
      // if it has become a link since.
      const handle = await open(
        source,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile()) {
          throw new SiteOutputContainmentError(
            `Build output entry ${relative(sourceRoot, source)} is not a regular file`,
          );
        }
        bytes += info.size;
        if (bytes > limits.maxBytes) {
          throw new SiteOutputContainmentError(
            `Build output exceeds ${limits.maxBytes} bytes; refusing to export it`,
          );
        }
        await writeFile(target, await handle.readFile(), { mode: 0o600 });
      } finally {
        await handle.close();
      }
    }
  };

  await copyDirectory(sourceRoot, destination, 0);
  return { path: destination, files, bytes };
}
