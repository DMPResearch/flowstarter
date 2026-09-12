import type {
  BriefAsset,
  BriefPalette,
  BriefProject,
  BriefTone,
  BusinessIntakePayload,
  SocialMediaTarget,
  SocialPlatform,
} from './types';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const INSTRUCTION_INJECTION =
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,60}\b(previous|prior|above|earlier|system|developer)\b[^.\n]{0,30}\b(instruction|prompt|rule|message|context)s?\b/i;
const SYSTEM_PROBING =
  /\b(system prompt|reveal (?:the |your )?(?:prompt|instructions)|developer mode|jailbreak|you are now|act as (?:a |an )?system)\b/i;

const SOCIAL_HOSTS: Record<SocialPlatform, readonly string[]> = {
  instagram: ['instagram.com'],
  linkedin: ['linkedin.com'],
};

/*
 * Caps for the in-depth brief the client fills after the deposit. Each one is
 * a number somebody has to justify, so each carries the reason it is that
 * number. They are deliberately generous: the point is to refuse a payload
 * that could only have come from a script, not to argue with a client who
 * writes long.
 */

/** A sentence or two on what they sell. Past this it is a description. */
const MAX_OFFER_CHARS = 600;
/** Real projects a brief may list; beyond a dozen the work page is a directory. */
const MAX_PROJECTS = 12;
/** A project name is a title, not a paragraph. */
const MAX_PROJECT_NAME_CHARS = 80;
/** The dashboard asks for one line, so one line is what is accepted. */
const MAX_PROJECT_LINE_CHARS = 160;
/** Screens per project. A case study needing more is a site of its own. */
const MAX_PROJECT_SCREENSHOTS = 6;
/** References are a mood board for the build, never content; a few is plenty. */
const MAX_DESIGN_REFERENCES = 8;
/** The client's own photographs. More than this is an album, not a brief. */
const MAX_PHOTOS = 12;
/** An asset caption is alt-text length, not a story. */
const MAX_ASSET_CAPTION_CHARS = 200;
/** The asset id is a database identifier, never prose. */
const MAX_ASSET_ID_CHARS = 100;
/** Three adjectives are asked for; a fourth is a list, not a voice. */
const MAX_TONE_ADJECTIVES = 3;
/** An adjective is one word, with room for a hyphenated one. */
const MAX_TONE_ADJECTIVE_CHARS = 24;
/** One line of voice note, the same length the dashboard field allows. */
const MAX_TONE_VOICE_CHARS = 200;

/**
 * The only path shape the build can actually serve an uploaded asset from.
 * Anything else - a bare filename, a traversal, an external URL - is a path
 * the site would render as a broken image, so it is refused here rather than
 * shipped.
 */
const ASSET_PUBLIC_PATH =
  /^\/flowstarter-(media|assets)\/[A-Za-z0-9._-]{1,120}$/;
/** Six-digit hex: the only form the theme-token writer knows how to place. */
const PALETTE_HEX = /^#[0-9a-fA-F]{6}$/;

export class UnsafeBusinessIntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeBusinessIntakeError';
  }
}

export function containsAgentControlInstructions(text: string): boolean {
  return INSTRUCTION_INJECTION.test(text) || SYSTEM_PROBING.test(text);
}

/**
 * Deterministic first-line validation for public intake data. This does not
 * replace prompt isolation; it keeps malformed links and blatant role-control
 * payloads away from scrapers and agent sessions in the first place.
 */
export function assertSafeBusinessIntake(intake: BusinessIntakePayload): void {
  if (!UUID.test(intake.projectId))
    throw new UnsafeBusinessIntakeError('Invalid project identifier');
  if (
    intake.socialMedia.length > 0 &&
    (!intake.consent.publicProfileAnalysis || !intake.consent.acceptedAt)
  ) {
    throw new UnsafeBusinessIntakeError(
      'Public profile analysis requires explicit consent',
    );
  }

  assertTextField('business.name', intake.business.name, 200, true);
  assertTextField('business.niche', intake.business.niche, 240, true);
  assertTextField('business.location', intake.business.location, 240, true);
  assertTextField('business.description', intake.business.description, 5_000);
  assertTextField(
    'business.targetAudience',
    intake.business.targetAudience,
    1_000,
  );
  assertTextField('business.primaryGoal', intake.business.primaryGoal, 500);
  assertTextField('locale', intake.locale, 35, true);

  if (intake.socialMedia.length > 4) {
    throw new UnsafeBusinessIntakeError('Too many social profiles');
  }
  for (const target of intake.socialMedia) assertSocialTarget(target);

  if (intake.business.existingWebsiteUrl) {
    assertPublicHttpsUrl(
      intake.business.existingWebsiteUrl,
      'existing website',
    );
  }

  assertBrief(intake);
}

/**
 * The in-depth brief, validated field by field.
 *
 * Every part of it is optional, and absence is always fine: a brief taken
 * before the dashboard asked these questions simply has none of them. What is
 * not fine is a present field that the build cannot use - an asset path the
 * site cannot serve, a link that is not public HTTPS, a colour that is not a
 * hex. Those fail here, where the failure names the field, rather than in the
 * middle of a paid build.
 */
