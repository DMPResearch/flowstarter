import 'server-only';

/**
 * The one place that turns `X-Forwarded-For` into a client IP.
 *
 * Security audit 2026-09-13 (Claude, H3; Codex, similar) — every per-IP rate
 * limit in the product used to read `x-forwarded-for.split(',')[0]`, the
 * LEFTMOST entry. Caddy's `reverse_proxy` APPENDS the peer address it saw to
 * any `X-Forwarded-For` the client already sent, rather than replacing it, so
 * a request carrying `X-Forwarded-For: 1.2.3.4` arrives here as
 * `1.2.3.4, <real address>` — the leftmost entry is whatever the client
 * typed, and every "per-IP" limiter in the app was actually a
 * per-attacker-chosen-header limiter.
 *
 * The fix is the standard "trusted proxy" walk (the same algorithm Express's
 * `trust proxy` and the `proxy-addr` package use), not a raw-socket read:
 * Next.js route handlers here run on the Node runtime behind a reverse
 * proxy, and `NextRequest` has no cross-runtime way to read the underlying
 * TCP peer. Instead, walk `X-Forwarded-For` from the RIGHT. Each entry from
 * the right is trusted exactly as far as the proxy that appended it is
 * trusted to have appended its own real peer's address rather than passing a
 * client-supplied value through unchanged. The first entry (from the right)
 * whose value does NOT fall inside a configured trusted-proxy CIDR is the
 * client address — everything to its right was appended by proxies we trust
 * to tell the truth about who connected to them; everything to its left is
 * unverified and never inspected, because we stop there.
 *
 * Trusted ranges come from `FLOWSTARTER_TRUSTED_PROXIES` (comma-separated
 * CIDRs, plus the two named groups below), never a literal in a call site:
 *   - `loopback`    → 127.0.0.1/32, ::1/128 — the on-box Caddy that
 *                     reverse-proxies to this app over the loopback
 *                     interface in every environment that runs behind one.
 *   - `cloudflare`  → Cloudflare's published edge ranges (see
 *                     `CLOUDFLARE_IPV4_RANGES`/`CLOUDFLARE_IPV6_RANGES`
 *                     below). Add this token once a hostname's Cloudflare
 *                     DNS record is switched to proxied (orange-clouded);
 *                     until then Cloudflare is not in the request path and
 *                     trusting its ranges would trust nothing real.
 * With no env override, {@link defaultTrustedProxies} supplies
 * `loopback` for every environment that runs behind Caddy (`staging`,
 * `production`) and nothing for `development`/`test`, where there is
 * ordinarily no reverse proxy in front of `next dev` at all.
 */

export interface ClientIpEnv {
  FLOWSTARTER_TRUSTED_PROXIES?: string;
  FLOWSTARTER_ENV?: string;
  NODE_ENV?: string;
}

/**
 * Cloudflare's published edge IP ranges
 * (https://www.cloudflare.com/ips-v4, https://www.cloudflare.com/ips-v6),
 * recorded 2026-09-13. These change rarely; re-check the published lists
 * periodically rather than trusting this comment forever.
 */
export const CLOUDFLARE_IPV4_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

export const CLOUDFLARE_IPV6_RANGES: readonly string[] = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

const LOOPBACK_RANGES: readonly string[] = [
  '127.0.0.1/32',
  '::1/128',
  // Node's dual-stack socket layer sometimes reports an IPv4 loopback
  // connection as its IPv4-mapped IPv6 form; recognise the whole mapped
  // 127.0.0.0/8 the same way as the bare IPv4 form above.
  '::ffff:127.0.0.0/104',
];

const NAMED_PROXY_GROUPS: Record<string, readonly string[]> = {
  loopback: LOOPBACK_RANGES,
  cloudflare: [...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES],
};

/**
 * `FLOWSTARTER_TRUSTED_PROXIES`'s documented default per environment. Named
 * per {@link ClientIpEnv.FLOWSTARTER_ENV}, falling back to
 * {@link ClientIpEnv.NODE_ENV} the same way the rest of the app tells
 * "staging" apart from a bare `NODE_ENV=production` (see `src/env.ts`).
 *
 * `staging` and `production` both default to `loopback` — Caddy reverse-
 * proxies to this app from the same box in both. Cloudflare is deliberately
 * NOT in the default: today's DNS records are not proxied (see
 * docs/security/audit-2026-09-13-claude.md, H1/the infra notes on the
 * Cloudflare zone), so trusting Cloudflare's ranges by default would trust a
 * hop that is not actually in the request path. Add `cloudflare` to the env
 * var explicitly once a hostname's record is switched to proxied.
 */
export function defaultTrustedProxies(env: ClientIpEnv): readonly string[] {
  const flowstarterEnv = env.FLOWSTARTER_ENV ?? env.NODE_ENV;
  if (flowstarterEnv === 'staging' || flowstarterEnv === 'production') {
    return NAMED_PROXY_GROUPS.loopback;
  }
  // development, test, and anything unrecognised: no reverse proxy is
  // assumed to be in front, so nothing is trusted and X-Forwarded-For is
  // never honoured — the "rightmost untrusted hop" walk below degrades to
  // "the whole header is untrusted", which is the safe default.
  return [];
}

