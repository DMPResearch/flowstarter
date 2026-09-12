/**
 * When is the in-depth brief complete enough to build from.
 *
 * The intake used to ask everything before the preview, and the result was a
 * visitor answering seventeen questions to see a skeleton. The flow now has a
 * seam: a short conversation before the preview, and the real material after
 * the deposit, filled in on the client's own dashboard. This module is the
 * rule that decides when that second half is done.
 *
 * It is the same species as `sufficiency.ts` and follows the same law: no LLM,
 * no network, no filesystem, no clock. A gate that hallucinates is worse than
 * no gate, because it either nags a client who has already sent everything or
 * green-lights a build that will invent a case study. Same input, same codes,
 * forever.
 *
 * WHAT IT ASKS FOR, and why that list is short.
 *
 * The temptation with a brief form is to require everything the template can
 * render. A wellness template has seventeen image slots; a two-person business
 * does not have seventeen photographs, and asking for them is how a client
 * stops replying. So the blocking set is exactly two things:
 *
 *   the offer          because a site cannot say what a business does if the
 *                      business has not said it, and the alternative is the
 *                      generator inventing it.
 *   the projects       not "at least one project", but "an answer". A client
 *                      with no past work to show says so, `noProjects` is set,
 *                      and the work page is dropped by the page-set rule. A
 *                      client who has simply not filled the list in yet has
 *                      answered nothing, and those two states must not look
 *                      the same to a build.
 *
 * Everything else degrades. Photographs make the site better and their absence
 * does not make it dishonest, so a missing portrait is worth asking for and is
 * not worth stopping for.
 */

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/**
 * Stable identifiers. They key `BRIEF_MISSING_MESSAGES`, the dashboard's own
 * checklist and the reminder email. Renaming one silently rewrites history;
 * add a new code instead.
 */
export const BRIEF_MISSING_CODES = [
  'brief_offer_missing',
  'brief_offer_thin',
  'brief_projects_unanswered',
  'brief_project_unnamed',
  'brief_project_screenshots_missing',
  'brief_photos_missing',
  'brief_portrait_missing',
  'brief_design_reference_missing',
] as const;

export type BriefMissingCode = (typeof BRIEF_MISSING_CODES)[number];

export type BriefMissingSeverity = 'blocking' | 'degrades';

export interface BriefMissingItem {
  code: BriefMissingCode;
  severity: BriefMissingSeverity;
  /** The concrete ask, resolved from `BRIEF_MISSING_MESSAGES`. */
  message: string;
}

