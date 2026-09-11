'use client';

/**
 * The intake stage: the conversation and the preview it is building, side by
 * side, from the first question.
 *
 * `ConciergePanes` already does this for the later stages, but it is tuned
 * for a real site in an iframe -- a narrow conversation against a wide
 * viewport (0.62/1.38), and a mobile stack that puts the site pane above the
 * conversation. Neither is right while the questions are still being asked:
 * here the conversation is the work and the preview is the reward, so the
 * split is close to even, and on a phone there is no room for both at once.
 *
 * On a phone the preview collapses to a one-line status strip above the
 * conversation. Tapping it opens the pane; tapping again puts it away. The
 * strip is a real `button` with `aria-expanded`, not a tap-handler on a div,
 * so the same gesture works from the keyboard.
 */
import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { interpolate } from '../intake-script';

const KEY = 'landing.discovery.preview.pane.';

export function IntakeStage({
  conversation,
  preview,
  /** How many of the four shape-deciding answers have landed. */
  answeredCount,
  factTotal,
  t,
}: {
  conversation: ReactNode;
  preview: ReactNode;
  answeredCount: number;
  factTotal: number;
  t: (key: string) => string;
}) {
  const [stripOpen, setStripOpen] = useState(false);

  return (
    <div
      data-testid="intake-stage"
      className={[
        'grid grid-cols-1 gap-3',
        // Roughly 45/55 from 900px up: the conversation keeps enough room for
        // a comfortable bubble measure, the preview gets the larger half
        // because it is the thing being built.
        'min-[900px]:grid-cols-[minmax(0,0.45fr)_minmax(0,0.55fr)]',
        'min-[900px]:items-start min-[900px]:gap-5',
      ].join(' ')}
    >
      {/* The strip. Phone only: from 900px up the pane is always open and the
          strip has nothing to say. */}
      <button
        type="button"
        data-testid="preview-strip-toggle"
        onClick={() => setStripOpen((open) => !open)}
        aria-expanded={stripOpen}
        aria-controls="intake-preview-region"
        className={[
          'flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--fs-rule)]',
          'bg-white/60 px-3 py-2 text-left transition-colors dark:bg-white/[0.03]',
          'hover:border-[var(--purple-primary)]/40 min-[900px]:hidden',
        ].join(' ')}
      >
        <span className="min-w-0">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--fs-ink-faint)]">
            {t(`${KEY}title`)}
          </span>
          <span className="block truncate text-[12px] text-[var(--fs-ink)]">
            {interpolate(t(`${KEY}stripCount`), {
              done: answeredCount,
              total: factTotal,
            })}
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-[var(--fs-ink-faint)] transition-transform duration-200 ${
            stripOpen ? 'rotate-180' : ''
          }`}
          aria-hidden="true"
        />
      </button>

      {/* The pane. Hidden behind the strip on a phone, always on from 900px. */}
      <div
        id="intake-preview-region"
        data-testid="intake-preview-region"
        data-open={stripOpen ? 'yes' : 'no'}
        className={[
          stripOpen ? 'block' : 'hidden',
          'min-[900px]:block min-[900px]:col-start-2 min-[900px]:row-start-1',
        ].join(' ')}
      >
        {preview}
      </div>

      <div className="min-[900px]:col-start-1 min-[900px]:row-start-1 min-[900px]:min-w-0">
        {conversation}
      </div>
    </div>
  );
}
