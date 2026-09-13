import 'server-only';

/**
 * The one place this product makes an outbound request to a URL a stranger
 * supplied.
 *
 * The funnel is built on strings visitors type into an intake box: an
 * Instagram link, a LinkedIn link, their own website. We read those pages, and
 * then we read the pictures those pages point at, which are strings a third
 * party put in a meta tag. Every one of those is a server-side request forgery
 * primitive unless something stands between the string and the socket. This
 * module is that something, and it is the only thing in the product allowed to
 * be it.
 *
 * WHAT WAS WRONG BEFORE, because the fix only makes sense against it. Three
 * files each had their own version of "is this safe to fetch", and all three
 * checked the hostname TEXT against a regex of private ranges. That stops an
 * attacker who types `http://127.0.0.1`, who is not the attacker. It does not
 * stop `images.attacker.test` with an A record of 169.254.169.254, it does not
 * stop a public first hop redirecting to one, and two of the three then said
 * `redirect: 'follow'` and let the runtime chase the redirect without ever
 * looking at hop two. A hostname is a claim. An address is where the packet
 * goes. This module judges the address.
 *
 * THE RULES, each of which is one line of code and one class of attack:
 *
 *   SCHEME       https, and nothing else. http is available only outside
 *                production and only for a declared fixture origin, because a
 *                developer's test server is not a reason to make cleartext
 *                requests to the internet in production.
 *   PORT         443 unless configured. An attacker who cannot choose the port
 *                cannot reach the interesting things, which listen on 6379,
 *                5432, 8080 and 2375.
 *   CREDENTIALS  Never in the authority. `https://user:pass@host` is a way to
 *                make a URL read as one host and resolve as another.
 *   ADDRESS      Every address the hostname resolves to is checked, not the
 *                first one. A name that answers with one public address and
 *                one private address is refused outright: taking the public
 *                one would make the outcome depend on resolver ordering, which
 *                is a coin flip an attacker gets to keep tossing.
 *   PINNING      The connection is opened to the exact address that was
 *                validated, by handing the request its own `lookup`. This is
 *                the part that closes DNS rebinding: a name that resolved
 *                public a moment ago and private now cannot swap the
 *                destination between our check and our connect, because there
 *                is no second resolution in between.
 *   REDIRECTS    Followed by hand, re-validated in full at every hop,
 *                including a fresh resolution, up to a configured limit.
 *   DEADLINE     One budget for the whole request, headers THROUGH the last
 *                byte of body. A timeout cleared when the headers arrive is
 *                not a deadline; it is an invitation to dribble a body for an
 *                hour and hold a route handler open.
 *   SIZE         The body is read as it streams and abandoned the moment it
 *                passes the cap. `arrayBuffer()` allocates the whole thing
 *                first and checks afterwards, which is a cap that has already
 *                been exceeded by the time it is enforced.
 *   TYPE         An image fetch accepts an image content type and nothing
 *                else, so a public page cannot point us at a 400 MB log file.
 *   CREDENTIALS  No cookie header goes out, no cookie comes back into anything,
 *   (OURS)       no `Authorization`, no ambient session. These requests are
 *                anonymous in both directions.
 *
 * It never throws. Every failure is one of four reasons, and the callers all
 * turn those into the same "no profile available" fallback they had before,
 * which is the behaviour this change is not allowed to alter.
 */
import type { ClientRequest } from 'node:http';
import type { LookupFunction } from 'node:net';

import { isIpLiteral, isPublicAddress } from './ip-rules';
import { outboundConfig, type OutboundConfig } from './net-config';

/**
 * Why a request produced no bytes. The same vocabulary
 * `ProfileUnavailableReason` uses for these four cases, deliberately, so a
 * profile reading can hand it straight through without a translation table
 * that could disagree with itself.
 */
export type PublicFetchFailure =
  | 'blocked'
  | 'timeout'
  | 'network_error'
  | 'too_large';

