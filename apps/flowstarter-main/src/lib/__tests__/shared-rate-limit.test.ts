/**
 * The limiter the public capture endpoint counts with.
 *
 * Three things are defended:
 *
 *  1. With Upstash configured, the count lives in Redis, so "ten a minute" is
 *     ten a minute across every instance rather than per instance.
 *  2. With nothing configured, it falls back to the in-memory limiter and
 *     still counts - a limiter that quietly allowed everything in development
 *     is a rule nobody would ever see fail.
 *  3. An unreachable or unhappy Redis allows the request. A rate limiter that
 *     turns an outage of itself into an outage of every client's contact form
 *     has picked the wrong thing to protect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeRateLimit, upstashCredentials } from '../rate-limit';

const CONFIG = { limit: 3, windowMs: 60_000 };
const CREDENTIALS = { url: 'https://redis.example/', token: 'secret' };

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('upstashCredentials', () => {
  it('is null unless both halves are set', () => {
    expect(upstashCredentials({})).toBeNull();
    expect(
      upstashCredentials({ UPSTASH_REDIS_REST_URL: 'https://redis.example' })
    ).toBeNull();
    expect(upstashCredentials({ UPSTASH_REDIS_REST_TOKEN: 'x' })).toBeNull();
  });

  it('is both halves, trimmed, when they are', () => {
    expect(
      upstashCredentials({
        UPSTASH_REDIS_REST_URL: ' https://redis.example ',
        UPSTASH_REDIS_REST_TOKEN: ' secret ',
      })
    ).toEqual({ url: 'https://redis.example', token: 'secret' });
  });
});

describe('consumeRateLimit with Upstash', () => {
  it('increments and sets an expiry in one pipelined call', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ result: 1 }, { result: 1 }],
    });
    expect(await consumeRateLimit('k', CONFIG, CREDENTIALS)).toBe(false);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://redis.example/pipeline');
    expect(JSON.parse(init.body as string)).toEqual([
      ['INCR', 'k'],
      ['EXPIRE', 'k', '60', 'NX'],
    ]);
    expect(init.headers.Authorization).toBe('Bearer secret');
  });

  it('limits once the count passes the allowance', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ result: 3 }],
    });
    expect(await consumeRateLimit('k', CONFIG, CREDENTIALS)).toBe(false);

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ result: 4 }],
    });
    expect(await consumeRateLimit('k', CONFIG, CREDENTIALS)).toBe(true);
  });

  it('fails open when Redis refuses or is unreachable', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => [] });
    expect(await consumeRateLimit('k', CONFIG, CREDENTIALS)).toBe(false);

    fetchMock.mockRejectedValue(new Error('unreachable'));
    expect(await consumeRateLimit('k', CONFIG, CREDENTIALS)).toBe(false);
  });

  it('never lets a window shorter than a second round down to zero', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ result: 1 }],
    });
    await consumeRateLimit('k', { limit: 1, windowMs: 10 }, CREDENTIALS);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body[1]).toEqual(['EXPIRE', 'k', '1', 'NX']);
  });
});

describe('consumeRateLimit with nothing configured', () => {
  it('counts in memory, and keeps counting across calls', async () => {
    const key = `fallback-${Math.random()}`;
    expect(await consumeRateLimit(key, CONFIG, null)).toBe(false);
    expect(await consumeRateLimit(key, CONFIG, null)).toBe(false);
    expect(await consumeRateLimit(key, CONFIG, null)).toBe(false);
    expect(await consumeRateLimit(key, CONFIG, null)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts each key on its own', async () => {
    const run = Math.random();
    for (let i = 0; i < 4; i += 1) {
      await consumeRateLimit(`a-${run}`, CONFIG, null);
    }
    expect(await consumeRateLimit(`a-${run}`, CONFIG, null)).toBe(true);
    expect(await consumeRateLimit(`b-${run}`, CONFIG, null)).toBe(false);
  });
});
