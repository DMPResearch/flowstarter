/**
 * Where a funnel preview is published, decided by rule rather than by
 * whichever branch happened to throw first.
 *
 * The old shape was "Daytona, and if that fails spawn `astro dev`". Both
 * halves were wrong for the product. Daytona is a third party we do not
 * operate: when its key was revoked on 2026-09-12 every preview in the funnel
 * failed at the last phase, and nothing on our side could be done about it.
 * The `astro dev` fallback then made it worse rather than better — Astro 7
 * detaches its dev server, so the shim exited, the readiness loop broke, the
 * daemon was orphaned and the directory it was serving was deleted underneath
 * it (one leaked daemon ran for three days).
 *
 * Darius's hosting decision is that previews live on Flowstarter's own
 * platform, at `{previewId}.preview.flowstarter.dev` in development and
 * staging and `.net` in production, served by the previews deploy-agent on
 * the platform host. So that is the default, and it is the same deploy path a
 * paying customer's site uses — exercised dozens of times a day by traffic
 * that costs nothing when it breaks.
 *
 * This module decides only. It reads env and returns a name; it opens no
 * socket, spawns nothing and touches no disk, so the decision can be asserted
 * in a unit test exactly as the route will make it.
 */

/**
 * A plain env-shaped record rather than `NodeJS.ProcessEnv`: Next augments
 * that global with a required `NODE_ENV`, which would force every fixture
 * here to carry a field most of these rules never read. `process.env` itself
 * satisfies this looser shape.
 */
type EnvLike = Record<string, string | undefined>;

export type PreviewPublisherKind = 'platform' | 'daytona' | 'local-static';

/** The one env var that overrides the default. Named once. */
export const PREVIEW_PUBLISHER_ENV = 'FLOWSTARTER_PREVIEW_PUBLISHER';

/** The previews deploy-agent, and only it — never the paid-site agent. */
export const PLATFORM_PUBLISHER_ENV = [
  'FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL',
  'FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET',
] as const;

export const DAYTONA_PUBLISHER_ENV = ['DAYTONA_API_KEY'] as const;

export type PreviewPublisherReason =
  /** `FLOWSTARTER_PREVIEW_PUBLISHER=daytona` was set on purpose. */
  | 'daytona-requested'
  /** The previews deploy-agent is configured; previews go to the platform. */
  | 'platform-host-configured'
  /**
   * A developer's own machine with no previews host in `.env.local`. The
   * built `dist/` is served from this process instead, so the funnel still
   * shows a real, compiled site without anybody having to own a server.
   */
  | 'development-without-platform-host'
  /**
   * Staging or production with no previews host configured. There is no local
   * fallback outside development — serving generated HTML from the app's own
   * origin next to a real session is exactly what `local-preview-guard`
   * exists to refuse — so this is reported as missing configuration and the
   * funnel says so up front.
   */
  | 'platform-host-missing';

export interface PreviewPublisherDecision {
  publisher: PreviewPublisherKind;
  reason: PreviewPublisherReason;
  /**
   * Env var names (never values) still needed before the chosen publisher can
   * run. Empty when it is ready. `generation-availability.ts` reports these to
   * the visitor as "not configured" before a job is created.
   */
  missing: string[];
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? '';
}

function allPresent(env: EnvLike, names: readonly string[]): boolean {
  return names.every((name) => Boolean(trimmed(env[name])));
}

function absent(env: EnvLike, names: readonly string[]): string[] {
  return names.filter((name) => !trimmed(env[name]));
}

/**
 * Development means the resolved Flowstarter environment, not `NODE_ENV`.
 * Staging runs a production build of this app against the staging stack; it
 * must not get the developer fallback just because someone forgot a var.
 */
function isDevelopment(env: EnvLike): boolean {
  const declared = trimmed(env.FLOWSTARTER_ENV).toLowerCase();
  if (declared) return declared === 'development';
  return trimmed(env.NODE_ENV) !== 'production';
}

/**
 * The publisher for this process.
 *
 * Order is the whole rule:
 *  1. An explicit `FLOWSTARTER_PREVIEW_PUBLISHER=daytona` wins. Daytona is
 *     kept as a configured alternative, never as a default and never as a
 *     silent fallback — an operator who wants it says so.
 *  2. Otherwise `platform`, whenever the previews deploy-agent is configured.
 *  3. Otherwise, on a developer machine only, `local-static`.
 *  4. Otherwise `platform` with its missing vars named, so the funnel can
 *     decline honestly instead of narrating a doomed build.
 *
 * Any other value of the env var (a typo, an empty string, `daytona ` with a
 * space is fine, `sandbox` is not) falls through to the default rather than
 * throwing: a mistyped preference must not take the funnel down.
 */
export function resolvePreviewPublisher(
  env: EnvLike = process.env
): PreviewPublisherDecision {
  const requested = trimmed(env[PREVIEW_PUBLISHER_ENV]).toLowerCase();

  if (requested === 'daytona') {
    return {
      publisher: 'daytona',
      reason: 'daytona-requested',
      missing: absent(env, DAYTONA_PUBLISHER_ENV),
    };
  }

  if (allPresent(env, PLATFORM_PUBLISHER_ENV)) {
    return {
      publisher: 'platform',
      reason: 'platform-host-configured',
      missing: [],
    };
  }

  if (isDevelopment(env)) {
    return {
      publisher: 'local-static',
      reason: 'development-without-platform-host',
      missing: [],
    };
  }

  return {
    publisher: 'platform',
    reason: 'platform-host-missing',
    missing: absent(env, PLATFORM_PUBLISHER_ENV),
  };
}

/**
 * The env names the chosen publisher is still waiting on. Names only, so this
 * is safe to put in a log line or hand to the wizard.
 */
export function missingPreviewPublisherConfig(
  env: EnvLike = process.env
): string[] {
  return resolvePreviewPublisher(env).missing;
}
