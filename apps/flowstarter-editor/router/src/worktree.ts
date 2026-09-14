/**
 * Materialising and reading back an operator session's editable source.
 *
 * The router today spawns one editor process per workspace slug pinned
 * to `<workspacesRoot>/<slug>` (supervisor.ts), but nothing ever put
 * source code there — the directory only existed because `mkdir` made
 * it. This module is what fills it: a site manifest in, a real git
 * worktree with a real commit out, and the same walk in reverse when the
 * operator ships their changes back.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { editorSettingsJson } from "./agent-boundary.ts";

export interface ManifestFile {
  readonly path: string;
  readonly content: string;
  readonly encoding?: "base64";
}

const MAX_PATH_LENGTH = 400;

/**
 * Refuses anything about a manifest path that could land a write outside
 * the worktree, or inside git's own bookkeeping. Called on every file
 * BEFORE anything touches disk, so a single bad entry fails the whole
 * manifest rather than leaving a partial worktree behind.
 */
export function assertSafeManifestPath(path: string): void {
  if (!path) {
    throw new Error("manifest path is empty");
  }
  if (path.length > MAX_PATH_LENGTH) {
    throw new Error(
      `manifest path is longer than ${MAX_PATH_LENGTH} chars: "${path.slice(0, 60)}…"`,
    );
  }
  if (path.includes("\0")) {
    throw new Error(`manifest path contains a NUL byte: "${path}"`);
  }
  if (path.includes("\\")) {
    throw new Error(`manifest path uses a backslash, not a forward slash: "${path}"`);
  }
  if (path.startsWith("/")) {
    throw new Error(`manifest path is absolute, must be relative to the worktree root: "${path}"`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`manifest path escapes the worktree root via "..": "${path}"`);
  }
  if (segments[0] === ".git") {
    throw new Error(`manifest path writes into .git, which the router owns, not the manifest: "${path}"`);
  }
}

/**
 * `root` must be a strict subdirectory of `workspacesRoot` — never the
 * workspaces root itself, and never something that resolves outside it.
 * `materializeWorktree` is about to `rm -rf` this path, so this is the
 * one check standing between a bad slug and wiping every workspace on
 * the box.
 */
function assertWithinWorkspacesRoot(workspacesRoot: string, root: string): void {
  const rel = relative(workspacesRoot, root);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `refusing to materialize "${root}": it is not a strict subdirectory of the configured workspaces root "${workspacesRoot}"`,
    );
  }
}

