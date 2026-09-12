/**
 * Whether this deployment can offer to fetch a portrait at all, and if not,
 * which environment variable is missing.
 *
 * The connect buttons are the only place in the funnel where we ask somebody
 * to leave the site. Offering that button on a deployment with no credentials
 * behind it sends them to a provider that refuses the request and returns them
 * to a page that cannot explain why, which is the exact failure
 * `generation-availability.ts` was written to stop the live preview making:
 * check before the journey starts, and tell the truth up front instead of
 * narrating a doomed attempt.
 *
 * So this module answers one question, purely, from an environment object the
 * caller passes in. It returns env var NAMES and never values, which is what
 * makes it safe to put straight into a log line and straight into a response
 * body: `LINKEDIN_CLIENT_SECRET` is the name of a secret, not a secret.
 *
 * Nothing here reads `process.env` at module scope. A value captured at import
 * time cannot be exercised by a test and cannot be changed by an operator
 * restarting the process with a different environment.
 */
import {
  type EnvLike,
  type PortraitProvider,
  PORTRAIT_PROVIDERS,
  PORTRAIT_PROVIDER_ENV_VARS,
  portraitProviderCredentials,
} from './portrait-config';

export interface PortraitProviderAvailability {
  provider: PortraitProvider;
  available: boolean;
  /** Env var names only, never values, so this is safe in a log and safe in a response. */
  missing: string[];
}

/**
 * One provider's answer.
 *
 * Half a credential is not one, which is `portraitProviderCredentials`'
 * judgement rather than this module's, so `available` is read from there and
 * only the list of names is assembled here. Both halves missing means both
 * names are reported: an operator who set the id and forgot the secret should
 * be told about the secret and nothing else.
 */
export function portraitProviderAvailabilityFor(
  provider: PortraitProvider,
  env: EnvLike = process.env
): PortraitProviderAvailability {
  const names = PORTRAIT_PROVIDER_ENV_VARS[provider];
  const credentials = portraitProviderCredentials(provider, env);
  const missing: string[] = [];
  if (!credentials.clientId) missing.push(names.id);
  if (!credentials.clientSecret) missing.push(names.secret);
  return {
    provider,
    available: credentials.configured,
    missing,
  };
}

/**
 * Every provider, in the order `PORTRAIT_PROVIDERS` declares, available or
 * not. The full table rather than only the working ones, because the intake
 * renders a disabled button with a reason and cannot render what it is not
 * told about.
 */
export function portraitProviderAvailability(
  env: EnvLike = process.env
): PortraitProviderAvailability[] {
  return PORTRAIT_PROVIDERS.map((provider) =>
    portraitProviderAvailabilityFor(provider, env)
  );
}

/** True when at least one button can be live. Decides whether to show the row at all. */
export function anyPortraitProviderAvailable(
  env: EnvLike = process.env
): boolean {
  return portraitProviderAvailability(env).some((entry) => entry.available);
}