export type PublicFetchOutcome =
  | {
      status: 'ok';
      /** The URL that finally answered, after every hop was re-checked. */
      url: string;
      httpStatus: number;
      headers: Headers;
      /** Never longer than `maxBytes`. */
      bytes: Buffer;
    }
  | { status: 'failed'; reason: PublicFetchFailure };

/**
 * The shape of `fetch` the callers may inject.
 *
 * A test seam and nothing else: an injected implementation gets the scheme,
 * port, credential and per-hop redirect rules, but it cannot get address
 * pinning, because pinning is a property of the socket and an injected fetch
 * owns its own. Production never passes one. It is kept because the existing
 * suites are built on it, and a fixture server per assertion would make them
 * slower without making them better.
 */
export type FetchLike = (
  input: string,
  init: {
    headers: Record<string, string>;
    redirect: 'manual';
    signal: AbortSignal;
  }
) => Promise<Response>;

/** One resolution: every address a hostname answers with, in order. */
export type ResolveLike = (
  hostname: string
) => Promise<Array<{ address: string; family: number }>>;

/** What the caller will do with the body, which decides what we will accept. */
export type ExpectedBody = 'any' | 'image';

export interface PublicFetchInput {
  url: string;
  headers: Record<string, string>;
  /** Hard ceiling for this call. Clamped by the configured ceiling. */
  maxBytes: number;
  /** Headers through body. Clamped by the configured ceiling. */
  timeoutMs: number;
  /** Test seam. See `FetchLike`. */
  fetchImpl?: FetchLike;
  /** Test seam, so a private answer can be arranged without a private name. */
  resolveImpl?: ResolveLike;
  expect?: ExpectedBody;
  config?: OutboundConfig;
}

/**
 * Headers we refuse to send however a caller spells them. These requests carry
 * no identity: there is no session on the other end that is ours, and a header
 * that implies one is either an accident or an exfiltration.
 */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'cookie',
  'authorization',
  'proxy-authorization',
]);

function safeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

const failed = (reason: PublicFetchFailure): PublicFetchOutcome => ({
  status: 'failed',
  reason,
});

// ---------------------------------------------------------------------------
// The URL rule
// ---------------------------------------------------------------------------

interface Destination {
  url: URL;
  hostname: string;
  port: number;
  secure: boolean;
}

function defaultPortFor(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

/**
 * The scheme, port and credential rules, which are decidable from the text
 * alone. Everything that needs a resolver happens after this.
 */
function destinationFor(
  raw: string,
  config: OutboundConfig
): Destination | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:';
  if (!secure && !(url.protocol === 'http:' && config.allowInsecure)) {
    return null;
  }
  if (url.username || url.password) return null;
  if (!url.hostname) return null;

  const port = url.port ? Number(url.port) : defaultPortFor(url.protocol);
  if (!Number.isFinite(port) || !config.allowedPorts.has(port)) return null;

  // `[::1]` arrives bracketed from the URL authority; the address rules want
  // the address.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // A host written as an address is judged here rather than at connect time,
  // so the rule holds whatever transport runs underneath — including an
  // injected `fetch` in a test, which is exactly where a redirect to
  // `https://169.254.169.254/` would otherwise slip through.
  if (isIpLiteral(hostname)) {
    if (!addressAllowed(hostname, port, config)) return null;
    return { url, hostname, port, secure };
  }
  // A bare name with no dot is a machine on the local network, whatever it
  // resolves to; `localhost` is only the most obvious member of that set.
  if (!hostname.includes('.')) return null;
  return { url, hostname, port, secure };
}

/**
 * True when we will connect to this address on this port.
 *
 * The fixture escape hatch is keyed on the RESOLVED address, never on a
 * hostname, and it is empty in production. Keying it on a name would be this
 * module's own bug one indirection later: the name would be trusted and
 * whatever it resolved to would be connected to.
 */
