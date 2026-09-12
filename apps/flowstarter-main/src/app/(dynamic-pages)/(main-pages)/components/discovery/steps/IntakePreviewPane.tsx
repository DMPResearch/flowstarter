'use client';

/**
 * "Your preview", the pane that stands next to the intake conversation.
 *
 * It is a skeleton of a website, not a website: grey bars where the copy will
 * go, a header, a hero, a card row, a footer. What makes it worth showing
 * from the first question is that it is *their* skeleton. Every answer
 * reshapes it -- the business name lands in the header and the hero, the
 * industry picks which bands the site has, the tone answer sets the type
 * weight and the corner radius, the page count widens the nav and the card
 * row, and the commerce answer adds a product row.
 *
 * All of that is decided in `../preview-skeleton.ts`, which is pure. This
 * file only draws the decision, so the mapping stays testable without a DOM
 * and the pane can never show a shape the rules did not produce.
 *
 * Nothing here talks to the generator. When the real build starts,
 * `PreviewStep` renders this same skeleton as its loading frame and the
 * generated site replaces it in place.
 */
import { Pencil } from 'lucide-react';
import { BrandStrip, type BrandStripProps } from './BrandStrip';
import type { DiscoveryData } from '../discovery.logic';
import type { IntakeQuestionId } from '../intake-script';
import {
  type PreviewSkeleton,
  type SkeletonRadius,
  type SkeletonSectionId,
  type SkeletonWeight,
  derivePreviewSkeleton,
} from '../preview-skeleton';

const KEY = 'landing.discovery.preview.pane.';

/** Corner radius, one scale for the whole skeleton. */
const RADIUS: Record<SkeletonRadius, { block: string; chip: string }> = {
  sharp: { block: 'rounded-[3px]', chip: 'rounded-[3px]' },
  soft: { block: 'rounded-lg', chip: 'rounded-md' },
  round: { block: 'rounded-2xl', chip: 'rounded-full' },
};

/** The hero headline's weight, the one place the tone answer is legible. */
const WEIGHT: Record<SkeletonWeight, string> = {
  light: 'font-light tracking-tight',
  regular: 'font-semibold tracking-tight',
  bold: 'font-extrabold tracking-[-0.03em]',
};

/** Bar heights per band, so each section keeps its own silhouette. */
const BAR = 'bg-[var(--fs-ink)]/[0.09] dark:bg-white/[0.09]';
const BAR_SOFT = 'bg-[var(--fs-ink)]/[0.055] dark:bg-white/[0.06]';

function Bar({
  w,
  h = 'h-2',
  radius,
  className = '',
}: {
  w: string;
  h?: string;
  radius: SkeletonRadius;
  className?: string;
}) {
  return (
    <div
      className={`${w} ${h} ${RADIUS[radius].chip} ${BAR} ${className}`}
      aria-hidden="true"
    />
  );
}

/**
 * One band of the skeleton. The band's name is shown as a small label, which
 * is the whole point of a *labelled* skeleton: the visitor can read what the
 * site will have before any of it exists.
 */
