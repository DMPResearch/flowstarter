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
    lines.push(
      "THE CLIENT'S OWN PICTURES. These files are already in this worktree " +
        'and the client has confirmed in writing that they own them and that ' +
        'we may publish them. Reference them by the exact path given here:',
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
      'Use every one of these pictures somewhere the request calls for. ' +
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
  if (intent.assets.length === 0 && phrases.length === 0) return null;

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
  const missingAssets = intent.assets
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

/** Top-level route names in a built output, `dist/` prefix already stripped. */
export function builtPageNames(paths: readonly string[]): string[] {
  const names = new Set<string>();
  for (const path of paths) {
    if (!path.endsWith('.html')) continue;
    const clean = path.replace(/^\/+/, '');
    const first = clean.split('/')[0] ?? '';
    names.add(first === 'index.html' ? '(home)' : first.replace(/\.html$/, ''));
  }
  return Array.from(names).sort();
}

/**
 * Pages the build added beyond the seed and the allowance, or undefined when
 * it stayed inside it.
 */
export function findChangeRequestPageIssue(
  seedPages: readonly string[],
  builtPages: readonly string[],
  budget = CHANGE_REQUEST_NEW_PAGE_BUDGET,
): string | undefined {
  const known = new Set(seedPages);
  const added = builtPages.filter((page) => !known.has(page));
  if (added.length <= budget) return undefined;
  return (
    `This change request added ${added.length} new pages (${added.join(', ')}) ` +
    `to a site that had ${seedPages.length}. At most ${budget} new page` +
    `${budget === 1 ? '' : 's'} may come out of one change request. Remove ` +
    'the pages the request did not ask for and keep only what it named.'
  );
}
