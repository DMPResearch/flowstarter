/**
 * Where a client's own face may come from, and what may be done with it.
 *
 * Darius asked for one thing: "the portrait pic should be loaded by flowstarter
 * from my social pages". This module is the rule that answers it. It is pure —
 * no network, no clock, no storage — so every branch below can be exercised
 * with a fixture, which matters because the branches are the product: each one
 * is a sentence the client is shown about why we do or do not have a picture of
 * them.
 *
 * WHAT THE NETWORKS ACTUALLY DO, measured 2026-09-13 against the real
 * endpoints rather than assumed. These measurements are the whole reason the
 * priority order is what it is.
 *
 *   instagram.com/<handle>, logged out
 *       Serves an `og:image` of 100x100, and only to a crawler user agent
 *       (`facebookexternalhit/1.1`). A hundred pixels is a favicon with a face
 *       on it. It is real evidence and it is the last resort, which is exactly
 *       how it is ranked.
 *   www.instagram.com/api/v1/users/web_profile_info
 *       401 without a session. The endpoint that used to carry the full-size
 *       picture is gone for anonymous readers.
 *   the unsigned full-size Instagram CDN URL
 *       403. The signature is the access control; guessing at it is not a
 *       source, it is a break-in attempt.
 *   linkedin.com/in/<handle>, logged out
 *       Login wall. There is no public LinkedIn portrait, at any size.
 *   gravatar.com
 *       Nothing for the test email. Not modelled here: a source that answered
 *       for nobody is a branch with no evidence behind it.
 *
 * The conclusion those measurements force, and the rule this module encodes:
 * SCRAPING BEHIND A LOGIN IS NOT ACCEPTABLE. Not technically difficult —
 * unacceptable. So the two sources that can produce a real, full-size portrait
 * are the two where the person themselves presses a button and authorises it,
 * and everything else is either public by the publisher's own choice or is not
 * used at all.
 *
 * THE PRIORITY ORDER, best first:
 *
 *   1. linkedin-openid      "Sign in with LinkedIn using OpenID Connect",
 *                           scopes `openid profile email`, no app review.
 *                           Returns a picture URL, a name and a headline. The
 *                           best source we have: the person authorised it, the
 *                           picture is full size, and the headline is a line of
 *                           the client's own prose about themselves.
 *   2. instagram-login      The Instagram API with Instagram Login, scope
 *                           `instagram_business_basic`. BUSINESS AND CREATOR
 *                           ACCOUNTS ONLY. A personal account cannot be read at
 *                           all since Basic Display was retired, and that is
 *                           not a failure we can fix with a retry — it is a
 *                           fact about the account, so it gets its own reason
 *                           and its own sentence.
 *   3. github-avatar        Public, 460px, no credential needed. Only when the
 *                           one link or the brief actually names a GitHub
 *                           profile; we do not guess a handle from a name.
 *   4. website-about        The client's own site: `og:image`, or an image on
 *                           an about page, and ONLY when the page says it is a
 *                           person — alt text or a nearby heading that matches
 *                           the full name. A company's og:image is usually a
 *                           logo or a storefront, and a logo in a portrait slot
 *                           is worse than no portrait at all.
 *   5. instagram-public-og  The 100x100 above. Avatar only, forever.
 *
 * THE SIZE FLOOR, which is the other half of the rule. At or above
 * `portraitEdge` a picture may be the hero image or the about portrait. Below
 * it, but at or above `avatarEdge`, it may be used only as a small round
 * avatar — an about-section byline, a testimonial-style signature — and NEVER
 * UPSCALED. Below `avatarEdge` it is not used on the site at all. Both numbers
 * come from `portrait-config.ts`; neither is written in this file.
 *
 * RIGHTS are tracked separately from placement and are not this module's
 * decision. A candidate carries `consented`, which is true only for the two
 * connect flows, because there the person pressed the button themselves. The
 * three automatic sources are filed with `rights_confirmed_at` null and become
 * publishable only when the client taps "Use this" on the brief.
 */
import type { PortraitSizeFloors } from './portrait-config';

// ---------------------------------------------------------------------------
// The sources
// ---------------------------------------------------------------------------

export type PortraitSourceId =
  | 'linkedin-openid'
  | 'instagram-login'
  | 'github-avatar'
  | 'website-about'
  | 'instagram-public-og';

/**
 * Priority order, best first. The array is the rule: `judgePortraitSources`
 * walks it in order and the first usable candidate is the chosen one, so
 * reordering this list is the whole of reordering the preference.
 */