function Band({
  id,
  skeleton,
  t,
}: {
  id: SkeletonSectionId;
  skeleton: PreviewSkeleton;
  t: (key: string) => string;
}) {
  const { radius, cardCount } = skeleton;
  const label = t(`${KEY}section.${id}`);

  if (id === 'hero') return null; // drawn by the caller, it holds the name

  const body = () => {
    if (id === 'products') {
      return (
        <div
          className="grid grid-cols-4 gap-1.5"
          data-testid="preview-product-row"
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className={`${RADIUS[radius].block} ${BAR_SOFT} aspect-[4/5]`}
              aria-hidden="true"
            />
          ))}
        </div>
      );
    }
    if (id === 'work' || id === 'menu') {
      return (
        <div className="grid grid-cols-3 gap-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className={`${RADIUS[radius].block} ${BAR_SOFT} ${
                id === 'work' ? 'aspect-[4/3]' : 'h-8'
              }`}
              aria-hidden="true"
            />
          ))}
        </div>
      );
    }
    if (id === 'services') {
      return (
        <div
          className="grid gap-1.5"
          style={{
            gridTemplateColumns: `repeat(${Math.min(
              cardCount,
              3
            )}, minmax(0, 1fr))`,
          }}
          data-testid="preview-card-row"
        >
          {Array.from({ length: cardCount }).map((_, i) => (
            <div
              key={i}
              className={`${RADIUS[radius].block} ${BAR_SOFT} h-11 p-1.5`}
              aria-hidden="true"
            />
          ))}
        </div>
      );
    }
    if (id === 'testimonials') {
      return (
        <div className="flex items-center gap-2">
          <div
            className={`h-6 w-6 shrink-0 rounded-full ${BAR}`}
            aria-hidden="true"
          />
          <div className="flex-1 space-y-1">
            <Bar w="w-full" h="h-1.5" radius={radius} />
            <Bar w="w-3/5" h="h-1.5" radius={radius} />
          </div>
        </div>
      );
    }
    if (id === 'booking') {
      return (
        <div className="flex items-center gap-1.5">
          <div
            className={`h-7 flex-1 ${RADIUS[radius].block} ${BAR_SOFT}`}
            aria-hidden="true"
          />
          <div
            className={`h-7 w-16 ${RADIUS[radius].chip} bg-[var(--purple-primary)]/35`}
            aria-hidden="true"
          />
        </div>
      );
    }
    // about / contact
    return (
      <div className="space-y-1">
        <Bar w="w-full" h="h-1.5" radius={radius} />
        <Bar w="w-4/5" h="h-1.5" radius={radius} />
      </div>
    );
  };

  return (
    <section className="space-y-1.5" data-preview-section={id}>
      <p className="text-[8.5px] font-medium uppercase tracking-[0.16em] text-[var(--fs-ink-faint)]">
        {label}
      </p>
      {body()}
    </section>
  );
}

/**
 * The skeleton on its own, without the pane chrome around it. `PreviewStep`
 * renders this as the loading frame the generated site replaces, so the shape
 * the visitor watched fill in during the conversation is the shape the real
 * build lands into.
 */
export function DerivedSiteSkeleton({
  data,
  t,
  className = '',
  /**
   * `PreviewStep` renders this in the slot the old generic `SiteSkeleton`
   * held, and its tests (and the funnel recorder) find that slot by
   * `concierge-skeleton`. Overriding the id keeps that contract rather than
   * renaming a selector the E2E layer depends on.
   */
  testId = 'derived-site-skeleton',
}: {
  data: DiscoveryData;
  t: (key: string) => string;
  className?: string;
  testId?: string;
}) {
  const skeleton = derivePreviewSkeleton(data);
  const { radius, weight, navCount, siteName, named } = skeleton;

  return (
    <div
      data-testid={testId}
      data-radius={radius}
      data-weight={weight}
      data-sections={skeleton.sections.join(',')}
      className={`flex h-full w-full flex-col overflow-hidden bg-white text-left dark:bg-[#0d0b16] ${className}`}
    >
      {/* Header bar. The business name lands here the moment it is given. */}
      <header className="flex items-center justify-between gap-3 border-b border-[var(--fs-rule)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <div
            className={`h-3.5 w-3.5 shrink-0 ${RADIUS[radius].chip} bg-[var(--purple-primary)]/50`}
            aria-hidden="true"
          />
          {named ? (
            <span
              data-testid="preview-header-name"
              className="truncate text-[10px] font-semibold text-[var(--fs-ink)]"
            >
              {siteName}
            </span>
          ) : (
            <Bar w="w-12" h="h-2" radius={radius} />
          )}
        </div>
        <nav className="flex items-center gap-1.5" data-testid="preview-nav">
          {Array.from({ length: navCount }).map((_, i) => (
            <Bar key={i} w="w-5" h="h-1.5" radius={radius} />
          ))}
        </nav>
      </header>

      {/* The page itself. Scrolls inside the pane so a long section set does
          not stretch the modal. */}
      <div className="flex-1 space-y-3.5 overflow-y-auto px-3 py-3">
        {/* Hero. The name is the only real word on the page; everything else
            stays a bar, because everything else would be invented. */}
        <section className="space-y-1.5" data-preview-section="hero">
          <p className="text-[8.5px] font-medium uppercase tracking-[0.16em] text-[var(--fs-ink-faint)]">
            {t(`${KEY}section.hero`)}
          </p>
          {named ? (
            <p
              data-testid="preview-hero-name"
              className={`text-[15px] leading-tight text-[var(--fs-ink)] ${WEIGHT[weight]}`}
            >
              {siteName}
            </p>
          ) : (
            <Bar w="w-3/5" h="h-3.5" radius={radius} />
          )}
          <Bar w="w-4/5" h="h-1.5" radius={radius} />
          <div className="flex items-center gap-1.5 pt-1">
            <div
              className={`h-5 w-14 ${RADIUS[radius].chip} bg-[var(--purple-primary)]/45`}
              aria-hidden="true"
            />
            <div
              className={`h-5 w-11 ${RADIUS[radius].chip} border border-[var(--fs-rule)]`}
              aria-hidden="true"
            />
          </div>
        </section>

        {skeleton.sections
          .filter((id) => id !== 'hero')
          .map((id) => (
            <Band key={id} id={id} skeleton={skeleton} t={t} />
          ))}
      </div>

      {/* Footer */}
      <footer className="flex items-center justify-between gap-3 border-t border-[var(--fs-rule)] px-3 py-2">
        <Bar w="w-10" h="h-1.5" radius={radius} />
        <div className="flex gap-1.5">
          <Bar w="w-4" h="h-1.5" radius={radius} />
          <Bar w="w-4" h="h-1.5" radius={radius} />
        </div>
      </footer>
    </div>
  );
}