function assertBrief(intake: BusinessIntakePayload): void {
  assertTextField('offer', intake.offer, MAX_OFFER_CHARS);

  if (intake.projects) {
    if (intake.projects.length > MAX_PROJECTS) {
      throw new UnsafeBusinessIntakeError('Too many projects');
    }
    intake.projects.forEach((project, index) =>
      assertBriefProject(project, index),
    );
  }

  if (intake.designReferences) {
    if (intake.designReferences.length > MAX_DESIGN_REFERENCES) {
      throw new UnsafeBusinessIntakeError('Too many design references');
    }
    intake.designReferences.forEach((asset, index) =>
      assertBriefAsset(`designReferences[${index}]`, asset),
    );
  }

  if (intake.photos) {
    if (intake.photos.length > MAX_PHOTOS) {
      throw new UnsafeBusinessIntakeError('Too many photos');
    }
    intake.photos.forEach((photo, index) =>
      assertBriefAsset(`photos[${index}]`, photo),
    );
  }

  if (intake.palette) assertBriefPalette(intake.palette);
  if (intake.tone) assertBriefTone(intake.tone);
}

function assertBriefProject(project: BriefProject, index: number): void {
  const label = `projects[${index}]`;
  assertTextField(`${label}.name`, project.name, MAX_PROJECT_NAME_CHARS, true);
  assertTextField(`${label}.line`, project.line, MAX_PROJECT_LINE_CHARS);
  // A project link is an outbound link on a paid site, so it gets exactly the
  // same treatment as the client's existing website: public HTTPS or nothing.
  if (project.link) assertPublicHttpsUrl(project.link, `${label}.link`);
  if (project.screenshots) {
    if (project.screenshots.length > MAX_PROJECT_SCREENSHOTS) {
      throw new UnsafeBusinessIntakeError(`${label} has too many screenshots`);
    }
    project.screenshots.forEach((asset, position) =>
      assertBriefAsset(`${label}.screenshots[${position}]`, asset),
    );
  }
}

function assertBriefAsset(label: string, asset: BriefAsset): void {
  assertTextField(`${label}.id`, asset.id, MAX_ASSET_ID_CHARS, true);
  if (!ASSET_PUBLIC_PATH.test(asset.publicPath ?? '')) {
    throw new UnsafeBusinessIntakeError(
      `${label}.publicPath is not a path the build can serve`,
    );
  }
  assertTextField(`${label}.caption`, asset.caption, MAX_ASSET_CAPTION_CHARS);
}

function assertBriefPalette(palette: BriefPalette): void {
  const roles: ReadonlyArray<keyof Omit<BriefPalette, 'source'>> = [
    'primary',
    'secondary',
    'accent',
    'neutral',
  ];
  for (const role of roles) {
    const colour = palette[role];
    if (!colour) {
      throw new UnsafeBusinessIntakeError(`palette.${role} is missing`);
    }
    for (const mode of ['base', 'onLight', 'onDark'] as const) {
      if (!PALETTE_HEX.test(colour[mode] ?? '')) {
        throw new UnsafeBusinessIntakeError(
          `palette.${role}.${mode} is not a six-digit hex colour`,
        );
      }
    }
  }
  assertTextField('palette.source', palette.source, 40);
}

function assertBriefTone(tone: BriefTone): void {
  if ((tone.adjectives?.length ?? 0) > MAX_TONE_ADJECTIVES) {
    throw new UnsafeBusinessIntakeError('Too many tone adjectives');
  }
  (tone.adjectives ?? []).forEach((adjective, index) =>
    assertTextField(
      `tone.adjectives[${index}]`,
      adjective,
      MAX_TONE_ADJECTIVE_CHARS,
    ),
  );
  assertTextField('tone.voice', tone.voice, MAX_TONE_VOICE_CHARS);
}

function assertTextField(
  label: string,
  value: string | undefined,
  maxLength: number,
  required = false,
): void {
  const text = value?.trim() ?? '';
  if (required && !text)
    throw new UnsafeBusinessIntakeError(`${label} is required`);
  if (text.length > maxLength)
    throw new UnsafeBusinessIntakeError(`${label} is too long`);
  if (containsAgentControlInstructions(text)) {
    throw new UnsafeBusinessIntakeError(
      `${label} contains agent-control instructions`,
    );
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
    throw new UnsafeBusinessIntakeError(`${label} contains control characters`);
  }
}

function assertSocialTarget(target: SocialMediaTarget): void {
  assertTextField('social handle', target.handle, 100);
  if (!SAFE_PROVIDER.test(target.scraper.provider)) {
    throw new UnsafeBusinessIntakeError('Invalid scraper provider identifier');
  }
  const url = assertPublicHttpsUrl(target.profileUrl, target.platform);
  const allowedHosts = SOCIAL_HOSTS[target.platform];
  const hostname = url.hostname.toLowerCase();
  if (
    !allowedHosts.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`),
    )
  ) {
    throw new UnsafeBusinessIntakeError(
      `Profile URL does not match ${target.platform}`,
    );
  }
}

function assertPublicHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeBusinessIntakeError(`Invalid ${label} URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new UnsafeBusinessIntakeError(
      `${label} URL must be public HTTPS without credentials or ports`,
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    /^(?:10|127)\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    throw new UnsafeBusinessIntakeError(
      `${label} URL cannot target a private host`,
    );
  }
  return url;
}