function addressAllowed(
  address: string,
  port: number,
  config: OutboundConfig
): boolean {
  if (isPublicAddress(address)) return true;
  return config.fixtureOrigins.has(`${address.toLowerCase()}:${port}`);
}

async function defaultResolve(
  hostname: string
): Promise<Array<{ address: string; family: number }>> {
  const dns = await import('node:dns');
  // `all` because one answer is not the answer: a name that resolves to a
  // public address and a private one has to be refused on the strength of the
  // private one, and asking for a single address hides it.
  return await dns.promises.lookup(hostname, { all: true, verbatim: true });
}

/**
 * The one address this hop will be pinned to, or a failure.
 *
 * An IP literal skips resolution and is judged directly. A name is resolved
 * once, every answer is judged, and the first is returned. Any refused answer
 * refuses the whole hop.
 */
async function pinnedAddress(
  destination: Destination,
  config: OutboundConfig,
  resolveImpl: ResolveLike
): Promise<{ address: string; family: number } | PublicFetchFailure> {
  // Already judged by `destinationFor`: a literal is its own resolution.
  if (isIpLiteral(destination.hostname)) {
    return {
      address: destination.hostname,
      family: destination.hostname.includes(':') ? 6 : 4,
    };
  }

  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await resolveImpl(destination.hostname);
  } catch {
    return 'network_error';
  }
  if (!Array.isArray(answers) || answers.length === 0) return 'network_error';
  for (const answer of answers) {
    if (!addressAllowed(answer.address, destination.port, config)) {
      return 'blocked';
    }
  }
  const first = answers[0] as { address: string; family: number };
  return {
    address: first.address,
    family: first.family === 6 ? 6 : 4,
  };
}

// ---------------------------------------------------------------------------
// One hop, over a socket we chose the far end of
// ---------------------------------------------------------------------------

type HopResult =
  | { kind: 'redirect'; location: string }
  | { kind: 'response'; httpStatus: number; headers: Headers; bytes: Buffer }
  | { kind: 'failed'; reason: PublicFetchFailure };

/** True when the response itself says it is bigger than we agreed to read. */
function overDeclaredLength(
  raw: string | string[] | undefined,
  maxBytes: number
): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const declared = Number(value ?? '');
  return Number.isFinite(declared) && declared > maxBytes;
}

