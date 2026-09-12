/**
 * A paid change request as something a build can actually be held to.
 *
 * A client files a request the editor refused, an operator quotes it, the
 * client pays, and until this existed the only button left on the operator's
 * board was "Mark done", which moved a status and shipped nothing. The work
 * itself needs an agent pass over the site that is already live, and an agent
 * pass over a delivered site needs three things this module owns: the request
 * in the client's own words, the client's own rights-confirmed pictures with
 * the paths they will have on disk, and a check that the finished site
 * actually carries what was bought.
 *
 * The check is the delicate half, and it is written under the lesson PR #98
 * paid for: a gate that fails a build against text no site can contain is
 * worse than no gate. So the only evidence it will use is evidence that can
 * honestly be expected to appear in a built site:
 *
 *   - every asset the operator attached, by its public path, because those
 *     files were attached precisely so they would be on the page, and
 *   - text the client put in quotation marks, because quoting a sentence is
 *     how somebody says "these exact words".
 *
 * The rest of a request is an instruction ("please add a small gallery"), not
 * content, and looking for it in the output would fail every build that did
 * the work correctly. A request with neither kind of evidence passes with a
 * line on the board saying so, exactly as an unresolvable approved edit does.
 */
import { normalizePhrase, isUsablePhrase } from './preview-manifest';

/** Longest request text carried out of an untrusted jsonb payload. */
export const CHANGE_REQUEST_TEXT_MAX = 2_000;
/** Longest operator note carried with it. */
export const CHANGE_REQUEST_NOTE_MAX = 2_000;
/** Most assets one change request may carry into a build. */
export const CHANGE_REQUEST_ASSETS_MAX = 12;
/** Most quoted phrases the applied-change check will hold a build to. */
export const CHANGE_REQUEST_PHRASES_MAX = 8;

/** Where a client's own picture lands in the site, and what it depicts. */
export interface ChangeRequestAsset {
  /** `assets.id`, so the board and the audit trail name the same row. */
  assetId: string;
  /** Site-rooted path the agent writes into markup: `/flowstarter-media/x.jpg`. */
  publicPath: string;
  /** Where the bytes sit in the seeded manifest: `public/flowstarter-media/x.jpg`. */
  manifestPath: string;
  /**
   * What the file actually shows, from the client's own caption. Never
   * invented here: an asset with no caption carries an empty string and the
   * prompt says plainly that we do not know what it depicts, which is the
   * only honest thing to tell an agent that must not make one up.
   */
  caption: string;
  mime: string | null;
  width: number | null;
  height: number | null;
}

/**
 * How the pictures on this request came to be on it, which decides both how
 * the prompt phrases them and whether the output gate may be held to them.
 *
 *   - `operator`: a person ticked these boxes on the build card.
 *   - `named`: the request's own words name them by caption.
 *   - `library`: nothing matched, so the client's whole rights-confirmed
 *     library is being handed over in case the request needs one of them.
 *     These are offered, not required, and a build that uses none of them has
 *     done nothing wrong.
 *   - `none`: nothing matched and the request does not want a picture at all.
 */
export type ChangeRequestAssetSelection =
  | 'operator'
  | 'named'
  | 'library'
  | 'none';

/** Everything one CHANGE_REQUEST_BUILD is being asked to do. */
export interface ChangeRequestIntent {
  changeRequestId: string;
  /** The client's own words, unedited. */
  request: string;
  /** What the operator added when they pressed Build, or null. */
  operatorNote: string | null;
  /** The `site_versions.version` this build seeds from. 0 before any edit. */
  seedVersion: number;
  assets: ChangeRequestAsset[];
  /** Why these pictures are here. Older payloads carry none and read `named`. */
  assetSelection: ChangeRequestAssetSelection;
}

const ASSET_SELECTIONS: readonly ChangeRequestAssetSelection[] = [
  'operator',
  'named',
  'library',
  'none',
];

/**
 * The handover off an untrusted payload.
 *
 * Defaults to `named`, which is the strictest reading and the behaviour every
 * payload written before this field existed was built under: those assets were
 * required to appear on the site, so they stay required.
 */