export const PORTRAIT_SOURCE_ORDER: readonly PortraitSourceId[] = [
  'linkedin-openid',
  'instagram-login',
  'github-avatar',
  'website-about',
  'instagram-public-og',
];

/** True when the person themselves authorised the source with a button press. */
export function isConsentedSource(source: PortraitSourceId): boolean {
  return source === 'linkedin-openid' || source === 'instagram-login';
}

// ---------------------------------------------------------------------------
// The evidence
// ---------------------------------------------------------------------------

export interface PortraitPicture {
  /** Absolute https URL the provider gave us. */
  url: string;
  /** Null when the provider did not say and nothing has measured it yet. */
  width: number | null;
  height: number | null;
}

/** What a connect flow knows about one provider. */
export interface ConnectedProviderEvidence {
  /** Both halves of the credential are present in this environment. */
  configured: boolean;
  /** The person completed the flow and we hold a token's worth of answer. */
  connected: boolean;
  picture: PortraitPicture | null;
}

export interface InstagramLoginEvidence extends ConnectedProviderEvidence {
  /**
   * Instagram's own answer about the account. `personal` is terminal: Basic
   * Display is retired, so there is no API that will read it, and telling the
   * client to convert to a creator account is the only honest next step.
   */
  accountType: 'business' | 'creator' | 'personal' | 'unknown';
}

export interface GithubEvidence {
  /**
   * The handle, when the one link or the brief actually named a GitHub
   * profile. Null means nobody told us, and we do not guess one from a name.
   */
  handle: string | null;
  picture: PortraitPicture | null;
}

export interface WebsiteEvidence {
  picture: PortraitPicture | null;
  /**
   * The page said this image is a person: the alt text or a nearby heading
   * matched the client's full name. False for a logo, a storefront, or an
   * og:image with nothing around it to identify.
   */
  saysPerson: boolean;
}

/** Everything the rule is allowed to look at. Absent means "no evidence". */
export interface PortraitObservations {
  linkedin?: ConnectedProviderEvidence;
  instagram?: InstagramLoginEvidence;
  github?: GithubEvidence;
  website?: WebsiteEvidence;
  instagramPublic?: { picture: PortraitPicture | null };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** Where a picture may be placed on the built site. */
export type PortraitPlacement = 'hero' | 'about' | 'avatar';

/** What the measurement says about the picture, before anything is placed. */
export type PortraitSizeVerdict =
  /** At or above the portrait floor: hero or about portrait. */
  | 'portrait'
  /** Below the portrait floor, at or above the avatar floor: avatar only. */
  | 'avatar'
  /** Below the avatar floor. Not placed anywhere; never upscaled. */
  | 'too_small'
  /** Nothing has measured it. We do not place what we have not measured. */
  | 'unknown';

/**
 * Why a source is or is not usable. A closed set, because every member is
 * shown to a person as a sentence, and two reasons that read the same are two
 * reasons the client cannot act on differently.
 */
export type PortraitSourceReason =
  /** We have a picture and it cleared a floor. */
  | 'usable'
  /** The client never gave us this source to look at. */
  | 'not_offered'
  /** This deployment has no credentials for the provider, so no button. */
  | 'not_configured'
  /** Configured, but the person has not pressed the button. */
  | 'not_connected'
  /** Connected, and the provider had no picture on the account. */
  | 'no_picture'
  /** Instagram personal account. Unreadable since Basic Display was retired. */
  | 'personal_account'
  /** Nobody named a GitHub profile, and we do not guess handles. */
  | 'no_github_handle'
  /** The page had an image, but nothing on it said the image is a person. */
  | 'not_a_person'
  /** The URL is not one we are willing to request. */
  | 'not_public_url'
  /** Measured, and smaller than the avatar floor. */
  | 'below_avatar_floor'
  /** We hold a URL but no dimensions, so no placement can be justified. */
  | 'size_unknown';

export interface PortraitCandidate {
  source: PortraitSourceId;
  /** 1-based position in `PORTRAIT_SOURCE_ORDER`. */
  rank: number;
  /** True only when the picture may go somewhere on the site. */
  usable: boolean;
  verdict: PortraitSizeVerdict;
  reason: PortraitSourceReason;
  /** Empty whenever `usable` is false. */
  placements: readonly PortraitPlacement[];
  /**
   * The largest edge the picture may be rendered at, which is the picture's
   * own longest edge and never more. This is how "never upscaled" is carried
   * to the template rather than left as a note in a comment.
   */
  maxRenderEdge: number | null;
  picture: PortraitPicture | null;
  /** The person pressed the button themselves. See the module header. */
  consented: boolean;
}

export interface PortraitVerdict {
  /** Every source, in priority order, usable or not. This is the table. */
  candidates: PortraitCandidate[];
  /** The first usable candidate, or null when there is none. */
  chosen: PortraitCandidate | null;
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

/** Hosts we will never request a portrait from: loopback, link-local, private. */
const PRIVATE_HOST_RE =
  /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|0\.0\.0\.0$)/i;

/**
 * True when a picture URL is safe to request from our server.
 *
 * Deliberately a copy of the same predicate `profile-signals.ts` applies to a
 * profile page rather than an import of it: that module is the brand reader's
 * and carries its own allow list of profile hosts, while this one is about an
 * image URL from any of five different providers. Sharing the function would
 * couple two rules that are allowed to diverge, and the check itself is four
 * lines.
 */
export function isFetchablePictureUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (!url.hostname.includes('.')) return false;
  return !PRIVATE_HOST_RE.test(url.hostname);
}

