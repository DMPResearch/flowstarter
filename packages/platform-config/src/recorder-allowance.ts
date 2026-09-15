/**
 * The showcase recorder (Playwright, headless and headed Chrome) cannot get
 * past Arcjet's bot rule on staging.flowstarter.dev: no cookies, no prior
 * navigation, the exact fingerprint `detectBot` exists to catch. The existing
 * E2E bypass (`x-e2e-secret`, gated on `NODE_ENV !== 'production'` in
 * `middleware.ts` and `api-auth.ts`) does not help: the staging Next.js
 * build runs with `NODE_ENV=production` like any deployed build, and only
 * `FLOWSTARTER_ENV=staging` names it as not-production.
 *
 * This module decides one narrow question: does this request carry proof
 * it is the recorder? A header (`x-flowstarter-recorder`) equal to a secret
 * (`FLOWSTARTER_RECORDER_SECRET`), compared in constant time, absent from
 * `prod.env` so the rule is inert in production even before the second
 * check runs, and refused again whenever `flowstarterEnv === "production"`
 * regardless of what the header carries or what a misconfigured prod.env
 * might someday set. Two independent reasons production stays closed, not
 * one.
 *
 * A "yes" here does not skip the rest of Arcjet. `src/middleware.ts` in
 * flowstarter-main still runs shield and the sliding-window rate limit at
 * `LIVE`; only `detectBot` drops to `DRY_RUN` for that one request, so
 * Arcjet still records what it would have decided without ever turning it
 * into a 403. Rejecting an Arcjet-wide `DRY_RUN` on staging (the simpler
 * alternative) is deliberate: staging.flowstarter.dev is a public URL, and a
 * blanket dry-run would relax bot detection for every visitor, not just the
 * recorder.
 *
 * Pure and dependency-free, like `auth-transfer-policy.ts` next to it:
 * `readRecorderAllowanceEnvFromProcess()` is the only thing that reads
 * `process.env`, and tests pass their own record instead. The comparison
 * itself needs Web Crypto (`crypto.subtle`), available in both Node and the
 * Edge runtime middleware actually calls this from, which is why
 * `isRecorderRequestAllowed` is async even though the rest of this package
 * is sync.
 */

/** The header the recorder sends. Never logged with its value. */
export const RECORDER_HEADER_NAME = 'x-flowstarter-recorder';

/** Names the secret env var, so call sites and docs cannot spell it two ways. */
export const RECORDER_SECRET_ENV = 'FLOWSTARTER_RECORDER_SECRET';

/**
 * Everything the policy needs to know about the process it runs in. Passed
 * explicitly by tests; `readRecorderAllowanceEnvFromProcess()` fills it from
 * `process.env` otherwise.
 */
export interface RecorderAllowanceEnvInput {
  /** `FLOWSTARTER_ENV`. Only an exact `"production"` closes the gate. */
  readonly flowstarterEnv?: string;
  /** `FLOWSTARTER_RECORDER_SECRET`. Unset means the rule is inert. */
  readonly recorderSecret?: string;
}

/**
 * Reads the policy's inputs from the real environment. Kept to one function
 * so the rest of the module stays pure and testable without env stubbing.
 */
export function readRecorderAllowanceEnvFromProcess(
  source: Record<string, string | undefined> = typeof process !== 'undefined'
    ? process.env
    : {},
): RecorderAllowanceEnvInput {
  return {
    flowstarterEnv: source.FLOWSTARTER_ENV,
    recorderSecret: source[RECORDER_SECRET_ENV] || undefined,
  };
}

/**
 * Constant-time string equality over Web Crypto, so it runs in the Edge
 * middleware this is called from. Both sides are hashed to a fixed-length
 * digest first, so the comparison never branches on the raw input lengths —
 * a plain `a.length !== b.length` early return would leak the secret's
 * length through timing, which `timingSafeEqual` implementations elsewhere
 * in this repo (`node:crypto`) avoid by requiring equal-length buffers
 * up front instead. Hashing first gets the same property without a
 * length-mismatch throw to catch.
 */
async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const digest = async (value: string): Promise<Uint8Array> =>
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(value)),
    );
  const [digestA, digestB] = await Promise.all([digest(a), digest(b)]);

  let diff = digestA.length ^ digestB.length;
  const length = Math.max(digestA.length, digestB.length);
  for (let i = 0; i < length; i++) {
    diff |= (digestA[i] ?? 0) ^ (digestB[i] ?? 0);
  }
  return diff === 0;
}

/**
 * `true` only when every one of these holds:
 *   1. not production (`flowstarterEnv !== "production"`),
 *   2. a recorder secret is actually configured,
 *   3. the request carries the header, and
 *   4. it matches the secret, compared in constant time.
 *
 * The production check runs first and short-circuits before the header is
 * even read, so a stray `FLOWSTARTER_RECORDER_SECRET` in a production env
 * file can never be used — belt-and-braces alongside `prod.env` simply
 * never setting it in the first place.
 */
export async function isRecorderRequestAllowed(
  headerValue: string | null | undefined,
  env: RecorderAllowanceEnvInput = readRecorderAllowanceEnvFromProcess(),
): Promise<boolean> {
  if (env.flowstarterEnv === 'production') return false;
  if (!env.recorderSecret) return false;
  if (!headerValue) return false;
  return timingSafeStringEqual(headerValue, env.recorderSecret);
}