/** Runs git, captures stdout, throws with stderr on a non-zero exit. */
async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in "${cwd}": ${(stderr || stdout).trim()}`);
  }
  return stdout.trim();
}

// Set with -c flags on each git invocation, not env, so nothing about
// who is committing leaks in from (or out into) the container's own
// environment.
const GIT_AUTHOR_NAME = "Flowstarter Editor";
const GIT_AUTHOR_EMAIL = "editor@flowstarter.local";

function gitIdentityFlags(): readonly string[] {
  return ["-c", `user.name=${GIT_AUTHOR_NAME}`, "-c", `user.email=${GIT_AUTHOR_EMAIL}`];
}

const MAX_MANIFEST_FILES = 3000;

/**
 * Replaces `<workspacesRoot>/<slug>` with a fresh worktree built from
 * `files`, plus the `.claude/settings.json` that pins the operator
 * session (see agent-boundary.ts), then commits the result so there is
 * always a known-good HEAD to diff a later ship against.
 */
export async function materializeWorktree(input: {
  readonly workspacesRoot: string;
  readonly root: string;
  readonly files: readonly ManifestFile[];
  readonly label: string;
}): Promise<{ path: string; commitSha: string; fileCount: number }> {
  const workspacesRoot = resolve(input.workspacesRoot);
  const root = resolve(input.root);
  assertWithinWorkspacesRoot(workspacesRoot, root);

  if (input.files.length > MAX_MANIFEST_FILES) {
    throw new Error(`manifest has ${input.files.length} files, over the ${MAX_MANIFEST_FILES}-file cap`);
  }
  // Validate every path up front — nothing gets written until the whole
  // manifest is known-safe.
  for (const file of input.files) assertSafeManifestPath(file.path);

  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  for (const file of input.files) {
    const dest = join(root, file.path);
    await mkdir(dirname(dest), { recursive: true });
    const bytes =
      file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
    await writeFile(dest, bytes, { mode: 0o644 });
  }

  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(join(root, ".claude", "settings.json"), editorSettingsJson(), { mode: 0o644 });

  await runGit(["init", "-b", "main"], root);
  await runGit(["add", "--all"], root);
  await runGit([...gitIdentityFlags(), "commit", "-m", input.label], root);
  const commitSha = await runGit(["rev-parse", "HEAD"], root);

  return { path: root, commitSha, fileCount: input.files.length };
}

// Directories that are never part of the shippable manifest: git's own
// bookkeeping, installed dependencies, build/cache output, and the
// session pin itself (regenerated on every materialize, not something an
// operator edit could meaningfully change).
const SKIP_DIR_NAMES = new Set([".git", "node_modules", "dist", ".astro", ".claude"]);

// Large binaries an agent dropped in public/ are excluded outright,
// rather than counted toward the total-size cap below — the per-file
// limit is what actually keeps a single asset from making every ship
// round-trip slow.
const MAX_READBACK_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READBACK_TOTAL_FILES = 3000;
const MAX_READBACK_TOTAL_BYTES = 64 * 1024 * 1024;

// Extensions treated as binary regardless of whether they happen to
// decode as valid UTF-8 (a tiny/corrupt image could).
const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "ico",
  "pdf",
  "mp4",
  "webm",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "zip",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * Walks a worktree back into a manifest: text files come back as utf8,
 * anything binary (by extension, or because it just isn't valid utf8)
 * comes back base64-encoded. Skips git/dependency/build/session-pin
 * directories and anything over the per-file size limit; throws past the
 * total file-count or total-byte cap rather than silently truncating a
 * ship.
 */
export async function readWorktreeFiles(root: string): Promise<ManifestFile[]> {
  const out: ManifestFile[] = [];
  let totalBytes = 0;

  async function walk(dir: string, relDir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        await walk(join(dir, entry.name), relDir ? `${relDir}/${entry.name}` : entry.name);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks, sockets, etc — not source

      const abs = join(dir, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const info = await stat(abs);
      if (info.size > MAX_READBACK_FILE_BYTES) continue;

      if (out.length + 1 > MAX_READBACK_TOTAL_FILES) {
        throw new Error(`worktree has more than ${MAX_READBACK_TOTAL_FILES} files — refusing to ship a manifest this large`);
      }
      totalBytes += info.size;
      if (totalBytes > MAX_READBACK_TOTAL_BYTES) {
        throw new Error(`worktree content exceeds ${MAX_READBACK_TOTAL_BYTES} bytes — refusing to ship a manifest this large`);
      }

      const buf = await readFile(abs);
      if (BINARY_EXTENSIONS.has(extensionOf(entry.name))) {
        out.push({ path: relPath, content: buf.toString("base64"), encoding: "base64" });
        continue;
      }
      try {
        // `fatal: true` makes this throw on any byte sequence that is not
        // valid utf8, instead of silently substituting U+FFFD — a
        // silent substitution would ship corrupted content back.
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
        out.push({ path: relPath, content: text });
      } catch {
        out.push({ path: relPath, content: buf.toString("base64"), encoding: "base64" });
      }
    }
  }

  await walk(root, "");
  return out;
}

/**
 * Stages and commits whatever changed in the worktree since the last
 * commit. `--allow-empty` is deliberately NOT set: if the operator's
 * edits produced no diff (or none survived an undo), shipping an empty
 * commit would just be noise in a history flowstarter-main is going to
 * read back. Returns the current HEAD with `changed: false` instead.
 */
export async function commitWorktree(input: {
  readonly root: string;
  readonly message: string;
}): Promise<{ commitSha: string; changed: boolean }> {
  const root = resolve(input.root);
  await runGit(["add", "--all"], root);

  // `git diff --cached --quiet` exits 0 when there is nothing staged,
  // 1 when there is — the cheapest way to ask "would this commit be
  // empty" without parsing porcelain output.
  const diffProc = Bun.spawn({
    cmd: ["git", "diff", "--cached", "--quiet"],
    cwd: root,
    stdout: "ignore",
    stderr: "ignore",
  });
  const diffExitCode = await diffProc.exited;
  if (diffExitCode === 0) {
    const commitSha = await runGit(["rev-parse", "HEAD"], root);
    return { commitSha, changed: false };
  }

  await runGit([...gitIdentityFlags(), "commit", "-m", input.message], root);
  const commitSha = await runGit(["rev-parse", "HEAD"], root);
  return { commitSha, changed: true };
}
