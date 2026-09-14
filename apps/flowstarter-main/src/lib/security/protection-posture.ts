import 'server-only';

/**
 * Names which rate-limit/bot-shield tier this process is actually running
 * on, and refuses to boot in an environment that requires a distributed one
 * without either configuring it or explicitly opting out.
 *
 * Security audit 2026-09-13 (Claude H2): "Arcjet — the global rate limiter
 * and bot shield the middleware is built around — is not configured in
 * either running slot, and its failure mode is to allow the request... The
 * only warning is a `console.warn` at process start." Downstream of that,
 * `consumeRateLimit` (`src/lib/rate-limit.ts`) falls back to a per-process
 * `Map` when Upstash is absent, which it was in both slots. So the 20-req/min
 * global limit and every per-route limiter built on `consumeRateLimit` did
 * nothing shared across instances, in production, with only a log line
 * nobody was watching to say so.
 *
 * The fix has two rules:
 *   1. Name the active tier out loud at startup (`logProtectionPosture`,
 *      wired into `src/instrumentation.ts`), not just when something is
 *      already missing.
 *   2. In `staging`/`production`, refuse to start at all on the
 *      process-local-only tier unless `FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT=1`
 *      says that is a deliberate, single-instance deployment rather than an
 *      oversight (`assertRateLimitPostureOrThrow`).
 *
 * Fail-open per REQUEST when a configured Arcjet call itself errors stays
 * unchanged and is not this module's concern — that tradeoff is defensible
 * once the key's presence is guaranteed at boot, which is what this module
 * guarantees.
 */

export interface ProtectionEnv {
  ARCJET_KEY?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  FLOWSTARTER_ENV?: string;
  NODE_ENV?: string;
  FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT?: string;
}

export interface ProtectionPosture {
  arcjetConfigured: boolean;
  upstashConfigured: boolean;
  /** True when neither a shared bot/rate shield (Arcjet) nor a shared
   * rate-limit store (Upstash) is configured, so every limiter anywhere in
   * this app is one process's private memory, reset on every deploy and
   * invisible to every other instance. */
  processLocalOnly: boolean;
  /** Human-readable tier name for the startup log line, e.g. "arcjet+upstash",
   * "upstash", "arcjet", or "process-local". */
  tierLabel: string;
}

export function protectionPosture(env: ProtectionEnv): ProtectionPosture {
  const arcjetConfigured = !!env.ARCJET_KEY?.trim();
  const upstashConfigured = !!(
    env.UPSTASH_REDIS_REST_URL?.trim() && env.UPSTASH_REDIS_REST_TOKEN?.trim()
  );
  const processLocalOnly = !arcjetConfigured && !upstashConfigured;

  const parts: string[] = [];
  if (arcjetConfigured) parts.push('arcjet');
  if (upstashConfigured) parts.push('upstash');

  return {
    arcjetConfigured,
    upstashConfigured,
    processLocalOnly,
    tierLabel: parts.length > 0 ? parts.join('+') : 'process-local',
  };
}

/** Same "staging counts, bare NODE_ENV=production counts" rule
 * `src/lib/request-ip.ts`'s `defaultTrustedProxies` uses, so the two never
 * disagree about which environments this app treats as "live". */
function effectiveEnv(env: ProtectionEnv): string {
  return env.FLOWSTARTER_ENV ?? env.NODE_ENV ?? 'development';
}

export function requiresDistributedRateLimiting(env: ProtectionEnv): boolean {
  const e = effectiveEnv(env);
  return e === 'staging' || e === 'production';
}

/**
 * Boot-time gate. Throws — never `process.exit` itself, so the caller (only
 * ever `src/instrumentation.ts`) decides how the process actually ends —
 * when this environment requires a distributed limiter and none is
 * configured, unless explicitly overridden with
 * `FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT=1`.
 */
export function assertRateLimitPostureOrThrow(
  env: ProtectionEnv = process.env
): ProtectionPosture {
  const posture = protectionPosture(env);
  if (
    requiresDistributedRateLimiting(env) &&
    posture.processLocalOnly &&
    env.FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT !== '1'
  ) {
    throw new Error(
      `Refusing to start in ${effectiveEnv(env)}: no ARCJET_KEY and no ` +
        'UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN are configured, so ' +
        'every rate limiter in this process would be private, per-instance ' +
        'memory, reset on every deploy and invisible to every other instance ' +
        '(security audit 2026-09-13, H2/H4). Configure Arcjet and/or Upstash, ' +
        'or set FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT=1 to run anyway — only ' +
        'appropriate for a deliberate, single-instance deployment.'
    );
  }
  return posture;
}

/** Logs the active tier once at startup. Never throws. */
export function logProtectionPosture(
  env: ProtectionEnv = process.env,
  log: (message: string) => void = console.log
): ProtectionPosture {
  const posture = protectionPosture(env);
  log(
    `[protection-posture] active rate-limit tier: ${posture.tierLabel}` +
      (posture.processLocalOnly ? ' (single-process memory only)' : '')
  );
  return posture;
}
