/**
 * Parity guard: agent-boundary.ts mirrors pi-sdk.ts's immutable-path
 * rule (PACKAGE_MANAGER_DIRECTORIES / PACKAGE_MANAGER_FILES /
 * isPackageManagerConfigPath / assertMutableAgentPath's alwaysDenied
 * branch). A copy-paste mirror is only as good as the last time someone
 * remembered to re-copy it, so the first test below reads pi-sdk.ts off
 * disk and checks the router's own sets against it directly — a name
 * added upstream and not here fails this test, not silently.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  CLAUDE_DENY_RULES,
  PACKAGE_MANAGER_DIRECTORIES,
  PACKAGE_MANAGER_FILES,
  immutableAgentPathReason,
} from "../src/agent-boundary.ts";

const PI_SDK_PATH = new URL(
  "../../../../packages/agentic-codegen/src/flowstarter/pi-sdk.ts",
  import.meta.url,
);

/** Pulls every quoted string literal out of a `new Set([...])` block. */
function extractSetLiterals(source: string, constName: string): string[] {
  const setStart = source.indexOf(`const ${constName}`);
  if (setStart === -1) throw new Error(`could not find "const ${constName}" in pi-sdk.ts`);
  const open = source.indexOf("[", setStart);
  const close = source.indexOf("]", open);
  const body = source.slice(open + 1, close);
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "");
}

describe("parity with pi-sdk.ts's alwaysDenied rule", () => {
  test("every upstream PACKAGE_MANAGER_DIRECTORIES / PACKAGE_MANAGER_FILES entry is present here", async () => {
    const source = await readFile(PI_SDK_PATH, "utf8");
    const upstreamDirs = extractSetLiterals(source, "PACKAGE_MANAGER_DIRECTORIES");
    const upstreamFiles = extractSetLiterals(source, "PACKAGE_MANAGER_FILES");

    // Sanity: the extractor itself actually found entries, so this test
    // fails loudly (not vacuously) if pi-sdk.ts's shape changes.
    expect(upstreamDirs.length).toBeGreaterThan(0);
    expect(upstreamFiles.length).toBeGreaterThan(0);

    for (const dir of upstreamDirs) {
      expect(PACKAGE_MANAGER_DIRECTORIES.has(dir)).toBe(true);
    }
    for (const file of upstreamFiles) {
      expect(PACKAGE_MANAGER_FILES.has(file)).toBe(true);
    }
  });

  test("CLAUDE_DENY_RULES covers every entry in both sets", () => {
    for (const dir of PACKAGE_MANAGER_DIRECTORIES) {
      expect(CLAUDE_DENY_RULES.some((rule) => rule.includes(dir))).toBe(true);
    }
    for (const file of PACKAGE_MANAGER_FILES) {
      expect(CLAUDE_DENY_RULES.some((rule) => rule.includes(file))).toBe(true);
    }
  });
});

describe("immutableAgentPathReason", () => {
  test("denies package manager config, lockfiles, secrets, env, build output, and CI config", () => {
    expect(immutableAgentPathReason("package.json")).not.toBeNull();
    expect(immutableAgentPathReason("nested/.npmrc")).not.toBeNull();
    expect(immutableAgentPathReason(".pnpmfile.cjs")).not.toBeNull();
    expect(immutableAgentPathReason(".PNPMFILE.CJS")).not.toBeNull();
    expect(immutableAgentPathReason("pnpm-lock.yaml")).not.toBeNull();
    expect(immutableAgentPathReason("src/.env.local")).not.toBeNull();
    expect(immutableAgentPathReason(".github/workflows/x.yml")).not.toBeNull();
    expect(immutableAgentPathReason("node_modules/x/index.js")).not.toBeNull();
    expect(immutableAgentPathReason("astro.config.mjs")).not.toBeNull();
  });

  test('the basename "lock" check denies locksmiths.md too — mirrored from upstream exactly, not "fixed" here', () => {
    // Upstream's own comment on this line: the check is on the basename
    // alone (not a fixed list of known lockfile names), and the accepted
    // cost is that a page about a locksmith is denied along with every
    // lockfile upstream hasn't been taught the name of yet. This test
    // pins that real (if surprising) upstream behaviour rather than the
    // behaviour a reader might assume from the file name alone.
    expect(immutableAgentPathReason("src/content/blog/locksmiths.md")).not.toBeNull();
  });

  test("allows ordinary site source", () => {
    expect(immutableAgentPathReason("src/pages/about.astro")).toBeNull();
    expect(immutableAgentPathReason("src/components/Hero.astro")).toBeNull();
    expect(immutableAgentPathReason("public/flowstarter-media/x.jpg")).toBeNull();
  });
});
