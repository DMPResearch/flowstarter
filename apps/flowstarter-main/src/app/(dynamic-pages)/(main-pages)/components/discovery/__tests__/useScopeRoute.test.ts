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
import { useScopeRoute } from '../useScopeRoute';

const originalFetch = global.fetch;

let bodies: Array<Record<string, unknown>> = [];
let reply: Record<string, unknown> = { route: 'self-serve' };

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
  global.fetch = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return { ok: true, json: async () => reply } as Response;
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
