'use client';

/**
 * The stepper above the discovery conversation.
 *
 * The graph and scripted conversations used to draw their own thin progress
 * bar, seeded with a `{ done: 0, total: 1 }` placeholder that read "0/1"
 * until the first network turn landed. This component replaces that: it
 * shows every stage of the questionnaire from the very first frame, with the
 * current one highlighted, and computes the questions-answered count from
 * the script itself rather than waiting on a round trip.
 *
 * Pure and presentational — the order of stages, which one is current, and
 * how far the conversation has got are all decided elsewhere
 * (`discovery.logic.ts`, `intake-script.ts`); this only draws the decision.
 */
import { Check } from 'lucide-react';
import type { DiscoveryData, Step } from './discovery.logic';
import {
  CONVERSATION_LAST_STEP,
  conversationProgress,
  interpolate,
  type IntakeQuestionId,
} from './intake-script';

type StageStatus = 'done' | 'current' | 'upcoming';

function stageStatus(n: Step, current: Step): StageStatus {
  if (n < current) return 'done';
  if (n === current) return 'current';
  return 'upcoming';
}

const circleBase =
  'relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-colors';

const circleByStatus: Record<StageStatus, string> = {
  done: 'bg-[var(--purple-primary)] text-white',
  current:
    'border-2 border-[var(--purple-primary)] bg-[var(--fs-bg-elevated)] text-[var(--purple-primary)] shadow-[0_0_0_4px_var(--purple-primary-lightest)]',
  upcoming:
    'border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)] text-[var(--fs-ink-faint)]',
};

const labelByStatus: Record<StageStatus, string> = {
  done: 'text-[var(--fs-ink)]',
  current: 'font-bold text-[var(--fs-ink)]',
  upcoming: 'text-[var(--fs-ink-faint)]',
};

export function DiscoveryStepper({
  steps,
  current,
  data,
  answered,
  t,
}: {
  steps: ReadonlyArray<{ n: Step; key: string }>;
  current: Step;
  data: DiscoveryData;
  answered: readonly IntakeQuestionId[];
  t: (key: string) => string;
}) {
  const currentStage = steps.find((stage) => stage.n === current);
  const currentLabel = currentStage
    ? t(`landing.discovery.stepper.${currentStage.key}`)
    : '';
  const { done, total } = conversationProgress(data, answered);
  // The questionnaire is over once the wizard has moved past the scripted
  // conversation — the info agent and the preview have nothing left to count.
  const showsProgress = current <= CONVERSATION_LAST_STEP;

  return (
    <nav
      aria-label={t('landing.discovery.stepper.label')}
      data-testid="discovery-stepper"
      className="mb-5"
    >
      <ol className="flex items-start justify-between gap-0.5 pt-1 sm:gap-1">
        {steps.map((stage, index) => {
          const status = stageStatus(stage.n, current);
          const label = t(`landing.discovery.stepper.${stage.key}`);
          // The rule between two circles is "filled" once the visitor has
          // walked past the stage on its left.
          const lineFilled = index > 0 && steps[index - 1].n < current;
          return (
            <li
              key={stage.n}
              data-state={status}
              aria-current={status === 'current' ? 'step' : undefined}
              className={`relative flex flex-1 flex-col items-center gap-1.5 px-0.5 text-center ${
                index === 0
                  ? ''
                  : `before:absolute before:right-1/2 before:top-4 before:z-0 before:h-px before:w-full before:content-[''] ${
                      lineFilled
                        ? 'before:bg-[var(--purple-primary)]'
                        : 'before:bg-[var(--fs-rule)]'
                    }`
              }`}
            >
              <span className={`${circleBase} ${circleByStatus[status]}`}>
                {status === 'done' ? (
                  <Check className="h-4 w-4" aria-hidden="true" />
                ) : (
                  stage.n
                )}
              </span>
              <span
                className={`hidden text-[11px] leading-tight sm:text-xs lg:inline ${labelByStatus[status]}`}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ol>

      {/* Below `lg` the circles carry no labels, so this one line names the
          current stage instead.
          While the scripted conversation is still running, its denominator
          must be the same `total` the progress line below draws from
          (`conversationProgress`, ultimately the quick phase's own question
          count — see the readiness review's "Step 1 of 6" vs "0 of 4
          questions answered" finding). Past the quick phase there is no
          question count on screen to contradict, so the line falls back to
          naming the visitor's place among the wizard's own stages. */}
      <p className="mt-2 text-center text-xs text-[var(--fs-ink-faint)] lg:hidden">
        {interpolate(t('landing.discovery.stepper.position'), {
          n: current,
          total: showsProgress ? total : steps.length,
          label: currentLabel,
        })}
      </p>

      {showsProgress && (
        <div className="mt-3 flex items-center gap-3">
          <div
            className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--fs-rule)]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            aria-label={t('landing.discovery.chat.progressLabel')}
          >
            <div
              className="h-full rounded-full bg-[var(--purple-primary)] transition-[width] duration-300"
              style={{
                width: `${
                  total === 0 ? 100 : Math.round((done / total) * 100)
                }%`,
              }}
            />
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-[var(--fs-ink-faint)]">
            {interpolate(t('landing.discovery.chat.progressCount'), {
              done,
              total,
            })}
          </span>
        </div>
      )}
    </nav>
  );
}
