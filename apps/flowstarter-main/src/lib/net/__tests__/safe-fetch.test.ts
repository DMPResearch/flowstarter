// @vitest-environment node
/**
 * The outbound adapter, against a real socket.
 *
 * Codex F02 is a finding about what happens on the wire, so the cases that
 * matter cannot be proved with a fake `fetch`: a stubbed response can be made
 * to say anything, including that a request which really would have reached
 * 169.254.169.254 did not. Everything below therefore runs against an actual
 * HTTP server on an ephemeral loopback port, and the assertions are about what
 * that server did and did not receive.
 *
 * WHICH MEANS THE FIXTURE IS ON A PRIVATE ADDRESS, which the rule under test
 * exists to refuse. That tension is resolved the way production is configured
 * rather than by weakening anything: `FLOWSTARTER_FETCH_FIXTURE_ORIGINS` names
 * one `address:port` pair that is permitted despite the address rule, it is
 * keyed on the RESOLVED address so a name can never be trusted into it, and
 * `outboundConfig` drops it entirely when `NODE_ENV` is production. So the
 * fixture is reachable, its neighbour on the next port is not, and "refused"
 * below always means refused by the same code path production runs.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { outboundConfig } from '../net-config';
import {
  fetchPublicResource,
  isFetchableUrl,
  type FetchLike,
  type ResolveLike,
} from '../safe-fetch';

const HTML = '<!doctype html><title>a page</title>';
/** A PNG signature and IHDR for a 1x1 image, then filler. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]),
  Buffer.alloc(16, 7),
]);

/** Paths the fixture was asked for, so "never reached" is assertable. */
const served: string[] = [];
/** Headers of the last request, so "no cookie went out" is assertable. */
let lastHeaders: Record<string, unknown> = {};

let fixture: Server;
let neighbour: Server;
let fixturePort = 0;
let neighbourPort = 0;
const neighbourServed: string[] = [];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port)
    );
  });
}

beforeAll(async () => {
  fixture = createServer((request, response) => {
    const path = request.url ?? '/';
    served.push(path);
    lastHeaders = request.headers as Record<string, unknown>;

    if (path === '/page') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(HTML);
      return;
    }
    if (path === '/image') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(PNG);
      return;
    }
    if (path === '/not-an-image') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(HTML);
      return;
    }
    if (path === '/redirect-to-loopback') {
      response.writeHead(302, {
        location: `http://127.0.0.1:${neighbourPort}/internal`,
      });
      response.end();
      return;
    }
    if (path === '/redirect-to-metadata') {
      response.writeHead(302, {
        location: 'http://169.254.169.254/latest/meta-data/',
      });
      response.end();
      return;
    }
    if (path === '/redirect-same-host') {
      response.writeHead(302, {
        location: `http://rebind.fixture.test:${fixturePort}/second`,
      });
      response.end();
      return;
    }
    if (path === '/loop') {
      response.writeHead(302, { location: `/loop` });
      response.end();
      return;
    }
    if (path === '/redirect-to-page') {
      response.writeHead(302, { location: `/page` });
      response.end();
      return;
    }
    if (path === '/flood' || path === '/flood-image') {
      // Chunked on purpose: no content-length at all, so the only thing that
      // can stop this is a reader that counts as it goes.
      response.writeHead(200, {
        'content-type': path === '/flood' ? 'text/html' : 'image/png',
        'transfer-encoding': 'chunked',
      });
      const block = Buffer.alloc(64 * 1024, 0x61);
      const pump = () => {
        if (response.writableEnded || response.destroyed) return;
        if (response.write(block)) setImmediate(pump);
        else response.once('drain', pump);
      };
      pump();
      return;
    }
    if (path === '/slow-body') {
      // Headers immediately, body never. The shape that defeats a timeout
      // cleared when the headers land.
      response.writeHead(200, { 'content-type': 'text/html' });
      response.write('<html>');
      return;
    }
    response.writeHead(404).end();
  });
  neighbour = createServer((request, response) => {
    neighbourServed.push(request.url ?? '/');
    response.writeHead(200, { 'content-type': 'text/html' }).end('secret');
  });
  fixturePort = await listen(fixture);
  neighbourPort = await listen(neighbour);
});

