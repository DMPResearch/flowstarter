/**
 * How often the gate runs, which is the half of it that costs money.
 *
 * Once per brief: not once per render (the wizard hands a new `data` object
 * down on every change anywhere in it), and not once forever either, because a
 * visitor who goes back from the offer and says something different about their
 * business has a different brief and is owed a different answer.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_DISCOVERY, type DiscoveryData } from '../discovery.logic';
import {
  SCOPE_RETRY_ATTEMPTS,
  SCOPE_RETRY_DEFAULT_SECONDS,
  SCOPE_RETRY_MAX_SECONDS,
  scopeRetryAfterSeconds,
  useScopeRoute,
} from '../useScopeRoute';

const originalFetch = global.fetch;

let bodies: Array<Record<string, unknown>> = [];
let reply: Record<string, unknown> = { route: 'self-serve' };
/** What the fetch stub answers with, so a 429 can be replayed exactly. */
let replyStatus = { ok: true, retryAfter: null as string | null };

function data(overrides: Partial<DiscoveryData> = {}): DiscoveryData {
  return {
    ...EMPTY_DISCOVERY,
    fullName: 'Sarah Smith',
    email: 'sarah@example.com',
    description: 'A bakery in Cluj',
    websiteUrl: 'https://acme.example.com',
    ...overrides,
  };
}

