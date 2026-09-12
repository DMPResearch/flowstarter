import { useEffect, useState } from 'react';

/**
 * Live progress for a /api/discovery/preview/live build, as seen by the
 * visitor's browser. SSE (/api/discovery/preview/live/stream) is the primary
 * transport: the build takes 3-6 minutes and the point of this hook is that
 * each phase should appear the moment the pipeline enters it, not whenever a
 * poll happens to land.
 *
 * EventSource can be dropped by a proxy or missing in an environment (older
 * browsers, some serverless edges, and this test suite's jsdom, which has no
 * EventSource at all). If it errs, or is unavailable to begin with, this
 * falls back — once — to polling the plain status endpoint
 * (GET /api/discovery/preview/live?demoId=…), and never runs both transports
 * at the same time.
 */

export type PreviewProgressStatus = 'idle' | 'building' | 'ready' | 'failed';

export interface PreviewPhaseEntry {
  phase: string;
  /** Seconds since the generation started. */
  at: number;
  index: number;
}

export interface PreviewProgressSnapshot {
  status: PreviewProgressStatus;
  phase: string | null;
  /** Every phase seen so far, in order — the running log the UI renders. */
  phases: PreviewPhaseEntry[];
  previewUrl?: string;
  /**
   * The durable, shareable copy on the previews host. Not the same thing as
   * `previewUrl`, which points at the sandbox the iframe renders and dies with
   * it. Arrives after `ready` — the publish runs detached — so it is picked up
   * by a short second poll rather than by the stream, which has already
   * closed by then.
   */
  hostedPreviewUrl?: string;
  /**
   * ISO instant the hosted preview stops being served. Shown to the visitor
   * next to the link, never after it. A preview is temporary by rule, and the
   * rule is only honest if the person holding the link knows it.
   */
  hostedPreviewExpiresAt?: string;
  personalized: boolean;
  error?: string;
  /** True once SSE has been abandoned for the polling fallback. */
  usingFallback: boolean;
}

const IDLE_SNAPSHOT: PreviewProgressSnapshot = {
  status: 'idle',
  phase: null,
  phases: [],
  personalized: false,
  usingFallback: false,
};

const FALLBACK_POLL_MS = 3500;
/** Matches the previous poll loop's own cap; the SSE route has its own
 * (longer) server-side timeout, so this only bounds the fallback path. */
const FALLBACK_MAX_MS = 18 * 60_000;

/** How often, and for how long, the hosted copy is waited for after `ready`. */
const HOSTED_PREVIEW_POLL_MS = 3000;
const HOSTED_PREVIEW_MAX_MS = 90_000;

function streamUrl(demoId: string): string {
  return `/api/discovery/preview/live/stream?demoId=${encodeURIComponent(
    demoId
  )}`;
}

function statusUrl(demoId: string): string {
  return `/api/discovery/preview/live?demoId=${encodeURIComponent(demoId)}`;
}

