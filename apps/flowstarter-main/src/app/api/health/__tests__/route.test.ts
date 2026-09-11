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

    const { GET } = await import('../route');
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      supabase: { env: 'development', target: 'local', host: '127.0.0.1' },
    });
  });

  it('reports a remote target when pointed at a hosted project', async () => {
    process.env.FLOWSTARTER_ENV = 'production';
    process.env.NEXT_PUBLIC_SUPABASE_URL =
      'https://avptvzherjxymmbtbbbr.supabase.co';

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
    });
  });
});