afterAll(async () => {
  await new Promise((resolve) => fixture.close(resolve));
  await new Promise((resolve) => neighbour.close(resolve));
});

/**
 * The production policy, plus the one fixture origin and the neighbour's port.
 *
 * The neighbour's PORT is allowed while its ADDRESS is not, deliberately: it
 * makes the redirect case below fail on the address rule rather than on the
 * port rule, which is the rule the finding is about.
 */
function config() {
  return outboundConfig({
    NODE_ENV: 'test',
    FLOWSTARTER_FETCH_ALLOW_INSECURE: 'true',
    FLOWSTARTER_FETCH_FIXTURE_ORIGINS: `127.0.0.1:${fixturePort}`,
    FLOWSTARTER_FETCH_ALLOWED_PORTS: `${neighbourPort}`,
  });
}

/** Resolves the fixture's own names to the fixture. */
const resolveToFixture: ResolveLike = async () => [
  { address: '127.0.0.1', family: 4 },
];

const get = (url: string, over: Record<string, unknown> = {}) =>
  fetchPublicResource({
    url,
    headers: { accept: '*/*' },
    maxBytes: 256 * 1024,
    timeoutMs: 2_000,
    config: config(),
    resolveImpl: resolveToFixture,
    ...over,
  });

describe('the happy path is unchanged', () => {
  it('reads a page and reports what answered', async () => {
    const outcome = await get(`http://127.0.0.1:${fixturePort}/page`);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.bytes.toString('utf8')).toBe(HTML);
    expect(outcome.headers.get('content-type')).toBe('text/html');
  });

  it('reads an image when the content type is one we asked for', async () => {
    const outcome = await get(`http://127.0.0.1:${fixturePort}/image`, {
      expect: 'image',
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.bytes.equals(PNG)).toBe(true);
  });

  it('follows a redirect that stays inside the rules', async () => {
    const outcome = await get(
      `http://127.0.0.1:${fixturePort}/redirect-to-page`
    );
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.bytes.toString('utf8')).toBe(HTML);
  });

  it('sends no cookie and no authorization, however it is asked to', async () => {
    await get(`http://127.0.0.1:${fixturePort}/page`, {
      headers: {
        accept: '*/*',
        cookie: 'session=secret',
        Authorization: 'Bearer secret',
      },
    });
    expect(lastHeaders.cookie).toBeUndefined();
    expect(lastHeaders.authorization).toBeUndefined();
  });
});

describe('the destination rules', () => {
  it('refuses a redirect to loopback, and never opens the connection', async () => {
    neighbourServed.length = 0;
    const outcome = await get(
      `http://127.0.0.1:${fixturePort}/redirect-to-loopback`
    );
    expect(outcome).toEqual({ status: 'failed', reason: 'blocked' });
    // The assertion that matters: refusing after the request would still be a
    // server-side request, and this proves there was not one.
    expect(neighbourServed).toEqual([]);
  });

  it('refuses a redirect to the cloud metadata endpoint', async () => {
    const outcome = await get(
      `http://127.0.0.1:${fixturePort}/redirect-to-metadata`
    );
    expect(outcome).toEqual({ status: 'failed', reason: 'blocked' });
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const resolveImpl = vi.fn(async () => [{ address: '10.0.0.5', family: 4 }]);
    const outcome = await get(
      `http://internal.fixture.test:${fixturePort}/page`,
      { resolveImpl }
    );
    expect(outcome).toEqual({ status: 'failed', reason: 'blocked' });
    expect(resolveImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a name that answers with both a public and a private address', async () => {
    // Taking the public one would make the outcome depend on resolver
    // ordering, which is a coin flip the attacker gets to keep tossing.
    const resolveImpl = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    const outcome = await get(`http://mixed.fixture.test:${fixturePort}/page`, {
      resolveImpl,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'blocked' });
  });

  it('refuses an IPv6 loopback and a v4-mapped private address written out', async () => {
    for (const host of ['[::1]', '[::ffff:169.254.169.254]']) {
      const outcome = await get(`http://${host}:${fixturePort}/page`);
      expect(outcome, host).toEqual({ status: 'failed', reason: 'blocked' });
    }
  });

  it('refuses rebinding: the second resolution differs and is checked', async () => {
    // Hop one resolves to the fixture and is pinned to it. Hop two is the same
    // hostname and resolves to a private address, which is precisely the DNS
    // rebinding shape, and it is refused rather than followed.
    served.length = 0;
    const answers = [
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: '10.0.0.5', family: 4 }],
    ];
    let resolutions = 0;
    const resolveImpl: ResolveLike = async () => {
      const answer = answers[resolutions] ?? [];
      resolutions += 1;
      return answer;
    };
    const outcome = await get(
      `http://rebind.fixture.test:${fixturePort}/redirect-same-host`,
      { resolveImpl }
    );
    expect(outcome).toEqual({ status: 'failed', reason: 'blocked' });
    expect(resolutions).toBe(2);
    // Hop one happened, hop two did not, and nothing reached the rebound
    // address: the connection was pinned to the answer that was checked.
    expect(served).toEqual(['/redirect-same-host']);
  });

  it('refuses credentials in the authority, a foreign port and plain http when it is not allowed', async () => {
    const strict = outboundConfig({ NODE_ENV: 'production' });
    for (const url of [
      `http://user:pass@127.0.0.1:${fixturePort}/page`,
      'https://example.test:8080/page',
      'http://example.test/page',
      'file:///etc/passwd',
      'gopher://example.test/',
    ]) {
      const outcome = await get(url, { config: strict });
      expect(outcome, url).toEqual({ status: 'failed', reason: 'blocked' });
    }
  });

  it('gives up rather than chasing an endless redirect chain', async () => {
    const outcome = await get(`http://127.0.0.1:${fixturePort}/loop`, {
      config: outboundConfig({
        NODE_ENV: 'test',
        FLOWSTARTER_FETCH_ALLOW_INSECURE: 'true',
        FLOWSTARTER_FETCH_FIXTURE_ORIGINS: `127.0.0.1:${fixturePort}`,
        FLOWSTARTER_FETCH_MAX_REDIRECTS: '2',
      }),
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'blocked' });
  });
});

