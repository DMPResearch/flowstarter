import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reassembleFile, splitFrontmatter, topLevelKeys } from '../yaml-blocks';

/**
 * The top-level `site-labels.md` blocks a template's homepage and contact
 * page cannot render without, keyed by template slug.
 *
 * `hero` is the fold every visitor sees first: every template's homepage
 * opens with a `Hero.astro` that reads `hero.title`, `hero.text` and
 * `hero.actions` unconditionally. `contactPage` is the one place a paying
 * visitor is asked to act: every template's `getContactPageData()` reads
 * `siteLabels.contactPage` for the page's heading, intro and form — absent,
 * the page still builds (every field there defaults through `?? {}` /
 * `asString`), but it renders with nothing in it.
 *
 * This table is intentionally conservative: it lists only the blocks whose
 * absence leaves a page structurally empty of its core content, not every
 * optional block a repair pass elsewhere already guards (e.g. `aboutPage`,
 * `servicesPage`, `caseStudies` all default gracefully to an empty-but-
 * present section). `demo-coach` is the internal demo template, never a
 * customer site, and is intentionally left out; an unknown or absent slug
 * falls back to `[]` via the `?? []` at each call site.
 */
export const REQUIRED_LABEL_BLOCKS: Record<string, readonly string[]> = {
  'creative-portfolio': ['hero', 'contactPage'],
  'dorin-portfolio': ['hero', 'contactPage'],
  'local-trade': ['hero', 'contactPage'],
  'professional-services': ['hero', 'contactPage'],
  'wellness-therapy': ['hero', 'contactPage'],
};

const SITE_LABELS_RELATIVE_PATH = 'src/content/site-labels.md';

/**
 * Which of a template's required top-level blocks are missing from a
 * workspace's `site-labels.md`.
 *
 * Defensive by design: a file that cannot be read is a different failure
 * mode (already handled elsewhere, upstream of this check), so it is
 * reported as "nothing missing" here rather than raised as an error. A
 * template with no required blocks configured is likewise reported clean.
 */
export async function findMissingLabelBlocks(
  workspaceRoot: string,
  templateSlug: string,
): Promise<string[]> {
  const required = REQUIRED_LABEL_BLOCKS[templateSlug] ?? [];
  if (required.length === 0) return [];

  let raw: string;
  try {
    raw = await readFile(
      join(workspaceRoot, SITE_LABELS_RELATIVE_PATH),
      'utf8',
    );
  } catch {
    return [];
  }

  const { yaml } = splitFrontmatter(raw);
  const present = new Set(topLevelKeys(yaml));
  return required.filter((key) => !present.has(key));
}

/**
 * Which of a template's required top-level blocks are missing from an
 * *already-parsed* `site-labels.md` — the object `checkSiteLabelsIntegrity`
 * (`site-labels-integrity.ts`) produced from a real YAML parse, not a
 * re-scan of the raw text.
 *
 * This is what the two real call sites in `workflows.ts` use now:
 * `checkSiteLabelsIntegrity` runs first and either repairs an unterminated
 * frontmatter block or fails the job with `LABELS_UNPARSEABLE`, so by the
 * time this runs, `parsed` reflects exactly what Astro's own frontmatter
 * parser would see — unlike `findMissingLabelBlocks` above, which reads the
 * keys straight off the raw text with a line-anchored scan and reported
 * `hero` and `contactPage` as "present" in the file that started all this,
 * because their key lines existed even though the fence around them never
 * closed. `findMissingLabelBlocks` stays for direct, workspace-only callers
 * (and its own tests below); it is simply no longer what a build or preview
 * decides against.
 *
 * `parsed` is `undefined` when there was no file to check at all (the same
 * "different failure mode, handled elsewhere" case `findMissingLabelBlocks`
 * reports as `[]`).
 */
export function missingRequiredLabelBlocksFromParsed(
  parsed: Record<string, unknown> | undefined,
  templateSlug: string,
): string[] {
  const required = REQUIRED_LABEL_BLOCKS[templateSlug] ?? [];
  if (required.length === 0 || !parsed) return [];
  const present = new Set(Object.keys(parsed));
  return required.filter((key) => !present.has(key));
}

export interface RequiredBlockRepairInput {
  businessName: string;
  offer?: string;
  ctaLabel: string;
  ctaHref: string;
}

