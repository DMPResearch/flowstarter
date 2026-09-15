/**
 * Next.js's server-startup hook (https://nextjs.org/docs/app/guides/instrumentation) —
 * `register()` runs once when a Node.js server process starts, before it
 * serves its first request.
 *
 * Two things happen here today:
 *
 *   1. Log and enforce the rate-limit protection posture (security audit
 *      2026-09-13, Claude H2 — see `src/lib/security/protection-posture.ts`
 *      for the full rationale): name which tier (Arcjet, Upstash, both, or
 *      neither) is active, and refuse to start in `staging`/`production` on
 *      the process-local-only tier unless
 *      `FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT=1` says that is deliberate.
 *   2. Warm the sigma classifier (`src/lib/sigma/warm.ts`) so the first
 *      visitor through the funnel does not pay its cold ONNX-session cost.
 *      Unlike (1), a missing model warns rather than crashes — see that
 *      module's doc for why the two belong to different failure classes.
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
  const { warmSigmaOrWarn } = await import('@/lib/sigma/warm');

  logProtectionPosture();
  // Throws (crashing startup) rather than returning an error value: a
  // misconfigured production boot should fail loudly and immediately, the
  // same way apps/build-worker/src/isolation.ts refuses to start in native
  // mode outside development — never something a caller could accidentally
  // ignore.
  assertRateLimitPostureOrThrow();

  // Never throws — see src/lib/sigma/warm.ts. Runs after the rate-limit
  // gate: no point paying the ONNX warm-up cost on a boot that is about to
  // be refused anyway.
  await warmSigmaOrWarn();
}
