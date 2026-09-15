import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

/**
 * Is the database actually reachable, shared by both `/api/health` and
 * `/api/health/database`.
 *
 * Before this module existed, `/api/health` echoed `NEXT_PUBLIC_SUPABASE_URL`
 * (via `describeSupabaseTarget`) and never once queried the database, while
 * `/api/health/database` ran a real probe — so the endpoint every deploy
 * script, watcher and operator check actually trusts (`/api/health`)
 * answered `"ok":true` throughout a real outage that `/api/health/database`
 * was correctly reporting as failed. One probe, called from both routes, is
 * what keeps them from disagreeing again.
 *
 * The service role client is the right caller here: it is server-only, every
 * other server route already uses it, and this never returns a row, only
 * whether the query succeeded.
 */

/**
 * Long enough for a same-host or same-network query, short enough that a
 * genuinely dead database fails this probe fast rather than holding up
 * every caller of `/api/health` until its own timeout.
 */
export const DEFAULT_DATABASE_PROBE_TIMEOUT_MS = 3_000;

/**
 * A plain env-shaped record rather than `NodeJS.ProcessEnv`: Next.js
 * augments that global interface with a required `NODE_ENV`
 * (`next/types/global.d.ts`), which would force every test fixture below to
 * carry a field this module never reads. `process.env` itself still
 * satisfies this looser shape.
 */
type EnvLike = Record<string, string | undefined>;

export interface DatabaseProbeResult {
  ok: boolean;
  /** Never a value worth hiding — the driver's own error message, safe to log or return. */
  message?: string;
}

function timeoutMs(env: EnvLike): number {
  const configured = Number(env.FLOWSTARTER_DATABASE_HEALTH_TIMEOUT_MS?.trim());
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_DATABASE_PROBE_TIMEOUT_MS;
}

/**
 * `error instanceof Error` alone misses an abort: `AbortSignal.timeout`
 * rejects with a `DOMException`, and jsdom's `DOMException` (this route's
 * test environment) is not an instance of the realm's `Error` the way
 * Node's own is — so a timeout would otherwise fall through to
 * `'Unknown error'` and hide the one failure mode this probe exists to
 * catch fast.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return 'Unknown error';
}

/**
 * A single lightweight query — `head: true` so Postgres never has to
 * materialize a row, only confirm the table is reachable — bounded by
 * `FLOWSTARTER_DATABASE_HEALTH_TIMEOUT_MS` (falling back to
 * `DEFAULT_DATABASE_PROBE_TIMEOUT_MS`). Never throws: a client construction
 * failure or a network error both come back as `{ ok: false }` the same way
 * a query error does, so every caller can treat this the same regardless of
 * which stage failed.
 */
export async function probeDatabase(
  env: EnvLike = process.env
): Promise<DatabaseProbeResult> {
  try {
    const supabase = createSupabaseServiceRoleClient();
    const { error } = await supabase
      .from('workspaces')
      .select('count', { count: 'exact', head: true })
      .abortSignal(AbortSignal.timeout(timeoutMs(env)));

    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}
