/**
 * Where the project has got to, as six labelled steps.
 *
 * No enum names reach the page — every string comes from `PROJECT_STAGES`.
 *
 * On a phone the six steps do not become six full-width rows. Stacked, they
 * take up most of the screen and read as a checklist of things the client has
 * to do, which is the opposite of what a progress bar is for. So below `sm`
 * the list is one horizontally scrollable row with snap points, and the stage
 * the client is actually on is scrolled into view. The only reason this is a
 * client component is that last part: where a scroll container starts is not
 * something CSS can express.
 */
'use client';

import { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
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
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const row = list.current;
    // Only when the row actually scrolls, so the desktop layout is untouched
    // and nothing moves for a project sitting on its first stage.
    if (!row || row.scrollWidth <= row.clientWidth) return;

    const current = row.querySelector<HTMLElement>('[data-status="current"]');
    if (!current) return;

    // Set `scrollLeft` rather than calling `scrollIntoView`, which would also
    // scroll the page and drag the client away from the top of their dashboard.
    row.scrollLeft = Math.max(
      0,
      current.offsetLeft - (row.clientWidth - current.offsetWidth) / 2
    );
  }, [state]);

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
        ref={list}
        aria-label="Project progress"
        className={cn(
          'flex gap-2 overflow-x-auto pb-1',
          'snap-x snap-mandatory scroll-px-1 [scrollbar-width:none]',
          '[&::-webkit-scrollbar]:hidden',
          // The right edge fades out so it is obvious there is more row. A mask
          // rather than an overlaid gradient, because the strip behind it is
          // translucent glass and a solid gradient would have nothing to match.
          '[mask-image:linear-gradient(to_right,#000_0,#000_calc(100%-2rem),transparent_100%)]',
          // From `sm` up, all six fit: no scrolling, no snapping, no mask.
          'sm:items-stretch sm:overflow-visible sm:pb-0',
          'sm:snap-none sm:[mask-image:none]'
        )}
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
                'flex shrink-0 items-center justify-center gap-1.5',
                'snap-start rounded-[var(--fs-radius-glass-inner)] border px-3 py-2.5',
                'text-center text-xs font-semibold transition-colors',
                'sm:flex-1 sm:shrink',
                // Only one pill is filled, and it is the one the client is on.
                // Five green pills next to it made the row read as a wall of
                // colour where every step was shouting equally; a finished step
                // does not need a fill to say it is finished, it needs a tick.
                status === 'current' &&
                  'border-[var(--fs-tone-accent-edge)] bg-[var(--fs-tone-accent-emphasis)] text-[var(--fs-tone-accent)] shadow-[0_0_0_1px_var(--fs-tone-accent-edge),0_14px_32px_-14px_var(--fs-tone-accent-glow)]',
                status === 'done' &&
                  'border-[var(--fs-glass-edge)] bg-[var(--fs-tone-neutral-soft)] text-[var(--fs-ink)]',
                status === 'upcoming' &&
                  'border-[var(--fs-tone-neutral-edge)] bg-[var(--fs-tone-neutral-soft)] text-[var(--fs-tone-neutral)]'
              )}
            >
              {status === 'done' && (
                <Check
                  size={14}
                  strokeWidth={3}
                  aria-hidden="true"
                  className="shrink-0 text-[var(--fs-tone-ok)]"
                />
              )}
              {stage.label}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export default ProjectStateStepper;
