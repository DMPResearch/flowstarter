/**
 * Every number the network boundary is enforced with, in one place.
 *
 * Two boundaries, one file, because they are the same decision seen from
 * either side: how many bytes, how long, how many at once, and which
 * destinations are legitimate. Outbound is `safe-fetch.ts` requesting a
 * stranger's URL; ingress is a route reading a stranger's body.
 *
 * Nothing here reads `process.env` at module scope. A value captured at import
 * time cannot be exercised by a test and cannot be changed by an operator
 * restarting the process, which is the same argument `portrait-config.ts` and
 * `ops/alerts.ts` make, and this file follows their shape on purpose: a named
 * env var, a documented default behind it, and a pure function that reads the
 * environment it is handed.
 *
 * THE DEFAULTS ARE THE PRODUCTION POLICY. An empty environment gives https
 * only, port 443 only, public addresses only, no fixture escape hatch. Every
 * knob below can loosen that, and the two that loosen it dangerously — plain
 * http, and private fixture origins — are refused outright when `NODE_ENV` is
 * `production`, so a variable that leaks from a developer's shell into a
 * deployment cannot open a hole in it.
 */

/**
 * Deliberately not `NodeJS.ProcessEnv`: Next augments that type with a
 * required `NODE_ENV`, which every fixture in every test would then have to
 * carry for no reason. Same choice `portrait-config.ts` made.
 */
export type EnvLike = Record<string, string | undefined>;

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * A positive integer from the environment, or the default.
 *
 * A misconfigured value is the default rather than a crash: an operator who
 * types `FLOWSTARTER_FETCH_TIMEOUT_MS=fast` should get a working funnel with a
 * working budget, not a process that will not boot.
 */
