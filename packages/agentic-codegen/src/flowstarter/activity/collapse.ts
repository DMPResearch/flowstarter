/**
 * Twenty reads of one file are one step.
 *
 * A build emits hundreds of events. Shown one per line they are a log, and a
 * log is the thing this feature exists to not be. The collapse rule is the
 * whole difference: adjacent events that are the same work on the same thing
 * fold into one step with a count, so "read the services section" appears
 * once however many times the agent looked at it, and a run of edits to one
 * section reads as "editing the services section" rather than as nine lines
 * that each say a little less than the one above.
 *
 * Two things it will not do. It will not reorder unrelated work: the lookback
 * is three steps, so an event only folds into something still on screen. And
 * it will not merge across a long pause -- a second visit to the same section
 * twenty minutes later is a second visit, and saying otherwise would hide the
 * repair loop that caused it.
 */
import type {
  ActivitySubject,
  AgentActivityEvent,
  AgentActivityKind,
} from './events';

/** One line of the timeline: a burst of events that were the same work. */
export interface AgentActivityItem {
  /** Stable across re-renders of a growing list. */
  id: string;
  phase: string;
  kind: AgentActivityKind;
  subject: ActivitySubject;
  /** How many events folded in. 1 when the step stands alone. */
  count: number;
  /** When the burst started, and when its last event landed. */
  at: string;
  endedAt: string;
  /** The operator's extra, most recent wins. Absent unless `keepDetail`. */
  detail?: string;
  chips: string[];
  state: 'active' | 'done' | 'failed';
}

export interface CollapseOptions {
  /**
   * Keep `detail`. Off by default, because `detail` is where the file paths
   * and the raw gate verdicts live and a client is shown neither.
   */
  keepDetail?: boolean;
  /** How far back a matching step may be and still absorb an event. */
  lookback?: number;
  /** Longest gap, in ms, a burst may span before the next event starts a step. */
  burstWindowMs?: number;
  /** Newest steps kept. Older ones are dropped from the front. */
  maxSteps?: number;
  /** Chips kept per step, oldest first. */
  maxChipsPerStep?: number;
  /**
   * The run's status, when the caller knows it better than the events do.
   *
   * A timeline usually reads its own status off its last event, which is
   * right for a build: the worker writes a `done` or a `failed` step and the
   * list ends there. It is wrong wherever the run's end is known outside the
   * event list -- the funnel learns its preview failed from the stream's
   * `failed` frame, and the editor knows it is between requests -- and
   * without this the newest step would keep the live styling and the present
   * tense while nothing at all was happening.
   */
  status?: 'running' | 'done' | 'failed';
}

const DEFAULTS = {
  lookback: 3,
  burstWindowMs: 120_000,
  maxSteps: 200,
  maxChipsPerStep: 6,
} as const;

function instant(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The run's own status, read from its events rather than asked for. A run
 * whose last event is `done` is done, one whose last is `failed` failed, and
 * anything else is still going -- including a run whose events simply stop,
 * which is the truthful answer for a worker that died mid-build.
 */
export function activityStatus(
  events: readonly AgentActivityEvent[],
): 'running' | 'done' | 'failed' {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const kind = events[index]?.kind;
    if (kind === 'failed') return 'failed';
    if (kind === 'done') return 'done';
  }
  return events.length > 0 ? 'running' : 'running';
}

/** The collapse rule. Events oldest first in, steps oldest first out. */
export function collapseActivity(
  events: readonly AgentActivityEvent[],
  options: CollapseOptions = {},
): AgentActivityItem[] {
  const lookback = options.lookback ?? DEFAULTS.lookback;
  const burstWindowMs = options.burstWindowMs ?? DEFAULTS.burstWindowMs;
  const maxSteps = options.maxSteps ?? DEFAULTS.maxSteps;
  const maxChips = options.maxChipsPerStep ?? DEFAULTS.maxChipsPerStep;

  const items: AgentActivityItem[] = [];
  let sequence = 0;

  for (const event of events) {
    const at = instant(event.at);
    // A terminal step never absorbs and is never absorbed: "done" is a line
    // of its own, always, or a run that ends in a burst would hide its end.
    const mergeable = event.kind !== 'done' && event.kind !== 'failed';
    let target: AgentActivityItem | undefined;
    if (mergeable) {
      const from = Math.max(0, items.length - lookback);
      for (let index = items.length - 1; index >= from; index -= 1) {
        const candidate = items[index];
        if (!candidate) continue;
        if (candidate.kind !== event.kind) continue;
        if (candidate.subject !== event.subject) continue;
        if (at - instant(candidate.endedAt) > burstWindowMs) continue;
        target = candidate;
        break;
      }
    }

    if (target) {
      target.count += 1;
      target.endedAt = event.at;
      if (options.keepDetail && event.detail) target.detail = event.detail;
      for (const chip of event.chips ?? []) {
        if (target.chips.length >= maxChips) break;
        if (!target.chips.includes(chip)) target.chips.push(chip);
      }
      continue;
    }

    sequence += 1;
    items.push({
      id: `${event.phase}:${event.kind}:${event.subject}:${sequence}`,
      phase: event.phase,
      kind: event.kind,
      subject: event.subject,
      count: 1,
      at: event.at,
      endedAt: event.at,
      ...(options.keepDetail && event.detail ? { detail: event.detail } : {}),
      chips: (event.chips ?? []).slice(0, maxChips),
      state: 'done',
    });
  }

  const status = options.status ?? activityStatus(events);
  const last = items[items.length - 1];
  if (last) {
    if (last.kind === 'failed') last.state = 'failed';
    else if (status === 'running') last.state = 'active';
  }

  return items.length > maxSteps ? items.slice(items.length - maxSteps) : items;
}

/**
 * The one line a finished run collapses to. Counts, never adjectives: pages
 * touched, rules checked, repairs attempted. A count of zero is left out by
 * the caller rather than printed, because "0 repairs" is a boast.
 */
export interface ActivitySummary {
  /** Distinct pages the run built or edited. */
  pages: number;
  /** Gate checks the run ran. */
  checks: number;
  /** Repair passes the run took. */
  repairs: number;
  /** The gate that stopped it, when one did. */
  failedAt?: ActivitySubject;
}

export function summariseActivity(
  events: readonly AgentActivityEvent[],
): ActivitySummary {
  const pages = new Set<ActivitySubject>();
  let checks = 0;
  let repairs = 0;
  let failedAt: ActivitySubject | undefined;

  for (const event of events) {
    if (event.kind === 'checking') checks += 1;
    if (event.kind === 'repairing') repairs += 1;
    if (event.kind === 'failed') failedAt = event.subject;
    if (
      (event.kind === 'editing' || event.kind === 'building') &&
      event.subject.startsWith('page.')
    ) {
      pages.add(event.subject);
    }
  }

  return {
    pages: pages.size,
    checks,
    repairs,
    ...(failedAt ? { failedAt } : {}),
  };
}