function resolveTrustedProxies(env: ClientIpEnv): readonly string[] {
  const raw = env.FLOWSTARTER_TRUSTED_PROXIES?.trim();
  if (!raw) return defaultTrustedProxies(env);

  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const ranges: string[] = [];
  for (const token of tokens) {
    const named = NAMED_PROXY_GROUPS[token.toLowerCase()];
    if (named) {
      ranges.push(...named);
    } else {
      ranges.push(token);
    }
  }
  return ranges;
}

// ── Minimal, dependency-free CIDR matching ──────────────────────────────
//
// Deliberately not pulling in a CIDR package: the app's `ip-address` entry
// in the workspace root package.json is a transitive-version override, not
// a declared dependency of this app, and pnpm's strict node_modules would
// make importing it a phantom-dependency footgun. IPv4 containment is a
// handful of lines over a 32-bit integer; IPv6 is the same idea over a
// 128-bit BigInt. Both are covered by the test file next to this module.

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

/** Expands `::` and returns the eight 16-bit groups as a BigInt, or null. */
function ipv6ToBigInt(ip: string): bigint | null {
  // Strip a zone id (`fe80::1%eth0`) and brackets (`[::1]`), neither of
  // which participates in address comparison.
  let addr = ip.replace(/^\[|\]$/g, '').split('%')[0];

  // IPv4-mapped IPv6 (`::ffff:1.2.3.4`): rewrite the trailing dotted-quad
  // into two hex groups so the rest of this function only ever sees
  // colon-separated hex.
  const v4Tail = addr.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Tail) {
    const v4Int = ipv4ToInt(v4Tail[2]);
    if (v4Int === null) return null;
    const hi = (v4Int >>> 16).toString(16);
    const lo = (v4Int & 0xffff).toString(16);
    addr = `${v4Tail[1]}${hi}:${lo}`;
  }

  if (!addr.includes(':')) return null;
  const doubleColonCount = (addr.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;

  let head: string[];
  let tail: string[];
  if (addr.includes('::')) {
    const [left, right] = addr.split('::');
    head = left ? left.split(':') : [];
    tail = right ? right.split(':') : [];
  } else {
    head = addr.split(':');
    tail = [];
  }

  const missing = 8 - (head.length + tail.length);
  if (missing < 0) return null;
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  if (groups.length !== 8) return null;

  let value = BigInt(0);
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << BigInt(16)) | BigInt(parseInt(g, 16));
  }
  return value;
}

function ipv6InCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  const bits = bitsStr === undefined ? 128 : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false;
  const ipValue = ipv6ToBigInt(ip);
  const rangeValue = ipv6ToBigInt(range);
  if (ipValue === null || rangeValue === null) return false;
  if (bits === 0) return true;
  const one = BigInt(1);
  const allOnes = (one << BigInt(128)) - one;
  const hostBits = (one << BigInt(128 - bits)) - one;
  const mask = allOnes ^ hostBits;
  return (ipValue & mask) === (rangeValue & mask);
}

/** Strips a trailing `:port` from a bare IPv4 entry (`1.2.3.4:5678`), which
 * is not part of the HTTP spec for this header but shows up from some
 * proxies in practice. Left untouched for anything that is not a plain
 * IPv4-with-port shape, including every IPv6 form. */
function stripIpv4Port(entry: string): string {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(entry)
    ? entry.slice(0, entry.lastIndexOf(':'))
    : entry;
}

function isInTrustedRanges(ip: string, ranges: readonly string[]): boolean {
  const candidate = stripIpv4Port(ip);
  return ranges.some((cidr) =>
    cidr.includes(':') ? ipv6InCidr(candidate, cidr) : ipv4InCidr(candidate, cidr)
  );
}

/**
 * A caller reached this route with neither `X-Forwarded-For` nor
 * `X-Real-Ip` set at all. Behind Caddy in `staging`/`production` this
 * should not happen; in `development`/`test` it is the normal case (no
 * reverse proxy in front of `next dev`). Named and exported so a caller can
 * special-case it (e.g. skip DB-column storage) rather than treating it as
 * a real address — and, unlike the `'unknown'` string this replaces, every
 * caller and every test can see it is the no-header case by name instead of
 * a string that reads like a real (if odd) client value.
 */
export const NO_FORWARDED_HEADER = 'no-forwarded-header';

export interface HeaderSource {
  get(name: string): string | null;
}

/**
 * The corrected client IP for a request: the rightmost entry of
 * `X-Forwarded-For` that is NOT inside a trusted-proxy range, never the
 * leftmost. See the module doc comment for the full algorithm and why a
 * CIDR walk replaces a raw-socket read here.
 */
export function clientIp(
  headers: HeaderSource,
  env: ClientIpEnv = process.env
): string {
  const trusted = resolveTrustedProxies(env);
  const forwardedFor = headers.get('x-forwarded-for');

  if (forwardedFor) {
    const hops = forwardedFor
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    if (hops.length > 0) {
      for (let i = hops.length - 1; i >= 0; i--) {
        if (!isInTrustedRanges(hops[i], trusted)) {
          return hops[i];
        }
      }
      // Every hop matched a trusted range (the chain is entirely proxies we
      // trust to tell the truth) — fall back to the leftmost, same as
      // `proxy-addr`'s behaviour in this edge case, rather than inventing a
      // sentinel for a chain that was otherwise fully trusted.
      return hops[0];
    }
  }

  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;

  return NO_FORWARDED_HEADER;
}
