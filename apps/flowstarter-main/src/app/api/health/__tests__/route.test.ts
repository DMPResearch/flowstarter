import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

const probeDatabaseMock = vi.fn();
const probeMcpHealthMock = vi.fn();
const probeBuildWorkerHealthMock = vi.fn();

vi.mock('@/lib/health/database-probe', () => ({
  probeDatabase: (...args: unknown[]) => probeDatabaseMock(...args),
}));
vi.mock('@/lib/discovery/generation-availability', () => ({
  probeMcpHealth: (...args: unknown[]) => probeMcpHealthMock(...args),
}));
vi.mock('@/lib/flowstarter/pipeline/dispatch', () => ({
  probeBuildWorkerHealth: (...args: unknown[]) =>
    probeBuildWorkerHealthMock(...args),
}));

describe('GET /api/health', () => {
  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.FLOWSTARTER_MCP_URL;
    delete process.env.FLOWSTARTER_BUILD_WORKER_URL;
    // Sigma health is process-wide module state (src/lib/sigma/warm.ts), set
    // once by src/instrumentation.ts at real server startup. Reset it before
    // every test so ordering within this file cannot leak 'ready' from the
    // dedicated sigma test into the others, which all expect the pre-warm-up
    // default.
    const { resetSigmaHealthForTests } = await import('@/lib/sigma/warm');
    resetSigmaHealthForTests();
    probeDatabaseMock.mockReset().mockResolvedValue({ ok: true });
    probeMcpHealthMock.mockReset().mockResolvedValue(true);
    probeBuildWorkerHealthMock.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('reports ok and the resolved local Supabase target when every dependency is healthy', async () => {
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
      database: 'ok',
      templateLibrary: 'not-configured',
      buildWorker: 'not-configured',
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
      database: 'ok',
      templateLibrary: 'not-configured',
      buildWorker: 'not-configured',
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

  describe('dependency probes', () => {
    it('reports ok:false and database:"error" when the database probe fails, without changing the HTTP status', async () => {
      probeDatabaseMock.mockResolvedValue({
        ok: false,
        message: 'Database connection failed',
      });

      const { GET } = await import('../route');
      const response = await GET();
      const body = await response.json();

      // Still 200: every consumer of this route reads the JSON body, and a
      // non-2xx status combined with `curl -f` would hide the detail this
      // fix exists to surface (see the route's own docstring).
      expect(response.status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.database).toBe('error');
    });

    it('does not let a healthy database mask an unhealthy configured template library', async () => {
      process.env.FLOWSTARTER_MCP_URL = 'https://mcp.example.internal';
      probeMcpHealthMock.mockResolvedValue(false);

      const { GET } = await import('../route');
      const response = await GET();
      const body = await response.json();

      expect(body.ok).toBe(false);
      expect(body.database).toBe('ok');
      expect(body.templateLibrary).toBe('error');
      expect(probeMcpHealthMock).toHaveBeenCalledWith(
        'https://mcp.example.internal',
        process.env
      );
    });

    it('reports templateLibrary "ok" and keeps ok:true when the configured MCP server answers healthy', async () => {
      process.env.FLOWSTARTER_MCP_URL = 'https://mcp.example.internal';
      probeMcpHealthMock.mockResolvedValue(true);

      const { GET } = await import('../route');
      const response = await GET();
      const body = await response.json();

      expect(body.ok).toBe(true);
      expect(body.templateLibrary).toBe('ok');
    });

    it('does not let a healthy database mask an unhealthy configured build worker', async () => {
      process.env.FLOWSTARTER_BUILD_WORKER_URL = 'https://worker.example.com';
      probeBuildWorkerHealthMock.mockResolvedValue(false);

      const { GET } = await import('../route');
      const response = await GET();
      const body = await response.json();

      expect(body.ok).toBe(false);
      expect(body.database).toBe('ok');
      expect(body.buildWorker).toBe('error');
      expect(probeBuildWorkerHealthMock).toHaveBeenCalledWith(
        'https://worker.example.com',
        process.env
      );
    });

    it('reports buildWorker "ok" and keeps ok:true when the configured worker answers healthy', async () => {
      process.env.FLOWSTARTER_BUILD_WORKER_URL = 'https://worker.example.com';
      probeBuildWorkerHealthMock.mockResolvedValue(true);

      const { GET } = await import('../route');
      const response = await GET();
      const body = await response.json();

      expect(body.ok).toBe(true);
      expect(body.buildWorker).toBe('ok');
    });

    it('never probes the template library or build worker when neither URL is configured', async () => {
      const { GET } = await import('../route');
      const response = await GET();
      const body = await response.json();

      expect(body.templateLibrary).toBe('not-configured');
      expect(body.buildWorker).toBe('not-configured');
      expect(probeMcpHealthMock).not.toHaveBeenCalled();
      expect(probeBuildWorkerHealthMock).not.toHaveBeenCalled();
    });

    it('is unhealthy overall when every dependency fails at once', async () => {
      process.env.FLOWSTARTER_MCP_URL = 'https://mcp.example.internal';
      process.env.FLOWSTARTER_BUILD_WORKER_URL = 'https://worker.example.com';
      probeDatabaseMock.mockResolvedValue({ ok: false, message: 'timeout' });
      probeMcpHealthMock.mockResolvedValue(false);
      probeBuildWorkerHealthMock.mockResolvedValue(false);

      const { GET } = await import('../route');
      const response = await GET();
      const body = await response.json();

      expect(body).toMatchObject({
        ok: false,
        database: 'error',
        templateLibrary: 'error',
        buildWorker: 'error',
      });
    });
  });
});
