/**
 * usePreviewProgress: the SSE-first transport behind the preview step's
 * build log. What matters here is the contract with PreviewStep, not the
 * markup — events must land as an ordered phase log, a stream that finishes
 * must tear itself down completely, and a dropped stream must fail over to
 * polling exactly once (never running both transports at once).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePreviewProgress } from '../usePreviewProgress';

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

const originalEventSource = (globalThis as { EventSource?: unknown })
  .EventSource;
const originalFetch = global.fetch;

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
});

afterEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the SSE path', () => {
  it('opens a stream against the demoId and updates the phase log in order', async () => {
    const { result } = renderHook(() => usePreviewProgress('demo-1'));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe('/api/discovery/preview/live/stream?demoId=demo-1');

    act(() => source.emit('phase', { phase: 'Reading your brand', at: 3 }));
    expect(result.current.phases).toEqual([
      { phase: 'Reading your brand', at: 3, index: 1 },
    ]);
    expect(result.current.phase).toBe('Reading your brand');

    act(() => source.emit('phase', { phase: 'Choosing a template', at: 9 }));
    expect(result.current.phases).toEqual([
      { phase: 'Reading your brand', at: 3, index: 1 },
      { phase: 'Choosing a template', at: 9, index: 2 },
    ]);
    // Order preserved — the second phase never overwrites the first.
    expect(result.current.phases[0]!.phase).toBe('Reading your brand');
  });

  it('closes the stream and reports ready on the ready event, with no fallback', async () => {
    const { result } = renderHook(() => usePreviewProgress('demo-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;

    act(() =>
      source.emit('ready', {
        previewUrl: 'https://example.preview',
        personalized: true,
      })
    );

    expect(source.closed).toBe(true);
    expect(result.current.status).toBe('ready');
    expect(result.current.previewUrl).toBe('https://example.preview');
    expect(result.current.personalized).toBe(true);
    expect(result.current.usingFallback).toBe(false);
  });

  it('closes the stream and reports failure on the failed event', async () => {
    const { result } = renderHook(() => usePreviewProgress('demo-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;

    act(() => source.emit('failed', { error: 'budget exceeded' }));

    expect(source.closed).toBe(true);
    expect(result.current.status).toBe('failed');
    expect(result.current.error).toBe('budget exceeded');
  });

  it('closes the stream on unmount', async () => {
    const { unmount } = renderHook(() => usePreviewProgress('demo-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    expect(source.closed).toBe(false);

    unmount();

    expect(source.closed).toBe(true);
  });
});

describe('the polling fallback', () => {
  it('falls back to polling exactly once no matter how many times onerror fires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ status: 'building', phase: 'Building…' }),
    }) as unknown as typeof fetch;

    renderHook(() => usePreviewProgress('demo-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;

    // RTL's own `waitFor` above uses setInterval internally, so the spy is
    // installed only now and measured relative to this point — otherwise
    // it would double-count intervals that have nothing to do with the
    // fallback poll.
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    act(() => source.triggerError());
    act(() => source.triggerError());
    act(() => source.triggerError());

    // Exactly one polling interval was ever started, even though the
    // stream errored three times.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(source.closed).toBe(true);
  });

  it('polls the plain status endpoint and appends phases as they change, then stops polling once ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let call = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      call += 1;
      const body =
        call === 1
          ? { status: 'building', phase: 'Reading your brand' }
          : call === 2
          ? { status: 'building', phase: 'Choosing a template' }
          : {
              status: 'ready',
              phase: 'Choosing a template',
              previewUrl: 'https://example.preview',
              personalized: true,
              // The hosted copy never came up, so the watch that looks for
              // it has its answer and stops with everything else.
              hostedPreviewStatus: 'failed',
            };
      return { json: async () => body };
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => usePreviewProgress('demo-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    act(() => source.triggerError());

    // First poll fires immediately on fallback start.
    await vi.waitFor(() => expect(result.current.phases).toHaveLength(1));
    expect(result.current.usingFallback).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(result.current.phases).toHaveLength(2);
    expect(result.current.phases[1]!.phase).toBe('Choosing a template');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.previewUrl).toBe('https://example.preview');

    // The hosted-preview watch starts when the build is reported ready and
    // gets its answer on its first tick, so allow for that one call before
    // asserting that nothing keeps polling.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const callsAtReady = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // No further polling once the fallback and the hosted watch have both
    // resolved.
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsAtReady
    );
  });

  it('picks up the hosted preview and its expiry after the build is ready', async () => {
    // The publish to the previews host is detached, so the durable URL and
    // the date it dies arrive after the stream has closed. The visitor is
    // shown both together or neither: a shareable link with no expiry on it
    // is the promise this whole model exists to stop us making.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let call = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      call += 1;
      const ready = {
        status: 'ready',
        phase: 'Done',
        previewUrl: 'https://example.preview',
        personalized: true,
      };
      return {
        json: async () =>
          call === 1
            ? { ...ready, hostedPreviewStatus: 'pending' }
            : {
                ...ready,
                hostedPreviewStatus: 'live',
                hostedPreviewUrl:
                  'https://p-0123456789abcdef.preview.flowstarter.net',
                hostedPreviewExpiresAt: '2026-09-26T00:00:00.000Z',
              },
      };
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => usePreviewProgress('demo-2'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instances[0]!.triggerError());

    await vi.waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.hostedPreviewUrl).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(result.current.hostedPreviewUrl).toBe(
      'https://p-0123456789abcdef.preview.flowstarter.net'
    );
    expect(result.current.hostedPreviewExpiresAt).toBe(
      '2026-09-26T00:00:00.000Z'
    );
  });
});
