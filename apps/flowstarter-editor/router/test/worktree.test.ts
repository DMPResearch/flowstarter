/**
 * Materialize a manifest into a temp dir → files land correctly, base64
 * round-trips, `.claude/settings.json` is pinned, a real git commit
 * exists → read it back → text and binary both round-trip, git/
 * dependency dirs are skipped → ship a change → a new commit, or the
 * same HEAD when nothing changed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_DENY_RULES } from "../src/agent-boundary.ts";
import {
  assertSafeManifestPath,
  commitWorktree,
  materializeWorktree,
  readWorktreeFiles,
} from "../src/worktree.ts";

let workspacesRoot: string;

beforeEach(async () => {
  workspacesRoot = await mkdtemp(join(tmpdir(), "fse-wt-"));
});

afterEach(async () => {
  await rm(workspacesRoot, { recursive: true, force: true });
});

describe("assertSafeManifestPath", () => {
  test("refuses path traversal, absolute paths, backslashes, and .git writes", () => {
    expect(() => assertSafeManifestPath("../escape")).toThrow();
    expect(() => assertSafeManifestPath("a/../../escape")).toThrow();
    expect(() => assertSafeManifestPath("/abs")).toThrow();
    expect(() => assertSafeManifestPath("windows\\path.txt")).toThrow();
    expect(() => assertSafeManifestPath(".git/config")).toThrow();
    expect(() => assertSafeManifestPath("")).toThrow();
    expect(() => assertSafeManifestPath("x".repeat(401))).toThrow();
  });

  test("allows ordinary relative source paths", () => {
    expect(() => assertSafeManifestPath("src/pages/about.astro")).not.toThrow();
    expect(() => assertSafeManifestPath("public/flowstarter-media/x.jpg")).not.toThrow();
  });
});

describe("materializeWorktree", () => {
  test("writes files, decodes base64, pins .claude/settings.json, and commits", async () => {
    const root = join(workspacesRoot, "acme");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

    const result = await materializeWorktree({
      workspacesRoot,
      root,
      files: [
        { path: "src/pages/about.astro", content: "<h1>About</h1>" },
        { path: "public/flowstarter-media/logo.png", content: png.toString("base64"), encoding: "base64" },
      ],
      label: "session abc: open",
    });

    expect(result.path).toBe(root);
    expect(result.fileCount).toBe(2);
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

    const text = await readFile(join(root, "src/pages/about.astro"), "utf8");
    expect(text).toBe("<h1>About</h1>");

    const binary = await readFile(join(root, "public/flowstarter-media/logo.png"));
    expect(binary.equals(png)).toBe(true);

    const settingsRaw = await readFile(join(root, ".claude/settings.json"), "utf8");
    const settings = JSON.parse(settingsRaw);
    expect(settings.permissions.deny).toEqual([...CLAUDE_DENY_RULES]);
    expect(settings.permissions.additionalDirectories).toEqual([]);
    expect(settings.enableAllProjectMcpServers).toBe(false);

    // A real commit, not a fake sha — `git log` must find it.
    const logProc = Bun.spawn({ cmd: ["git", "log", "--oneline"], cwd: root, stdout: "pipe" });
    const log = await new Response(logProc.stdout).text();
    expect(await logProc.exited).toBe(0);
    expect(log).toContain("session abc: open");
  });

  test("refuses a root outside the configured workspaces root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "fse-outside-"));
    try {
      await expect(
        materializeWorktree({
          workspacesRoot,
          root: outside,
          files: [{ path: "a.txt", content: "x" }],
          label: "escape attempt",
        }),
      ).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("refuses the workspaces root itself as the materialize target", async () => {
    await expect(
      materializeWorktree({
        workspacesRoot,
        root: workspacesRoot,
        files: [{ path: "a.txt", content: "x" }],
        label: "escape attempt",
      }),
    ).rejects.toThrow();
  });

  test("refuses an unsafe manifest path before writing anything", async () => {
    const root = join(workspacesRoot, "acme");
    await expect(
      materializeWorktree({
        workspacesRoot,
        root,
        files: [{ path: "../escape.txt", content: "x" }],
        label: "bad manifest",
      }),
    ).rejects.toThrow();
  });
});

describe("readWorktreeFiles", () => {
  test("round-trips text and binary, and skips .git / node_modules", async () => {
    const root = join(workspacesRoot, "acme");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

    await materializeWorktree({
      workspacesRoot,
      root,
      files: [
        { path: "src/pages/about.astro", content: "<h1>About</h1>" },
        { path: "public/flowstarter-media/logo.png", content: png.toString("base64"), encoding: "base64" },
      ],
      label: "session abc: open",
    });

    // Simulate an installed dependency that must never round-trip back.
    await mkdir(join(root, "node_modules/left-pad"), { recursive: true });
    await writeFile(join(root, "node_modules/left-pad/index.js"), "module.exports = () => {}");

    const files = await readWorktreeFiles(root);
    const byPath = new Map(files.map((f) => [f.path, f]));

    expect(byPath.get("src/pages/about.astro")?.content).toBe("<h1>About</h1>");
    expect(byPath.get("src/pages/about.astro")?.encoding).toBeUndefined();

    const logo = byPath.get("public/flowstarter-media/logo.png");
    expect(logo?.encoding).toBe("base64");
    expect(Buffer.from(logo?.content ?? "", "base64").equals(png)).toBe(true);

    expect([...byPath.keys()].some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect([...byPath.keys()].some((p) => p.startsWith(".git/"))).toBe(false);
    expect([...byPath.keys()].some((p) => p.startsWith(".claude/"))).toBe(false);
  });
});

describe("commitWorktree", () => {
  test("commits a real change and returns a new sha", async () => {
    const root = join(workspacesRoot, "acme");
    const opened = await materializeWorktree({
      workspacesRoot,
      root,
      files: [{ path: "src/pages/about.astro", content: "<h1>About</h1>" }],
      label: "session abc: open",
    });

    await writeFile(join(root, "src/pages/about.astro"), "<h1>About us</h1>");
    const shipped = await commitWorktree({ root, message: "Update about copy" });

    expect(shipped.changed).toBe(true);
    expect(shipped.commitSha).not.toBe(opened.commitSha);
  });

  test("returns changed:false and the same HEAD when nothing changed", async () => {
    const root = join(workspacesRoot, "acme");
    const opened = await materializeWorktree({
      workspacesRoot,
      root,
      files: [{ path: "src/pages/about.astro", content: "<h1>About</h1>" }],
      label: "session abc: open",
    });

    const shipped = await commitWorktree({ root, message: "No-op ship" });
    expect(shipped.changed).toBe(false);
    expect(shipped.commitSha).toBe(opened.commitSha);
  });
});
