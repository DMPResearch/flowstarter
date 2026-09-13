/**
 * The on-disk half of the `GENERATED_HTML_UNSAFE` gate.
 *
 * `findMarkupPolicyIssue` in `@flowstarter/agentic-codegen` runs inside the
 * workflow, over the text the build produced, so the agent gets one pass to
 * take its own markup back out. This is the gate of record: it reads the
 * compiled `dist/` directly, after the repair pass and after every other
 * transformation, because the only question that matters is what the client's
 * visitors would actually be served.
 *
 * Structured like `output-cal-preview.ts` and `output-placeholder-images.ts`,
 * which walk the same directory for the same reason. The difference is what it
 * does with a file: HTML is parsed into the tree a browser would build (see
 * `markup-policy.ts`), and compiled JavaScript is scanned for the one
 * capability that survives the page that asked for it — a service worker.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  findMarkupPolicyViolations,
  findServiceWorkerRegistration,
  type MarkupPolicy,
  type MarkupViolation,
} from '@flowstarter/agentic-codegen';

/** Never part of a deployable site, and never worth walking. */
const SKIPPED_DIRS = new Set([
  '.git',
  'node_modules',
  '.astro',
  '.cache',
  '.turbo',
  '.next',
  '.vercel',
  '.netlify',
]);

/** Files a browser parses as markup. */
const HTML_OUTPUT = /\.html?$/i;

/** Files a browser executes. */
const SCRIPT_OUTPUT = /\.(m|c)?js$/i;

/**
 * A page past this is not a page. The largest template build's biggest
 * compiled page is a small fraction of it, and parsing an arbitrarily large
 * file the agent wrote is the one way this gate could become the slow step.
 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Every capability the compiled site under `dir` asks for that `policy` does
 * not grant, relative to `dir` and in posix form. Empty means it is clean.
 */
export async function findMarkupViolationsInDir(
  dir: string,
  policy: MarkupPolicy,
): Promise<MarkupViolation[]> {
  const violations: MarkupViolation[] = [];

  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      const isHtml = HTML_OUTPUT.test(entry.name);
      const isScript = SCRIPT_OUTPUT.test(entry.name);
      if (!isHtml && !isScript) continue;

      const rel = relative(dir, absolute).split(sep).join('/');
      let content: string;
      try {
        content = await readFile(absolute, 'utf8');
      } catch {
        // A file this worker cannot read is a file the deploy would not ship
        // either; the tarball step fails on it long before a visitor sees it.
        continue;
      }
      if (content.length > MAX_FILE_BYTES) continue;

      if (isHtml) {
        violations.push(...findMarkupPolicyViolations(rel, content, policy));
      } else {
        violations.push(...findServiceWorkerRegistration(rel, content));
      }
    }
  };

  await walk(dir);
  violations.sort((a, b) =>
    a.path === b.path
      ? (a.line ?? 0) - (b.line ?? 0)
      : a.path < b.path
        ? -1
        : 1,
  );
  return violations;
}
