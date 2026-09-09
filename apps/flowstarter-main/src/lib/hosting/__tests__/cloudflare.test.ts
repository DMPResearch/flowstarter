import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareApiError,
  CloudflareClient,
  cloudflareFromEnv,
} from '../cloudflare';

function envelopeOk<T>(result: T) {
  return {
    success: true as const,
    errors: [] as Array<{ code: number; message: string }>,
    messages: [] as Array<{ code: number; message: string }>,
    result,
  };
}

function mockFetchSeq(responses: Array<{ body: unknown; status?: number }>) {
  const queue = [...responses];
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error('mockFetchSeq exhausted');
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('CloudflareClient', () => {
  it('throws when constructed without token', () => {
    expect(() => new CloudflareClient({ token: '' })).toThrow();
  });

  it('listZones forwards name param + bearer', async () => {
    const fetchSpy = mockFetchSeq([
      {
        body: envelopeOk([
          {
            id: 'zone1',
            name: 'example.com',
            status: 'active',
            paused: false,
            type: 'full',
            account: { id: 'a', name: 'A' },
            name_servers: [],
          },
        ]),
      },
    ]);
    const client = new CloudflareClient({
      token: 'cf-token',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    const zones = await client.listZones({ name: 'example.com' });
    expect(zones[0].id).toBe('zone1');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      'https://api.cloudflare.com/client/v4/zones?name=example.com'
    );
    expect((init?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer cf-token'
    );
  });

  it('upsertRecord creates when no match found', async () => {
    const fetchSpy = mockFetchSeq([
      // listRecords (empty)
      { body: envelopeOk([]) },
      // createRecord
      {
        body: envelopeOk({
          id: 'rec1',
          zone_id: 'zone1',
          zone_name: 'example.com',
          name: 'shop.example.com',
          type: 'A',
          content: '1.2.3.4',
          ttl: 1,
          proxied: false,
          created_on: '',
          modified_on: '',
        }),
      },
    ]);
    const client = new CloudflareClient({
      token: 't',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    const rec = await client.upsertRecord({
      zoneId: 'zone1',
      type: 'A',
      name: 'shop.example.com',
      content: '1.2.3.4',
    });
    expect(rec.id).toBe('rec1');
    expect(fetchSpy.mock.calls[1][1]?.method).toBe('POST');
  });

  it('upsertRecord short-circuits when match is identical', async () => {
    const existing = {
      id: 'rec1',
      zone_id: 'zone1',
      zone_name: 'example.com',
      name: 'shop.example.com',
      type: 'A' as const,
      content: '1.2.3.4',
      ttl: 1,
      proxied: false,
      created_on: '',
      modified_on: '',
    };
    const fetchSpy = mockFetchSeq([{ body: envelopeOk([existing]) }]);
    const client = new CloudflareClient({
      token: 't',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    const rec = await client.upsertRecord({
      zoneId: 'zone1',
      type: 'A',
      name: 'shop.example.com',
      content: '1.2.3.4',
    });
    expect(rec).toEqual(existing);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('upsertRecord patches when content differs', async () => {
    const existing = {
      id: 'rec1',
      zone_id: 'zone1',
      zone_name: 'example.com',
      name: 'shop.example.com',
      type: 'A' as const,
      content: '1.2.3.4',
      ttl: 1,
      proxied: false,
      created_on: '',
      modified_on: '',
    };
    const fetchSpy = mockFetchSeq([
      { body: envelopeOk([existing]) },
      { body: envelopeOk({ ...existing, content: '5.6.7.8' }) },
    ]);
    const client = new CloudflareClient({
      token: 't',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    const rec = await client.upsertRecord({
      zoneId: 'zone1',
      type: 'A',
      name: 'shop.example.com',
      content: '5.6.7.8',
    });
    expect(rec.content).toBe('5.6.7.8');
    expect(fetchSpy.mock.calls[1][1]?.method).toBe('PATCH');
  });

  it('throws CloudflareApiError when success=false', async () => {
    const fetchSpy = mockFetchSeq([
      {
        body: {
          success: false,
          errors: [{ code: 1003, message: 'invalid token' }],
          messages: [],
          result: null,
        },
        status: 403,
      },
    ]);
    const client = new CloudflareClient({
      token: 't',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    await expect(client.listZones()).rejects.toBeInstanceOf(CloudflareApiError);
  });
});

describe('cloudflareFromEnv', () => {
  it('throws if token missing', () => {
    expect(() => cloudflareFromEnv({} as unknown as NodeJS.ProcessEnv)).toThrow(
      /CLOUDFLARE_API_TOKEN/
    );
  });
  it('builds when token set', () => {
    const c = cloudflareFromEnv({
      CLOUDFLARE_API_TOKEN: 'x',
    } as unknown as NodeJS.ProcessEnv);
    expect(c).toBeInstanceOf(CloudflareClient);
  });
});

describe('findZoneByName', () => {
  it('answers with the zone when the account manages it', async () => {
    const fetchSpy = mockFetchSeq([
      {
        body: envelopeOk([
          {
            id: 'zone1',
            name: 'example.com',
            status: 'active',
            paused: false,
            type: 'full',
            account: { id: 'a', name: 'A' },
            name_servers: [],
          },
        ]),
      },
    ]);
    const client = new CloudflareClient({
      token: 't',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    expect((await client.findZoneByName('example.com'))?.id).toBe('zone1');
  });

  it('answers null rather than throwing for a zone somebody else manages', async () => {
    const fetchSpy = mockFetchSeq([{ body: envelopeOk([]) }]);
    const client = new CloudflareClient({
      token: 't',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    expect(await client.findZoneByName('someone-elses.com')).toBeNull();
  });
});

describe('deleteRecord', () => {
  it('DELETEs the record in its zone', async () => {
    const fetchSpy = mockFetchSeq([{ body: envelopeOk({ id: 'rec1' }) }]);
    const client = new CloudflareClient({
      token: 't',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    expect(await client.deleteRecord('zone1', 'rec1')).toEqual({ id: 'rec1' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone1/dns_records/rec1'
    );
    expect(init?.method).toBe('DELETE');
    // A DELETE carries no body, so `body` must not be the string "undefined".
    expect(init?.body).toBeUndefined();
  });
});

describe('CloudflareClient error shapes that are not the documented envelope', () => {
  it('carries the body text when Cloudflare answers with HTML', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('<html>521 Web Server Is Down</html>', { status: 521 })
    );
    const client = new CloudflareClient({
      token: 't',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    const error = await client
      .listZones()
      .catch((e: unknown) => e as CloudflareApiError);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).status).toBe(521);
    expect((error as CloudflareApiError).errors[0].message).toContain('521');
  });

  it('falls back to the status text when there is no body at all', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('', { status: 502, statusText: 'Bad Gateway' })
    );
    const client = new CloudflareClient({
      token: 't',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    const error = await client
      .listRecords('zone1', { name: 'a.example.com', type: 'A' })
      .catch((e: unknown) => e as CloudflareApiError);
    expect((error as CloudflareApiError).errors).toEqual([
      { code: 0, message: 'Bad Gateway' },
    ]);
  });
});
