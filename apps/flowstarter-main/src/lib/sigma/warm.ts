import 'server-only';

/**
 * Startup warm-up for the sigma classifier (`@flowstarter/sigma-flowstarter`,
 * PR #160), wired into `src/instrumentation.ts`.
 *
 * `warmSigma()` (`packages/sigma-flowstarter/src/gate.ts`) pays the cold ONNX
 * session cost — loading the local encoder and the committed centroids —
 * once, off the request path. It throws on purpose when the model cache is
 * missing, because the package's own design note says a process that could
 * only ever fail open should fail loudly rather than silently degrade.
 *
 * That note is right for the classifier's own request-time behaviour, but
 * wrong for THIS process's boot: `packages/sigma-flowstarter/src/gate.ts`
 * already fails every classification open to human review when the model
 * cannot warm (see its module doc — "no path that returns `allow` without a
 * confident `clean`"), so a missing model degrades the product, it does not
 * corrupt it. Crashing server startup over it would take down the entire
 * app — discovery funnel, dashboard, billing, everything — over a slot image
 * that forgot to bake the model in, the exact failure this module exists to
 * make visible instead of fatal. `assertRateLimitPostureOrThrow` in
 * `protection-posture.ts` crashes boot for its own reason (silent
 * process-local rate limiting is a security hole); this module logs a clear
 * warning and reports it on `/api/health` instead.
 *
 * State is process-wide, matching the encoder's own singleton pattern
 * (`getEncoder()` in `packages/sigma-core/src/encoder.ts`): the warm-up cost
 * is paid once per process, and `/api/health` needs to read the outcome
 * without re-running it on every request. Stored on `globalThis`, not a
 * plain module-level `let`: `src/instrumentation.ts` and
 * `src/app/api/health/route.ts` both import this file, but Turbopack
 * builds each entry point (a route, the instrumentation hook) as its own
 * separate chunk graph, and this file gets bundled into BOTH — verified
 * 2026-09-15 that warm-up genuinely succeeded (`docker logs` showed
 * "[sigma] warm: model ready") while `/api/health` kept reporting
 * `"missing"` forever after, because `register()`'s copy of this module's
 * `health` variable and `route.ts`'s copy were two independent closures in
 * two independent bundles, sharing nothing despite running in the same
 * process. `globalThis` is the one thing genuinely shared across every
 * module scope in a JS realm regardless of how a bundler split the code
 * that reaches it.
 *
 * Logs via `process.stdout`/`stderr.write`, not `console.log`/`.warn`:
 * `next.config.mjs` sets `compiler.removeConsole` in production, which
 * strips every `console.*` CALL EXPRESSION from the compiled output —
 * verified 2026-09-15 that a `console.log`/`console.warn` here never made
 * it into `docker logs` at all, silently, the one failure mode this module
 * exists to make loud. `src/lib/security/protection-posture.ts` avoids the
 * same trap by capturing `console.log` as a function VALUE in a default
 * parameter (the strip only pattern-matches literal call syntax); this
 * sidesteps it more directly.
 */

export type SigmaHealth = 'ready' | 'missing';

const GLOBAL_KEY = Symbol.for('flowstarter.sigma.health');

type GlobalWithSigmaHealth = typeof globalThis & { [GLOBAL_KEY]?: SigmaHealth };

function getGlobal(): GlobalWithSigmaHealth {
  return globalThis as GlobalWithSigmaHealth;
}

/** What `/api/health` reports under `sigma`. `'missing'` until warm-up succeeds. */
export function getSigmaHealth(): SigmaHealth {
  return getGlobal()[GLOBAL_KEY] ?? 'missing';
}

function setSigmaHealth(next: SigmaHealth): void {
  getGlobal()[GLOBAL_KEY] = next;
}

/** Tests only. Defaults to 'missing' — the pre-warm-up state. */
export function resetSigmaHealthForTests(next: SigmaHealth = 'missing'): void {
  setSigmaHealth(next);
}

/**
 * Call once from `register()`. Never throws: a missing model cache or a
 * broken ONNX runtime binary logs a warning naming the fix
 * (`deploy/hetzner-staging/README.md`, "Shipping the sigma model") and
 * leaves `getSigmaHealth()` at `'missing'`, rather than crashing the whole
 * app's boot.
 */
export async function warmSigmaOrWarn(): Promise<void> {
  try {
    const { warmSigma } = await import('@flowstarter/sigma-flowstarter');
    await warmSigma();
    setSigmaHealth('ready');
    process.stdout.write('[sigma] warm: model ready\n');
  } catch (error) {
    setSigmaHealth('missing');
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[sigma] model did not warm up — every acceptable-use/scope check will fail open to ` +
        `human review until this is fixed. See deploy/hetzner-staging/README.md, "Shipping ` +
        `the sigma model". ${message}\n`
    );
  }
}
