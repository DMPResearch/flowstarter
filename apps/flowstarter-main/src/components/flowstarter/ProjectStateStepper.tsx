/**
 * Where the project has got to, as six labelled steps.
 *
 * Server-renderable: it takes a state and renders. No enum names reach the
 * page — every string comes from `PROJECT_STAGES`.
 */
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { cn } from '@/lib/utils';
import { PROJECT_STAGES, currentStage, stageStatus } from './project-progress';

export function ProjectStateStepper({
  state,
  className,
}: {
  state: ProjectState;
  className?: string;
}) {
  const here = currentStage(state);

  return (
    <div className={cn('flex flex-col gap-5', className)}>
      <div>
        <h2
          className="text-xl font-bold text-[var(--fs-ink)]"
          data-testid="project-stage-title"
        >
          {here.title}
        </h2>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-[var(--fs-ink-dim)]">
          {here.detail}
        </p>
      </div>

      <ol
        className="flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-2"
        aria-label="Project progress"
      >
        {PROJECT_STAGES.map((stage) => {
          const status = stageStatus(stage, state);
          return (
            <li
              key={stage.state}
              data-testid="project-stage"
              data-state={stage.state}
              data-status={status}
              aria-current={status === 'current' ? 'step' : undefined}
              className={cn(
                'flex-1 rounded-[var(--fs-radius-glass-inner)] border px-3 py-2.5 text-center text-xs font-semibold transition-colors',
                // Three tones, one vocabulary with the tiles above: accent is
                // "you are here", ok is "done", neutral is "not yet". The pill
                // used to borrow the landing page's button gradient, which tied
                // a progress indicator to a marketing CTA and put white text on
                // a light fill in dark mode.
                // The live step carries a second edge and a glow so it still
                // wins the row when five done steps are sitting next to it.
                status === 'current' &&
                  'border-[var(--fs-tone-accent-edge)] bg-[var(--fs-tone-accent-soft)] text-[var(--fs-tone-accent)] shadow-[0_0_0_1px_var(--fs-tone-accent-edge),0_14px_32px_-14px_var(--fs-tone-accent-glow)]',
                status === 'done' &&
                  'border-[var(--fs-tone-ok-edge)] bg-[var(--fs-tone-ok-soft)] text-[var(--fs-tone-ok)]',
                status === 'upcoming' &&
                  'border-[var(--fs-tone-neutral-edge)] bg-[var(--fs-tone-neutral-soft)] text-[var(--fs-tone-neutral)]'
              )}
            >
              {stage.label}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export default ProjectStateStepper;
