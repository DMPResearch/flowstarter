/**
 * What the agent is doing, while it does it.
 *
 * A header that names the work and spins while it runs, a vertical timeline of
 * the steps already taken, and one line of summary once it is over. It is the
 * same shape a reader already knows from a search assistant: the detail is
 * there if you want it, folded away if you do not.
 *
 * It renders steps, not events. The rules that turn a pipeline's structured
 * events into steps -- collapsing a burst of reads into one line, turning a
 * file path into "the home page copy" -- live in `@flowstarter/agentic-codegen`
 * and run before this component is ever called, and the phrasing comes from
 * the caller's own locale. Nothing here invents a word: a step with no label
 * is a step this component will not draw.
 *
 * Quiet by design. The timeline is a 1px rule, the dots are ink at two
 * weights and the chips are neutral pills, because a list of twenty steps
 * each wearing its own colour is a list nobody reads. The one exception is a
 * failure, which takes the danger ink, since that is the line the reader has
 * to find.
 */
'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import {
  GlassSurface,
  type GlassSurfaceVariant,
} from '../surfaces/GlassSurface';
import { Pill } from '../surfaces/Pill';

/**
 * What the agent was doing when the step happened. One closed set, so a step
 * can never arrive wearing a verb the design system has no dot for.
 */
export const AGENT_ACTIVITY_KINDS = [
  'thinking',
  'reading',
  'editing',
  'searching',
  'checking',
  'repairing',
  'building',
  'publishing',
  'done',
  'failed',
] as const;

export type AgentActivityKind = (typeof AGENT_ACTIVITY_KINDS)[number];

/** Where a step is in its own little life. */
export type AgentActivityStepState = 'active' | 'done' | 'failed';

export interface AgentActivityStep {
  /** Stable across re-renders, so a streaming list does not re-mount itself. */
  id: string;
  kind: AgentActivityKind;
  /**
   * The whole step, in one phrase, already in the reader's language. Past
   * tense for a step that is over, present participle for the live one.
   */
  label: string;
  /** A second line, when there is genuinely more to say. Optional on purpose. */
  detail?: string;
  /** Searches and library lookups, as chips inside the step. */
  chips?: string[];
  /** Defaults to `done`; the caller marks the live one `active`. */
  state?: AgentActivityStepState;
}

export type AgentActivityStatus = 'running' | 'done' | 'failed';

export interface AgentActivityLabels {
  /** Reached by a screen reader only, naming the region. */
  region: string;
  /** The button that opens the timeline. */
  expand: string;
  /** The button that folds it away. */
  collapse: string;
}

const DEFAULT_LABELS: AgentActivityLabels = {
  region: 'Agent activity',
  expand: 'Show the steps',
  collapse: 'Hide the steps',
};

export interface AgentActivityProps
  extends Omit<HTMLAttributes<HTMLElement>, 'onChange' | 'title'> {
  /** Whether the work is still running, finished, or stopped at a gate. */
  status: AgentActivityStatus;
  /** The line of the header that says what kind of work this is. */
  headline: string;
  /** What the work is about: a page, a site, a change. Optional. */
  topic?: string;
  /** Oldest first. The component does not sort. */
  steps: AgentActivityStep[];
  /**
   * The one line shown when the timeline is folded away and the work is
   * over: "Built 4 pages, checked 6 rules, 2 repairs".
   */
  summary?: string;
  /**
   * What stopped it, in plain words. Shown under the header on a failure, so
   * a reader who never opens the timeline still learns which gate it was.
   */
  failure?: string;
  /** Open on first render. Defaults to open while running, folded when over. */
  defaultOpen?: boolean;
  /** Controlled open state. Pass `onOpenChange` with it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Which rung of the glass ladder to sit on. Defaults to `card`. */
  surface?: GlassSurfaceVariant;
  /** Tightens the padding, for a panel beside a preview rather than a page section. */
  dense?: boolean;
  /** Screen-reader and button copy. Supply these from the app's own locale. */
  labels?: Partial<AgentActivityLabels>;
  /** Rendered under the timeline: a cancel button, a link to the board. */
  footer?: ReactNode;
  className?: string;
}

