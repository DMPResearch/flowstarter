import 'server-only';

/**
 * In-memory live-demo job store. A demo = one generated, sandbox-hosted site
 * the visitor can see and edit up to LIVE_EDIT_CAP times. Keyed by demoId.
 *
 * NOTE: process-local and ephemeral by design — fine for a single Node
 * worker / local dev. Production (multi-instance) must back this with a
 * durable store (Supabase) + the existing demo_edit_counters cap; the route
 * shapes here are written so that swap is mechanical.
 */
/**
 * Two free changes before the deposit ask: enough to prove the team edits the
 * site live, few enough that the preview never becomes the product. The
 * wizard reveals the deposit offer once both are spent.
 */
export const LIVE_EDIT_CAP = 2;

export interface LiveJob {
  demoId: string;
  status: 'building' | 'ready' | 'failed';
  /**
   * Upstream URL for the live site: Daytona sandbox or local `astro dev`
   * (http://127.0.0.1:<port>). Clients never see loopback URLs over HTTPS —
   * GET/stream rewrite those through `/api/discovery/preview/live/frame/<id>/`
   * so the wizard iframe is same-origin.
   */
  previewUrl?: string;
  /**
   * The durable copy on the previews host, e.g.
   * `https://p-<16 hex>.preview.flowstarter.net`. Present only once the
   * previews deploy-agent reports the site live; both URLs are exposed so the
   * funnel can offer a shareable link without pretending the sandbox one is
   * one.
   */
  hostedPreviewUrl?: string;
  /** 'pending' | 'live' | 'failed' | 'removed', straight off funnel_previews. */
  hostedPreviewStatus?: string;
  /**
   * ISO instant the hosted preview stops being served, from
   * `funnel_previews.expires_at`. A preview is temporary by rule, so the
   * visitor is told when it ends at the same moment they are given the link.
   */
  hostedPreviewExpiresAt?: string;
  sandboxId?: string;
  /**
   * FLOWSTARTER_LOCAL_PREVIEW mode: absolute path of the on-disk workspace the
   * local `astro dev` serves. The edit loop targets this when there is no
   * sandbox.
   */
  localRoot?: string;
  /** Absolute path to the site's single content file (for edits). */
  contentFile?: string;
  /** Relative path of that file inside the sandbox workspace. */
  contentRel: string;
  editsUsed: number;
  error?: string;
  /**
   * The phase the job was in when it failed. The error says what went wrong;
   * this says where, which is what the reliability ledger is grouped by.
   */
  failedPhase?: string;
  /** Latest streamed progress phase. */
  phase?: string;
  /**
   * Every phase this run has entered, with the second it started at. The SSE
   * stream replays this on connect, so a client that subscribes late (or
   * reconnects) still sees the whole story rather than only what happens next.
   */
  phases?: Array<{ phase: string; at: number }>;
  /** Base template live? then personalization hot-swapped in (progressive). */
  personalized?: boolean;
  /** Capped edit-loop state (see LIVE_EDIT_CAP). */
  editStatus?: 'idle' | 'editing' | 'done' | 'failed';
  editPhase?: string;
  editError?: string;
  createdAt: number;
  teardown?: () => Promise<void>;
  /**
   * The address the intake asked for with "Where should I send your preview
   * once it's ready?". Collected by the wizard since forever and, until the
   * preview-ready email existed, never used to send anything.
   */
  leadEmail?: string;
  /** The name to greet, and the business the preview is of. */
  leadName?: string;
  businessName?: string;
  /**
   * Set the instant the preview-ready email is attempted, so a second pass
   * over a job that is already `ready` cannot mail the visitor twice. The job
   * store is process-local, which is exactly the scope that matters here: the
   * ready transition happens once, in one process, in the detached generator
   * that owns the job.
   */
  readyEmailAt?: number;
}

// Anchored on globalThis, not module scope: in `next dev` every route handler
// is bundled as its own entry with its own instance of this module, so a plain
// module-level Map gives POST /live and POST /live/edit two different stores —
// the edit route 404'd "unknown demo" for jobs the live route reported ready.
// One process, one store, whichever bundle asks.
const globalStore = globalThis as typeof globalThis & {
  __flowstarterLiveJobs?: Map<string, LiveJob>;
};
const jobs = (globalStore.__flowstarterLiveJobs ??= new Map<string, LiveJob>());

export function createJob(demoId: string): LiveJob {
  const job: LiveJob = {
    demoId,
    status: 'building',
    contentRel: 'src/content/site-labels.md',
    editsUsed: 0,
    createdAt: Date.now(),
  };
  jobs.set(demoId, job);
  return job;
}

export function getJob(demoId: string): LiveJob | undefined {
  return jobs.get(demoId);
}

export function updateJob(demoId: string, patch: Partial<LiveJob>): void {
  const j = jobs.get(demoId);
  if (!j) return;
  const next = { ...j, ...patch };
  if (patch.phase && patch.phase !== j.phase) {
    next.phases = [
      ...(j.phases ?? []),
      { phase: patch.phase, at: Math.round((Date.now() - j.createdAt) / 1000) },
    ];
  }
  jobs.set(demoId, next);
}

/** Best-effort GC: tear down + drop demos older than the TTL. */
export async function reapStaleJobs(ttlMs = 45 * 60_000): Promise<void> {
  const now = Date.now();
  for (const [id, j] of Array.from(jobs.entries())) {
    if (now - j.createdAt > ttlMs) {
      try {
        await j.teardown?.();
      } catch {
        /* autoStopInterval is the backstop */
      }
      jobs.delete(id);
    }
  }
}

// `reapStaleJobs` used to only exist for callers to invoke; nothing did, so
// every local `astro dev` child (and every Daytona sandbox) a demo ever
// opened stayed up until the process restarted — ~12 zombies were found
// squatting ports on 2026-08-31. One interval per process, anchored on
// globalThis for the same reason the job Map is: `next dev` bundles this
// module once per route, and each bundle re-running this file must not start
// its own timer. `unref()` so it never keeps a short-lived process (tests,
// a serverless worker) alive just to be a backstop.
const REAP_INTERVAL_MS = 5 * 60_000;
const globalReaper = globalThis as typeof globalThis & {
  __flowstarterLiveJobsReaperStarted?: boolean;
};
if (!globalReaper.__flowstarterLiveJobsReaperStarted) {
  globalReaper.__flowstarterLiveJobsReaperStarted = true;
  const timer = setInterval(() => {
    void reapStaleJobs();
  }, REAP_INTERVAL_MS);
  timer.unref?.();
}
