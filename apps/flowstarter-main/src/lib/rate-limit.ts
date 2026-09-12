/**
 * In-memory sliding window rate limiter with automatic cleanup.
 *
 * Suitable for single-instance deployments (Vercel serverless, single-node).
 * For multi-instance, swap this with Upstash Redis (@upstash/ratelimit).
 *
 * Features:
 * - Sliding window prevents burst abuse at window boundaries
 * - Automatic stale entry cleanup on a configurable interval
 * - Bounded memory: entries expire and are pruned
 * - Configurable per-instance (separate limiters for different routes)
 */

interface RateLimitEntry {
  /** Timestamps of requests within the current window */
  timestamps: number[];
}

export interface RateLimitConfig {
  /** Maximum requests allowed within the window */
  limit: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** How often to prune stale entries (defaults to 2x windowMs) */
  cleanupIntervalMs?: number;
}

export interface RateLimitResult {
  limited: boolean;
  remaining: number;
  resetAt: number;
}

export class SlidingWindowRateLimiter {
  private entries = new Map<string, RateLimitEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(config: RateLimitConfig) {
    this.limit = config.limit;
    this.windowMs = config.windowMs;

    const cleanupInterval = config.cleanupIntervalMs ?? config.windowMs * 2;
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupInterval);
    // Allow the timer to not block process exit
    if (
      this.cleanupTimer &&
      typeof this.cleanupTimer === 'object' &&
      'unref' in this.cleanupTimer
    ) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Check and record a request. Returns whether the request is rate-limited.
   */
  check(key: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let entry = this.entries.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.entries.set(key, entry);
    }

    // Remove timestamps outside the current window
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    // Check limit before recording
    if (entry.timestamps.length >= this.limit) {
      const oldestInWindow = entry.timestamps[0] ?? now;
      return {
        limited: true,
        remaining: 0,
        resetAt: oldestInWindow + this.windowMs,
      };
    }

    // Record this request
    entry.timestamps.push(now);
    return {
      limited: false,
      remaining: this.limit - entry.timestamps.length,
      resetAt: now + this.windowMs,
    };
  }

  /**
   * Remove entries with no timestamps in the current window.
   * Called automatically on the cleanup interval.
   */
  cleanup(): void {
    const windowStart = Date.now() - this.windowMs;
    this.entries.forEach((entry, key) => {
      entry.timestamps = entry.timestamps.filter(
        (ts: number) => ts > windowStart
      );
      if (entry.timestamps.length === 0) {
        this.entries.delete(key);
      }
    });
  }

  /** Number of tracked keys (for monitoring) */
  get size(): number {
    return this.entries.size;
  }

  /** Stop the cleanup timer (for testing / shutdown) */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.entries.clear();
  }
}

// ── Pre-configured instances ────────────────────────────────────────────────

/** Rate limiter for public lead capture: 10 requests per minute per IP */
export const leadCaptureRateLimiter = new SlidingWindowRateLimiter({
  limit: 10,
  windowMs: 60_000,
});

/** Rate limiter for public contact form: 5 requests per minute per IP */
export const contactRateLimiter = new SlidingWindowRateLimiter({
  limit: 5,
  windowMs: 60_000,
});

/**
 * MVP readiness review, "Security": `/api/discovery/preview/live` — a real
 * Pi generation run, `maxDuration = 300` — had no rate limit at all. A
 * genuine visitor calls this once per completed intake, so this stays
 * deliberately tight; env-overridable rather than a bare literal in the
 * route, same as the funnel spend cap's `DISCOVERY_FUNNEL_BUDGET_EUR`.
 */
function discoveryPreviewLiveLimit(): number {
  const raw = Number(process.env.DISCOVERY_PREVIEW_LIVE_RATE_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/** Rate limiter for `POST /api/discovery/preview/live`: 5 per minute per IP
 * by default (see {@link discoveryPreviewLiveLimit}). */
export const discoveryPreviewLiveRateLimiter = new SlidingWindowRateLimiter({
  limit: discoveryPreviewLiveLimit(),
  windowMs: 60_000,
});

// ── Shared, when there is somewhere to share it ─────────────────────────────

/**
 * A fixed-window counter that survives more than one process when Upstash is
 * configured, and falls back to the in-memory limiter when it is not.
 *
 * The limiter above is honest about what it is: one process's view. That is
 * enough in development and enough on a single node, and it is not enough for
 * the public lead capture endpoint on a platform running more than one
 * instance, where "ten a minute" is ten a minute times however many instances
 * happen to be up.
 *
 * So when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are both set
 * the count lives in Redis instead, over the REST API - no client library and
 * no connection to keep open in a serverless handler. `INCR` the key, and set
 * the expiry only if it has none, pipelined into one request.
 *
 * FAILING OPEN IS DELIBERATE. An unreachable Redis allows the request. A rate
 * limiter that turns an outage of itself into an outage of every client's
 * contact form has picked the wrong thing to protect.
 */
export interface SharedRateLimitConfig {
  limit: number;
  windowMs: number;
}

export interface UpstashCredentials {
  url: string;
  token: string;
}

export function upstashCredentials(
  env: Record<string, string | undefined> = process.env
): UpstashCredentials | null {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

/**
 * One limiter per (limit, window) pair rather than one per key: the limiter
 * itself holds a map of keys, and a fresh instance per call would have no
 * memory of the request before it.
 */
const fallbackLimiters = new Map<string, SlidingWindowRateLimiter>();

function fallbackLimiter(
  config: SharedRateLimitConfig
): SlidingWindowRateLimiter {
  const id = `${config.limit}:${config.windowMs}`;
  let limiter = fallbackLimiters.get(id);
  if (!limiter) {
    limiter = new SlidingWindowRateLimiter(config);
    fallbackLimiters.set(id, limiter);
  }
  return limiter;
}

/** True when this key has already had its allowance for the window. */
export async function consumeRateLimit(
  key: string,
  config: SharedRateLimitConfig,
  credentials: UpstashCredentials | null = upstashCredentials()
): Promise<boolean> {
  if (!credentials) {
    return fallbackLimiter(config).check(key).limited;
  }

  const seconds = Math.max(1, Math.ceil(config.windowMs / 1000));
  try {
    const response = await fetch(
      `${credentials.url.replace(/\/+$/, '')}/pipeline`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([
          ['INCR', key],
          ['EXPIRE', key, String(seconds), 'NX'],
        ]),
      }
    );
    if (!response.ok) return false;
    const body = (await response.json()) as { result?: unknown }[];
    const count = Number(body?.[0]?.result ?? 0);
    return Number.isFinite(count) && count > config.limit;
  } catch {
    return false;
  }
}
