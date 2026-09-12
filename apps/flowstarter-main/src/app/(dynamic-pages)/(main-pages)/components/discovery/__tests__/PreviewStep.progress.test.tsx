/**
 * PreviewStep's transport for build progress: SSE first, a polling fallback
 * only if the stream errors. What matters here is the visible contract —
 * phases appear in order as the stream reports them, the step still reaches
 * "live" if the stream drops and polling takes over, and only one transport
 * is ever active at a time — not the exact markup.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_DISCOVERY, type DiscoveryData } from '../discovery.logic';
import { PreviewStep } from '../steps/PreviewStep';

vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({ isSignedIn: false, isLoaded: true }),
  useClerk: () => ({ openSignIn: vi.fn() }),
}));

type Listener = (event: { data: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onerror: ((event: Event) => void) | null = null;
  private listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: Listener) {
    (this.listeners[type] ??= []).push(cb);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    for (const cb of this.listeners[type] ?? []) {
      cb({ data: JSON.stringify(data) });
    }
  }

  triggerError() {
    this.onerror?.(new Event('error'));
  }
}

const DATA: DiscoveryData = {
  ...EMPTY_DISCOVERY,
  businessName: 'Ionescu Dental',
  description: 'A dental clinic that stays open late.',
};
const t = (key: string) => key;

const originalEventSource = (globalThis as { EventSource?: unknown })
  .EventSource;
const originalFetch = global.fetch;

/** Routes fetch by path + method so a single mock can serve both the live
 * POST kickoff and the fallback GET poll. */
function routedFetch(handlers: {
  postLive?: () => unknown;
  getLive?: (call: number) => unknown;
  postJson?: () => unknown;
}) {
  let getLiveCalls = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.startsWith('/api/discovery/preview/live') && method === 'POST') {
      return { ok: true, json: async () => handlers.postLive?.() ?? {} };
    }
    if (url.startsWith('/api/discovery/preview/live') && method === 'GET') {
      getLiveCalls += 1;
      return {
        ok: true,
        json: async () => handlers.getLive?.(getLiveCalls) ?? {},
      };
    }
    if (url.startsWith('/api/discovery/preview') && method === 'POST') {
      return {
        ok: true,
        json: async () => handlers.postJson?.() ?? { skip: true },
      };
    }
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  window.sessionStorage.clear();
  // jsdom has no scrollIntoView; PreviewStep calls it whenever the chat log
  // changes, which happens once the live preview shows up.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SSE progress', () => {
  it('appends phases to the visible log in order as the stream reports them', async () => {
    global.fetch = routedFetch({ postLive: () => ({ demoId: 'demo-1' }) });
    render(<PreviewStep data={DATA} t={t} />);

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe('/api/discovery/preview/live/stream?demoId=demo-1');

    // Scoped to the log on purpose: the current phase is deliberately written
    // twice — once as a message here, once in the always-visible "Now:" line —
    // so an unscoped query would match both.
    const conversation = () => screen.getByRole('log');

    act(() => source.emit('phase', { phase: 'Reading your brand', at: 2 }));
    expect(
      await within(conversation()).findByText(/Reading your brand/)
    ).toBeInTheDocument();

    act(() => source.emit('phase', { phase: 'Choosing a template', at: 8 }));
    expect(
      await within(conversation()).findByText(/Choosing a template/)
    ).toBeInTheDocument();
    // Both stay visible, in the order they arrived.
    const log = conversation();
    const lines = Array.from(log.querySelectorAll('span')).map(
      (el) => el.textContent
    );
    const brandIndex = lines.findIndex((l) =>
      l?.includes('Reading your brand')
    );
    const templateIndex = lines.findIndex((l) =>
      l?.includes('Choosing a template')
    );
    expect(brandIndex).toBeGreaterThanOrEqual(0);
    expect(templateIndex).toBeGreaterThan(brandIndex);
  });

  it('switches to the live preview and closes the stream once ready arrives', async () => {
    global.fetch = routedFetch({ postLive: () => ({ demoId: 'demo-1' }) });
    render(<PreviewStep data={DATA} t={t} />);

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;

    act(() =>
      source.emit('ready', {
        previewUrl: 'https://acme.preview.example',
        personalized: true,
      })
    );

    const frame = await screen.findByTitle('Live site preview');
    expect(frame).toBeInTheDocument();
    expect(source.closed).toBe(true);

    // The funnel iframe must never carry `allow-same-origin`: the local
    // preview proxy re-hosts generated content on this app's own origin
    // (see `local-preview-guard.ts`), so `allow-same-origin` would let that
    // framed document read this page's cookies and storage.
    const sandbox = frame.getAttribute('sandbox') ?? '';
    expect(sandbox.split(' ')).not.toContain('allow-same-origin');
    expect(sandbox.split(' ')).toContain('allow-scripts');
  });

  it('closes the stream on unmount', async () => {
    global.fetch = routedFetch({ postLive: () => ({ demoId: 'demo-1' }) });
    const { unmount } = render(<PreviewStep data={DATA} t={t} />);

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    expect(source.closed).toBe(false);

    unmount();
    expect(source.closed).toBe(true);
  });
});

describe('polling fallback', () => {
  it('falls back to polling exactly once when the stream errors, and still reaches live', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    global.fetch = routedFetch({
      postLive: () => ({ demoId: 'demo-1' }),
      getLive: (call) =>
        call < 2
          ? { status: 'building', phase: 'Building…' }
          : {
              status: 'ready',
              phase: 'Building…',
              previewUrl: 'https://acme.preview.example',
              personalized: true,
            },
    });
    render(<PreviewStep data={DATA} t={t} />);
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;

    // Installed only now and measured relative to this point — vi.waitFor
    // above uses setInterval internally, unrelated to the fallback poll.
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    act(() => source.triggerError());
    act(() => source.triggerError());
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(source.closed).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });

    await vi.waitFor(() =>
      expect(screen.getByTitle('Live site preview')).toBeInTheDocument()
    );
  });
});