beforeEach(() => {
  bodies = [];
  reply = { route: 'self-serve' };
  replyStatus = { ok: true, retryAfter: null };
  global.fetch = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return {
        ok: replyStatus.ok,
        headers: { get: () => replyStatus.retryAfter },
        json: async () => reply,
      } as unknown as Response;
    }
  ) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('useScopeRoute', () => {
  it('does nothing at all until the conversation is over', async () => {
    renderHook(() => useScopeRoute({ data: data(), active: false }));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('classifies once, however many times the wizard re-renders', async () => {
    // `data()` returns a fresh object every call, which is exactly what the
    // wizard does on every change anywhere in it. Identity must not be what
    // decides whether a model is asked a question.
    const { rerender } = renderHook(
      ({ d }: { d: DiscoveryData }) => useScopeRoute({ data: d, active: true }),
      { initialProps: { d: data() } }
    );
    rerender({ d: data() });
    rerender({ d: data() });
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect(bodies).toHaveLength(1);
  });

  it('re-classifies when the visitor changes what their business does', async () => {
    const { rerender } = renderHook(
      ({ d }: { d: DiscoveryData }) => useScopeRoute({ data: d, active: true }),
      { initialProps: { d: data() } }
    );
    await waitFor(() => expect(bodies).toHaveLength(1));

    rerender({ d: data({ description: 'A portal my customers log into' }) });
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].description).toBe('A portal my customers log into');
  });

  it('re-classifies when the link changes', async () => {
    const { rerender } = renderHook(
      ({ d }: { d: DiscoveryData }) => useScopeRoute({ data: d, active: true }),
      { initialProps: { d: data() } }
    );
    await waitFor(() => expect(bodies).toHaveLength(1));

    rerender({ d: data({ websiteUrl: 'https://portal.example.com' }) });
    await waitFor(() => expect(bodies).toHaveLength(2));
  });

  it('does not re-classify when only the name changes', async () => {
    const { rerender } = renderHook(
      ({ d }: { d: DiscoveryData }) => useScopeRoute({ data: d, active: true }),
      { initialProps: { d: data() } }
    );
    await waitFor(() => expect(bodies).toHaveLength(1));

    rerender({ d: data({ fullName: 'Sarah J Smith' }) });
    // The name is not evidence about scope, so changing it buys nothing and
    // must not cost a model call.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bodies).toHaveLength(1);
  });

  it('sends the clarifying answer on the second pass and only then', async () => {
    reply = {
      route: 'ask-one-more-question',
      questionKey: 'landing.discovery.scope.question',
    };
    const { result } = renderHook(() =>
      useScopeRoute({ data: data(), active: true })
    );
    await waitFor(() => expect(result.current.state.status).toBe('question'));

    reply = { route: 'discovery-call', bookingUrl: null };
    result.current.clarify('Software my customers log into');
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[0].clarification).toBeUndefined();
    expect(bodies[1].clarification).toBe('Software my customers log into');
    await waitFor(() => expect(result.current.state.status).toBe('offer'));
  });

  it('ignores an empty clarification rather than spending a call on it', async () => {
    reply = {
      route: 'ask-one-more-question',
      questionKey: 'landing.discovery.scope.question',
    };
    const { result } = renderHook(() =>
      useScopeRoute({ data: data(), active: true })
    );
    await waitFor(() => expect(bodies).toHaveLength(1));
    result.current.clarify('   ');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bodies).toHaveLength(1);
  });

  it('fails open to the preview when the request throws', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const { result } = renderHook(() =>
      useScopeRoute({ data: data(), active: true })
    );
    await waitFor(() => expect(result.current.state.status).toBe('self-serve'));
  });

  /**
   * Finding 2 of the 2026-09-15 showcase run.
   *
   * `/api/discovery/scope` answers a rate limit with
   * `429 {"route":"self-serve","reason":"unavailable"}` and a `Retry-After`.
   * This hook read `route`, believed it, mounted `PreviewStep` and generated a
   * preview for a haulage client-portal brief -- with an invented "Customer
   * Portal" page and a EUR 159.80 deposit offer. Twice, on film.
   *
   * The server no longer sends `self-serve` for this (see the route's
   * `unavailable()`), and the hook no longer believes it either: the word
   * `unavailable` is read before `route` is, so a browser on an older bundle
   * and a server on an older deploy both still stop.
   */
  describe('when the route answers without deciding', () => {
    it('holds rather than generating, on a 429 that still says self-serve', async () => {
      // The body an older deploy sends. The word beats the route field.
      replyStatus = { ok: false, retryAfter: '60' };
      reply = { route: 'self-serve', reason: 'unavailable' };
      const { result } = renderHook(() =>
        useScopeRoute({ data: data(), active: true })
      );
      await waitFor(() => expect(result.current.state.status).toBe('hold'));
    });

    it('shows the notice the server wrote, not a locale-key fallback', async () => {
      // What the route sends now: `hold`, with the copy and the sentence.
      replyStatus = { ok: false, retryAfter: '60' };
      reply = {
        route: 'hold',
        reason: 'unavailable',
        offerCopy: {
          titleKey: 'landing.discovery.scope.hold.title',
          bodyKey: 'landing.discovery.scope.hold.body',
        },
        policy: { title: 'Încă verificăm', locale: 'ro' },
      };
      const { result } = renderHook(() =>
        useScopeRoute({ data: data(), active: true })
      );
      await waitFor(() => expect(result.current.state.status).toBe('hold'));
      const state = result.current.state as {
        status: 'hold';
        policy?: { title: string };
        copy?: { titleKey: string };
      };
      expect(state.policy?.title).toBe('Încă verificăm');
      expect(state.copy?.titleKey).toBe('landing.discovery.scope.hold.title');
    });

    it('holds on a 200 that admits it could not decide', async () => {
      reply = { route: 'self-serve', reason: 'unavailable' };
      const { result } = renderHook(() =>
        useScopeRoute({ data: data(), active: true })
      );
      // The status code is not what makes it undecided; the word is.
      await waitFor(() => expect(result.current.state.status).toBe('hold'));
    });

    it('holds on any non-OK answer, even one that forgot the reason', async () => {
      replyStatus = { ok: false, retryAfter: null };
      reply = { route: 'self-serve' };
      const { result } = renderHook(() =>
        useScopeRoute({ data: data(), active: true })
      );
      await waitFor(() => expect(result.current.state.status).toBe('hold'));
    });

    it("retries on the server's clock, bounded, and takes the real answer", async () => {
      vi.useFakeTimers();
      try {
        replyStatus = { ok: false, retryAfter: '5' };
        reply = { route: 'self-serve', reason: 'unavailable' };
        const { result } = renderHook(() =>
          useScopeRoute({ data: data(), active: true })
        );
        await vi.waitFor(() =>
          expect(result.current.state.status).toBe('hold')
        );
        expect(bodies).toHaveLength(1);

        // The window the server asked for, not one of our own.
        replyStatus = { ok: true, retryAfter: null };
        reply = { route: 'discovery-call', bookingUrl: null };
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(() => expect(bodies).toHaveLength(2));
        await vi.waitFor(() =>
          expect(result.current.state.status).toBe('offer')
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops after SCOPE_RETRY_ATTEMPTS rather than hammering the route', async () => {
      vi.useFakeTimers();
      try {
        replyStatus = { ok: false, retryAfter: '1' };
        reply = { route: 'self-serve', reason: 'unavailable' };
        const { result } = renderHook(() =>
          useScopeRoute({ data: data(), active: true })
        );
        await vi.waitFor(() => expect(bodies).toHaveLength(1));

        for (let i = 0; i < SCOPE_RETRY_ATTEMPTS + 3; i++) {
          await vi.advanceTimersByTimeAsync(1_000);
        }

        expect(bodies).toHaveLength(SCOPE_RETRY_ATTEMPTS);
        // And it is still a hold, which is what the visitor is reading: a
        // person picks this up, nothing has been built.
        expect(result.current.state.status).toBe('hold');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('scopeRetryAfterSeconds', () => {
    it('reads a delta in seconds', () => {
      expect(scopeRetryAfterSeconds('45')).toBe(45);
    });

    it('reads an HTTP date, which the header is also allowed to be', () => {
      const at = new Date(Date.now() + 30_000).toUTCString();
      expect(scopeRetryAfterSeconds(at)).toBeGreaterThan(25);
      expect(scopeRetryAfterSeconds(at)).toBeLessThanOrEqual(30);
    });

    it('falls back to the documented default, never to zero', () => {
      // Zero would be a retry loop with no wait in it, which is the browser
      // becoming the load that caused the rate limit.
      expect(scopeRetryAfterSeconds(null)).toBe(SCOPE_RETRY_DEFAULT_SECONDS);
      expect(scopeRetryAfterSeconds('soon')).toBe(SCOPE_RETRY_DEFAULT_SECONDS);
      expect(scopeRetryAfterSeconds('0')).toBe(SCOPE_RETRY_DEFAULT_SECONDS);
      expect(scopeRetryAfterSeconds('-9')).toBe(SCOPE_RETRY_DEFAULT_SECONDS);
    });

    it('caps a header that asks the visitor to wait an unreasonable time', () => {
      expect(scopeRetryAfterSeconds('86400')).toBe(SCOPE_RETRY_MAX_SECONDS);
    });
  });

  it('sends the visitor language so the notice is not always English', async () => {
    renderHook(() => useScopeRoute({ data: data(), active: true }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].locale).toBe('en');
  });

  it('treats a route it does not recognise as the preview', async () => {
    reply = { route: 'something-new' };
    const { result } = renderHook(() =>
      useScopeRoute({ data: data(), active: true })
    );
    await waitFor(() => expect(result.current.state.status).toBe('self-serve'));
  });

  it('does not show a question with no question in it', async () => {
    reply = { route: 'ask-one-more-question' };
    const { result } = renderHook(() =>
      useScopeRoute({ data: data(), active: true })
    );
    await waitFor(() => expect(result.current.state.status).toBe('self-serve'));
  });
});
