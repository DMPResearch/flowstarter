/**
 * "Your site": where the project has got to, and what the site is doing.
 *
 * Server-renderable and hook-free. It takes a project state and a list of
 * tiles that `siteOverviewTiles` already decided, and renders them. Nothing is
 * computed here, so there is no rule in this file that a test would have to
 * mount a component to reach.
 *
 * The stepper stays at the top because it answers the question a client asks
 * first ("where is my site?"), and the tiles sit under it because they only
 * mean anything once there is a site to talk about.
 */
import Link from 'next/link';
import type { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { cn } from '@/lib/utils';
import { ProjectStateStepper } from './ProjectStateStepper';
import type { SiteOverviewTile } from './site-overview';

/**
 * Tone is emphasis, never alarm. `attention` borrows the product's primary
 * colour because it means "there is something for you here"; `muted` is the
 * ordinary card, dimmed, because it means "not switched on yet".
 */
const TONE_CLASS: Record<SiteOverviewTile['tone'], string> = {
  ok: 'border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)]/40',
  attention:
    'border-[var(--purple-primary)]/30 bg-[var(--purple-primary)]/[0.07]',
  muted: 'border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)]/20',
};

export function SiteOverview({
  state,
  tiles,
}: {
  state: ProjectState;
  tiles: SiteOverviewTile[];
}) {
  return (
    <section className="flex flex-col gap-6 rounded-2xl border border-[var(--fs-glass-edge)] bg-[var(--fs-glass-bg)] px-6 py-6 shadow-[var(--fs-card-shadow)] backdrop-blur-xl">
      <div className="flex flex-col gap-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--purple-primary)]">
          Your site
        </p>
        <ProjectStateStepper state={state} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <Tile key={tile.key} tile={tile} />
        ))}
      </div>
    </section>
  );
}

function Tile({ tile }: { tile: SiteOverviewTile }) {
  const className = cn(
    'flex flex-col gap-1 rounded-xl border px-4 py-3.5 text-left transition-colors',
    TONE_CLASS[tile.tone],
    tile.href && 'hover:border-[var(--purple-primary)]/40'
  );

  const body = (
    <>
      <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--fs-ink-faint)]">
        {tile.label}
      </p>
      <p
        className={cn(
          'text-2xl font-bold leading-tight',
          tile.tone === 'muted'
            ? 'text-[var(--fs-ink-dim)]'
            : 'text-[var(--fs-ink)]'
        )}
      >
        {tile.value}
      </p>
      <p className="text-xs leading-relaxed text-[var(--fs-ink-dim)]">
        {tile.note}
      </p>
    </>
  );

  // The links are shortcuts to pages that authorize themselves; none of them
  // is a gate, so a tile is safe to render for anyone who reached this page.
  if (tile.href) {
    return (
      <Link
        href={tile.href}
        data-testid="site-overview-tile"
        data-key={tile.key}
        data-tone={tile.tone}
        className={className}
      >
        {body}
      </Link>
    );
  }

  return (
    <div
      data-testid="site-overview-tile"
      data-key={tile.key}
      data-tone={tile.tone}
      className={className}
    >
      {body}
    </div>
  );
}
