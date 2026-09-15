import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('GET /api/health', () => {
  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    // Sigma health is process-wide module state (src/lib/sigma/warm.ts), set
    // once by src/instrumentation.ts at real server startup. Reset it before
    // every test so ordering within this file cannot leak 'ready' from the
    // dedicated sigma test into the others, which all expect the pre-warm-up
    // default.
    const { resetSigmaHealthForTests } = await import('@/lib/sigma/warm');
    resetSigmaHealthForTests();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
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
      sigma: 'missing',
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
      sigma: 'missing',
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

  it('reports sigma as ready once startup warm-up succeeded, without failing the probe', async () => {
    process.env.FLOWSTARTER_ENV = 'development';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';

    const { GET } = await import('../route');
    const { resetSigmaHealthForTests } = await import('@/lib/sigma/warm');
    // Startup warm-up is a real ONNX model load and out of scope for this
    // unit test (see packages/sigma-flowstarter and
    // apps/flowstarter-main/README.md for the one-off fetch-model command
    // that would make it succeed for real); this asserts the route wires the
    // module-level result through, not that warm-up itself works.
    resetSigmaHealthForTests('ready');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sigma).toBe('ready');
  });

  it('reports sigma as missing rather than fail the probe when the model never warmed', async () => {
    process.env.FLOWSTARTER_ENV = 'development';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';

    const { GET } = await import('../route');
    const { resetSigmaHealthForTests } = await import('@/lib/sigma/warm');
    resetSigmaHealthForTests();

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sigma).toBe('missing');
  });
});