function assetSelectionOf(value: unknown): ChangeRequestAssetSelection {
  return ASSET_SELECTIONS.includes(value as ChangeRequestAssetSelection)
    ? (value as ChangeRequestAssetSelection)
    : 'named';
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** `/flowstarter-media/<name>`, the only shape an asset path may take. */
const PUBLIC_MEDIA_PATH = /^\/flowstarter-media\/[A-Za-z0-9._-]{1,120}$/;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max).trim() : '';
}

function finiteInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * The intent off an untrusted job payload.
 *
 * `payload` is a jsonb column an operator can edit, so every field is
 * re-checked here rather than trusted: a malformed asset entry is dropped, and
 * a payload with no usable request at all returns null so the worker fails the
 * job loudly instead of running an agent against nothing.
 */
export function parseChangeRequestIntent(
  payload: unknown,
): ChangeRequestIntent | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const raw = (payload as Record<string, unknown>)['changeRequest'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const changeRequestId = record['changeRequestId'];
  if (typeof changeRequestId !== 'string' || !UUID.test(changeRequestId)) {
    return null;
  }
  const request = text(record['request'], CHANGE_REQUEST_TEXT_MAX);
  if (request.length === 0) return null;

  const note = text(record['operatorNote'], CHANGE_REQUEST_NOTE_MAX);
  const assets: ChangeRequestAsset[] = [];
  const rawAssets = Array.isArray(record['assets']) ? record['assets'] : [];
  for (const entry of rawAssets) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const asset = entry as Record<string, unknown>;
    const assetId = asset['assetId'];
    const publicPath = asset['publicPath'];
    if (typeof assetId !== 'string' || !UUID.test(assetId)) continue;
    if (typeof publicPath !== 'string' || !PUBLIC_MEDIA_PATH.test(publicPath)) {
      continue;
    }
    assets.push({
      assetId,
      publicPath,
      manifestPath: `public${publicPath}`,
      caption: text(asset['caption'], 300),
      mime: typeof asset['mime'] === 'string' ? asset['mime'] : null,
      width: finiteInt(asset['width']),
      height: finiteInt(asset['height']),
    });
    if (assets.length >= CHANGE_REQUEST_ASSETS_MAX) break;
  }

  return {
    changeRequestId,
    request,
    operatorNote: note.length > 0 ? note : null,
    seedVersion: finiteInt(record['seedVersion']) ?? 0,
    assets,
    assetSelection: assetSelectionOf(record['assetSelection']),
  };
}

/** A quoted single token that is really a file name: `"hero-image-2.png"`. */
const QUOTED_FILE_NAME =
  /^[^\s]{1,120}\.(?:png|jpe?g|gif|webp|avif|svg|pdf|mp4|webm|css|js|ts|astro|md|json|zip)$/i;

/** Words with a letter in them; displayed copy worth quoting has at least two. */
function wordCount(value: string): number {
  return value.split(/\s+/).filter((word) => /[A-Za-z]/.test(word)).length;
}

/**
 * The sentences the client put in quotation marks, which are the only part of
 * a free-text request that is a claim about what the site should say.
 *
 * Straight and curly quotes both count, because the box the client typed into
 * is a browser textarea and the operating system decides which it produces.
 *
 * Three filters, and all three exist for the reason PR #98 exists: a gate
 * built on a string no built site can ever contain fails every build that did
 * the work correctly, which is worse than having no gate at all.
 *
 *   - the preview's own "is this prose" rule, which already refuses urls,
 *     timestamps, quoted JSON keys and anything too short to be a sentence;
 *   - a file name, which is a quoted single token ending in an extension. A
 *     client writing `use "hero-image-2.png"` is naming a file on their own
 *     computer, and the published copy is renamed by the media pipeline, so
 *     that string is never going to be in the output;
 *   - anything of one word. Copy a client cares enough about to quote is a
 *     phrase; a single quoted word is nearly always a label they are pointing
 *     at rather than text they want rendered.
 */
export function quotedRequestPhrases(request: string): string[] {
  const found: string[] = [];
  const pattern = /"([^"]{4,200})"|\u201C([^\u201D]{4,200})\u201D/g;
  let match = pattern.exec(request);
  while (match !== null) {
    const candidate = (match[1] ?? match[2] ?? '').trim();
    if (
      isUsablePhrase(candidate) &&
      !QUOTED_FILE_NAME.test(candidate) &&
      wordCount(candidate) >= 2 &&
      !found.includes(candidate)
    ) {
      found.push(candidate);
    }
    if (found.length >= CHANGE_REQUEST_PHRASES_MAX) break;
    match = pattern.exec(request);
  }
  return found;
}

