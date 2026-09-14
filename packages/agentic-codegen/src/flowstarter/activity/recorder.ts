/**
 * The one place an activity event is made.
 *
 * The pipeline calls `phase()` where it already announces a phase and `tool()`
 * where a tool call starts; the recorder decides the rest. It holds the phase
 * so a tool event knows which part of the build it belongs to, it rate-limits
 * repeats so a thousand reads of one file cost one event a second rather than
 * a thousand rows, and it stops emitting at a hard cap so a runaway loop
 * cannot fill a table.
 *
 * Rate-limiting here and collapsing in `collapse.ts` are two halves of the
 * same idea at two different costs. The limiter protects the database and the
 * wire; the collapse protects the reader. Neither alone is enough: drop the
 * limiter and a build writes 40,000 rows, drop the collapse and a reconnecting
 * client still has to read them.
 */
import {
  assertSafeEvent,
  type ActivitySubject,
  type AgentActivityEvent,
  type AgentActivityKind,
} from './events';
import { subjectForPath } from './friendly-names';
import { activityForPhase, activityForToolCall } from './phase-rules';

export type AgentActivitySink = (event: AgentActivityEvent) => void;

/**
 * What the Pi session hands back on every tool call. It is deliberately the
 * raw pair and not an event: the session knows the tool name and its
 * arguments, and the rule that decides what those mean lives here, not in the
 * SDK wrapper.
 */
export type ActivityToolSink = (toolName: string, args: unknown) => void;

export interface ActivityRecorderOptions {
  /** Where an event goes. Must not throw; the recorder swallows what it does. */
  sink: AgentActivitySink;
  /** Injected so a test does not have to wait a second and a half. */
  now?: () => number;
  /** Shortest gap between two events with the same kind and subject. */
  minIntervalMs?: number;
  /** Events one run may emit before the rest are dropped. */
  maxEvents?: number;
}

/** A tool call repeated inside this window is one event, not two. */
export const ACTIVITY_MIN_INTERVAL_MS = 1_500;
/** What one run may write. A build that wants more is a build with a loop. */
export const ACTIVITY_MAX_EVENTS = 400;

export class ActivityRecorder {
  private readonly sink: AgentActivitySink;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxEvents: number;
  private readonly lastEmitted = new Map<string, number>();
  private currentPhase = '';
  private emitted = 0;

  constructor(options: ActivityRecorderOptions) {
    this.sink = options.sink;
    this.now = options.now ?? (() => Date.now());
    this.minIntervalMs = options.minIntervalMs ?? ACTIVITY_MIN_INTERVAL_MS;
    this.maxEvents = options.maxEvents ?? ACTIVITY_MAX_EVENTS;
  }

  /** How many events this run has written. For the cap, and for tests. */
  get eventCount(): number {
    return this.emitted;
  }

  /** The phase the recorder is currently attributing tool calls to. */
  get phaseName(): string {
    return this.currentPhase;
  }

  /**
   * A phase boundary. Always emitted: a phase is the skeleton of the story,
   * and a rate limiter that swallowed one would leave a gap nothing fills.
   */
  phase(phase: string, detail?: string): void {
    this.currentPhase = phase;
    const { kind, subject } = activityForPhase(phase);
    this.write(kind, subject, { detail: detail ?? phase, force: true });
  }

  /**
   * One tool call. `read_file` on a path the friendly-name rule cannot place
   * still produces a step, on `file.other`; a tool the table does not know
   * produces nothing at all.
   */
  tool(toolName: string, args: unknown): void {
    const match = activityForToolCall(toolName, args);
    if (!match) return;
    const subject: ActivitySubject = match.path
      ? subjectForPath(match.path)
      : toolName.includes('template')
        ? 'template.library'
        : 'site';
    this.write(match.kind, subject, {
      ...(match.path ? { detail: match.path } : {}),
      ...(match.chip ? { chips: [match.chip] } : {}),
    });
  }

  /** A gate ran. `verdict` is the operator's line; a client sees neither. */
  gate(subject: ActivitySubject, verdict?: string): void {
    this.write('checking', subject, {
      ...(verdict ? { detail: verdict } : {}),
      force: true,
    });
  }

  /** A repair pass started, against the gate that asked for it. */
  repair(subject: ActivitySubject, detail?: string): void {
    this.write('repairing', subject, {
      ...(detail ? { detail } : {}),
      force: true,
    });
  }

  /** The run finished. Emitted once; a second call is ignored. */
  finish(subject: ActivitySubject = 'site'): void {
    this.write('done', subject, { force: true });
  }

  /**
   * The run stopped at a gate. `subject` names the gate, `detail` is the
   * verdict the operator needs. Neither is ever a model's own words.
   */
  fail(subject: ActivitySubject, detail?: string): void {
    this.write('failed', subject, {
      ...(detail ? { detail } : {}),
      force: true,
    });
  }

  private write(
    kind: AgentActivityKind,
    subject: ActivitySubject,
    options: { detail?: string; chips?: string[]; force?: boolean } = {},
  ): void {
    if (this.emitted >= this.maxEvents) return;
    const now = this.now();
    const key = `${kind}:${subject}`;
    if (!options.force) {
      const previous = this.lastEmitted.get(key);
      if (previous !== undefined && now - previous < this.minIntervalMs) return;
    }
    this.lastEmitted.set(key, now);

    const event: AgentActivityEvent = {
      at: new Date(now).toISOString(),
      phase: this.currentPhase,
      kind,
      subject,
      ...(options.detail ? { detail: options.detail.slice(0, 300) } : {}),
      ...(options.chips && options.chips.length > 0
        ? { chips: options.chips }
        : {}),
    };

    try {
      this.sink(assertSafeEvent(event));
      this.emitted += 1;
    } catch {
      // A step nobody can read is worth less than a build that finishes. An
      // event that fails validation is dropped, not repaired: a repaired
      // event is an invented one.
    }
  }
}
