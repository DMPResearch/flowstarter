/**
 * Where the one photograph of the client is allowed to sit on the built site,
 * and what counts as having mishandled it.
 *
 * The app decides whether we have a picture at all and how big it is
 * (`apps/flowstarter-main/src/lib/flowstarter/portrait-source.ts`, which reads
 * its floors from `portrait-config.ts`). This module is the other end of that
 * rule: the build has the picture, the template has slots, and somebody has to
 * say which slots the picture may fill. Nothing here is imported from the app.
 * This package is built and type-checked without the Next app, and a gate that
 * could only run inside the web process is a gate the worker cannot run.
 *
 * THE MEASUREMENT THAT FORCES THIS, and the reason it is not a style note.
 * Instagram's public OpenGraph picture is 100 pixels square: that is the one
 * portrait we can get for a person who connects nothing, and it is real
 * evidence of what they look like. A hundred pixels is a perfectly good round
 * byline avatar at the 96px the templates render one at. It is not a hero. The
 * only way to make it fill a hero is to scale it up, and an upscaled headshot
 * on a site somebody paid for reads as a mistake, not as a photograph. So the
 * size verdict the app computed travels with the picture and decides the
 * placements, and this gate fails a build that ignored it.
 *
 * THE OTHER HALF is the case the placeholder-image gate cannot see. That gate
 * (`placeholder-images.ts`) knows the template's own stand-in art by name and
 * by hash, and its defence for an about-page slot holding a guide graphic is
 * "there may be no client photograph, and initials are the honest answer".
 * That defence stops being true the moment a portrait exists. A build that was
 * handed a photograph and still renders `/images/about-me-photo.svg` in the
 * about slot has left the client's face in a folder.
 *
 * Everything here is pure: files in, findings out. No disk, no network, no
 * clock. The slot parse is `site-media.ts`'s, the section and key vocabulary is
 * `generated-assets.ts`'s, and neither is restated here.
 */

import {
  CLIENT_MEDIA_SECTION,
  HERO_SECTION,
  PERSON_KEY,
  PERSON_SECTION,
} from './generated-assets';
import {
  CONTENT_FILES,
  parseSiteImageSlots,
  type SiteImageSlot,
} from './site-media';

/** Where a picture may sit on the built site. */
export type PortraitPlacement = 'hero' | 'about' | 'avatar';

/** What the app measured. 'portrait' cleared the floor, 'avatar' did not. */
export type PortraitSizeVerdict = 'portrait' | 'avatar';

/** The one portrait a build has, as it reaches the template. */
export interface BuildPortrait {
  /** Site-rooted, always under `/flowstarter-media/`. */
  publicPath: string;
  verdict: PortraitSizeVerdict;
  /** Longest edge in pixels. The site never renders it larger than this. */
  longEdge: number;
}

/**
 * The hero and about floor, in pixels on the longest edge.
 *
 * Mirrors `FLOWSTARTER_PORTRAIT_MIN_EDGE` and its default in
 * `apps/flowstarter-main/src/lib/flowstarter/portrait-config.ts`. That file is
 * the source of truth: an operator raises or lowers the floor there, and the
 * verdict normally arrives on the job already computed. This constant is the
 * fallback for a caller holding raw dimensions and no floor of its own, and it
 * is a named constant rather than a literal so the two numbers can be compared
 * by grepping for one of them.
 */
export const DEFAULT_PORTRAIT_EDGE = 400;

/** Client media lives here; `site-media.ts` writes it under exactly this path. */
const CLIENT_MEDIA_PREFIX = '/flowstarter-media/';

/** The template's own artwork lives here. A slot still pointing in is unfilled. */
const TEMPLATE_ART_PREFIX = '/images/';

/** The failure codes, in the shape workflows.ts already uses for a gate. */
export const PORTRAIT_UPSCALED = 'PORTRAIT_UPSCALED';
export const PORTRAIT_SLOT_UNFILLED = 'PORTRAIT_SLOT_UNFILLED';

/**
 * Which of the three placements a content slot is.
 *
 * Total by design, and the fall-through is `'about'`: an image slot in a
 * section no pattern recognises is a body-width picture somewhere down the
 * page, which is the about portrait's shape and scale, never the hero's. That
 * default only decides *what a portrait would be* if one were put there; it
 * never on its own makes an unrecognised slot something a portrait is owed
 * (see the unfilled rule below).
 */