/**
 * The prompt paragraph the agent is given.
 *
 * The request is quoted verbatim and labelled as the client's own words: it is
 * the thing they paid for, and paraphrasing it here is how a build ends up
 * doing something adjacent to what was asked. The assets are listed with the
 * exact path they will have on disk, so the agent references a file that is
 * really there rather than inventing one. The prohibitions are stated as
 * rules, not preferences, because the failure this replaces was a delivered
 * site carrying invented projects and template art.
 */
export function changeRequestFeedback(intent: ChangeRequestIntent): string {
  const lines: string[] = [
    'PAID CHANGE REQUEST, trusted. The client asked for this after their ' +
      'site was delivered, and they have paid for it. These are their own ' +
      'words, unedited:',
    '',
    intent.request.trim(),
    '',
  ];

  if (intent.operatorNote) {
    lines.push(
      'The Flowstarter team added this note about how to do it:',
      '',
      intent.operatorNote.trim(),
      '',
    );
  }

  if (intent.assets.length > 0) {
    const offered = intent.assetSelection === 'library';
    lines.push(
      offered
        ? "THE CLIENT'S PICTURE LIBRARY. Nothing in the request names a " +
            'particular file, so this is every picture the client has ' +
            'confirmed in writing that they own and that we may publish. ' +
            'Reference any you use by the exact path given here:'
        : "THE CLIENT'S OWN PICTURES. These files are already in this " +
            'worktree and the client has confirmed in writing that they own ' +
            'them and that we may publish them. Reference them by the exact ' +
            'path given here:',
    );
    for (const asset of intent.assets) {
      const size =
        asset.width && asset.height ? ` (${asset.width}x${asset.height})` : '';
      const caption = asset.caption
        ? ` shows: ${asset.caption}`
        : ' has no caption, so describe it only in general terms and never ' +
          'claim what it depicts';
      lines.push(`  - ${asset.publicPath}${size} --${caption}`);
    }
    lines.push(
      offered
        ? 'These are available if the request calls for them. Use only the ' +
            'ones it actually needs and leave the rest out; putting a ' +
            'picture on a page because it was listed here is not what was ' +
            'asked for. Write alt text that matches the caption above and ' +
            'nothing more.'
        : 'Use every one of these pictures somewhere the request calls for. ' +
            'Write alt text that matches the caption above and nothing more.',
      '',
    );
  } else {
    lines.push(
      'No client pictures are attached to this request. Do not add any image ' +
        'file that is not already in this worktree.',
      '',
    );
  }

  lines.push(
    'RULES for this pass, in order of importance:',
    '1. Do the request and nothing else. Every other page, section, heading, ' +
      'sentence, image and style in this site is already approved and paid ' +
      'for; leave it exactly as it is.',
    '2. Invent nothing. Do not add a project, case study, client, testimonial, ' +
      'statistic, price, award or logo that is not already in these files or ' +
      'named in the request above.',
    '3. Add no image file. The only pictures you may introduce are the ones ' +
      'listed above, by their given path; every other image reference must ' +
      'already exist in this worktree.',
    '4. Create no page that does not already exist unless the request asks ' +
      'for one in so many words.',
    '5. Keep the template component system, the routes and the styling ' +
      'tokens; this is an edit to a live site, not a rebuild of it.',
  );
  return lines.join('\n');
}

/** The line the operator's build conversation opens with. */
export function changeRequestSummary(intent: ChangeRequestIntent): string {
  const seed =
    intent.seedVersion > 0
      ? `version ${intent.seedVersion} of the published site`
      : 'the delivered site';
  const pictures =
    intent.assets.length === 0
      ? 'no pictures attached'
      : `${intent.assets.length} of the client's own picture${
          intent.assets.length === 1 ? '' : 's'
        }: ${intent.assets.map((asset) => asset.publicPath).join(', ')}`;
  return (
    `Building paid change request ${intent.changeRequestId} from ${seed}, ` +
    `with ${pictures}.\nThe client asked: "${intent.request
      .replace(/\s+/g, ' ')
      .trim()}"` +
    (intent.operatorNote
      ? `\nTeam note: ${intent.operatorNote.replace(/\s+/g, ' ').trim()}`
      : '')
  );
}