describe('the size and time budgets', () => {
  it('aborts an endless chunked body at the cap, with no content-length anywhere', async () => {
    const outcome = await get(`http://127.0.0.1:${fixturePort}/flood`, {
      maxBytes: 128 * 1024,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'too_large' });
  });

  it('aborts an oversized image response at the cap', async () => {
    const outcome = await get(`http://127.0.0.1:${fixturePort}/flood-image`, {
      maxBytes: 128 * 1024,
      expect: 'image',
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'too_large' });
  });

  it('refuses a response whose content type is not an image we asked for', async () => {
    const outcome = await get(`http://127.0.0.1:${fixturePort}/not-an-image`, {
      expect: 'image',
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'blocked' });
  });

  it('keeps the deadline running through the body, not only the headers', async () => {
    const started = Date.now();
    const outcome = await get(`http://127.0.0.1:${fixturePort}/slow-body`, {
      timeoutMs: 300,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'timeout' });
    // The headers arrived at once; had the timer been cleared there, this
    // would hang until the suite's own timeout instead.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('clamps a caller that asks for more than the configured ceiling', async () => {
    const outcome = await get(`http://127.0.0.1:${fixturePort}/flood`, {
      maxBytes: 500 * 1024 * 1024,
      config: outboundConfig({
        NODE_ENV: 'test',
        FLOWSTARTER_FETCH_ALLOW_INSECURE: 'true',
        FLOWSTARTER_FETCH_FIXTURE_ORIGINS: `127.0.0.1:${fixturePort}`,
        FLOWSTARTER_FETCH_MAX_BYTES: `${128 * 1024}`,
      }),
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'too_large' });
  });
});

describe('the configured policy', () => {
  it('is https, port 443, public addresses only when nothing is set', () => {
    const production = outboundConfig({ NODE_ENV: 'production' });
    expect(Array.from(production.allowedPorts)).toEqual([443]);
    expect(production.allowInsecure).toBe(false);
    expect(production.fixtureOrigins.size).toBe(0);
  });

  it('refuses to loosen itself in production however the environment is set', () => {
    const production = outboundConfig({
      NODE_ENV: 'production',
      FLOWSTARTER_FETCH_ALLOW_INSECURE: 'true',
      FLOWSTARTER_FETCH_FIXTURE_ORIGINS: '127.0.0.1:8080',
    });
    expect(production.allowInsecure).toBe(false);
    expect(production.fixtureOrigins.size).toBe(0);
    expect(production.allowedPorts.has(8080)).toBe(false);
  });
});