/** The longest edge, or null when the picture has not been measured. */
export function longEdgeOf(picture: PortraitPicture | null): number | null {
  if (!picture) return null;
  const width = picture.width ?? 0;
  const height = picture.height ?? 0;
  const longest = Math.max(width, height);
  return longest > 0 ? longest : null;
}

/**
 * The size verdict for one measurement. The only place the two floors are
 * compared against anything.
 */
export function sizeVerdictFor(
  longEdge: number | null,
  floors: PortraitSizeFloors
): PortraitSizeVerdict {
  if (longEdge === null) return 'unknown';
  if (longEdge >= floors.portraitEdge) return 'portrait';
  if (longEdge >= floors.avatarEdge) return 'avatar';
  return 'too_small';
}

/**
 * Where a verdict allows a picture to be placed.
 *
 * A portrait may also be an avatar: a large picture scaled down is fine, and
 * the about-section byline is a legitimate home for it. The reverse is the
 * rule that matters — an avatar is never a hero, because the only way to make
 * a 100 pixel picture fill a hero is to upscale it.
 */
export function placementsFor(
  verdict: PortraitSizeVerdict
): readonly PortraitPlacement[] {
  if (verdict === 'portrait') return ['hero', 'about', 'avatar'];
  if (verdict === 'avatar') return ['avatar'];
  return [];
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

function unusable(
  source: PortraitSourceId,
  reason: PortraitSourceReason,
  picture: PortraitPicture | null = null
): Omit<PortraitCandidate, 'rank'> {
  return {
    source,
    usable: false,
    verdict: 'unknown',
    reason,
    placements: [],
    maxRenderEdge: null,
    picture,
    consented: isConsentedSource(source),
  };
}

/**
 * Judges one picture that has already cleared its source's own preconditions.
 *
 * Everything after "the provider gave us this URL" is the same for all five
 * sources: the URL must be one we are willing to fetch, it must have been
 * measured, and the measurement decides the placement.
 */
function judgePicture(
  source: PortraitSourceId,
  picture: PortraitPicture | null,
  floors: PortraitSizeFloors
): Omit<PortraitCandidate, 'rank'> {
  if (!picture || !picture.url.trim()) return unusable(source, 'no_picture');
  if (!isFetchablePictureUrl(picture.url)) {
    return unusable(source, 'not_public_url', picture);
  }
  const longEdge = longEdgeOf(picture);
  const verdict = sizeVerdictFor(longEdge, floors);
  if (verdict === 'unknown') return unusable(source, 'size_unknown', picture);
  if (verdict === 'too_small') {
    return {
      ...unusable(source, 'below_avatar_floor', picture),
      verdict,
    };
  }
  return {
    source,
    usable: true,
    verdict,
    reason: 'usable',
    placements: placementsFor(verdict),
    // Never more than the picture itself. This is the "never upscaled" rule.
    maxRenderEdge: longEdge,
    picture,
    consented: isConsentedSource(source),
  };
}

/** A connect-flow provider, from unconfigured through to a measured picture. */
function judgeConnected(
  source: PortraitSourceId,
  evidence: ConnectedProviderEvidence | undefined,
  floors: PortraitSizeFloors
): Omit<PortraitCandidate, 'rank'> {
  if (!evidence) return unusable(source, 'not_configured');
  if (!evidence.configured) return unusable(source, 'not_configured');
  if (!evidence.connected) return unusable(source, 'not_connected');
  return judgePicture(source, evidence.picture, floors);
}

/**
 * The whole table: every source, with the reason it is or is not usable, in
 * priority order, plus the one we would use.
 *
 * Pure and total. Absent evidence is a reason, never a throw, because the
 * common case at the top of the funnel is that we know nothing about four of
 * the five sources and the client still deserves a preview.
 */
export function judgePortraitSources(
  observations: PortraitObservations,
  floors: PortraitSizeFloors
): PortraitVerdict {
  const judged: Array<Omit<PortraitCandidate, 'rank'>> = [
    judgeConnected('linkedin-openid', observations.linkedin, floors),
    judgeInstagramLogin(observations.instagram, floors),
    judgeGithub(observations.github, floors),
    judgeWebsite(observations.website, floors),
    judgeInstagramPublic(observations.instagramPublic, floors),
  ];

  const candidates = judged.map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
  }));

  return {
    candidates,
    chosen: candidates.find((candidate) => candidate.usable) ?? null,
  };
}