/** What a built site is missing of the change somebody paid for. */
export interface UnappliedChangeRequest {
  missingAssets: string[];
  missingPhrases: string[];
}

/** The error a build fails with when it did not deliver the paid change. */
export const CHANGE_REQUEST_NOT_APPLIED = 'CHANGE_REQUEST_NOT_APPLIED';

/**
 * The paid change measured against the site that came out of the build.
 *
 * Returns null when there is nothing to report, which includes the case where
 * there was nothing checkable in the first place: a request with no attached
 * pictures and no quoted sentence has no evidence, and a check that cannot be
 * evaluated must not fail a build somebody paid for. `describeUncheckable`
 * is what the board is told instead.
 */
export function findUnappliedChangeRequest(
  files: ReadonlyArray<{ path: string; content: string }>,
  intent: ChangeRequestIntent,
): UnappliedChangeRequest | null {
  const phrases = quotedRequestPhrases(intent.request);
  // A library handover is an offer, not an instruction: nothing in the request
  // named these files, so a build that used none of them did exactly what was
  // asked. Holding it to them would be the PR #98 mistake again -- a gate
  // failing a correct build against evidence the request never promised.
  const required = intent.assetSelection === 'library' ? [] : intent.assets;
  if (required.length === 0 && phrases.length === 0) return null;

  const haystack = files
    .map((file) => normalizePhrase(file.content))
    .join('\n');
  const emitted = new Set(
    files.map((file) => file.path.replace(/^dist\//, '')),
  );

  // An asset counts as delivered when the built site references its path, or
  // when the built output simply carries the file: a template may render it
  // through a CSS background or a framework-hashed URL, and either way the
  // picture is on the site.
  const missingAssets = required
    .filter((asset) => {
      const needle = normalizePhrase(asset.publicPath);
      if (needle.length > 0 && haystack.includes(needle)) return false;
      const bare = asset.publicPath.replace(/^\//, '');
      return !emitted.has(bare);
    })
    .map((asset) => asset.publicPath);

  const missingPhrases = phrases.filter((phrase) => {
    const needle = normalizePhrase(phrase);
    return needle.length > 0 && !haystack.includes(needle);
  });

  if (missingAssets.length === 0 && missingPhrases.length === 0) return null;
  return { missingAssets, missingPhrases };
}

/** The board line for a request nothing in the output can be checked against. */
export function describeUncheckableChangeRequest(
  intent: ChangeRequestIntent,
): string {
  return (
    `Change request ${intent.changeRequestId} attached no pictures and quoted ` +
    'no exact wording, so there is nothing in the built site this check can ' +
    'be held to and it passes. The request itself was given to the agents ' +
    'verbatim, and a person still reviews this build.'
  );
}

/** The repair brief for a build that did not deliver what was paid for. */
export function unappliedChangeRequestFeedback(
  intent: ChangeRequestIntent,
  missing: UnappliedChangeRequest,
): string {
  const lines = [
    'UNDELIVERED PAID CHANGE, trusted. The site you produced does not carry ' +
      'the change the client paid for. Their words again, unedited:',
    '',
    intent.request.trim(),
    '',
  ];
  if (missing.missingAssets.length > 0) {
    lines.push(
      "These pictures of the client's are in this worktree and are on no " +
        'page of the built site. Put each one where the request asks for it, ' +
        'referencing exactly this path:',
      ...missing.missingAssets.map((path) => `  - ${path}`),
      '',
    );
  }
  if (missing.missingPhrases.length > 0) {
    lines.push(
      'The client quoted this wording and it is nowhere in the built site. ' +
        'Put it back verbatim:',
      ...missing.missingPhrases.map(
        (phrase) => `  - ${phrase.replace(/\s+/g, ' ').trim()}`,
      ),
      '',
    );
  }
  lines.push(
    'Change nothing else. Invent no project, image, client or claim to make ' +
      'this fit.',
  );
  return lines.join('\n');
}

/** The operator-facing failure detail, when a repair pass did not fix it. */
export function describeUnappliedChangeRequest(
  intent: ChangeRequestIntent,
  missing: UnappliedChangeRequest,
): string {
  const parts: string[] = [];
  if (missing.missingAssets.length > 0) {
    parts.push(`pictures not on the site: ${missing.missingAssets.join(', ')}`);
  }
  if (missing.missingPhrases.length > 0) {
    parts.push(
      `wording not on the site: ${missing.missingPhrases.join(' | ')}`,
    );
  }
  return (
    `The built site does not carry the paid change ${intent.changeRequestId} ` +
    `(${parts.join('; ')}). The request has been left at paid, so nobody is ` +
    'told work shipped that did not.'
  );
}

/**
 * How many pages beyond the ones the site already had a paid change request
 * may add before the build is treated as having invented them.
 *
 * A full build's page budget comes from the brief, because nothing exists yet
 * and the brief is the whole of what was bought. A change request is the
 * opposite case: the pages the site already has were paid for, reviewed and
 * are live, and the request itself may legitimately have bought one more ("add
 * a workshops page"). So the budget here is "everything that was already
 * there, plus a small allowance", which still catches the failure this gate
 * exists for -- an agent that answers a one-section ask by generating a site
 * -- without ever failing a client for the page they just paid for.
 */
export const CHANGE_REQUEST_NEW_PAGE_BUDGET = 2;

/** Least of its original bytes a pre-existing route file may be left with. */
export const CHANGE_REQUEST_MIN_SEED_ROUTE_RATIO = 0.6;

/**
 * The numbers this gate reads, in one place.
 *
 * Every call site takes the allowance from here rather than writing a literal,
 * because the allowance is a policy decision about how much a change request
 * may grow a paid site, and a policy decision that appears as a `2` in four
 * files is one nobody can change safely.
 */
export interface ChangeRequestPageBudgetConfig {
  /** New top-level routes one change request may add beyond the seed. */
  newPageAllowance: number;
  /** Smallest fraction of its original size a seed route file may keep. */
  minSeedRouteRatio: number;
}

export const CHANGE_REQUEST_PAGE_BUDGET: Readonly<ChangeRequestPageBudgetConfig> =
  Object.freeze({
    newPageAllowance: CHANGE_REQUEST_NEW_PAGE_BUDGET,
    minSeedRouteRatio: CHANGE_REQUEST_MIN_SEED_ROUTE_RATIO,
  });

/** The name a site's front page goes by on both sides of this comparison. */
export const HOME_PAGE_NAME = '(home)';

/** Where a template keeps its routes; the only directory that makes pages. */
const SEED_ROUTE_ROOT = 'src/pages/';

/** File types Astro turns into a route. A `.ts` under pages is an endpoint. */
const ROUTE_EXTENSION = /\.(?:astro|md|mdx|markdown|html)$/i;

/**
 * The one page-name normalisation, used on both sides of the comparison.
 *
 * `index` is the front page under either spelling, a route file loses its
 * extension, and a directory keeps its name. This is the whole reason the two
 * readers below exist as a pair rather than as two independent ones: the gate
 * that shipped compared built `.html` names against a seed manifest that has
 * no `.html` in it at all, so the seed always read as an empty site and every
 * request against a site with three or more routes failed as though the agent
 * had invented all of them.
 */
function pageNameForSegment(segment: string): string {
  const base = segment.replace(/\.[A-Za-z0-9]+$/, '');
  return base === 'index' ? HOME_PAGE_NAME : base;
}

/** Top-level route names in a built output, `dist/` prefix already stripped. */
export function builtPageNames(paths: readonly string[]): string[] {
  const names = new Set<string>();
  for (const path of paths) {
    if (!path.endsWith('.html')) continue;
    const first = path.replace(/^\/+/, '').split('/')[0] ?? '';
    if (first.length === 0) continue;
    names.add(pageNameForSegment(first));
  }
  return Array.from(names).sort();
}

/**
 * The same top-level route names, read off a seed manifest instead.
 *
 * A published manifest is source, not output: `src/pages/index.astro`,
 * `src/pages/case-studies/[slug].astro`, `src/content/**`, `public/**`. Only
 * `src/pages/**` makes routes, so only that is read, and it is read to the
 * same names a build of it would produce:
 *
 *   - `index.astro` is `(home)`;
 *   - `about.astro` is `about`;
 *   - `case-studies/[slug].astro` is `case-studies`, because every slug it
 *     generates is emitted under `dist/case-studies/<slug>/index.html` and
 *     `builtPageNames` reads all of those back as the one name
 *     `case-studies`. The content entries behind the route therefore never
 *     need counting: both sides collapse a section to its section name, and
 *     that symmetry is what makes the comparison honest;
 *   - a file or directory beginning with `_` is not a route in Astro, and a
 *     dynamic route at the top level (`[...slug].astro`) has no name a person
 *     could read, so neither is counted.
 */
export function seedPageNames(paths: readonly string[]): string[] {
  const names = new Set<string>();
  for (const raw of paths) {
    const path = raw.replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!path.startsWith(SEED_ROUTE_ROOT)) continue;
    const segments = path
      .slice(SEED_ROUTE_ROOT.length)
      .split('/')
      .filter(Boolean);
    if (segments.length === 0) continue;
    if (segments.some((segment) => segment.startsWith('_'))) continue;
    const last = segments[segments.length - 1] as string;
    if (!ROUTE_EXTENSION.test(last)) continue;
    const first = segments[0] as string;
    if (first.startsWith('[')) continue;
    names.add(pageNameForSegment(first));
  }
  return Array.from(names).sort();
}

/**
 * The pages the site had before this change request touched it.
 *
 * Source first, because the seed is a manifest. A manifest that somehow holds
 * built output instead is read as built output rather than as an empty site:
 * an unreadable baseline is the one input this gate must never treat as "the
 * site had no pages", because that reading is what failed four paid builds in
 * a single day.
 */
export function changeRequestSeedPages(paths: readonly string[]): string[] {
  const fromSource = seedPageNames(paths);
  return fromSource.length > 0 ? fromSource : builtPageNames(paths);
}

/** What one change request did to the site's set of top-level routes. */
export interface ChangeRequestPageChange {
  added: string[];
  removed: string[];
  kept: string[];
}

/** The seed and the build compared, with removals named as removals. */
export function diffChangeRequestPages(
  seedPages: readonly string[],
  builtPages: readonly string[],
): ChangeRequestPageChange {
  const seed = new Set(seedPages);
  const built = new Set(builtPages);
  return {
    added: builtPages.filter((page) => !seed.has(page)),
    removed: seedPages.filter((page) => !built.has(page)),
    kept: builtPages.filter((page) => seed.has(page)),
  };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

/** The board line: what this change request did to the site's pages. */
export function describeChangeRequestPageChange(
  change: ChangeRequestPageChange,
): string {
  const parts: string[] = [];
  if (change.added.length > 0) {
    parts.push(
      `added ${change.added.length} ${plural(change.added.length, 'page')} ` +
        `(${change.added.join(', ')})`,
    );
  }
  if (change.removed.length > 0) {
    parts.push(
      `removed ${change.removed.length} ` +
        `${plural(change.removed.length, 'page')} ` +
        `(${change.removed.join(', ')})`,
    );
  }
  if (parts.length === 0) {
    return (
      `This change request left all ${change.kept.length} pages of the site ` +
      'in place.'
    );
  }
  return `This change request ${parts.join(' and ')}, and kept ${change.kept.length}.`;
}

/**
 * Pages the build added beyond the seed and the allowance, or undefined when
 * it stayed inside it.
 *
 * Only additions can exceed a budget. A request that removes a page and adds
 * none has not outgrown anything, so a deletion can never fail here however
 * many routes it takes away; the pages it removed are reported as removed, by
 * `describeChangeRequestPageChange`, and are never counted as new.
 */
export function findChangeRequestPageIssue(
  seedPages: readonly string[],
  builtPages: readonly string[],
  budget = CHANGE_REQUEST_PAGE_BUDGET.newPageAllowance,
): string | undefined {
  const change = diffChangeRequestPages(seedPages, builtPages);
  if (change.added.length <= budget) return undefined;
  const removed =
    change.removed.length > 0
      ? ` It also removed ${change.removed.length} the site already had ` +
        `(${change.removed.join(', ')}).`
      : '';
  return (
    `This change request added ${change.added.length} new pages ` +
    `(${change.added.join(', ')}) to a site that had ${seedPages.length}. ` +
    `At most ${budget} new ${plural(budget, 'page')} may come out of one ` +
    `change request.${removed}`
  );
}

/** The error a change request fails with when its repair pass damaged the site. */
export const CHANGE_REQUEST_REPAIR_DAMAGED_SITE =
  'CHANGE_REQUEST_REPAIR_DAMAGED_SITE';

/**
 * What to do about a build that outgrew its page budget.
 *
 * The gate that shipped had one answer for every case -- "remove the pages the
 * request did not ask for and keep only what it named" -- and handed it to an
 * agent with no list of which pages those were. The agent obliged by gutting
 * `src/pages/case-studies/[slug].astro` down to 355 bytes, repointing links at
 * /contact and writing a robots.txt for a domain nobody owns. A repair brief
 * that does not name its targets is an invitation to guess at a paid site.
 *
 * So the plan is computed here, as data:
 *
 *   - `pass`: inside the allowance, which includes every deletion-only
 *     request, however much it deleted.
 *   - `repair`: the build added pages the seed never had, and every page that
 *     has to go is one of those. The instruction names them, and names the
 *     seed's own routes as untouchable.
 *   - `fail`: the build lost routes the seed had *and* invented more than the
 *     allowance. A second agent pass over a site that has already lost
 *     approved pages can only lose more of them, so the job fails with a
 *     reason an operator can read rather than being repaired.
 */
export type ChangeRequestPagePlan =
  | { action: 'pass'; summary: string }
  | {
      action: 'repair';
      summary: string;
      removePages: string[];
      protectedPages: string[];
      instruction: string;
    }
  | { action: 'fail'; summary: string };

export function planChangeRequestPageRepair(
  seedPages: readonly string[],
  builtPages: readonly string[],
  budget = CHANGE_REQUEST_PAGE_BUDGET.newPageAllowance,
): ChangeRequestPagePlan {
  const change = diffChangeRequestPages(seedPages, builtPages);
  const summary = describeChangeRequestPageChange(change);
  const issue = findChangeRequestPageIssue(seedPages, builtPages, budget);
  if (!issue) return { action: 'pass', summary };

  if (change.removed.length > 0) {
    return {
      action: 'fail',
      summary:
        `${issue} This build also removed ${change.removed.length} ` +
        `${plural(change.removed.length, 'route')} the client had already ` +
        `paid for (${change.removed.join(', ')}), so it is not repaired: a ` +
        'second pass told to remove pages would be pointed at a site that ' +
        'has already lost approved ones. The request stays paid.',
    };
  }

  const seed = new Set(seedPages);
  const removePages = change.added.filter((page) => !seed.has(page));
  // Belt and braces on the one thing a repair brief may never say. `added` is
  // built-minus-seed by construction, so this can only ever be a no-op today
  // -- and it is here so that it stays one if that construction is changed.
  if (removePages.length !== change.added.length) {
    return {
      action: 'fail',
      summary:
        `${issue} Getting back inside the allowance would mean deleting a ` +
        'route the site already had, which a change request may never do on ' +
        'its own, so the job fails instead of repairing. The request stays ' +
        'paid.',
    };
  }

  const protectedPages = [...seedPages];
  return {
    action: 'repair',
    summary,
    removePages,
    protectedPages,
    instruction: [
      issue,
      '',
      'Delete only these pages, which this pass created and the request did ' +
        `not ask for: ${removePages.join(', ')}.`,
      'These routes were on the site before this change request, are paid ' +
        'for and approved, and must be left exactly as they are -- not ' +
        'deleted, not emptied, not rewritten, not relinked: ' +
        `${protectedPages.join(', ')}.`,
      'Change no other file. Do not touch robots.txt, do not touch ' +
        'sitemap.xml, and do not repoint a link that already worked.',
    ].join('\n'),
  };
}

/** Files as the manifest carries them: a path and its text. */
export interface RepairDiffFile {
  path: string;
  content: string;
  encoding?: string;
}

/** Absolute `https://host` references, for the robots/sitemap rule below. */
const ABSOLUTE_HOST = /https?:\/\/([A-Za-z0-9._-]+)/g;

/** Files whose whole job is to tell a crawler which site this is. */
function isCrawlerFile(path: string): boolean {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  return (
    name === 'robots.txt' ||
    name === 'sitemap.xml' ||
    name === 'sitemap-index.xml'
  );
}

function hostsIn(content: string): string[] {
  const hosts: string[] = [];
  const pattern = new RegExp(ABSOLUTE_HOST.source, 'g');
  let match = pattern.exec(content);
  while (match !== null) {
    const host = (match[1] ?? '').toLowerCase();
    if (host.length > 0 && !hosts.includes(host)) hosts.push(host);
    match = pattern.exec(content);
  }
  return hosts;
}

/** Is this manifest path one of the site's own routes? */
function isSeedRoutePath(path: string): boolean {
  const clean = path.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  return clean.startsWith(SEED_ROUTE_ROOT) && ROUTE_EXTENSION.test(clean);
}

function byteLength(file: RepairDiffFile): number {
  return file.encoding === 'base64'
    ? Math.floor((file.content.length * 3) / 4)
    : Buffer.byteLength(file.content, 'utf8');
}

/**
 * What a repair pass did that a repair pass is never allowed to do.
 *
 * Measured across the corrective pass and scoped to the seed's own routes,
 * which is the only framing that gets both halves right. A page the *change
 * request* deleted is legitimate and is already gone from `before`, so it is
 * never counted; a page the *build* invented is not in the seed, so deleting
 * it is exactly what the repair was asked to do. What is left is the set this
 * refuses to lose. Three refusals, all of them things the 2026-09-12 repair
 * actually did to a live site:
 *
 *   - a seed route that survived the change request is gone after the repair;
 *   - a seed route is still there but has been cut below
 *     `minSeedRouteRatio` of the bytes it had going in, which is how
 *     `case-studies/[slug].astro` became a 355-byte stub;
 *   - robots.txt or a sitemap now points at an absolute domain that is not
 *     the site's own and was not there before, which is how a paid site came
 *     to advertise a hostname nobody owns.
 */
export function findChangeRequestRepairDamage(
  seedPaths: readonly string[],
  before: readonly RepairDiffFile[],
  after: readonly RepairDiffFile[],
  options: {
    siteHostname?: string | null;
    minSeedRouteRatio?: number;
  } = {},
): string | undefined {
  const ratio =
    options.minSeedRouteRatio ?? CHANGE_REQUEST_PAGE_BUDGET.minSeedRouteRatio;
  const ownHost = (options.siteHostname ?? '').toLowerCase();
  const afterByPath = new Map(after.map((file) => [file.path, file]));
  const seedRoutes = new Set(
    seedPaths
      .map((path) => path.replace(/\\/g, '/').replace(/^\.?\/+/, ''))
      .filter(isSeedRoutePath),
  );

  const deleted: string[] = [];
  const gutted: string[] = [];
  for (const file of before) {
    if (!seedRoutes.has(file.path.replace(/\\/g, '/').replace(/^\.?\/+/, ''))) {
      continue;
    }
    const now = afterByPath.get(file.path);
    if (!now) {
      deleted.push(file.path);
      continue;
    }
    const was = byteLength(file);
    const is = byteLength(now);
    if (was > 0 && is < was * ratio) {
      gutted.push(`${file.path} (${was} bytes -> ${is})`);
    }
  }

  const knownHosts = new Set<string>();
  for (const file of before) {
    if (!isCrawlerFile(file.path)) continue;
    for (const host of hostsIn(file.content)) knownHosts.add(host);
  }
  if (ownHost.length > 0) knownHosts.add(ownHost);
  const invented: string[] = [];
  for (const file of after) {
    if (!isCrawlerFile(file.path)) continue;
    for (const host of hostsIn(file.content)) {
      if (!knownHosts.has(host)) invented.push(`${file.path} -> ${host}`);
    }
  }

  const faults: string[] = [];
  if (deleted.length > 0) {
    faults.push(
      `deleted route ${plural(deleted.length, 'file')}: ${deleted.join(', ')}`,
    );
  }
  if (gutted.length > 0) {
    faults.push(
      `emptied route ${plural(gutted.length, 'file')}: ${gutted.join(', ')}`,
    );
  }
  if (invented.length > 0) {
    faults.push(
      'pointed a crawler at a domain this site does not own: ' +
        invented.join(', '),
    );
  }
  if (faults.length === 0) return undefined;

  return (
    'The corrective pass damaged the site it was asked to trim: ' +
    `${faults.join('; ')}. Nothing was published and the request stays paid, ` +
    'because a repair that removes work the client already paid for is worse ' +
    'than the problem it was fixing.'
  );
}
