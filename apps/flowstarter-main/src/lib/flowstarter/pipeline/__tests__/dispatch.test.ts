/**
 * The nudge to the build worker.
 *
 * The ledger row is the commitment and this call is only a nudge, so every
 * refusal here has to be loud enough for the caller to decide what it means:
 * the Stripe webhook swallows it, the operator's re-dispatch shows it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchError, dispatchAgentJob } from '../dispatch';

const SECRET = 'k'.repeat(32);
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 202 });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('FLOWSTARTER_BUILD_WORKER_URL', 'https://worker.example.com');
  vi.stubEnv('FLOWSTARTER_BUILD_WORKER_SECRET', SECRET);
});

afterEach(() => vi.unstubAllGlobals());

describe('dispatchAgentJob', () => {
  it('posts the job id to the worker, bearing the shared secret', async () => {
    await dispatchAgentJob('job-1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://worker.example.com/jobs/full-site');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(init.body)).toEqual({ jobId: 'job-1' });
    // A stale answer would tell the worker a job is already running.
    expect(init.cache).toBe('no-store');
  });

  it('refuses when the worker is not configured', async () => {
    vi.stubEnv('FLOWSTARTER_BUILD_WORKER_URL', '');
    await expect(dispatchAgentJob('job-1')).rejects.toThrow(/not configured/);

    vi.stubEnv('FLOWSTARTER_BUILD_WORKER_URL', 'https://worker.example.com');
    vi.stubEnv('FLOWSTARTER_BUILD_WORKER_SECRET', '');
    await expect(dispatchAgentJob('job-1')).rejects.toBeInstanceOf(
      DispatchError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a secret short enough to be guessed', async () => {
    vi.stubEnv('FLOWSTARTER_BUILD_WORKER_SECRET', 'k'.repeat(31));
    await expect(dispatchAgentJob('job-1')).rejects.toThrow(
      /at least 32 characters/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to send the secret over plain http to a remote host', async () => {
    vi.stubEnv('FLOWSTARTER_BUILD_WORKER_URL', 'http://worker.example.com');
    await expect(dispatchAgentJob('job-1')).rejects.toThrow(/must use HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows plain http to the local worker a developer runs', async () => {
    for (const origin of ['http://127.0.0.1:8787', 'http://localhost:8787']) {
      vi.stubEnv('FLOWSTARTER_BUILD_WORKER_URL', origin);
      await expect(dispatchAgentJob('job-1')).resolves.toBeUndefined();
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports the status when the worker rejects the job', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(dispatchAgentJob('job-1')).rejects.toThrow(
      /rejected job with 503/
    );
  });
});