function judgeInstagramLogin(
  evidence: InstagramLoginEvidence | undefined,
  floors: PortraitSizeFloors
): Omit<PortraitCandidate, 'rank'> {
  const source: PortraitSourceId = 'instagram-login';
  if (!evidence) return unusable(source, 'not_configured');
  if (!evidence.configured) return unusable(source, 'not_configured');
  // Checked before `connected`, because a personal account is a fact about the
  // account rather than a step the person has not taken yet: telling them to
  // press a button that cannot work for them is worse than telling them why.
  if (evidence.accountType === 'personal') {
    return unusable(source, 'personal_account');
  }
  if (!evidence.connected) return unusable(source, 'not_connected');
  return judgePicture(source, evidence.picture, floors);
}

function judgeGithub(
  evidence: GithubEvidence | undefined,
  floors: PortraitSizeFloors
): Omit<PortraitCandidate, 'rank'> {
  const source: PortraitSourceId = 'github-avatar';
  if (!evidence || !evidence.handle || !evidence.handle.trim()) {
    return unusable(source, 'no_github_handle');
  }
  return judgePicture(source, evidence.picture, floors);
}

function judgeWebsite(
  evidence: WebsiteEvidence | undefined,
  floors: PortraitSizeFloors
): Omit<PortraitCandidate, 'rank'> {
  const source: PortraitSourceId = 'website-about';
  if (!evidence) return unusable(source, 'not_offered');
  if (!evidence.picture) return unusable(source, 'no_picture');
  // The load-bearing line for this source. An og:image that nothing on the
  // page identifies as a person is a logo or a storefront most of the time,
  // and a logo in a portrait slot is worse than an empty portrait slot.
  if (!evidence.saysPerson) {
    return unusable(source, 'not_a_person', evidence.picture);
  }
  return judgePicture(source, evidence.picture, floors);
}

function judgeInstagramPublic(
  evidence: { picture: PortraitPicture | null } | undefined,
  floors: PortraitSizeFloors
): Omit<PortraitCandidate, 'rank'> {
  const source: PortraitSourceId = 'instagram-public-og';
  if (!evidence) return unusable(source, 'not_offered');
  return judgePicture(source, evidence.picture, floors);
}

// ---------------------------------------------------------------------------
// Saying it in words
// ---------------------------------------------------------------------------

/**
 * The locale key for what a source did, so the intake and the brief print the
 * same sentence from the same rule rather than each inventing their own.
 */
export function portraitReasonCopyKey(reason: PortraitSourceReason): string {
  return `portrait.reason.${reason}`;
}

/**
 * The locale key for the size verdict, which is what the brief's Photos
 * section shows next to the picture as "the size verdict in plain words".
 */
export function portraitVerdictCopyKey(verdict: PortraitSizeVerdict): string {
  return `portrait.verdict.${verdict}`;
}

/** The locale key naming a source, for "we found this on LinkedIn". */
export function portraitSourceCopyKey(source: PortraitSourceId): string {
  return `portrait.source.${source}`;
}

/**
 * Whether the automatic sources are worth running at all.
 *
 * The two connect flows are a button the person presses. The other three are
 * requests we make on their behalf inside the brand-signals fetch, and there
 * is no point making them once a connected provider has already given us a
 * full-size picture that the person authorised.
 */
export function shouldRunAutomaticSources(
  observations: PortraitObservations,
  floors: PortraitSizeFloors
): boolean {
  const linkedin = judgeConnected(
    'linkedin-openid',
    observations.linkedin,
    floors
  );
  if (linkedin.usable && linkedin.verdict === 'portrait') return false;
  const instagram = judgeInstagramLogin(observations.instagram, floors);
  return !(instagram.usable && instagram.verdict === 'portrait');
}
