/**
 * The `[integrity]` gate for `src/content/site-labels.md` — the one content
 * file every template reads its copy from.
 *
 * `findWorkspaceIntegrityIssue` in `workflows.ts` already does this shape of
 * check for `global.css`: a mechanical parse, not a scan, run right after the
 * agent pass and before anything trusts the file. `site-labels.md` had no
 * equivalent, and a paid build (job `7508bf52`, 2026-09-14) is what that cost:
 * the agent pass wrote 277 lines that open with `---` and never close it.
 * Astro's own frontmatter parser found no closing fence, produced no
 * `siteLabels` at all, and every template's `Hero.astro` reads
 * `(siteLabels as any).hero ?? {}` — correct, and it is what kept the build
 * from crashing, but it turned "the labels did not parse" into a page that
 * silently shipped with an empty `<h1>` and a bare "Home" `<title>` instead
 * of a build failure anyone would see.
 *
 * `required-label-blocks.ts`'s own check did not catch it either, and could
 * not have: it looks for top-level keys with a line-anchored scan of the raw
 * text, independent of whether the `---` fences even close, so `hero:` and
 * `contactPage:` both read as "present" in that 277-line file even though
 * Astro parsed nothing from it. This module is the check that actually
 * mirrors what Astro does — a real YAML parse of the fenced block — and it
 * runs before the required-blocks check, which then reads the object this
 * module already parsed rather than re-deriving its own, weaker answer from
 * the same raw text.
 *
 * Rules decide, models phrase: the repair here is entirely mechanical (close
 * the fence, only when everything it would enclose is already valid YAML on
 * its own) and the failure, when the file cannot be trusted at all, is one
 * plain sentence naming what is wrong — never a guess at what the labels
 * were supposed to say.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { splitFrontmatter } from '../yaml-blocks';

/** The ledger code a build (or a preview) fails under when this gate cannot be satisfied. */
export const LABELS_UNPARSEABLE = 'LABELS_UNPARSEABLE';

const SITE_LABELS_RELATIVE_PATH = 'src/content/site-labels.md';

/** Raised by `checkSiteLabelsIntegrity` when the file cannot be repaired deterministically. */
export class SiteLabelsUnparseableError extends Error {
  readonly code = LABELS_UNPARSEABLE;
  constructor(detail: string) {
    super(detail);
    this.name = 'SiteLabelsUnparseableError';
  }
}

export interface SiteLabelsIntegrityResult {
  /** The frontmatter's YAML, parsed into a plain object — never raw text past this point. */
  readonly parsed: Record<string, unknown>;
  /** True when the file on disk needed its closing fence added. */
  readonly repaired: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `yamlText` parsed as a YAML *map* specifically — a list, a scalar or invalid YAML all fail this. */
function tryParseYamlMap(
  yamlText: string,
): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = parseYaml(yamlText);
  } catch {
    return undefined;
  }
  return isPlainObject(value) ? value : undefined;
}

/**
 * Reads, validates and — when it can be done without guessing at content —
 * repairs a workspace's `site-labels.md`.
 *
 * Absent entirely: reported as nothing to check (`undefined`), the same
 * convention `findMissingLabelBlocks` already uses. A missing file is a
 * different failure mode than a broken one, and is handled upstream of this
 * gate.
 *
 * Present, and the frontmatter opens and closes onto YAML that parses into a
 * map: returned as-is, `repaired: false`.
 *
 * Present, opens with `---`, but never closes it — the run5 shape. The
 * deterministic repair: if closing the fence at the end of the file would
 * make the whole remainder parse as a YAML map on its own, the file is
 * rewritten with that closing fence and the now-valid parse is returned.
 * Nothing about the labels themselves is invented; the only change is the
 * three characters that were missing.
 *
 * Anything else wrong — no opening fence at all, a fence that closes onto
 * YAML that still doesn't parse, an unterminated fence whose remainder is
 * not valid YAML either, or YAML that parses to something other than a map
 * (a string, a list, `null`) — cannot be repaired without guessing at
 * structure the agent pass was supposed to have written, so this throws
 * `SiteLabelsUnparseableError` instead of letting a page ship with silently
 * empty copy.
 */
export async function checkSiteLabelsIntegrity(
  workspaceRoot: string,
): Promise<SiteLabelsIntegrityResult | undefined> {
  const filePath = join(workspaceRoot, SITE_LABELS_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }

  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!withoutBom.startsWith('---')) {
    throw new SiteLabelsUnparseableError(
      `${SITE_LABELS_RELATIVE_PATH} does not open with the "---" frontmatter fence every template's labels have to be written inside.`,
    );
  }

  const opened = splitFrontmatter(raw);
  if (opened.hasFm) {
    const parsed = tryParseYamlMap(opened.yaml);
    if (!parsed) {
      throw new SiteLabelsUnparseableError(
        `${SITE_LABELS_RELATIVE_PATH}'s frontmatter opens and closes, but the YAML between the fences does not parse into a set of labels.`,
      );
    }
    return { parsed, repaired: false };
  }

  // Opens but never closes. Test the deterministic repair by asking exactly
  // the question it depends on: does appending the missing fence at the end
  // of the file turn the whole thing into something that opens AND closes,
  // onto YAML that parses as a map? Reusing `splitFrontmatter` here (rather
  // than re-deriving "the remainder" by hand) is what guarantees this check
  // and the repair agree on exactly what the closing fence would enclose.
  const candidate = `${raw.replace(/\s+$/, '')}\n---\n`;
  const candidateFm = splitFrontmatter(candidate);
  const parsed = candidateFm.hasFm
    ? tryParseYamlMap(candidateFm.yaml)
    : undefined;
  if (!parsed) {
    throw new SiteLabelsUnparseableError(
      `${SITE_LABELS_RELATIVE_PATH} opens with "---" but never closes the frontmatter block, and what follows does not parse as YAML on its own, so it cannot be closed automatically.`,
    );
  }
  await writeFile(filePath, candidate, 'utf8');
  return { parsed, repaired: true };
}
