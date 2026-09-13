import 'server-only';

/**
 * Compiling a generated preview workspace into a static site.
 *
 * This is the step that replaced "hand the workspace to a Daytona sandbox and
 * hope". A preview is a static Astro site; the previews Caddy can only serve
 * static files; so the honest thing to do before publishing one is to build
 * it, here, and deploy the `dist/` output — exactly what the build worker does
 * for a site somebody paid for.
 *
 * The same rules the worker's validator runs under apply:
 *
 *  - A FIXED command. `./node_modules/.bin/astro build`, never the generated
 *    `package.json`'s own `build` script. The manifest came out of a model and
 *    is not an instruction we follow.
 *  - NO SHELL. `execFile`, so nothing in a generated filename can be read as
 *    a shell operator.
 *  - A SCRUBBED environment. The app's process env holds Supabase service
 *    keys, Stripe secrets, Clerk secrets and the OpenRouter key; none of them
 *    have any business being visible to tenant code. Only PATH/HOME and the
 *    build's own flags are passed through.
 *  - A TIMEOUT, and a hard kill after it. A build that will not finish is the
 *    workspace's fault; the funnel gets its answer instead of a hung job.
 *  - CAPS on what comes back, so a generated site cannot exhaust this process
 *    by emitting a million files.
 *
 * The copy is deliberate: the pipeline deletes its own workspace the instant
 * `run()` returns, and the free-edit loop still needs a tree on disk to edit.
 * So the build happens in a copy this module owns and hands back, and the
 * caller's `cleanup()` is what removes it.
 */

import { execFile } from 'node:child_process';
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { ArchiveFile } from '@/lib/hosting/site-archive';

/** Where the copies live. One parent so an operator can find and sweep them. */
export const PREVIEW_BUILD_PARENT = 'flowstarter-preview-builds';

/** Long enough for a cold Astro build of a full template, short enough to fail. */
const DEFAULT_BUILD_TIMEOUT_MS = 240_000;

/** Output caps, mirrored from the sandbox build so the two cannot disagree. */
const MAX_ENTRIES = 5_000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_DEPTH = 20;

/** Extensions carried as UTF-8; everything else is base64. */
const TEXT_EXTENSIONS = new Set([
  'html',
  'htm',
  'xhtml',
  'css',
  'js',
  'mjs',
  'cjs',
  'json',
  'map',
  'svg',
  'txt',
  'xml',
  'webmanifest',
  'md',
  'csv',
]);

export class StaticPreviewBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaticPreviewBuildError';
  }
}

/**
 * Where the vetted template sources (and their pre-installed `node_modules`)
 * live on disk. One rule, so the build and anything else that needs the same
 * dependency tree cannot disagree about where to find it.
 */
export function templateRootDir(
  env: Record<string, string | undefined> = process.env
): string {
  return (
    env.FLOWSTARTER_TEMPLATE_ROOT?.trim() ||
    resolve(process.cwd(), '../flowstarter-templates')
  );
}

export interface StaticPreviewBuild {
  /** The compiled site, root-relative, ready for the deploy-agent. */
  files: ArchiveFile[];
  /** The workspace copy the build ran in. The free-edit loop targets this. */
  workspaceRoot: string;
  /** Absolute path of `dist/` inside that copy. */
  distRoot: string;
  /** Removes the copy. Safe to call twice. */
  cleanup: () => Promise<void>;
}

function isTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.has(path.split('.').pop()?.toLowerCase() ?? '');
}

/**
 * The build's whole environment. Everything the app knows is left behind.
 * `NODE_ENV=production` because that is what a deployed site is built as, and
 * `ASTRO_TELEMETRY_DISABLED` because a build on our host does not phone home
 * about a client's site.
 */
function buildEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? tmpdir(),
    NODE_ENV: 'production',
    CI: '1',
    ASTRO_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: '--max-old-space-size=2048',
  };
}

/**
 * `astroBin` is the CLI's own real path, not `join(cwd, 'node_modules',
 * '.bin', 'astro')` through the `node_modules` symlink `buildStaticPreview`
 * plants in the copy: pnpm writes that shim as a real file with its climb
 * back to the content-addressed store baked in as literal `..` segments,
 * sized to the package's depth under wherever `pnpm install` ran, and
 * Node resolves a main-module argument like that with `path.resolve` —
 * plain string arithmetic, never a filesystem lookup — before it ever opens
 * a file. A workspace copy almost never sits at the same depth from `/` as
 * the installed template, so climbing from the copy's `.bin` directory
 * lands on a path that was never real anywhere, and the build fails with a
 * MODULE_NOT_FOUND that has nothing to do with the generated site. Invoking
 * the shim at its own real location — same as
 * apps/flowstarter-main/src/app/api/discovery/preview/live/route.ts's
 * `publishLocalPreview` already does for `astro dev` — sidesteps the climb
 * entirely; `cwd` alone is what points the build at the copy.
 */