export function placementForSlot(
  slot: Pick<SiteImageSlot, 'section' | 'key'>,
): PortraitPlacement {
  // The same haystack `classifyRole` in generated-assets.ts matches on, so a
  // template that names the slot on the key rather than the section reads the
  // same to both files.
  const haystack = `${slot.section} ${slot.key}`;
  // A byline avatar and a testimonial signature are round and small whatever
  // the picture is. Checked first: a testimonial section named "aboutClients"
  // is an avatar slot, not an about slot.
  if (PERSON_KEY.test(slot.key)) return 'avatar';
  if (PERSON_SECTION.test(haystack)) return 'avatar';
  if (HERO_SECTION.test(haystack)) return 'hero';
  return 'about';
}

/**
 * True when a slot that classifies as `'about'` really is the about portrait,
 * rather than the fall-through: a case-study thumbnail, a service card, an
 * unnamed body image.
 *
 * `CLIENT_MEDIA_SECTION` is the list generated-assets.ts already refuses to
 * paint artwork into when the client gave us real media, which makes it the
 * same list read from this side: about, story, portrait, profile, founder,
 * bio, team. Its neighbour `ABOUT_SECTION` is deliberately not reused here,
 * because that one also matches studio, space and mood, which are atmosphere
 * slots a photograph of the client does not belong in.
 */
function isRecognisedAboutSlot(slot: SiteImageSlot): boolean {
  return CLIENT_MEDIA_SECTION.test(`${slot.section} ${slot.key}`);
}

/** True when this path is one of the template's content files. */
function isContentFile(path: string): boolean {
  const normalized = path.split('\\').join('/');
  return CONTENT_FILES.some(
    (file) => normalized === file || normalized.endsWith(`/${file}`),
  );
}

/** Every image slot in the content files among a set of in-memory files. */
export function portraitSlotsInFiles(
  files: readonly { path: string; content: string }[],
): SiteImageSlot[] {
  const slots: SiteImageSlot[] = [];
  for (const file of files) {
    if (!isContentFile(file.path)) continue;
    // Addressed by the path the caller gave us, so a finding names a file the
    // caller can open.
    slots.push(...parseSiteImageSlots(file.path, file.content));
  }
  return slots;
}

/**
 * The placements a verdict allows.
 *
 * Mirrors `placementsFor` in the app's `portrait-source.ts`, named here so the
 * two can be diffed by eye: a portrait may also be an avatar, because scaling
 * a large picture down is free, while an avatar is never a hero and never an
 * about portrait, because scaling a small one up is the defect.
 */
export function allowedPlacements(
  verdict: PortraitSizeVerdict,
): readonly PortraitPlacement[] {
  return verdict === 'portrait' ? ['hero', 'about', 'avatar'] : ['avatar'];
}

export interface PortraitSlotFinding {
  slot: SiteImageSlot;
  placement: PortraitPlacement;
  code: typeof PORTRAIT_UPSCALED | typeof PORTRAIT_SLOT_UNFILLED;
}

/**
 * The one placement a portrait should be put in when a slot is standing empty:
 * the about portrait when the picture is big enough for one, otherwise the
 * byline avatar. Only one, so a build is never told it left three slots
 * unfilled for a person who has exactly one face.
 */
function preferredPlacement(verdict: PortraitSizeVerdict): PortraitPlacement {
  return verdict === 'portrait' ? 'about' : 'avatar';
}

/**
 * Every way the built site has mishandled the portrait it was given.
 * Returns [] when there is no portrait: a build with no client photograph is
 * not a build with a defect, it is a build that renders initials instead.
 */
export function findPortraitSlotFindings(
  files: readonly { path: string; content: string }[],
  portrait: BuildPortrait | null,
): PortraitSlotFinding[] {
  if (!portrait) return [];
  const allowed = allowedPlacements(portrait.verdict);
  const wanted = preferredPlacement(portrait.verdict);
  const findings: PortraitSlotFinding[] = [];

  for (const slot of portraitSlotsInFiles(files)) {
    const placement = placementForSlot(slot);
    if (slot.currentPath === portrait.publicPath) {
      if (!allowed.includes(placement)) {
        findings.push({ slot, placement, code: PORTRAIT_UPSCALED });
      }
      continue;
    }
    // A slot the portrait is allowed and expected to fill, still showing the
    // template's own artwork while the client's photograph sits unused. An
    // 'avatar' slot got there by name (an `avatar` key, a testimonial
    // section) and needs no further check; an 'about' slot may only be the
    // fall-through, so it has to be one the vocabulary actually recognises.
    if (placement !== wanted) continue;
    if (placement === 'about' && !isRecognisedAboutSlot(slot)) continue;
    if (!slot.currentPath.startsWith(TEMPLATE_ART_PREFIX)) continue;
    findings.push({ slot, placement, code: PORTRAIT_SLOT_UNFILLED });
  }

  // Stable order so the repair pass is handed the same sentence twice for the
  // same site, whatever order the caller collected its files in.
  return findings.sort(
    (a, b) =>
      a.slot.file.localeCompare(b.slot.file) || a.slot.line - b.slot.line,
  );
}

