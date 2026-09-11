/**
 * The bridge between the preview a client approved and the build they paid
 * for.
 *
 * A visitor gets two free changes to their preview. Until this module existed
 * those changes were applied to the running preview workspace and nowhere
 * else: `rememberClaimablePreview` had already written the pre-edit manifest
 * to `funnel_previews`, the claim copied that manifest into
 * `flowstarter_project_artifacts.preview_manifest`, and the build worker seeds
 * its worktree from exactly that column. So the paid build started from the
 * site as it was *before* the client edited it, and the two changes they
 * watched land were changes to a demo.
 *
 * Two things fix that, and both live here as pure functions so they can be
 * tested without a database:
 *
 *   `appliedPreviewEdit` turns "the workspace before, the workspace after, and
 *   what the client asked for" into a record of what actually changed. The
 *   caller re-stashes the *after* files, which is what makes the build seed
 *   from the edited site. The record is what makes the change auditable.
 *
 *   `derivePreviewIntent` turns the stored preview into the compact
 *   `previewIntent` the deposit webhook puts on the FULL_SITE_BUILD payload,
 *   so the worker can tell its agent what to preserve and check that it did.
 *
 * Rules decide, models phrase: the phrases a build is held to are diffed out
 * of the files, never guessed from the client's sentence.
 */
import type {
  ApprovedPreviewEdit,
  BusinessIntakePayload,
  PreviewBriefSnapshot,
  PreviewIntent,
  TemplateScaffoldFile,
} from '@flowstarter/agentic-codegen/src/flowstarter/types';
import {
  isPreviewToolingPath,
  isUsablePhrase,
  orderByRelevance,
  phraseFromLine,
  normalizePhrase,
  stripPreviewToolingFiles,
  usablePhrases,
  MAX_PHRASE_CHARS,
  MIN_PHRASE_CHARS,
} from '@flowstarter/agentic-codegen/src/flowstarter/preview-manifest';

/**
 * The phrase rules moved to `@flowstarter/agentic-codegen` so the build worker
 * can apply exactly the same ones when it re-derives an edit's evidence. They
 * are re-exported here because this module is where the rest of the app (and
 * every test written against it) has always looked for them.
 */
