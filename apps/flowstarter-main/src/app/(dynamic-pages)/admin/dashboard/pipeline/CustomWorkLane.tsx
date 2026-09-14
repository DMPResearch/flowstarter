'use client';

/**
 * The "Custom work" lane, rendered above the project columns.
 *
 * Above and not beside, because it is a different kind of thing: the columns
 * below are one project's journey through six states, and this is a list of
 * people nobody has replied to yet. Putting it in the row of columns would
 * have made it look like a seventh state a project can be in, which is exactly
 * the misreading `custom-work-lane.ts` explains at length.
 *
 * A card shows the brief, the evidence the classifier quoted, and one action.
 * The evidence is the point: an operator should be able to see, without
 * opening anything, why this person was routed away from the generator, and be
 * able to disagree with it.
 *
 * Exported as its own module for the same reason `PipelineColumns.tsx` is: a
 * page component can only export the page, and the design gallery renders this
 * on fixture data.
 */
import { Check, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CustomWorkCard } from '@/hooks/useCustomWorkLane';

const CARD =
  'rounded-xl border border-[var(--ls-rule)] bg-[var(--ls-glass-bg)] p-4';

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-[var(--fs-tone-neutral-soft)] px-2 py-0.5 text-[11px] text-[var(--fs-ink-faint)]">
      {children}
    </span>
  );
}

export function CustomWorkLeadCard({
  card,
  onMarkContacted,
  marking,
  t,
}: {
  card: CustomWorkCard;
  onMarkContacted: (id: string) => void;
  marking: boolean;
  t: (key: string) => string;
}) {
  return (
    <article
      className={[
        CARD,
        // The same left rule the stalled project card wears, and the same red,
        // so "needs a person" is one mark on this board rather than two.
        card.needsAttention
          ? 'border-l-2 border-l-[var(--fs-tone-danger)]'
          : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-semibold text-[var(--fs-ink)]">{card.name}</p>
          <p className="text-xs text-[var(--fs-ink-faint)]">{card.email}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip>
            {t('admin.customWork.card.waitingFor')} {card.waitingFor}
          </Chip>
          <Chip>{card.bookingStatus}</Chip>
          {card.source === 'contact_form' && (
            <Chip>{t('admin.customWork.card.viaForm')}</Chip>
          )}
        </div>
      </header>

      <p className="mt-3 text-sm text-[var(--fs-ink)]">{card.description}</p>

      {card.linkUrl && (
        <p className="mt-2 truncate text-xs text-[var(--fs-ink-faint)]">
          {card.linkUrl}
        </p>
      )}

      {card.evidence.length > 0 && (
        <div className="mt-3">
          <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[var(--fs-ink-faint)]">
            <Sparkles className="h-3 w-3" aria-hidden />
            {t('admin.customWork.card.evidence')}
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {card.evidence.map((fragment) => (
              <li
                key={fragment}
                className="text-xs italic text-[var(--fs-ink-faint)]"
              >
                {fragment}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-[11px] text-[var(--fs-ink-faint)]">
        {t('admin.customWork.card.classifier')} {card.classifier} ({card.scope},{' '}
        {card.confidence.toFixed(2)}) {card.routeRule}
      </p>

      {card.confirmationSentAt === null && (
        <p className="mt-2 text-[11px] text-[var(--fs-tone-danger)]">
          {t('admin.customWork.card.noConfirmation')}
        </p>
      )}

      <div className="mt-3">
        {card.contacted ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-[var(--fs-ink-faint)]">
            <Check className="h-3.5 w-3.5" aria-hidden />
            {t('admin.customWork.card.contacted')}
          </span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={marking}
            onClick={() => onMarkContacted(card.id)}
          >
            {marking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : null}
            {marking
              ? t('admin.customWork.card.marking')
              : t('admin.customWork.card.markContacted')}
          </Button>
        )}
      </div>
    </article>
  );
}

export function CustomWorkLane({
  cards,
  waitingCount,
  onMarkContacted,
  markingId,
  t,
}: {
  cards: readonly CustomWorkCard[];
  waitingCount: number;
  onMarkContacted: (id: string) => void;
  markingId: string | null;
  t: (key: string) => string;
}) {
  return (
    <section className="mb-6">
      <header className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-[var(--fs-ink)]">
          {t('admin.customWork.lane.title')}
        </h2>
        {waitingCount > 0 && (
          <span className="rounded-full bg-[var(--fs-tone-danger-soft,var(--fs-tone-neutral-soft))] px-2 py-0.5 text-[11px] text-[var(--fs-ink-faint)]">
            {waitingCount} {t('admin.customWork.lane.waiting')}
          </span>
        )}
      </header>

      {cards.length === 0 ? (
        <p className="text-sm text-[var(--fs-ink-faint)]">
          {t('admin.customWork.lane.empty')}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((card) => (
            <CustomWorkLeadCard
              key={card.id}
              card={card}
              onMarkContacted={onMarkContacted}
              marking={markingId === card.id}
              t={t}
            />
          ))}
        </div>
      )}
    </section>
  );
}