const MAX_FINDINGS_LISTED = 8;

/** One finding as the clause it contributes to the sentence. */
function describeFinding(
  finding: PortraitSlotFinding,
  portrait: BuildPortrait,
): string {
  const where = `${finding.slot.file} line ${finding.slot.line}`;
  if (finding.code === PORTRAIT_UPSCALED) {
    return (
      `${where} puts ${portrait.publicPath} in a ${finding.placement} slot ` +
      `(${finding.slot.section}.${finding.slot.key}), which only fills that ` +
      `slot by scaling a ${portrait.longEdge}px picture up`
    );
  }
  return (
    `${where} still shows ${finding.slot.currentPath} in the ` +
    `${finding.placement} slot (${finding.slot.section}.${finding.slot.key}) ` +
    'while the client’s own photograph is unused'
  );
}

/** The findings, phrased once for the agent and for the job log. */
export function describePortraitSlotFindings(
  findings: readonly PortraitSlotFinding[],
  portrait: BuildPortrait,
): string {
  const codes = Array.from(
    // `Array.from` over the Set rather than a spread, for the ES5-target
    // reason placeholder-images.ts documents: one consumer type-checks this
    // package without `downlevelIteration`.
    new Set(findings.map((finding) => finding.code)),
  ).join(' + ');
  const listed = findings.slice(0, MAX_FINDINGS_LISTED);
  const detail = listed
    .map((finding) => describeFinding(finding, portrait))
    .join('; ');
  const overflow =
    findings.length > listed.length
      ? ` and ${findings.length - listed.length} more`
      : '';
  const allowed = allowedPlacements(portrait.verdict).join(', ');
  return (
    `${codes}: the client’s photograph is ${portrait.publicPath}, ` +
    `${portrait.longEdge}px on its longest side, which the size rule allows ` +
    `only as: ${allowed}. Put it in the ` +
    `${preferredPlacement(portrait.verdict)} slot at its own size or smaller, ` +
    'never scaled up, and where it does not fit render initials or no image ' +
    `rather than the template’s stock art. Fix: ${detail}${overflow}.`
  );
}

/** The sentence the repair pass is given. Undefined when there is nothing wrong. */
export function findPortraitSlotIssue(
  files: readonly { path: string; content: string }[],
  portrait: BuildPortrait | null,
): string | undefined {
  const findings = findPortraitSlotFindings(files, portrait);
  // `portrait` is non-null whenever there is a finding at all, but the check
  // is written out rather than asserted: this returns a sentence to an agent,
  // and a non-null assertion here would be a crash in the gate that was meant
  // to describe a defect.
  if (findings.length === 0 || !portrait) return undefined;
  return describePortraitSlotFindings(findings, portrait);
}

/**
 * Reads the portrait out of a brief payload without depending on the type that
 * declares it, so this composes with the unmerged brief-to-build work.
 *
 * Strict about all three fields on purpose. A path outside
 * `/flowstarter-media/` is not a portrait this build wrote, and a picture with
 * no dimensions has not been measured: we do not place what nobody measured,
 * which is the same answer `sizeVerdictFor` gives an unmeasured picture in the
 * app.
 */
export function buildPortraitFrom(
  brief:
    | {
        portrait?: {
          publicPath?: unknown;
          width?: unknown;
          height?: unknown;
        } | null;
      }
    | null
    | undefined,
  floors: { portraitEdge: number },
): BuildPortrait | null {
  const portrait = brief?.portrait;
  if (!portrait) return null;
  const publicPath = portrait.publicPath;
  if (typeof publicPath !== 'string') return null;
  if (!publicPath.startsWith(CLIENT_MEDIA_PREFIX)) return null;
  const longEdge = Math.max(edge(portrait.width), edge(portrait.height));
  if (longEdge <= 0) return null;
  return {
    publicPath,
    verdict: longEdge >= floors.portraitEdge ? 'portrait' : 'avatar',
    longEdge,
  };
}

/** One declared dimension as a number, or 0 for anything unusable. */
function edge(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}
