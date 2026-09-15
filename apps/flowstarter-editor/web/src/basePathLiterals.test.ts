import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the fix in `lib/basePath.ts`: a sub-path production deploy
 * (`VITE_BASE_PATH=/editor/`) sits behind Caddy's `handle_path /editor/*`,
 * which strips the prefix before proxying to the router. Any `fetch()`,
 * `new WebSocket()`, `new URL()`, or `.pathname =` that hardcodes an
 * absolute `/api/...`, `/ws`, or `/pair` literal — instead of routing it
 * through `withBasePath()` / `EDITOR_BASE_PATH` — sends that request one
 * level too high, past the prefix Caddy is stripping for, and it falls
 * through to the tenant's own site content instead of the router (200
 * with unrelated HTML, not the JSON/upgrade the caller expects).
 *
 * This scans the SPA's own source tree for that exact shape and fails the
 * build on any new occurrence outside the declared exceptions below. It
 * is intentionally narrow — a plain grep for `/api/` etc. would also flag
 * every doc comment in the tree (this codebase references those paths in
 * JSDoc constantly) — so it only matches the call/assignment shapes that
 * actually build a request or navigation URL, and skips comment lines.
 */

const SRC_ROOT = path.resolve(import.meta.dirname);

// Files entirely out of scope for the scan (generated, or the helper
// module itself, which legitimately contains the base-path literal
// `import.meta.env.BASE_URL` that everything else routes through).
const EXCLUDED_FILES = new Set(["routeTree.gen.ts", "basePath.ts", "basePathLiterals.test.ts"]);

function isScannableSourceFile(fileName: string): boolean {
  if (!/\.(ts|tsx)$/.test(fileName)) return false;
  if (fileName.endsWith(".test.ts") || fileName.endsWith(".test.tsx")) return false;
  if (fileName.endsWith(".browser.tsx")) return false;
  if (EXCLUDED_FILES.has(fileName)) return false;
  return true;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules") continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (isScannableSourceFile(entry)) out.push(full);
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/**") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed === "*/"
  );
}

// The dangerous shapes: a literal (not a variable, not a template
// expression) starting a fetch call, a WebSocket URL, a `new URL(...)`
// first argument, or a direct `.pathname =` assignment, whose value is
// itself an absolute `/api/...`, `/ws`, or `/pair` path.
const DANGEROUS_PATTERNS: ReadonlyArray<RegExp> = [
  /fetch\(\s*(['"`])(\/api\/|\/ws|\/pair)/,
  /new WebSocket\(\s*(['"`])(\/api\/|\/ws|\/pair)/,
  /new URL\(\s*(['"`])(\/api\/|\/ws|\/pair)/,
  /\.pathname\s*=\s*(['"`])(\/api\/|\/ws|\/pair)/,
];

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

interface AllowedException {
  readonly file: string;
  readonly lineIncludes: string;
  readonly reason: string;
}

// Every hit the scan below finds must either be fixed to route through
// `withBasePath()` (or `EDITOR_BASE_PATH` for a raw prefix), or be listed
// here with a reason it is correctly exempt. Keep this list short — it is
// a review gate, not a place to launder a real bug.
const ALLOWED_EXCEPTIONS: ReadonlyArray<AllowedException> = [
  {
    file: "components/settings/ConnectionsSettings.tsx",
    lineIncludes: "url.pathname",
    reason:
      "resolveDesktopPairingUrl's endpointUrl is a standalone desktop-exposed " +
      "backend's own origin (LAN host:port), not this SPA's own sub-path " +
      "deploy behind Caddy — it is always root-mounted, so a bare /pair here " +
      "is correct.",
  },
];

describe("editor SPA base-path literals", () => {
  const files = listSourceFiles(SRC_ROOT);
  expect(files.length).toBeGreaterThan(0);

  const violations: Violation[] = [];

  for (const absoluteFile of files) {
    const relativeFile = path.relative(SRC_ROOT, absoluteFile).split(path.sep).join("/");
    const lines = readFileSync(absoluteFile, "utf8").split(/\r?\n/);
    lines.forEach((lineText, index) => {
      if (isCommentLine(lineText)) return;
      if (!DANGEROUS_PATTERNS.some((pattern) => pattern.test(lineText))) return;
      violations.push({ file: relativeFile, line: index + 1, text: lineText.trim() });
    });
  }

  const unmatchedViolations = violations.filter(
    (violation) =>
      !ALLOWED_EXCEPTIONS.some(
        (exception) =>
          exception.file === violation.file && violation.text.includes(exception.lineIncludes),
      ),
  );

  it("has no hardcoded /api, /ws, or /pair path literal outside the base-path helper", () => {
    if (unmatchedViolations.length === 0) return;
    const details = unmatchedViolations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join("\n");
    expect.fail(
      `Found ${unmatchedViolations.length} hardcoded absolute-path literal(s) that skip ` +
        `withBasePath()/EDITOR_BASE_PATH (lib/basePath.ts). These break under a sub-path ` +
        `deploy (VITE_BASE_PATH=/editor/) — route them through withBasePath(), or add a ` +
        `reasoned entry to ALLOWED_EXCEPTIONS in this test if the literal is correctly ` +
        `exempt:\n${details}`,
    );
  });

  it("only lists exceptions that still match something in the tree", () => {
    const stale = ALLOWED_EXCEPTIONS.filter(
      (exception) =>
        !violations.some(
          (violation) =>
            violation.file === exception.file && violation.text.includes(exception.lineIncludes),
        ),
    );
    expect(
      stale,
      `Stale ALLOWED_EXCEPTIONS entries (no longer present in source): ${JSON.stringify(stale)}`,
    ).toEqual([]);
  });
});