function runAstroBuild(
  cwd: string,
  astroBin: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolveBuild, rejectBuild) => {
    const child = execFile(
      astroBin,
      ['build'],
      {
        cwd,
        env: buildEnv(),
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        shell: false,
      },
      (error, _stdout, stderr) => {
        if (!error) return resolveBuild();
        // Never quote the child's whole output back: it can be long and it is
        // generated content. The tail is enough to tell a missing dependency
        // from a syntax error in a page the model wrote.
        const tail = String(stderr ?? '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(-600);
        rejectBuild(
          new StaticPreviewBuildError(
            `the preview did not build${tail ? `: ${tail}` : ''}`
          )
        );
      }
    );
    // A killed child still resolves through the callback above; this only
    // guards the case where spawning itself fails (no such binary).
    child.on('error', (error) =>
      rejectBuild(
        new StaticPreviewBuildError(
          `the preview build could not start: ${error.message}`
        )
      )
    );
  });
}

/** Walks a built `dist/` into archive entries, refusing anything oversized. */
export async function collectDistFiles(
  distRoot: string
): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = [];
  let total = 0;
  let entries = 0;

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      throw new StaticPreviewBuildError(
        'the built preview is nested deeper than the archive allows'
      );
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > MAX_ENTRIES) {
        throw new StaticPreviewBuildError(
          `the built preview has more than ${MAX_ENTRIES} files`
        );
      }
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }
      // Symlinks are skipped rather than followed: the target may sit outside
      // the tree, and a static host has no use for one.
      if (!entry.isFile()) continue;
      const size = (await stat(absolute)).size;
      if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) {
        throw new StaticPreviewBuildError(
          'the built preview is larger than the archive allows'
        );
      }
      total += size;
      const path = relative(distRoot, absolute).split(sep).join('/');
      const bytes = await readFile(absolute);
      files.push(
        isTextPath(path)
          ? { path, content: bytes.toString('utf8') }
          : { path, content: bytes.toString('base64'), encoding: 'base64' }
      );
    }
  }

  await walk(distRoot, 0);
  if (!files.some((file) => file.path === 'index.html')) {
    throw new StaticPreviewBuildError(
      'the built preview has no root index.html'
    );
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

export interface BuildStaticPreviewInput {
  projectId: string;
  /** The template the workspace was scaffolded from; its deps are reused. */
  templateSlug: string;
  /** The pipeline's workspace. Read, never written to, never built in. */
  workspaceRoot: string;
  /** Overrides {@link DEFAULT_BUILD_TIMEOUT_MS}; for tests and slow hosts. */
  timeoutMs?: number;
  /** Reuse an existing copy (a rebuild after a free edit) instead of copying. */
  existingWorkspaceRoot?: string;
}

/**
 * Copies the workspace, builds it, and reads `dist/` back.
 *
 * On any failure the copy is removed before the error leaves this function:
 * the thing that made the old `astro dev` fallback so expensive was a failure
 * path that left something behind every time it ran.
 */
export async function buildStaticPreview(
  input: BuildStaticPreviewInput
): Promise<StaticPreviewBuild> {
  const configured = Number(
    process.env.FLOWSTARTER_PREVIEW_BUILD_TIMEOUT_MS?.trim()
  );
  const timeoutMs =
    input.timeoutMs ??
    (Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_BUILD_TIMEOUT_MS);

  let workspaceRoot = input.existingWorkspaceRoot ?? '';
  const owned = !input.existingWorkspaceRoot;
  const cleanup = async () => {
    if (workspaceRoot)
      await rm(workspaceRoot, { recursive: true, force: true });
  };

  try {
    if (owned) {
      const parent = join(tmpdir(), PREVIEW_BUILD_PARENT);
      workspaceRoot = join(parent, input.projectId);
      await mkdir(parent, { recursive: true });
      await rm(workspaceRoot, { recursive: true, force: true });
      await cp(input.workspaceRoot, workspaceRoot, { recursive: true });
      // The template's pre-installed dependency tree, linked rather than
      // copied: an Astro template's node_modules is hundreds of megabytes and
      // every preview would pay for a copy of it.
      await symlink(
        resolve(templateRootDir(), input.templateSlug, 'node_modules'),
        join(workspaceRoot, 'node_modules'),
        'dir'
      ).catch((error: NodeJS.ErrnoException) => {
        // EEXIST means the workspace already carried one, which is fine.
        if (error.code !== 'EEXIST') throw error;
      });
    }

    const distRoot = join(workspaceRoot, 'dist');
    await rm(distRoot, { recursive: true, force: true });
    const astroBin = resolve(
      templateRootDir(),
      input.templateSlug,
      'node_modules',
      '.bin',
      'astro'
    );
    await runAstroBuild(workspaceRoot, astroBin, timeoutMs);
    const files = await collectDistFiles(distRoot);
    return { files, workspaceRoot, distRoot, cleanup };
  } catch (error) {
    if (owned) await cleanup().catch(() => {});
    throw error;
  }
}
