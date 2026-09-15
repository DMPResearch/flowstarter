import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

let selectResult: { error: { message: string } | null } = { error: null };
let createClientImpl = vi.fn();

const abortSignalSpy = vi.fn(
  () =>
    Promise.resolve() as unknown as Promise<{
      error: { message: string } | null;
    }>
);
const selectSpy = vi.fn(() => ({ abortSignal: abortSignalSpy }));
const fromSpy = vi.fn(() => ({ select: selectSpy }));
const mockSupabase = { from: fromSpy };

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => createClientImpl(),
}));

describe('probeDatabase', () => {
  beforeEach(() => {
    selectResult = { error: null };
    abortSignalSpy.mockReset();
    abortSignalSpy.mockImplementation(() => Promise.resolve(selectResult));
    selectSpy.mockReset();
    selectSpy.mockImplementation(() => ({ abortSignal: abortSignalSpy }));
    fromSpy.mockReset();
    fromSpy.mockImplementation(() => ({ select: selectSpy }));
    createClientImpl = vi.fn(() => mockSupabase);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports ok:true on a clean query', async () => {
    const { probeDatabase } = await import('../database-probe');
    const result = await probeDatabase({});
    expect(result).toEqual({ ok: true });
    expect(fromSpy).toHaveBeenCalledWith('workspaces');
    expect(selectSpy).toHaveBeenCalledWith('count', {
      count: 'exact',
      head: true,
    });
  });

  it('reports ok:false with the driver message when the query errors', async () => {
    selectResult = { error: { message: 'connection refused' } };
    const { probeDatabase } = await import('../database-probe');
    const result = await probeDatabase({});
    expect(result).toEqual({ ok: false, message: 'connection refused' });
  });

  it('reports ok:false rather than throw when constructing the client fails', async () => {
    createClientImpl = vi.fn(() => {
      throw new Error('Refusing to run development against a remote project');
    });
    const { probeDatabase } = await import('../database-probe');
    const result = await probeDatabase({});
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Refusing to run development/);
  });

  it('reports ok:false rather than throw when the query itself rejects (e.g. an abort)', async () => {
    abortSignalSpy.mockImplementation(() =>
      Promise.reject(
        new DOMException('The operation was aborted', 'AbortError')
      )
    );
    const { probeDatabase } = await import('../database-probe');
    const result = await probeDatabase({});
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/aborted/i);
  });

  it('bounds the query with the default timeout by default', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const { probeDatabase, DEFAULT_DATABASE_PROBE_TIMEOUT_MS } = await import(
      '../database-probe'
    );
    await probeDatabase({});
    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_DATABASE_PROBE_TIMEOUT_MS);
  });

  it('honors FLOWSTARTER_DATABASE_HEALTH_TIMEOUT_MS when it is a valid positive number', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const { probeDatabase } = await import('../database-probe');
    await probeDatabase({ FLOWSTARTER_DATABASE_HEALTH_TIMEOUT_MS: '500' });
    expect(timeoutSpy).toHaveBeenCalledWith(500);
  });

  it('falls back to the default timeout for an invalid override', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const { probeDatabase, DEFAULT_DATABASE_PROBE_TIMEOUT_MS } = await import(
      '../database-probe'
    );
    for (const invalid of ['not-a-number', '-5', '0', '']) {
      timeoutSpy.mockClear();
      await probeDatabase({ FLOWSTARTER_DATABASE_HEALTH_TIMEOUT_MS: invalid });
      expect(timeoutSpy).toHaveBeenCalledWith(
        DEFAULT_DATABASE_PROBE_TIMEOUT_MS
      );
    }
  });
});
