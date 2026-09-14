/**
 * Events in, sentences out.
 *
 * The pipeline emits `AgentActivityEvent`s with a `kind` and a `subject`, both
 * tokens from a closed set. The collapse rule in `@flowstarter/agentic-codegen`
 * folds the bursts. This is the last step: it looks each token up in the
 * dictionary and hands the design system a list of finished phrases.
 *
 * The two halves of a step are looked up separately --
 * `agentActivity.step.editing.active` and
 * `agentActivity.subject.section.services` -- so a language that words a verb
 * differently only has to say so once, and a subject that gains a row in the
 * codegen table without a row here is caught by the test that walks both
 * lists rather than by a client reading a token on their dashboard.
 *
 * Nothing here can invent a step. Given no events it returns no steps, and the
 * caller shows whatever it showed before the agent started.
 */
// Deep import, not the package root: the root re-exports the Pi SDK and the
// whole generation pipeline, and this module is imported by browser code.
import {
  ACTIVITY_SUBJECTS,
  AGENT_ACTIVITY_KINDS,
  activityStatus,
  collapseActivity,
  summariseActivity,
  type AgentActivityEvent,
} from '@flowstarter/agentic-codegen/src/flowstarter/activity';
import type { AgentActivityStep } from '@flowstarter/flow-design-system';

/**
 * The dictionary, as this module needs it. The app's own `t` is typed against
 * the literal key catalogue, which a key built at runtime cannot satisfy, so
 * the boundary is crossed once here rather than cast at every lookup.
 */
export type ActivityTranslate = (
  key: string,
  vars?: Record<string, string | number>
) => string;

/** The one cast. Hand it the app's `t` and get the shape this module wants. */
export function activityTranslate(t: unknown): ActivityTranslate {
  return t as ActivityTranslate;
}

/** Every dictionary key the timeline can ask for. The test walks this. */
export function activityCopyKeys(): string[] {
  const keys = [
    'agentActivity.step.repeat',
    'agentActivity.failure',
    'agentActivity.summary.page',
    'agentActivity.summary.pages',
    'agentActivity.summary.check',
    'agentActivity.summary.checks',
    'agentActivity.summary.repair',
    'agentActivity.summary.repairs',
    'agentActivity.summary.empty',
    'agentActivity.expand',
    'agentActivity.collapse',
    'agentActivity.region',
  ];
  for (const kind of AGENT_ACTIVITY_KINDS) {
    keys.push(`agentActivity.step.${kind}.active`);
    keys.push(`agentActivity.step.${kind}.past`);
  }
  for (const subject of ACTIVITY_SUBJECTS) {
    keys.push(`agentActivity.subject.${subject}`);
  }
  return keys;
}

export interface ActivityStepsOptions {
  /**
   * Show the operator's extra: the file path a step touched, the raw gate
   * verdict. Operators get it because they are the ones who fix the thing; a
   * client is told the services section was edited, not which file that is.
   */
  detail?: boolean;
  /** Newest steps kept. The oldest fall off the top. */
  maxSteps?: number;
  /**
   * The run's status, when the surface knows it better than the events do.
   * Without it the newest step keeps the live dot and the present tense even
   * on a run the caller has already been told is over.
   */
  status?: 'running' | 'done' | 'failed';
}

/**
 * Turn the raw events into the steps the timeline draws. Oldest first, the
 * live one marked, nothing invented for an event that never arrived.
 */
export function activitySteps(
  events: readonly AgentActivityEvent[],
  t: ActivityTranslate,
  options: ActivityStepsOptions = {}
): AgentActivityStep[] {
  const items = collapseActivity(events, {
    ...(options.detail ? { keepDetail: true } : {}),
    ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
    ...(options.status ? { status: options.status } : {}),
  });

  return items.map((item) => {
    const tense = item.state === 'active' ? 'active' : 'past';
    const subject = t(`agentActivity.subject.${item.subject}`);
    const base = t(`agentActivity.step.${item.kind}.${tense}`, { subject });
    // A count is shown, never described. "(6)" after a step says the agent
    // came back to it six times without spending a clause saying so.
    const label =
      item.count > 1
        ? t('agentActivity.step.repeat', { label: base, count: item.count })
        : base;

    return {
      id: item.id,
      kind: item.kind,
      label,
      ...(options.detail && item.detail ? { detail: item.detail } : {}),
      ...(item.chips.length > 0 ? { chips: item.chips } : {}),
      state: item.state,
    };
  });
}

/**
 * The one line a finished run folds to. Counts only: "Built 4 pages, checked
 * 6 rules, 2 repairs". A count of zero is left out rather than printed,
 * because "0 repairs" is a boast and this surface does not boast.
 */
export function activitySummaryLine(
  events: readonly AgentActivityEvent[],
  t: ActivityTranslate
): string {
  const summary = summariseActivity(events);
  const parts: string[] = [];
  const add = (count: number, one: string, many: string) => {
    if (count <= 0) return;
    parts.push(t(count === 1 ? one : many, { count }));
  };
  add(
    summary.pages,
    'agentActivity.summary.page',
    'agentActivity.summary.pages'
  );
  add(
    summary.checks,
    'agentActivity.summary.check',
    'agentActivity.summary.checks'
  );
  add(
    summary.repairs,
    'agentActivity.summary.repair',
    'agentActivity.summary.repairs'
  );
  if (parts.length === 0) return t('agentActivity.summary.empty');
  return parts.join(', ');
}

/**
 * What stopped it, in plain words: the gate, named from the same token the
 * board uses. Empty when the run did not fail, so a caller can pass it
 * straight through without a branch of its own.
 */
export function activityFailureLine(
  events: readonly AgentActivityEvent[],
  t: ActivityTranslate
): string {
  const summary = summariseActivity(events);
  if (!summary.failedAt) return '';
  return t('agentActivity.failure', {
    subject: t(`agentActivity.subject.${summary.failedAt}`),
  });
}

/** The run's status, read off its events. Re-exported so a caller imports once. */
export { activityStatus };