/**
 * The live step is the one a screen reader is told about, and the one the
 * list scrolls to. A list with none (everything finished) has no live step,
 * which is the correct answer rather than a fallback to the last one.
 */
function findActiveStep(
  steps: AgentActivityStep[],
): AgentActivityStep | undefined {
  return steps.find((step) => step.state === 'active');
}

export function AgentActivity({
  status,
  headline,
  topic,
  steps,
  summary,
  failure,
  defaultOpen,
  open: controlledOpen,
  onOpenChange,
  surface = 'card',
  dense = false,
  labels,
  footer,
  className = '',
  ...props
}: AgentActivityProps) {
  const copy = { ...DEFAULT_LABELS, ...labels };
  const bodyId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(
    defaultOpen ?? status === 'running',
  );
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;
  const listRef = useRef<HTMLOListElement>(null);

  const toggle = useCallback(() => {
    const next = !isOpen;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }, [isControlled, isOpen, onOpenChange]);

  const activeStep = findActiveStep(steps);

  // Keep the newest step in view as they stream in, and only then: a list the
  // reader has scrolled back through should not yank itself forward, so this
  // does nothing once the work is over.
  useEffect(() => {
    if (!isOpen || status !== 'running') return;
    const list = listRef.current;
    if (!list) return;
    const last = list.lastElementChild;
    if (last && 'scrollIntoView' in last) {
      (last as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [isOpen, status, steps.length]);

  const classes = ['fs-activity', dense ? 'fs-activity--dense' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <GlassSurface
      as="section"
      variant={surface}
      dense={dense}
      className={classes}
      data-status={status}
      aria-label={copy.region}
      {...props}
    >
      <button
        type="button"
        className="fs-activity__header fs-focus-ring"
        aria-expanded={isOpen}
        aria-controls={bodyId}
        aria-label={isOpen ? copy.collapse : copy.expand}
        onClick={toggle}
      >
        <span className="fs-activity__glyph" aria-hidden="true">
          {status === 'running' ? (
            <span className="fs-activity__spinner" />
          ) : (
            <span className="fs-activity__mark" />
          )}
        </span>
        <span className="fs-activity__heading">
          <span className="fs-activity__headline">{headline}</span>
          {topic ? (
            <>
              <span className="fs-activity__sep" aria-hidden="true">
                ·
              </span>
              <span className="fs-activity__topic">{topic}</span>
            </>
          ) : null}
        </span>
        <span className="fs-activity__chevron" aria-hidden="true" />
      </button>

      {/* The live region carries only the step that is running now. It is
          separate from the list because the list is a history: announcing all
          of it on every append would read the whole build out loud. */}
      <p className="fs-activity__announce" role="status" aria-live="polite">
        {activeStep ? activeStep.label : ''}
      </p>

      {failure ? <p className="fs-activity__failure">{failure}</p> : null}

      {isOpen ? (
        <div className="fs-activity__body" id={bodyId}>
          <ol className="fs-activity__list" ref={listRef}>
            {steps.map((step) => (
              <li
                key={step.id}
                className="fs-activity__step"
                data-state={step.state ?? 'done'}
                data-kind={step.kind}
              >
                <span className="fs-activity__dot" aria-hidden="true" />
                <span className="fs-activity__step-body">
                  <span className="fs-activity__label">{step.label}</span>
                  {step.detail ? (
                    <span className="fs-activity__detail">{step.detail}</span>
                  ) : null}
                  {step.chips && step.chips.length > 0 ? (
                    <span className="fs-activity__chips">
                      {step.chips.map((chip, index) => (
                        <Pill
                          key={`${step.id}-chip-${index}`}
                          size="sm"
                          tone="neutral"
                          className="fs-activity__chip"
                        >
                          {chip}
                        </Pill>
                      ))}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
          {footer ? <div className="fs-activity__footer">{footer}</div> : null}
        </div>
      ) : summary ? (
        <p className="fs-activity__summary" id={bodyId}>
          {summary}
        </p>
      ) : null}
    </GlassSurface>
  );
}

AgentActivity.displayName = 'AgentActivity';
