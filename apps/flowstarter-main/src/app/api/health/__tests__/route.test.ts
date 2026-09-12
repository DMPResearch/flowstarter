import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('GET /api/health', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('reports ok and the resolved local Supabase target', async () => {
    process.env.FLOWSTARTER_ENV = 'development';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.FLOWSTARTER_BUILD_COMMIT = 'test-sha-1';

    const { GET } = await import('../route');
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      supabase: { env: 'development', target: 'local', host: '127.0.0.1' },
      commit: 'test-sha-1',
    });
  });

  it('reports a remote target when pointed at a hosted project', async () => {
    process.env.FLOWSTARTER_ENV = 'production';
    process.env.NEXT_PUBLIC_SUPABASE_URL =
      'https://avptvzherjxymmbtbbbr.supabase.co';
    process.env.FLOWSTARTER_BUILD_COMMIT = 'test-sha-2';

    const { GET } = await import('../route');
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      supabase: {
        env: 'production',
        target: 'remote',
        host: 'avptvzherjxymmbtbbbr.supabase.co',
      },
      commit: 'test-sha-2',
    });
  });

  it('omits commit rather than fail when FLOWSTARTER_BUILD_COMMIT is unset in production', async () => {
    process.env.FLOWSTARTER_ENV = 'production';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    delete process.env.FLOWSTARTER_BUILD_COMMIT;

    const { GET } = await import('../route');
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty('commit');
  });
});