export function usePreviewProgress(
  demoId: string | null
): PreviewProgressSnapshot {
  const [snapshot, setSnapshot] =
    useState<PreviewProgressSnapshot>(IDLE_SNAPSHOT);

  useEffect(() => {
    if (!demoId) {
      setSnapshot(IDLE_SNAPSHOT);
      return;
    }

    let cancelled = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let fallbackStarted = false;
    let lastPolledPhase: string | null = null;
    const startedAt = Date.now();

    setSnapshot({ ...IDLE_SNAPSHOT, status: 'building' });

    const stopPoll = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    const closeSource = () => {
      if (source) {
        source.close();
        source = null;
      }
    };
    const settle = () => {
      closeSource();
      stopPoll();
    };

    const appendPhase = (phase: string, at: number) => {
      setSnapshot((prev) => ({
        ...prev,
        phase,
        phases: [...prev.phases, { phase, at, index: prev.phases.length + 1 }],
      }));
    };

    const runFallbackPoll = async () => {
      if (cancelled) return;
      if (Date.now() - startedAt > FALLBACK_MAX_MS) {
        setSnapshot((prev) => ({
          ...prev,
          status: 'failed',
          error: 'Generation timed out',
        }));
        settle();
        return;
      }
      let json: {
        status?: string;
        phase?: string;
        previewUrl?: string;
        personalized?: boolean;
        error?: string;
      } = {};
      try {
        const res = await fetch(statusUrl(demoId));
        json = await res.json().catch(() => ({}));
      } catch {
        return; // try again next tick
      }
      if (cancelled) return;
      if (json.phase && json.phase !== lastPolledPhase) {
        lastPolledPhase = json.phase;
        appendPhase(json.phase, Math.round((Date.now() - startedAt) / 1000));
      }
      if (json.status === 'ready') {
        setSnapshot((prev) => ({
          ...prev,
          status: 'ready',
          previewUrl: json.previewUrl,
          personalized: json.personalized ?? false,
        }));
        settle();
      } else if (json.status === 'failed') {
        setSnapshot((prev) => ({
          ...prev,
          status: 'failed',
          error: json.error ?? 'Generation failed',
        }));
        settle();
      }
    };

    const startFallback = () => {
      if (fallbackStarted || cancelled) return;
      fallbackStarted = true;
      closeSource();
      setSnapshot((prev) => ({ ...prev, usingFallback: true }));
      pollTimer = setInterval(() => void runFallbackPoll(), FALLBACK_POLL_MS);
      void runFallbackPoll();
    };

    if (typeof EventSource === 'undefined') {
      startFallback();
    } else {
      try {
        source = new EventSource(streamUrl(demoId));
      } catch {
        source = null;
      }
      if (!source) {
        startFallback();
      } else {
        source.addEventListener('phase', (event) => {
          if (cancelled) return;
          try {
            const data = JSON.parse((event as MessageEvent).data) as {
              phase?: string;
              at?: number;
            };
            if (data.phase) appendPhase(data.phase, data.at ?? 0);
          } catch {
            /* malformed frame — skip it, the connection is still good */
          }
        });
        source.addEventListener('ready', (event) => {
          if (cancelled) return;
          try {
            const data = JSON.parse((event as MessageEvent).data) as {
              previewUrl?: string;
              personalized?: boolean;
            };
            setSnapshot((prev) => ({
              ...prev,
              status: 'ready',
              previewUrl: data.previewUrl,
              personalized: data.personalized ?? false,
            }));
          } catch {
            /* ignore */
          }
          settle();
        });
        source.addEventListener('failed', (event) => {
          if (cancelled) return;
          let error = 'Generation failed';
          try {
            const data = JSON.parse((event as MessageEvent).data) as {
              error?: string;
            };
            if (data.error) error = data.error;
          } catch {
            /* ignore */
          }
          setSnapshot((prev) => ({ ...prev, status: 'failed', error }));
          settle();
        });
        source.onerror = () => {
          if (cancelled) return;
          startFallback();
        };
      }
    }

    return () => {
      cancelled = true;
      settle();
    };
  }, [demoId]);

  // The hosted copy lands after the build is reported ready: `publishFunnelPreview`
  // is deliberately detached so a previews host that is slow or down cannot
  // hold up the preview the visitor is already looking at. By then the stream
  // has closed and the build poll has settled, so this is its own short watch,
  // and it stops the moment there is an answer either way.
  const ready = snapshot.status === 'ready';
  const hosted = snapshot.hostedPreviewUrl;
  useEffect(() => {
    if (!demoId || !ready || hosted) return;
    let cancelled = false;
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (cancelled) return;
      if (Date.now() - startedAt > HOSTED_PREVIEW_MAX_MS) {
        clearInterval(timer);
        return;
      }
      let json: {
        hostedPreviewUrl?: string;
        hostedPreviewStatus?: string;
        hostedPreviewExpiresAt?: string;
      } = {};
      try {
        const res = await fetch(statusUrl(demoId));
        json = await res.json().catch(() => ({}));
      } catch {
        return; // try again next tick
      }
      if (cancelled) return;
      if (json.hostedPreviewUrl) {
        setSnapshot((prev) => ({
          ...prev,
          hostedPreviewUrl: json.hostedPreviewUrl,
          ...(json.hostedPreviewExpiresAt
            ? { hostedPreviewExpiresAt: json.hostedPreviewExpiresAt }
            : {}),
        }));
        clearInterval(timer);
        return;
      }
      // `failed` and `removed` are answers too: there will be no hosted copy,
      // and asking for one every three seconds for a minute is noise.
      if (
        json.hostedPreviewStatus === 'failed' ||
        json.hostedPreviewStatus === 'removed'
      ) {
        clearInterval(timer);
      }
    }, HOSTED_PREVIEW_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [demoId, ready, hosted]);

  return snapshot;
}