export {
  isPreviewToolingPath,
  isUsablePhrase,
  phraseFromLine,
  normalizePhrase,
  stripPreviewToolingFiles,
  usablePhrases,
  MAX_PHRASE_CHARS,
  MIN_PHRASE_CHARS,
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Enough to pin a copy change; few enough that the payload stays compact. */
export const MAX_PHRASES_PER_EDIT = 8;
/** The free-change cap is 2; the ceiling is here so payload size is bounded. */
export const MAX_CARRIED_EDITS = 8;
export const MAX_CHANGED_PATHS_PER_EDIT = 20;
/** A client instruction is capped by the edit route; capped again on the way out. */
export const MAX_INSTRUCTION_CHARS = 2_000;

export const DEPOSIT_PERCENT = 20;
export const BALANCE_PERCENT = 80;

/**
 * The text half of a manifest, with tooling state left out.
 *
 * The exclusion is here as well as at capture time on purpose: this function
 * is what a diff is computed from, and a manifest captured before the capture
 * rule existed still holds `.astro/dev.json`. Skipping it here means an old
 * preview edited today produces a clean record rather than a record of a dev
 * server's process id.
 */
function textFiles(
  files: readonly TemplateScaffoldFile[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of files) {
    if (!file || typeof file.path !== 'string') continue;
    if (file.encoding === 'base64') continue;
    if (typeof file.content !== 'string') continue;
    if (isPreviewToolingPath(file.path)) continue;
    map.set(file.path, file.content);
  }
  return map;
}

/**
 * What one free change did, as a fact about the files rather than a promise.
 *
 * A phrase counts as added when its normalized form appears nowhere in the
 * same file's previous content. Comparing per file and by normalized line
 * means reordering, re-indenting or re-quoting a line is not mistaken for new
 * copy, which matters: every false phrase here becomes a build the validator
 * fails for no reason.
 *
 * Two rules decide which lines are even looked at, and both exist because of
 * the 2026-09-12 false positive:
 *
 *   The file has to be somewhere a client's change can meaningfully land, and
 *   the content files are read before the pages, components and layouts. Path
 *   order used to decide this, which put `.astro/` first and `src/content/`
 *   last, and the eight-phrase cap then filled with a dev server's pid, port
 *   and start time before it ever reached the headline.
 *
 *   The line has to be prose. `"pid": 97132,` is long enough and has letters
 *   in it, which was the entire previous test.
 *
 * The cap is applied last, after both filters, so it now bounds evidence
 * rather than truncating it.
 */
export function appliedPreviewEdit(input: {
  index: number;
  instruction: string;
  before: readonly TemplateScaffoldFile[];
  after: readonly TemplateScaffoldFile[];
  appliedAt?: string;
}): ApprovedPreviewEdit {
  const before = textFiles(input.before);
  const after = textFiles(input.after);
  const changedPaths: string[] = [];
  const phrases: string[] = [];
  const seen = new Set<string>();

  for (const [path, content] of Array.from(after.entries()).sort((a, b) =>
    a[0] < b[0] ? -1 : 1
  )) {
    const previous = before.get(path);
    if (previous === content) continue;
    changedPaths.push(path);
  }
  // A deleted file is a change too, and the build should know the path moved.
  for (const path of Array.from(before.keys())) {
    if (!after.has(path) && !changedPaths.includes(path))
      changedPaths.push(path);
  }

  for (const path of orderByRelevance(changedPaths)) {
    const content = after.get(path);
    if (content === undefined) continue;
    const previous = before.get(path);
    const known = new Set(
      (previous ?? '').split('\n').map((line) => normalizePhrase(line))
    );
    for (const line of content.split('\n')) {
      if (known.has(normalizePhrase(line))) continue;
      const phrase = phraseFromLine(line);
      if (!phrase || !isUsablePhrase(phrase)) continue;
      const key = normalizePhrase(phrase);
      if (seen.has(key)) continue;
      // A phrase already somewhere else in the old file is not this edit's
      // doing; it only moved.
      if (normalizePhrase(previous ?? '').includes(key)) continue;
      seen.add(key);
      phrases.push(phrase);
    }
  }

  return {
    index: input.index,
    instruction: input.instruction.trim().slice(0, MAX_INSTRUCTION_CHARS),
    changedPaths: changedPaths.slice(0, MAX_CHANGED_PATHS_PER_EDIT),
    addedPhrases: phrases.slice(0, MAX_PHRASES_PER_EDIT),
    appliedAt: input.appliedAt ?? new Date().toISOString(),
  };
}

/** The untrusted JSON shape `funnel_previews.manifest` is read back as. */
export interface StoredPreviewManifest {
  files?: unknown;
  intake?: unknown;
  appliedEdits?: unknown;
}

/**
 * `appliedEdits` as stored, re-validated on the way out.
 *
 * The column is JSON written by this process, but it is still read back as
 * `unknown`: a manifest written by an older build, or hand-edited, must not
 * put a malformed edit onto a job payload the worker will trust.
 */
export function parseAppliedEdits(raw: unknown): ApprovedPreviewEdit[] {
  if (!Array.isArray(raw)) return [];
  const edits: ApprovedPreviewEdit[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const instruction =
      typeof record['instruction'] === 'string'
        ? record['instruction'].trim()
        : '';
    if (!instruction) continue;
    const strings = (value: unknown, cap: number): string[] =>
      Array.isArray(value)
        ? value
            .filter(
              (item): item is string =>
                typeof item === 'string' && item.trim().length > 0
            )
            .map((item) => item.slice(0, MAX_PHRASE_CHARS))
            .slice(0, cap)
        : [];
    edits.push({
      index:
        typeof record['index'] === 'number' && Number.isInteger(record['index'])
          ? record['index']
          : edits.length + 1,
      instruction: instruction.slice(0, MAX_INSTRUCTION_CHARS),
      // Tooling paths and unusable phrases are dropped on the way out as
      // well as on the way in: `funnel_previews.manifest` rows written before
      // this rule existed hold `.astro/dev.json` and the eight lines of dev
      // server state it produced, and a build must never be held to them.
      changedPaths: strings(
        record['changedPaths'],
        MAX_CHANGED_PATHS_PER_EDIT
      ).filter((path) => !isPreviewToolingPath(path)),
      addedPhrases: usablePhrases(
        strings(record['addedPhrases'], MAX_PHRASES_PER_EDIT)
      ),
      appliedAt:
        typeof record['appliedAt'] === 'string'
          ? record['appliedAt']
          : new Date(0).toISOString(),
    });
    if (edits.length >= MAX_CARRIED_EDITS) break;
  }
  return edits;
}

/** The handful of brief facts worth repeating to a build agent. */
export function briefSnapshot(
  intake: BusinessIntakePayload | undefined
): PreviewBriefSnapshot {
  const business = intake?.business;
  const trim = (value: unknown, cap = 400): string | undefined =>
    typeof value === 'string' && value.trim().length > 0
      ? value.trim().slice(0, cap)
      : undefined;
  return {
    businessName: trim(business?.name, 200) ?? '',
    niche: trim(business?.niche, 200) ?? '',
    location: trim(business?.location, 200) ?? '',
    ...(trim(business?.description)
      ? { description: trim(business?.description) }
      : {}),
    ...(trim(business?.targetAudience)
      ? { targetAudience: trim(business?.targetAudience) }
      : {}),
    ...(trim(business?.primaryGoal)
      ? { primaryGoal: trim(business?.primaryGoal) }
      : {}),
    ...(trim(intake?.locale, 32) ? { locale: trim(intake?.locale, 32) } : {}),
  };
}

/**
 * The compact record of an approved preview that rides on the build payload.
 *
 * Returns null for anything that is not a real claimed preview — an
 * operator-created project has no preview at all, and a manifest with no files
 * is not something a build can be held to. The caller omits the key entirely
 * in that case, so the payload stays the shape it always was.
 */
export function derivePreviewIntent(input: {
  previewId: string | null | undefined;
  manifest: unknown;
  artifactPath?: string | null;
  templateSlug?: string | null;
  capturedAt?: string;
}): PreviewIntent | null {
  const previewId = input.previewId;
  if (typeof previewId !== 'string' || !UUID.test(previewId)) return null;
  if (!input.manifest || typeof input.manifest !== 'object') return null;
  const manifest = input.manifest as StoredPreviewManifest;
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length === 0) return null;

  const intake =
    manifest.intake && typeof manifest.intake === 'object'
      ? (manifest.intake as BusinessIntakePayload)
      : undefined;

  return {
    previewId,
    manifest: {
      ref: `funnel_previews:${previewId}`,
      artifactPath: input.artifactPath ?? null,
      templateSlug: input.templateSlug ?? null,
      fileCount: files.length,
    },
    edits: parseAppliedEdits(manifest.appliedEdits),
    brief: briefSnapshot(intake),
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
}

export interface DepositBuildPayload {
  trigger: 'deposit_paid';
  source: 'payment_intent' | 'deposit_invoice';
  depositPercent: number;
  balancePercent: number;
  claimedPreviewId?: string;
  previewIntent?: PreviewIntent;
}

/**
 * The FULL_SITE_BUILD payload.
 *
 * The two new keys are additive and both optional: a workspace an operator
 * created by hand has no claimed preview, and the payload it gets is
 * byte-identical to the one this path has always written. The worker treats a
 * missing `previewIntent` as "nothing was approved", not as an error.
 */
export function depositBuildPayload(input: {
  source: 'payment_intent' | 'deposit_invoice';
  claimedPreviewId?: string | null;
  previewIntent?: PreviewIntent | null;
}): DepositBuildPayload {
  return {
    trigger: 'deposit_paid',
    source: input.source,
    depositPercent: DEPOSIT_PERCENT,
    balancePercent: BALANCE_PERCENT,
    ...(typeof input.claimedPreviewId === 'string' &&
    UUID.test(input.claimedPreviewId)
      ? { claimedPreviewId: input.claimedPreviewId }
      : {}),
    ...(input.previewIntent ? { previewIntent: input.previewIntent } : {}),
  };
}
