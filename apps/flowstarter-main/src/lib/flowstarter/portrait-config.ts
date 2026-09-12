/**
 * Every number and every provider credential the portrait pipeline reads.
 *
 * The rule that decides where a client's face may appear is arithmetic over a
 * size floor, and a size floor written inline in the rule is a number nobody
 * can change without a deploy and a code review. So it lives here, with a
 * named environment variable in front of it and a documented default behind
 * it, the same shape `src/lib/ops/alerts.ts` uses for its dedupe windows.
 *
 * Everything in this file is a pure function of an environment object the
 * caller passes in. Nothing reads `process.env` at module scope, because a
 * value captured at import time cannot be exercised by a test and cannot be
 * changed by an operator restarting the process with a different environment.
 */

/**
 * Deliberately not `NodeJS.ProcessEnv`: Next augments that type with a
 * required `NODE_ENV`, which every fixture in every test would then have to
 * carry for no reason. Same choice `generation-availability.ts` made.
 */
export type EnvLike = Record<string, string | undefined>;

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * A positive integer from the environment, or the default.
 *
 * A misconfigured value is the default rather than a crash: an operator who
 * types `FLOWSTARTER_PORTRAIT_MIN_EDGE=large` should get a working funnel and
 * a size floor that still means something, not a page that will not render.
 */