export function positiveIntFromEnv(
  raw: string | undefined,
  fallback: number
): number {
  const parsed = Number.parseInt(trimmed(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function flagFromEnv(raw: string | undefined): boolean {
  return trimmed(raw).toLowerCase() === 'true';
}

function isProduction(env: EnvLike): boolean {
  return trimmed(env.NODE_ENV) === 'production';
}

function listFromEnv(raw: string | undefined): string[] {
  return trimmed(raw)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/** The only port a public https endpoint answers on unless told otherwise. */
export const DEFAULT_ALLOWED_PORT = 443;
export const ALLOWED_PORTS_ENV_VAR = 'FLOWSTARTER_FETCH_ALLOWED_PORTS';

/** Hops. Three is enough for a CDN; four is a redirect chain with a purpose. */
export const DEFAULT_MAX_REDIRECTS = 3;
export const MAX_REDIRECTS_ENV_VAR = 'FLOWSTARTER_FETCH_MAX_REDIRECTS';

/**
 * The whole request, headers through the last byte of the body. A visitor is
 * sitting in front of the wizard waiting for a preview, and an endpoint that
 * is slow to answer an anonymous request is one that is about to refuse it.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 4_000;
export const FETCH_TIMEOUT_ENV_VAR = 'FLOWSTARTER_FETCH_TIMEOUT_MS';

/** The ceiling on any single outbound body, whatever a caller asks for. */
export const DEFAULT_MAX_FETCH_BYTES = 6 * 1024 * 1024;
export const MAX_FETCH_BYTES_ENV_VAR = 'FLOWSTARTER_FETCH_MAX_BYTES';

/** Plain http, for a fixture server on a developer's own machine. */
export const ALLOW_INSECURE_ENV_VAR = 'FLOWSTARTER_FETCH_ALLOW_INSECURE';

/**
 * `address:port` origins permitted despite the public-address rule, so a test
 * or a developer can point the adapter at a loopback fixture without the
 * production rule being weakened for anything else.
 *
 * Keyed on the RESOLVED ADDRESS, never on the hostname. A hostname allow list
 * would be the bug this module exists to fix, one indirection later: the
 * fixture's name would be trusted and whatever it resolved to would be
 * connected to.
 */
export const FIXTURE_ORIGINS_ENV_VAR = 'FLOWSTARTER_FETCH_FIXTURE_ORIGINS';

/** The content types an image fetch will accept a body from. */
export const DEFAULT_IMAGE_CONTENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
];
export const IMAGE_CONTENT_TYPES_ENV_VAR =
  'FLOWSTARTER_FETCH_IMAGE_CONTENT_TYPES';

export interface OutboundConfig {
  /** Ports we will connect to. Always includes every fixture origin's port. */
  allowedPorts: ReadonlySet<number>;
  maxRedirects: number;
  /** Headers through body, one budget, not one per phase. */
  timeoutMs: number;
  maxBytes: number;
  /** True only outside production, and only when asked for. */
  allowInsecure: boolean;
  /** `address:port`, empty in production. */
  fixtureOrigins: ReadonlySet<string>;
  imageContentTypes: ReadonlySet<string>;
}

/** The outbound policy, read from the environment. */
export function outboundConfig(env: EnvLike = process.env): OutboundConfig {
  const production = isProduction(env);
  const fixtureOrigins = new Set(
    production ? [] : listFromEnv(env[FIXTURE_ORIGINS_ENV_VAR])
  );

  const ports = new Set<number>([DEFAULT_ALLOWED_PORT]);
  for (const entry of listFromEnv(env[ALLOWED_PORTS_ENV_VAR])) {
    const port = Number.parseInt(entry, 10);
    if (Number.isFinite(port) && port > 0 && port <= 65535) ports.add(port);
  }
  // A fixture origin names its own port; requiring it in two variables is a
  // way to get a fixture that fails for a reason nobody can see.
  for (const origin of Array.from(fixtureOrigins)) {
    const port = Number.parseInt(origin.slice(origin.lastIndexOf(':') + 1), 10);
    if (Number.isFinite(port) && port > 0 && port <= 65535) ports.add(port);
  }

  const configured = listFromEnv(env[IMAGE_CONTENT_TYPES_ENV_VAR]);

  return {
    allowedPorts: ports,
    maxRedirects: positiveIntFromEnv(
      env[MAX_REDIRECTS_ENV_VAR],
      DEFAULT_MAX_REDIRECTS
    ),
    timeoutMs: positiveIntFromEnv(
      env[FETCH_TIMEOUT_ENV_VAR],
      DEFAULT_FETCH_TIMEOUT_MS
    ),
    maxBytes: positiveIntFromEnv(
      env[MAX_FETCH_BYTES_ENV_VAR],
      DEFAULT_MAX_FETCH_BYTES
    ),
    allowInsecure: !production && flagFromEnv(env[ALLOW_INSECURE_ENV_VAR]),
    fixtureOrigins,
    imageContentTypes: new Set(
      configured.length > 0 ? configured : DEFAULT_IMAGE_CONTENT_TYPES
    ),
  };
}

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

/**
 * The largest anonymous body we will read, whatever its `Content-Length` says
 * and whether or not it has one. A logo or a headshot fits in two megabytes;
 * the authenticated uploader asks for its own, larger number.
 */
export const DEFAULT_MAX_ANON_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_ANON_BODY_BYTES_ENV_VAR = 'FLOWSTARTER_MAX_ANON_BODY_BYTES';

/** The largest JSON body any public route will read. Prose, not files. */
export const DEFAULT_MAX_JSON_BODY_BYTES = 256 * 1024;
export const MAX_JSON_BODY_BYTES_ENV_VAR = 'FLOWSTARTER_MAX_JSON_BODY_BYTES';

/**
 * The pixel ceiling a picture has to clear BEFORE it is decoded, read from the
 * file's header rather than from the decoder.
 *
 * This is the number that makes a decompression bomb boring. A PNG whose IHDR
 * says 40000x40000 is a few kilobytes on the wire and six gigabytes of RGBA in
 * memory, so every byte-length cap in the product passes it and the process
 * dies at the decode. 40 megapixels is a 50 megapixel phone camera's worth of
 * headroom over anything a logo or a headshot needs.
 */
export const DEFAULT_MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGE_PIXELS_ENV_VAR = 'FLOWSTARTER_MAX_IMAGE_PIXELS';

/**
 * How many pictures may be decoding at once across the process.
 *
 * A decode is the most expensive thing an anonymous request can ask this
 * server to do, and the cost is memory, which is the resource that takes the
 * whole process down rather than one request. Four is a small machine's worth
 * of concurrent work; the queue behind it is what turns an amplification
 * attempt into a slow queue instead of an out-of-memory.
 */
export const DEFAULT_IMAGE_DECODE_CONCURRENCY = 4;
export const IMAGE_DECODE_CONCURRENCY_ENV_VAR =
  'FLOWSTARTER_IMAGE_DECODE_CONCURRENCY';

export interface IngressConfig {
  maxAnonBodyBytes: number;
  maxJsonBodyBytes: number;
  maxImagePixels: number;
  imageDecodeConcurrency: number;
}

/** The ingress policy, read from the environment. */
export function ingressConfig(env: EnvLike = process.env): IngressConfig {
  return {
    maxAnonBodyBytes: positiveIntFromEnv(
      env[MAX_ANON_BODY_BYTES_ENV_VAR],
      DEFAULT_MAX_ANON_BODY_BYTES
    ),
    maxJsonBodyBytes: positiveIntFromEnv(
      env[MAX_JSON_BODY_BYTES_ENV_VAR],
      DEFAULT_MAX_JSON_BODY_BYTES
    ),
    maxImagePixels: positiveIntFromEnv(
      env[MAX_IMAGE_PIXELS_ENV_VAR],
      DEFAULT_MAX_IMAGE_PIXELS
    ),
    imageDecodeConcurrency: positiveIntFromEnv(
      env[IMAGE_DECODE_CONCURRENCY_ENV_VAR],
      DEFAULT_IMAGE_DECODE_CONCURRENCY
    ),
  };
}
