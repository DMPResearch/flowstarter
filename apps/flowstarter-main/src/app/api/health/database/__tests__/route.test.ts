import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probeDatabaseMock = vi.fn();

vi.mock('@/lib/health/database-probe', () => ({
  probeDatabase: (...args: unknown[]) => probeDatabaseMock(...args),
}));

describe('GET /api/health/database', () => {
  beforeEach(() => {
    probeDatabaseMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports healthy when the shared probe succeeds', async () => {
    probeDatabaseMock.mockResolvedValue({ ok: true });
    const { GET } = await import('../route');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'healthy',
      database: 'supabase',
    });
  });

  it('reports 503 and the driver message when the shared probe fails, the same probe /api/health uses', async () => {
    probeDatabaseMock.mockResolvedValue({
      ok: false,
      message: 'Database connection failed',
    });
    const { GET } = await import('../route');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: 'error',
      error: 'Database connection failed',
    });
  });
});

describe('HEAD /api/health/database', () => {
  beforeEach(() => {
    probeDatabaseMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers 200 when the probe succeeds and 503 when it fails', async () => {
    const { HEAD } = await import('../route');

    probeDatabaseMock.mockResolvedValue({ ok: true });
    expect((await HEAD()).status).toBe(200);

    probeDatabaseMock.mockResolvedValue({ ok: false, message: 'down' });
    expect((await HEAD()).status).toBe(503);
  });
});