/**
 * The "what we know so far" list. Four facts, always all four, so the list
 * does not jump as it fills. A fact the visitor has given carries an edit
 * button that sends the conversation back to that question; one they have not
 * is a quiet placeholder with nothing to press.
 */
export function KnownSoFar({
  data,
  t,
  onEdit,
}: {
  data: DiscoveryData;
  t: (key: string) => string;
  onEdit?: (id: IntakeQuestionId) => void;
}) {
  const { facts } = derivePreviewSkeleton(data);
  const editLabel = t('landing.discovery.chat.edit');

  return (
    <div data-testid="known-so-far" className="mt-3">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--fs-ink-faint)]">
        {t(`${KEY}knownTitle`)}
      </p>
      <dl className="divide-y divide-[var(--fs-rule)] border-y border-[var(--fs-rule)]">
        {facts.map((fact) => {
          const label = t(fact.labelKey);
          const known = Boolean(fact.value);
          // Every fact is now either the visitor's own words or a short
          // derived label, so there is no stored option value left to look up.
          const shown = fact.value;
          return (
            <div
              key={fact.id}
              data-known-fact={fact.id}
              data-known={known ? 'yes' : 'no'}
              className="flex items-baseline gap-3 py-1.5"
            >
              <dt className="w-16 shrink-0 text-[11px] text-[var(--fs-ink-faint)]">
                {label}
              </dt>
              <dd
                className={`min-w-0 flex-1 truncate text-[12px] ${
                  known
                    ? 'text-[var(--fs-ink)]'
                    : 'text-[var(--fs-ink-faint)] italic'
                }`}
              >
                {known ? shown : t(`${KEY}factEmpty`)}
              </dd>
              {known && onEdit && (
                <button
                  type="button"
                  onClick={() => onEdit(fact.id)}
                  aria-label={`${editLabel}: ${label}`}
                  title={editLabel}
                  className="shrink-0 rounded p-1 text-[var(--fs-ink-faint)] transition-colors hover:text-[var(--purple-primary)]"
                >
                  <Pencil className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/**
 * The whole right-hand pane: title, skeleton, the facts list, and the brand
 * strip under it.
 *
 * The strip is last on purpose. The skeleton is a promise about shape and
 * fills in from the first answer; the colours and the voice cannot appear
 * until the visitor has given a link and said what they offer, so putting them
 * above the facts would leave a hole in the pane for most of the conversation.
 */
export function IntakePreviewPane({
  data,
  t,
  onEdit,
  brand,
  // Matched to `ConversationLog`'s own `max-h-[42vh]` so the two panes read
  // as one row rather than one column overhanging the other.
  heightClassName = 'h-[42vh] min-h-[260px]',
}: {
  data: DiscoveryData;
  t: (key: string) => string;
  onEdit?: (id: IntakeQuestionId) => void;
  /** Everything `useBrandSignals` produced, or absent while it has nothing. */
  brand?: Omit<BrandStripProps, 't'>;
  heightClassName?: string;
}) {
  return (
    <div data-testid="intake-preview-pane" className="flex flex-col">
      {/* Below 900px the strip above the pane already carries this title, so
          printing it again here would say the same thing twice in a row. */}
      <p className="mb-2 hidden text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--fs-ink-faint)] min-[900px]:block">
        {t(`${KEY}title`)}
      </p>
      <div
        className={`overflow-hidden rounded-xl border border-[var(--fs-rule)] shadow-sm ${heightClassName}`}
      >
        <DerivedSiteSkeleton data={data} t={t} />
      </div>
      <p className="mt-2 text-[11px] leading-snug text-[var(--fs-ink-faint)]">
        {t(`${KEY}caption`)}
      </p>
      <KnownSoFar data={data} t={t} onEdit={onEdit} />
      {brand ? <BrandStrip {...brand} t={t} /> : null}
    </div>
  );
}