export interface BriefReadiness {
  /** True when nothing `blocking` is outstanding. */
  ready: boolean;
  missing: BriefMissingItem[];
  /**
   * 0 to 1, for the dashboard's progress line. Counts the five things a
   * complete brief has, not the codes, so adding a `degrades` code later does
   * not make every existing brief look less finished than it was.
   */
  completeness: number;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface BriefProjectInput {
  name?: string | null;
  line?: string | null;
  link?: string | null;
  screenshotAssetIds?: readonly string[] | null;
}

export interface BriefPhotoInput {
  assetId: string;
  kind?: string | null;
  width?: number | null;
  height?: number | null;
  /** Only a rights-confirmed photograph may be published. */
  rightsConfirmed?: boolean;
}

export interface BriefInput {
  offer?: string | null;
  projects?: readonly BriefProjectInput[] | null;
  /** The explicit "I have no past work to show". */
  noProjects?: boolean | null;
  photos?: readonly BriefPhotoInput[] | null;
  designReferenceAssetIds?: readonly string[] | null;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Enough of an offer to write a homepage from without inventing claims.
 * Roughly two sentences. Whitespace is collapsed before counting, so padding
 * with newlines does not pass the gate.
 */
export const MIN_OFFER_CHARS = 80;

/**
 * The long edge a photograph needs to survive a full-width slot. Below this it
 * is visibly soft on any modern display, which reads as a cheap site rather
 * than a cheap photo. Same number `sufficiency.ts` uses for a hero, because it
 * is the same slot.
 */
export const MIN_PHOTO_LONG_EDGE = 1600;

/** Fewer than this and the photographs do not cover a page. */
export const MIN_PHOTOS = 2;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * One concrete ask per code. Never "send us some photos": a client who reads
 * that sends four blurry shots of the car park. Each line names the subject,
 * the shape and where it lands. No em dashes, no emoji.
 */
export const BRIEF_MISSING_MESSAGES: Record<BriefMissingCode, string> = {
  brief_offer_missing:
    'A sentence or two on what you offer, in your own words: what you sell, ' +
    'who it is for, and what someone gets. We will not publish it verbatim, ' +
    'we need it so the site says true things.',
  brief_offer_thin:
    'A little more on what you offer. What we have is one short line, which ' +
    'is not enough to write a homepage from without making things up. Two or ' +
    'three sentences is plenty.',
  brief_projects_unanswered:
    'Your products or projects: a name, one line about each, a link if there ' +
    'is one, and a screenshot or two. If you have nothing to show yet, say ' +
    'so and we will leave the work section off rather than fill it with ' +
    'examples that are not yours.',
  brief_project_unnamed:
    'A name for every project you have listed. A project with a description ' +
    'and no name cannot go on the site.',
  brief_project_screenshots_missing:
    'A screenshot for each project you listed. One good screen of the real ' +
    'thing beats a stock illustration of it.',
  brief_photos_missing:
    'Two photographs for the site: the place you work, the thing you make, ' +
    'or you at work. At least 1600 pixels on the long edge, straight off a ' +
    'recent phone is fine, and no heavy filters.',
  brief_portrait_missing:
    'One portrait of you, for the about section. Looking at the camera, ' +
    'shoulders up, in reasonable light. At least 1600 pixels on the long edge.',
  brief_design_reference_missing:
    'One or two screenshots of sites you like, so we aim at the look you ' +
    'have in mind rather than the one we would have guessed. These are ' +
    'references only and never appear on your site.',
};

// ---------------------------------------------------------------------------
// Reading the input
// ---------------------------------------------------------------------------

/** Collapsed length, so a wall of newlines does not count as prose. */
export function offerLength(offer: string | null | undefined): number {
  return (offer ?? '').replace(/\s+/g, ' ').trim().length;
}

function namedProjects(
  projects: readonly BriefProjectInput[] | null | undefined
): BriefProjectInput[] {
  return (projects ?? []).filter(
    (project) => (project.name ?? '').trim().length > 0
  );
}

/** A photograph big enough to be worth placing. */
export function isUsablePhoto(photo: BriefPhotoInput): boolean {
  if (photo.rightsConfirmed === false) return false;
  const longEdge = Math.max(photo.width ?? 0, photo.height ?? 0);
  return longEdge >= MIN_PHOTO_LONG_EDGE;
}

/**
 * True when a photograph is under the size we asked for. The uploader shows a
 * warning on this rather than refusing the file: a small picture is still
 * better than a stock one, it just cannot hold the top of the page.
 */
export function isUndersizedPhoto(photo: {
  width?: number | null;
  height?: number | null;
}): boolean {
  const longEdge = Math.max(photo.width ?? 0, photo.height ?? 0);
  return longEdge > 0 && longEdge < MIN_PHOTO_LONG_EDGE;
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

function item(
  code: BriefMissingCode,
  severity: BriefMissingSeverity
): BriefMissingItem {
  return { code, severity, message: BRIEF_MISSING_MESSAGES[code] };
}

/** The five things a complete brief has, for the progress line. */
const COMPLETENESS_PARTS = 5;

/**
 * Decides what is still missing. Pure: no I/O, no randomness, no model.
 *
 * Ordering is declaration order below and is stable, so two runs over the same
 * brief produce byte-identical lists, which is what lets the reminder email be
 * idempotent and the dashboard checklist not reshuffle under the reader.
 */
export function evaluateBriefReadiness(input: BriefInput): BriefReadiness {
  const missing: BriefMissingItem[] = [];

  // ── The offer ───────────────────────────────────────────────────────────
  const offerChars = offerLength(input.offer);
  const offerDone = offerChars >= MIN_OFFER_CHARS;
  if (offerChars === 0) {
    missing.push(item('brief_offer_missing', 'blocking'));
  } else if (!offerDone) {
    // Two situations, two codes. A client told "you have written nothing" when
    // they have written a line stops trusting the form.
    missing.push(item('brief_offer_thin', 'blocking'));
  }

  // ── The projects ────────────────────────────────────────────────────────
  const projects = input.projects ?? [];
  const named = namedProjects(projects);
  const answered = Boolean(input.noProjects) || named.length > 0;
  if (!answered) {
    missing.push(item('brief_projects_unanswered', 'blocking'));
  }
  if (named.length < projects.length) {
    missing.push(item('brief_project_unnamed', 'blocking'));
  }
  if (
    named.length > 0 &&
    named.some((project) => (project.screenshotAssetIds ?? []).length === 0)
  ) {
    missing.push(item('brief_project_screenshots_missing', 'degrades'));
  }

  // ── The photographs ─────────────────────────────────────────────────────
  const photos = input.photos ?? [];
  const usable = photos.filter(isUsablePhoto);
  const photosDone = usable.length >= MIN_PHOTOS;
  if (!photosDone) {
    missing.push(item('brief_photos_missing', 'degrades'));
  }
  const portraitDone = usable.some((photo) => photo.kind === 'portrait');
  if (!portraitDone) {
    missing.push(item('brief_portrait_missing', 'degrades'));
  }

  // ── The references ──────────────────────────────────────────────────────
  const referencesDone = (input.designReferenceAssetIds ?? []).length > 0;
  if (!referencesDone) {
    missing.push(item('brief_design_reference_missing', 'degrades'));
  }

  const done = [
    offerDone,
    answered,
    photosDone,
    portraitDone,
    referencesDone,
  ].filter(Boolean).length;

  return {
    ready: missing.every((entry) => entry.severity !== 'blocking'),
    missing,
    completeness: done / COMPLETENESS_PARTS,
  };
}

// ---------------------------------------------------------------------------
// The reminder
// ---------------------------------------------------------------------------

/**
 * How long after the deposit we wait before saying anything. A client who paid
 * an hour ago and is mid-form does not need an email; one who paid yesterday
 * and has not come back does.
 */
export const BRIEF_REMINDER_AFTER_MS = 24 * 60 * 60 * 1000;

export type BriefReminderVerdict =
  | { send: false; reason: 'brief_ready' | 'too_soon' | 'overridden' }
  | { send: true; missing: BriefMissingItem[] };

/**
 * Whether to tell a client we are waiting on them. A rule, so it can be tested
 * without a clock and without a mailer, and so the scheduler that eventually
 * calls it has nothing to decide.
 *
 * `now` is a parameter rather than `Date.now()` for exactly that reason.
 */
export function briefReminderDue(input: {
  readiness: BriefReadiness;
  depositPaidAt: Date | string | null | undefined;
  overrideAt?: Date | string | null;
  now: Date;
  afterMs?: number;
}): BriefReminderVerdict {
  if (input.readiness.ready) return { send: false, reason: 'brief_ready' };
  if (input.overrideAt) return { send: false, reason: 'overridden' };
  const paid = input.depositPaidAt ? new Date(input.depositPaidAt) : null;
  if (!paid || Number.isNaN(paid.getTime())) {
    return { send: false, reason: 'too_soon' };
  }
  const elapsed = input.now.getTime() - paid.getTime();
  if (elapsed < (input.afterMs ?? BRIEF_REMINDER_AFTER_MS)) {
    return { send: false, reason: 'too_soon' };
  }
  return {
    send: true,
    missing: input.readiness.missing.filter(
      (entry) => entry.severity === 'blocking'
    ),
  };
}

/**
 * Whether the build worker may start the agent pass.
 *
 * Two ways through: the brief is ready, or an operator has said build it
 * anyway. Nothing else, and in particular not "the deposit is old enough":
 * a build that starts without a brief is a build that invents one.
 */
export function briefAllowsBuild(input: {
  readyAt?: Date | string | null;
  overrideAt?: Date | string | null;
}): boolean {
  return Boolean(input.readyAt) || Boolean(input.overrideAt);
}