describe('the injected-fetch seam', () => {
  /** A `fetch` that answers with whatever the case needs. */
  function answering(init: {
    status?: number;
    headers?: Record<string, string>;
    body?: Uint8Array;
  }): FetchLike {
    return async () =>
      new Response(Buffer.from(init.body ?? new Uint8Array(0)), {
        status: init.status ?? 200,
        headers: init.headers ?? {},
      });
  }

  const seam = (fetchImpl: FetchLike, over: Record<string, unknown> = {}) =>
    fetchPublicResource({
      url: 'https://cdn.example.com/a.png',
      headers: { accept: 'image/*' },
      maxBytes: 1024,
      timeoutMs: 1_000,
      fetchImpl,
      ...over,
    });

  it('reads a response the same way the socket path does', async () => {
    const outcome = await seam(
      answering({
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array([1, 2, 3]),
      }),
      { expect: 'image' }
    );
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(Array.from(outcome.bytes)).toEqual([1, 2, 3]);
  });

  it('refuses a content type outside the image allow list', async () => {
    const outcome = await seam(
      answering({ headers: { 'content-type': 'text/html' } }),
      { expect: 'image' }
    );
    expect(outcome).toEqual({ status: 'failed', reason: 'blocked' });
  });

  it('refuses a declared length over the cap without reading the body', async () => {
    const outcome = await seam(
      answering({
        headers: { 'content-type': 'image/png', 'content-length': '99999999' },
        body: new Uint8Array(8),
      }),
      { expect: 'image' }
    );
    expect(outcome).toEqual({ status: 'failed', reason: 'too_large' });
  });

  it('stops at the cap when the body is longer than the header admitted', async () => {
    const outcome = await seam(
      answering({
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array(4096),
      }),
      { expect: 'image' }
    );
    expect(outcome).toEqual({ status: 'failed', reason: 'too_large' });
  });

  it('treats a redirect with nowhere to go as a refusal', async () => {
    const outcome = await seam(answering({ status: 302 }));
    expect(outcome).toEqual({ status: 'failed', reason: 'blocked' });
  });

  it('reports a transport that throws as a network error, not a crash', async () => {
    const outcome = await seam(async () => {
      throw new Error('connection reset');
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'network_error' });
  });
});

describe('the default resolver and the socket', () => {
  it('reports a name that does not resolve rather than throwing', async () => {
    // No `resolveImpl`, so this exercises the real DNS path. `.invalid` is
    // reserved by the IETF precisely so it can never resolve, which makes this
    // a local failure rather than a request to anybody.
    const outcome = await fetchPublicResource({
      url: 'https://nothing.here.invalid/page',
      headers: { accept: '*/*' },
      maxBytes: 1024,
      timeoutMs: 2_000,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'network_error' });
  });

  it('reports a refused connection rather than throwing', async () => {
    // A port that was listening a moment ago and is not now, so the connect
    // fails rather than hanging.
    const closed = createServer();
    const closedPort = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));

    const outcome = await fetchPublicResource({
      url: `http://127.0.0.1:${closedPort}/page`,
      headers: { accept: '*/*' },
      maxBytes: 1024,
      timeoutMs: 2_000,
      config: outboundConfig({
        NODE_ENV: 'test',
        FLOWSTARTER_FETCH_ALLOW_INSECURE: 'true',
        FLOWSTARTER_FETCH_FIXTURE_ORIGINS: `127.0.0.1:${closedPort}`,
      }),
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'network_error' });
  });
});

describe('isFetchableUrl', () => {
  it('is the cheap filter, and agrees with the destination rules', () => {
    const strict = outboundConfig({ NODE_ENV: 'production' });
    expect(isFetchableUrl('https://example.com/a.png', strict)).toBe(true);
    for (const url of [
      'http://example.com/a.png',
      'https://example.com:8080/a.png',
      'https://user:pass@example.com/a.png',
      'https://127.0.0.1/a.png',
      'https://[::1]/a.png',
      'https://localhost/a.png',
      'https://169.254.169.254/latest/',
      'not a url at all',
    ]) {
      expect(isFetchableUrl(url, strict), url).toBe(false);
    }
  });
});