/**
 * Escape a value for use inside a double-quoted YAML scalar.
 *
 * `businessName` and `offer` are client-supplied text, so this has to hold
 * even against an adversarial input: backslashes and double quotes are
 * escaped so the string cannot end early, and any literal line break is
 * escaped to `\n` rather than left raw, so it cannot close the scalar and
 * start a new (attacker-chosen) top-level YAML key on the next line.
 */
function yamlQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, '\\n')
    .replace(/[\r\n]/g, '\\n')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** A one-line fallback when the intake carried no offer to quote from. */
function heroText(input: RequiredBlockRepairInput): string {
  const offer = input.offer?.trim();
  return offer && offer.length > 0
    ? offer
    : `${input.businessName} is ready to help — get in touch to find out more.`;
}

function introText(input: RequiredBlockRepairInput): string {
  const offer = input.offer?.trim();
  return offer && offer.length > 0
    ? offer
    : `Reach out to ${input.businessName} to get started.`;
}

/**
 * `Hero.astro` reads `hero.title`, `hero.text` and `hero.actions` with no
 * fallback for a missing block (only individual optional fields — `image`,
 * `highlights`, `label`, `tags` — degrade gracefully), so those three are
 * the minimum that keeps the fold from rendering blank.
 */
function buildHeroBlock(input: RequiredBlockRepairInput): string {
  return [
    'hero:',
    `  title: ${yamlQuote(input.businessName)}`,
    `  text: ${yamlQuote(heroText(input))}`,
    '  actions:',
    `    - label: ${yamlQuote(input.ctaLabel)}`,
    `      href: ${yamlQuote(input.ctaHref)}`,
  ].join('\n');
}

/**
 * `getContactPageData()` defaults every field through `?? {}` / `asString`,
 * so nothing here is required to keep the build from crashing — but with
 * the block absent the page has no heading, no intro and no way to act,
 * which is the whole page's job. This fills exactly that: a heading, an
 * intro sentence, and the CTA carried through the form's submit label and
 * the details panel's call link — not the fields (address, map embed,
 * phone) that were already going to render fine empty.
 */
function buildContactPageBlock(input: RequiredBlockRepairInput): string {
  return [
    'contactPage:',
    '  titleLines:',
    `    - text: ${yamlQuote(`Contact ${input.businessName}`)}`,
    `  introText: ${yamlQuote(introText(input))}`,
    '  form:',
    `    title: ${yamlQuote('Get in touch')}`,
    `    submitLabel: ${yamlQuote(input.ctaLabel)}`,
    '  details:',
    `    strategicCallLabel: ${yamlQuote(input.ctaLabel)}`,
    `    strategicCallHref: ${yamlQuote(input.ctaHref)}`,
  ].join('\n');
}

const BLOCK_BUILDERS: Record<
  string,
  (input: RequiredBlockRepairInput) => string
> = {
  hero: buildHeroBlock,
  contactPage: buildContactPageBlock,
};

/**
 * Deterministically construct and append the named missing blocks to a
 * workspace's `site-labels.md`, preserving everything else byte-for-byte.
 *
 * No LLM: this exists specifically so a missing block never costs a retry of
 * the (expensive, non-deterministic) agent pass that writes the file. Each
 * block is built from `repair` alone — the business name, the offer, and a
 * default call to action — never from any other content already in the file,
 * so it composes safely no matter what else is or isn't present.
 */
export async function repairMissingLabelBlocks(
  workspaceRoot: string,
  missing: readonly string[],
  repair: RequiredBlockRepairInput,
): Promise<void> {
  if (missing.length === 0) return;

  const unknown = missing.filter((key) => !(key in BLOCK_BUILDERS));
  if (unknown.length > 0) {
    throw new Error(
      `required-label-blocks: no deterministic repair known for ${unknown.join(', ')}`,
    );
  }

  const filePath = join(workspaceRoot, SITE_LABELS_RELATIVE_PATH);
  const raw = await readFile(filePath, 'utf8');
  const original = splitFrontmatter(raw);

  const appended = missing.map((key) => BLOCK_BUILDERS[key]!(repair));
  const newYaml = [original.yaml.replace(/\s+$/, ''), ...appended].join('\n\n');

  await writeFile(filePath, reassembleFile(original, newYaml), 'utf8');
}
