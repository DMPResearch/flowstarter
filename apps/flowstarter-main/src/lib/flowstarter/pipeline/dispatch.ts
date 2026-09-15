/**
 * The one place that knows how to nudge the build worker.
 *
 * The ledger row is the commitment; this HTTP call is only a nudge. Callers
 * differ on whether a failed nudge matters: the Stripe webhook swallows it,
 * because failing the webhook over an unreachable worker would make Stripe
 * retry for days over something a retry cannot fix — leaving a job `queued`
 * with nothing running it, which is precisely what an operator needs to be
 * able to fix by hand. The operator path lets the error surface instead.
 *
 * So this throws on every failure and lets each caller choose. It never
 * creates or mutates a job row; enqueueing stays in deposit-workflow.ts,
 * behind its unique indexes.
 *
 * `probeBuildWorkerHealth` also lives here, alongside the only other code
 * that talks to this worker, for `/api/health` to report `buildWorker`
 * honestly when `FLOWSTARTER_BUILD_WORKER_URL` is configured.
 */

/**
 * A plain env-shaped record rather than `NodeJS.ProcessEnv`: Next.js
 * augments that global interface with a required `NODE_ENV`, which would
 * force every test fixture below to carry a field this module never reads.
 * `process.env` itself still satisfies this looser shape.
 */
type EnvLike = Record<string, string | undefined>;

/** Long enough for a same-host or same-network health check, short enough that a dead worker fails fast. */
export const DEFAULT_BUILD_WORKER_HEALTH_TIMEOUT_MS = 2_000;

function healthTimeoutMs(env: EnvLike): number {
  const configured = Number(
    env.FLOWSTARTER_BUILD_WORKER_HEALTH_TIMEOUT_MS?.trim()
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_BUILD_WORKER_HEALTH_TIMEOUT_MS;
}

/**
 * A bounded `GET /health` against the build worker. `handleRequest` in
 * apps/build-worker/src/http.ts answers `/health` before it ever checks
 * `Authorization`, so no shared secret is needed here. Anything other than a
 * clean 2xx inside the timeout — refused connection, DNS failure, a hang, a
 * 5xx — counts as "not answering", mirroring `probeMcpHealth` in
 * lib/discovery/generation-availability.ts (#142): never throws, an
 * unparsable URL or a network failure both just report `false`.
 */
export async function probeBuildWorkerHealth(
  workerUrl: string,
  env: EnvLike = process.env
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL('/health', workerUrl);
  } catch {
    return false;
  }
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(healthTimeoutMs(env)),
      cache: 'no-store',
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class DispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchError';
  }
}

/**
 * POSTs an existing job id to the build worker. Throws on any failure so the
 * caller can decide whether that is fatal — for a re-dispatch it is not: the
 * row is queued either way and a poller will still reach it.
 */
export async function dispatchAgentJob(jobId: string): Promise<void> {
  const endpoint = process.env.FLOWSTARTER_BUILD_WORKER_URL;
  const secret = process.env.FLOWSTARTER_BUILD_WORKER_SECRET;
  if (!endpoint || !secret) {
    throw new DispatchError('Flowstarter build worker is not configured');
  }
  if (secret.length < 32) {
    throw new DispatchError(
      'FLOWSTARTER_BUILD_WORKER_SECRET must be at least 32 characters'
    );
  }

  const url = new URL('/jobs/full-site', endpoint);
  if (
    url.protocol !== 'https:' &&
    url.hostname !== '127.0.0.1' &&
    url.hostname !== 'localhost'
  ) {
    throw new DispatchError('Flowstarter build worker must use HTTPS');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jobId }),
    signal: AbortSignal.timeout(8_000),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new DispatchError(
      `Flowstarter build worker rejected job with ${response.status}`
    );
  }
}