function contentTypeAllowed(
  raw: string | undefined,
  expect: ExpectedBody,
  config: OutboundConfig
): boolean {
  if (expect !== 'image') return true;
  const value = (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return config.imageContentTypes.has(value);
}

/**
 * Performs one request against an address we have already validated, reading
 * the body under both budgets.
 *
 * Node's `http.request` rather than `fetch` for exactly one reason: it takes a
 * `lookup`, and a `lookup` that ignores its hostname and answers with the
 * address we validated is what pins the connection. `fetch` resolves the name
 * itself, inside undici, after our check — which is the window a rebinding
 * attack lives in.
 */
async function hopOverSocket(input: {
  destination: Destination;
  address: string;
  family: number;
  headers: Record<string, string>;
  maxBytes: number;
  deadlineAt: number;
  expect: ExpectedBody;
  config: OutboundConfig;
}): Promise<HopResult> {
  const remaining = input.deadlineAt - Date.now();
  if (remaining <= 0) return { kind: 'failed', reason: 'timeout' };

  const transport = input.destination.secure
    ? await import('node:https')
    : await import('node:http');

  return await new Promise<HopResult>((resolve) => {
    let settled = false;
    let request: ClientRequest | null = null;
    const finish = (result: HopResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ kind: 'failed', reason: 'timeout' });
    }, Math.max(remaining, 1));

    /**
     * The pin. `net.connect` calls this with the hostname and it answers with
     * the address we already judged, so the name is used for SNI and
     * certificate validation and never for routing.
     *
     * Both callback shapes, because Node asks for both: with happy-eyeballs on
     * (the default since Node 20) the connector passes `all: true` and expects
     * an array, and with it off it expects `(address, family)`. Answering only
     * one of the two is an `ERR_INVALID_IP_ADDRESS` on a version bump rather
     * than a hole, but it is still a fixed-at-the-source detail.
     */
    const pin = ((
      _hostname: string,
      options: { all?: boolean },
      callback: (
        error: Error | null,
        address: string | Array<{ address: string; family: number }>,
        family?: number
      ) => void
    ) => {
      if (options?.all) {
        callback(null, [{ address: input.address, family: input.family }]);
        return;
      }
      callback(null, input.address, input.family);
    }) as unknown as LookupFunction;

    request = transport.request(
      input.destination.url,
      {
        method: 'GET',
        headers: input.headers,
        lookup: pin,
        // A fresh connection per request. A pooled one could be a socket
        // opened for a different destination under the same host header.
        agent: false,
        ...(input.destination.secure
          ? { servername: input.destination.hostname }
          : {}),
      },
      (response) => {
        const httpStatus = response.statusCode ?? 0;
        if (httpStatus >= 300 && httpStatus < 400) {
          const location = response.headers.location;
          response.destroy();
          if (!location) {
            finish({ kind: 'failed', reason: 'blocked' });
            return;
          }
          finish({ kind: 'redirect', location });
          return;
        }

        if (
          !contentTypeAllowed(
            response.headers['content-type'],
            input.expect,
            input.config
          )
        ) {
          response.destroy();
          finish({ kind: 'failed', reason: 'blocked' });
          return;
        }

        // An honest sender saying "this is bigger than your cap" is worth
        // believing: refusing here costs nothing and saves the transfer. A
        // dishonest one is caught by the counter below, which is why the
        // header is never the only check.
        if (
          overDeclaredLength(response.headers['content-length'], input.maxBytes)
        ) {
          response.destroy();
          finish({ kind: 'failed', reason: 'too_large' });
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > input.maxBytes) {
            // Abandoned mid-stream. The bytes past the cap are never read and
            // never allocated, which is the difference between a cap and a
            // complaint.
            response.destroy();
            finish({ kind: 'failed', reason: 'too_large' });
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', () =>
          finish({ kind: 'failed', reason: 'network_error' })
        );
        response.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            // Set-Cookie is dropped rather than carried: nothing downstream
            // has a cookie jar, and a header nobody reads is a header that
            // will eventually be read by accident.
            if (name.toLowerCase() === 'set-cookie') continue;
            headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          }
          finish({
            kind: 'response',
            httpStatus,
            headers,
            bytes: Buffer.concat(chunks),
          });
        });
      }
    );

    request.on('error', () =>
      finish({ kind: 'failed', reason: 'network_error' })
    );
    request.end();
  });
}

// ---------------------------------------------------------------------------
// One hop, through an injected fetch
// ---------------------------------------------------------------------------

