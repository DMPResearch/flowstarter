/**
 * Next.js's server-startup hook (https://nextjs.org/docs/app/guides/instrumentation) —
 * `register()` runs once when a Node.js server process starts, before it
 * serves its first request.
 *
 * Today this only logs and enforces the rate-limit protection posture
 * (security audit 2026-09-13, Claude H2 — see
 * `src/lib/security/protection-posture.ts` for the full rationale): name
 * which tier (Arcjet, Upstash, both, or neither) is active, and refuse to
 * start in `staging`/`production` on the process-local-only tier unless
 * `FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT=1` says that is deliberate.
 *
 * Guarded to the Node.js runtime only (`NEXT_RUNTIME === 'nodejs'`): Next
 * also calls `register()` once for the Edge runtime, and this check reads
 * plain `process.env` and throws on failure, neither of which is
 * Edge-appropriate. `middleware.ts` runs on the Edge runtime and is
 * unaffected by this file either way.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { assertRateLimitPostureOrThrow, logProtectionPosture } = await import(
    '@/lib/security/protection-posture'
  );

  logProtectionPosture();
  // Throws (crashing startup) rather than returning an error value: a
  // misconfigured production boot should fail loudly and immediately, the
  // same way apps/build-worker/src/isolation.ts refuses to start in native
  // mode outside development — never something a caller could accidentally
  // ignore.
  assertRateLimitPostureOrThrow();
}