export function positiveIntFromEnv(
  raw: string | undefined,
  fallback: number
): number {
  const parsed = Number.parseInt(trimmed(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Size floors
// ---------------------------------------------------------------------------

/**
 * The two thresholds the placement rule is built on, measured on the longest
 * edge of the picture in pixels.
 */
export interface PortraitSizeFloors {
  /**
   * At or above this a picture may be the hero image or the about portrait.
   * 400 is the number `profile-picture.ts` already used for the same judgement
   * and is kept so the two rules cannot disagree about one file.
   */
  portraitEdge: number;
  /**
   * At or above this, and below `portraitEdge`, a picture may only be a small
   * round avatar: an about-section byline, a testimonial-style signature. It
   * is never scaled up to fill a slot it is too small for, because an upscaled
   * headshot on a paid site reads as a mistake rather than as a photograph.
   *
   * 96 is the size the templates render a byline avatar at, and Instagram's
   * public OpenGraph picture is 100 square, which is exactly the case this
   * floor exists to admit.
   */
  avatarEdge: number;
}

/** The floor when nothing is set. Overridable per environment. */
export const DEFAULT_PORTRAIT_EDGE = 400;
/** The avatar floor when nothing is set. Overridable per environment. */
export const DEFAULT_AVATAR_EDGE = 96;

/** The env var an operator raises or lowers the hero/about floor with. */
export const PORTRAIT_EDGE_ENV_VAR = 'FLOWSTARTER_PORTRAIT_MIN_EDGE';
/** The env var an operator raises or lowers the avatar floor with. */
export const AVATAR_EDGE_ENV_VAR = 'FLOWSTARTER_PORTRAIT_AVATAR_MIN_EDGE';

/**
 * The floors, read from the environment.
 *
 * An avatar floor above the portrait floor is nonsense rather than a policy:
 * it would make a picture simultaneously too small to be an avatar and large
 * enough to be a hero. A pair that crosses over therefore collapses to the
 * defaults instead of producing a rule with no middle.
 */
export function portraitSizeFloors(
  env: EnvLike = process.env
): PortraitSizeFloors {
  const portraitEdge = positiveIntFromEnv(
    env[PORTRAIT_EDGE_ENV_VAR],
    DEFAULT_PORTRAIT_EDGE
  );
  const avatarEdge = positiveIntFromEnv(
    env[AVATAR_EDGE_ENV_VAR],
    DEFAULT_AVATAR_EDGE
  );
  if (avatarEdge > portraitEdge) {
    return {
      portraitEdge: DEFAULT_PORTRAIT_EDGE,
      avatarEdge: DEFAULT_AVATAR_EDGE,
    };
  }
  return { portraitEdge, avatarEdge };
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** How long we will wait for a provider's token or profile endpoint. */
export const DEFAULT_PORTRAIT_PROVIDER_TIMEOUT_MS = 6_000;
export const PORTRAIT_PROVIDER_TIMEOUT_ENV_VAR =
  'FLOWSTARTER_PORTRAIT_PROVIDER_TIMEOUT_MS';

/** How long a signed connect state is good for. Ten minutes of attention. */
export const DEFAULT_PORTRAIT_STATE_TTL_MS = 10 * 60 * 1000;
export const PORTRAIT_STATE_TTL_ENV_VAR = 'FLOWSTARTER_PORTRAIT_STATE_TTL_MS';

/** A headshot, not a hero photograph. The cap `profile-picture.ts` uses. */
export const DEFAULT_MAX_PORTRAIT_BYTES = 4 * 1024 * 1024;
export const MAX_PORTRAIT_BYTES_ENV_VAR = 'FLOWSTARTER_PORTRAIT_MAX_BYTES';

export interface PortraitBudgets {
  providerTimeoutMs: number;
  stateTtlMs: number;
  maxBytes: number;
}

export function portraitBudgets(env: EnvLike = process.env): PortraitBudgets {
  return {
    providerTimeoutMs: positiveIntFromEnv(
      env[PORTRAIT_PROVIDER_TIMEOUT_ENV_VAR],
      DEFAULT_PORTRAIT_PROVIDER_TIMEOUT_MS
    ),
    stateTtlMs: positiveIntFromEnv(
      env[PORTRAIT_STATE_TTL_ENV_VAR],
      DEFAULT_PORTRAIT_STATE_TTL_MS
    ),
    maxBytes: positiveIntFromEnv(
      env[MAX_PORTRAIT_BYTES_ENV_VAR],
      DEFAULT_MAX_PORTRAIT_BYTES
    ),
  };
}

// ---------------------------------------------------------------------------
// Provider credentials
// ---------------------------------------------------------------------------

/** The two providers a person can authorise us against. */
export type PortraitProvider = 'linkedin' | 'instagram';

export const PORTRAIT_PROVIDERS: readonly PortraitProvider[] = [
  'linkedin',
  'instagram',
];

/** True when a string names one of the two providers. */
export function isPortraitProvider(value: string): value is PortraitProvider {
  return (PORTRAIT_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The env names each provider needs. Named here, once, so the docs, the
 * `.env.example`, the disabled-button copy and the route all agree about what
 * is missing.
 */
export const PORTRAIT_PROVIDER_ENV_VARS: Record<
  PortraitProvider,
  { id: string; secret: string }
> = {
  linkedin: { id: 'LINKEDIN_CLIENT_ID', secret: 'LINKEDIN_CLIENT_SECRET' },
  instagram: { id: 'INSTAGRAM_APP_ID', secret: 'INSTAGRAM_APP_SECRET' },
};

export interface PortraitProviderCredentials {
  provider: PortraitProvider;
  clientId: string;
  clientSecret: string;
  /** True only when both halves are present. Half a credential is not one. */
  configured: boolean;
}

export function portraitProviderCredentials(
  provider: PortraitProvider,
  env: EnvLike = process.env
): PortraitProviderCredentials {
  const names = PORTRAIT_PROVIDER_ENV_VARS[provider];
  const clientId = trimmed(env[names.id]);
  const clientSecret = trimmed(env[names.secret]);
  return {
    provider,
    clientId,
    clientSecret,
    configured: Boolean(clientId && clientSecret),
  };
}

/**
 * Which providers this deployment can actually offer.
 *
 * The intake reads this to decide whether a button is live or disabled. It
 * returns names, never values, so it is safe to log and safe to send to a
 * browser.
 */
export function configuredPortraitProviders(
  env: EnvLike = process.env
): PortraitProvider[] {
  return PORTRAIT_PROVIDERS.filter(
    (provider) => portraitProviderCredentials(provider, env).configured
  );
}

/**
 * The secret the connect state is signed with.
 *
 * Falls back to the provider's own client secret, which is already a shared
 * secret between us and the provider and never reaches a browser. There is
 * deliberately no default beyond that: an unsigned state is a state anybody
 * can mint, and a connect flow with a forgeable state hands one person's
 * photograph to another person's preview.
 */
export const PORTRAIT_STATE_SECRET_ENV_VAR =
  'FLOWSTARTER_PORTRAIT_STATE_SECRET';

export function portraitStateSecret(
  provider: PortraitProvider,
  env: EnvLike = process.env
): string {
  return (
    trimmed(env[PORTRAIT_STATE_SECRET_ENV_VAR]) ||
    portraitProviderCredentials(provider, env).clientSecret
  );
}

// ---------------------------------------------------------------------------
// The automatic sources
// ---------------------------------------------------------------------------

/**
 * The edge we ask GitHub for. `github.com/<handle>.png?size=N` is a request,
 * not a promise: the bytes that come back are whatever the person uploaded,
 * resized down to at most N, so 460 is the largest useful ask rather than a
 * guaranteed answer. Every picture is measured after it is downloaded, and
 * this number never reaches the placement rule.
 */
export const DEFAULT_GITHUB_AVATAR_EDGE = 460;
export const GITHUB_AVATAR_EDGE_ENV_VAR = 'FLOWSTARTER_PORTRAIT_GITHUB_EDGE';

/**
 * The most of a client's own page we will scan for a picture of them.
 *
 * The same cap `profile-signals.ts` puts on a profile page, for the same
 * reason: a marketing site is frequently a megabyte of minified script, the
 * portrait is in the first screenful of markup, and scanning the rest is time
 * a visitor spends watching a spinner. Counted in characters of the decoded
 * body, which for any document is at most that many bytes.
 */
export const DEFAULT_MAX_PORTRAIT_HTML_BYTES = 1_500_000;
export const MAX_PORTRAIT_HTML_BYTES_ENV_VAR =
  'FLOWSTARTER_PORTRAIT_MAX_HTML_BYTES';

/**
 * How many `<img>` tags we will consider before we stop looking.
 *
 * A gallery page has hundreds of them. The person is not the two hundredth
 * one, and every extra tag is another window of surrounding markup to
 * normalise while a visitor waits.
 */
export const DEFAULT_MAX_IMG_TAGS_SCANNED = 200;
export const MAX_IMG_TAGS_SCANNED_ENV_VAR = 'FLOWSTARTER_PORTRAIT_MAX_IMG_TAGS';

/**
 * How far back from an `<img>` we look for the heading that names the person.
 *
 * A heading two thousand characters earlier is a different part of the page,
 * and treating it as the caption for this picture is exactly how a logo ends
 * up labelled with the founder's name. Wide enough to cover a card, narrow
 * enough that it has to be the same card.
 */
export const DEFAULT_PORTRAIT_HEADING_WINDOW_CHARS = 2_000;
export const PORTRAIT_HEADING_WINDOW_ENV_VAR =
  'FLOWSTARTER_PORTRAIT_HEADING_WINDOW';

/**
 * How long each of the three automatic sources gets before we move on.
 *
 * The same four seconds `profile-fetch.ts` gives a profile page, and for the
 * same reason: these requests run inside the brand-signals fetch while a
 * visitor waits on a preview, they run in parallel so the visitor pays for the
 * slowest rather than the sum, and a source that has not answered inside the
 * budget is an absent picture, which the rule already has a reason for.
 */
export const DEFAULT_PORTRAIT_AUTO_TIMEOUT_MS = 4_000;
export const PORTRAIT_AUTO_TIMEOUT_ENV_VAR =
  'FLOWSTARTER_PORTRAIT_AUTO_TIMEOUT_MS';

export interface PortraitAutoBudgets {
  /** The `?size=` we ask GitHub for. Never trusted as the answer. */
  githubAvatarEdge: number;
  /** Characters of a client's own page we scan. */
  maxHtmlBytes: number;
  /** `<img>` tags we consider on it. */
  maxImgTags: number;
  /** Characters before an `<img>` that count as its surroundings. */
  headingWindowChars: number;
  /** Per source, not per run. The three sources run in parallel. */
  timeoutMs: number;
}

export function portraitAutoBudgets(
  env: EnvLike = process.env
): PortraitAutoBudgets {
  return {
    githubAvatarEdge: positiveIntFromEnv(
      env[GITHUB_AVATAR_EDGE_ENV_VAR],
      DEFAULT_GITHUB_AVATAR_EDGE
    ),
    maxHtmlBytes: positiveIntFromEnv(
      env[MAX_PORTRAIT_HTML_BYTES_ENV_VAR],
      DEFAULT_MAX_PORTRAIT_HTML_BYTES
    ),
    maxImgTags: positiveIntFromEnv(
      env[MAX_IMG_TAGS_SCANNED_ENV_VAR],
      DEFAULT_MAX_IMG_TAGS_SCANNED
    ),
    headingWindowChars: positiveIntFromEnv(
      env[PORTRAIT_HEADING_WINDOW_ENV_VAR],
      DEFAULT_PORTRAIT_HEADING_WINDOW_CHARS
    ),
    timeoutMs: positiveIntFromEnv(
      env[PORTRAIT_AUTO_TIMEOUT_ENV_VAR],
      DEFAULT_PORTRAIT_AUTO_TIMEOUT_MS
    ),
  };
}