/** Drops a body we have decided not to read. Never throws. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed, or never had a body. Either way there is nothing left.
  }
}

async function readCappedStream(
  response: Response,
  maxBytes: number
): Promise<Buffer | 'too_large'> {
  const body = response.body;
  if (!body) return Buffer.from(await response.arrayBuffer());
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) return 'too_large';
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // A stream that is already gone needs no cancelling.
    }
  }
  return Buffer.concat(chunks);
}

async function hopOverFetch(input: {
  destination: Destination;
  headers: Record<string, string>;
  maxBytes: number;
  signal: AbortSignal;
  expect: ExpectedBody;
  config: OutboundConfig;
  fetchImpl: FetchLike;
}): Promise<HopResult> {
  const response = await input.fetchImpl(input.destination.url.toString(), {
    headers: input.headers,
    redirect: 'manual',
    signal: input.signal,
  });
  const httpStatus = response.status;
  if (httpStatus >= 300 && httpStatus < 400) {
    const location = response.headers.get('location');
    if (!location) return { kind: 'failed', reason: 'blocked' };
    return { kind: 'redirect', location };
  }
  if (
    !contentTypeAllowed(
      response.headers.get('content-type') ?? undefined,
      input.expect,
      input.config
    )
  ) {
    await discard(response);
    return { kind: 'failed', reason: 'blocked' };
  }
  if (
    overDeclaredLength(
      response.headers.get('content-length') ?? undefined,
      input.maxBytes
    )
  ) {
    await discard(response);
    return { kind: 'failed', reason: 'too_large' };
  }
  const bytes = await readCappedStream(response, input.maxBytes);
  if (bytes === 'too_large') return { kind: 'failed', reason: 'too_large' };
  return { kind: 'response', httpStatus, headers: response.headers, bytes };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * One GET against a URL a stranger supplied, under every rule in the module
 * header, returning bytes and deciding nothing about them.
 *
 * Never throws. Every failure is one of four reasons, and a caller that only
 * knows how to say "no profile available" can use all four the same way.
 */
export async function fetchPublicResource(
  input: PublicFetchInput
): Promise<PublicFetchOutcome> {
  const config = input.config ?? outboundConfig();
  const expect = input.expect ?? 'any';
  const maxBytes = Math.min(input.maxBytes, config.maxBytes);
  const timeoutMs = Math.min(input.timeoutMs, config.timeoutMs);
  const headers = safeHeaders(input.headers);
  const resolveImpl = input.resolveImpl ?? defaultResolve;

  // One budget for the whole thing, set before the first DNS question and not
  // extended by anything that happens after it.
  const deadlineAt = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = input.url;
    for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
      // Before the first request and again after every redirect, in full. A
      // hostile endpoint that answers hop one from a public address and points
      // hop two at 169.254.169.254 is the entire reason redirects are followed
      // by hand rather than by the runtime.
      const destination = destinationFor(current, config);
      if (!destination) return failed('blocked');

      let result: HopResult;
      if (input.fetchImpl) {
        result = await hopOverFetch({
          destination,
          headers,
          maxBytes,
          signal: controller.signal,
          expect,
          config,
          fetchImpl: input.fetchImpl,
        });
      } else {
        const pinned = await pinnedAddress(destination, config, resolveImpl);
        if (typeof pinned === 'string') return failed(pinned);
        result = await hopOverSocket({
          destination,
          address: pinned.address,
          family: pinned.family,
          headers,
          maxBytes,
          deadlineAt,
          expect,
          config,
        });
      }

      if (result.kind === 'failed') return failed(result.reason);
      if (result.kind === 'redirect') {
        let next: string;
        try {
          next = new URL(result.location, destination.url).toString();
        } catch {
          return failed('blocked');
        }
        current = next;
        continue;
      }
      return {
        status: 'ok',
        url: destination.url.toString(),
        httpStatus: result.httpStatus,
        headers: result.headers,
        bytes: result.bytes,
      };
    }
    // Out of hops. A chain this long is a redirect loop or a laundering
    // attempt, and neither is a page we want.
    return failed('blocked');
  } catch (error) {
    const aborted =
      controller.signal.aborted ||
      (error instanceof Error && error.name === 'AbortError');
    return failed(aborted ? 'timeout' : 'network_error');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when a URL is worth attempting at all: https, no credentials, a
 * hostname, and — when the host is written as an address — a public one.
 *
 * A syntactic pre-check and explicitly NOT the security boundary. It is here
 * so a URL that can never succeed is dropped without a DNS question and
 * without a socket; the destination is decided by `fetchPublicResource`, after
 * resolution, against the address. Anything that treats this as the guard is
 * repeating the bug this module replaced.
 */
export function isFetchableUrl(
  raw: string,
  config: OutboundConfig = outboundConfig()
): boolean {
  return destinationFor(raw, config) !== null;
}
