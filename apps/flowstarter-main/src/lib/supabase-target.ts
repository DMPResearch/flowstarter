/**
 * Keeps development and staging off a hosted Supabase project.
 *
 * The base `.env` in this app points `NEXT_PUBLIC_SUPABASE_URL` at the
 * production project so that a build with no local overrides still has a
 * valid URL to validate against. That is convenient for production, and
 * dangerous everywhere else: a developer (or an agent) who forgets to start
 * the local stack would otherwise read and write the production database by
 * accident. This module is the single place that decides whether the
 * resolved Supabase target is allowed for the resolved environment, so the
 * rule lives in one spot instead of being re-implemented, or forgotten, at
 * each call site.
 */

export type FlowstarterEnv = 'development' | 'test' | 'staging' | 'production';

const FLOWSTARTER_ENV_VALUES: readonly FlowstarterEnv[] = [
  'development',
  'test',
  'staging',
  'production',
];

function isFlowstarterEnv(value: string | undefined): value is FlowstarterEnv {
  return (
    !!value && (FLOWSTARTER_ENV_VALUES as readonly string[]).includes(value)
  );
}

/**
 * The environment this process is running as. `FLOWSTARTER_ENV` is
 * authoritative when set (it is the only way to name `staging`, since
 * staging otherwise runs with `NODE_ENV=production` like a real production
 * build). Otherwise it is derived from `NODE_ENV`.
 */
export function resolveFlowstarterEnv(
  env: NodeJS.ProcessEnv = process.env
): FlowstarterEnv {
  if (isFlowstarterEnv(env.FLOWSTARTER_ENV)) return env.FLOWSTARTER_ENV;
  if (env.NODE_ENV === 'production') return 'production';
  if (env.NODE_ENV === 'test') return 'test';
  return 'development';
}

const LOCAL_HOSTNAMES = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  'host.docker.internal',
]);

/**
 * Whether a Supabase URL's host is the local CLI stack (or a Docker service
 * name for it, such as `supabase_kong_flowstarter`) rather than a hosted
 * project. An unparsable URL is treated as remote: it is not a target we can
 * vouch for, so it does not get the benefit of the doubt.
 */
export function classifySupabaseHost(url: string): 'local' | 'remote' {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return 'remote';
  }
  if (LOCAL_HOSTNAMES.has(hostname)) return 'local';
  // A Docker Compose service name (e.g. `supabase_kong_flowstarter`) has no
  // dot in it; a real hostname, hosted Supabase included, always does.
  if (hostname.length > 0 && !hostname.includes('.')) return 'local';
  return 'remote';
}

export interface SupabaseTargetDescription {
  env: FlowstarterEnv;
  target: 'local' | 'remote';
  host: string;
}

/**
 * The resolved environment and Supabase target, safe to log or return from
 * an API route: never the key, and the host only (not the full URL, which
 * can carry a project ref that reads like an identifier worth not repeating
 * unnecessarily).
 */
export function describeSupabaseTarget(
  env: NodeJS.ProcessEnv = process.env
): SupabaseTargetDescription {
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  let host = '';
  if (url) {
    try {
      host = new URL(url).hostname;
    } catch {
      host = '';
    }
  }
  return {
    env: resolveFlowstarterEnv(env),
    target: url ? classifySupabaseHost(url) : 'remote',
    host,
  };
}

/**
 * Throws when `development` or `staging` is about to talk to a remote
 * (hosted) Supabase project. `test` and `production` are never blocked:
 * tests mock or stub the client, and production is supposed to be remote.
 * `FLOWSTARTER_ALLOW_REMOTE_SUPABASE=1` is the explicit, deliberate escape
 * hatch for the rare case that really does need it.
 */
export function assertSupabaseTargetAllowed(
  env: NodeJS.ProcessEnv = process.env
): void {
  const { env: resolvedEnv, target, host } = describeSupabaseTarget(env);
  if (resolvedEnv !== 'development' && resolvedEnv !== 'staging') return;
  if (target !== 'remote') return;
  if (env.FLOWSTARTER_ALLOW_REMOTE_SUPABASE === '1') return;

  throw new Error(
    `Refusing to run ${resolvedEnv} against a remote Supabase project (${
      host || 'unknown host'
    }). ` +
      'Start the local stack with `supabase start` and run `pnpm db:env` to point this app at it ' +
      '(on the staging host, use the supabase-stack script instead). ' +
      'If you really mean to use a remote project, set FLOWSTARTER_ALLOW_REMOTE_SUPABASE=1 explicitly.'
  );
}

type GuardResult = 'unchecked' | 'ok' | Error;

let guardResult: GuardResult = 'unchecked';

/**
 * Runs `assertSupabaseTargetAllowed` once per process and memoises the
 * outcome, so the Supabase client factories can call it on every invocation
 * (including cached-client fast paths) at effectively no cost. A failure is
 * memoised too and rethrown on every later call: `process.env` does not
 * change mid-process, so re-running the check would only find the same
 * violation again, and a guard that goes quiet after its first warning would
 * be worse than no guard.
 */
export function ensureSupabaseTargetAllowed(): void {
  if (guardResult === 'ok') return;
  if (guardResult instanceof Error) throw guardResult;

  try {
    assertSupabaseTargetAllowed();
    guardResult = 'ok';
  } catch (error) {
    guardResult = error instanceof Error ? error : new Error(String(error));
    throw error;
  }
}

/** Test-only: resets the memoisation so `ensureSupabaseTargetAllowed` re-checks. */
export function resetSupabaseTargetGuardForTests(): void {
  guardResult = 'unchecked';
}
