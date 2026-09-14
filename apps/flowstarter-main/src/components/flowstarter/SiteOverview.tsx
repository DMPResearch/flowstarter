/**
 * "Your site": where the project has got to, and what the site is doing.
 *
 * Server-renderable and hook-free. It takes a project state and a list of
 * tiles that `siteOverviewTiles` already decided, and renders them. Nothing is
 * computed here beyond which colour a tile wears, so there is no rule in this
 * file that a test would have to mount a component to reach.
 *
 * The stepper stays at the top because it answers the question a client asks
 * first ("where is my site?"), and the tiles sit under it because they only
 * mean anything once there is a site to talk about.
 *
 * The glass is the design system's, not this file's: a GlassSurface panel with
 * StatTiles inside it. Nothing here sets a blur, a translucent fill or a
 * border colour of its own.
 */
import Link from 'next/link';
import {
  CalendarCheck,
  ClipboardList,
  History,
  Mail,
  Pencil,
  ShoppingBag,
  type LucideIcon,
} from 'lucide-react';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import {
  GlassSurface,
  type Tone,
} from '@flowstarter/flow-design-system/components/surfaces/GlassSurface';
import { StatTile } from '@flowstarter/flow-design-system/components/surfaces/StatTile';
import { ClientBuildActivity } from './ClientBuildActivity';
import { ProjectStateStepper } from './ProjectStateStepper';
import type { ClientBuildSignal } from './project-build-signal';
import type { SiteOverviewTile, SiteOverviewTileKey } from './site-overview';

/**
 * What each tile is about, as a colour. A client scanning the row should be
 * able to tell enquiries from bookings without reading the labels, so the
 * subject owns the hue: money-and-edits indigo, messages blue, calendar teal,
 * their own work violet, their own words pink, the shop green.
 */
const SUBJECT_PALETTE: Record<SiteOverviewTileKey, Tone> = {
  credits: 'accent',
  enquiries: 'info',
  bookings: 'teal',
  changes: 'violet',
  brief: 'pink',
  store: 'ok',
};

const SUBJECT_ICON: Record<SiteOverviewTileKey, LucideIcon> = {
  credits: Pencil,
  enquiries: Mail,
  bookings: CalendarCheck,
  changes: History,
  brief: ClipboardList,
  store: ShoppingBag,
};

/**
 * The rules tone outranks the subject, because it is the only one of the two
 * that is about the client rather than about the category. `attention` means
 * "there is something for you to do", which is amber; `muted` means "not
 * switched on yet", which is the colourless tone. Everything else keeps its
 * subject colour. Nothing here is red: none of these states is a failure.
 */
export function tilePalette(tile: SiteOverviewTile): Tone {
  if (tile.tone === 'attention') return 'warn';
  if (tile.tone === 'muted') return 'neutral';
  return SUBJECT_PALETTE[tile.key];
}

/**
 * Whether the timeline belongs on this page at all.
 *
 * One state, because the six in `project-progress.ts` are the only vocabulary
 * this panel has and only one of them means "an agent is working on it right
 * now". A change request on a live site is a build too, but that one runs
 * while the project sits in LIVE_SUBSCRIPTION and is watched from the editor,
 * where the client asked for it — putting it here as well would report the
 * same work twice on two pages.
 */
export function buildIsRunning(state: ProjectState): boolean {
  return state === ProjectState.AGENTS_WORKING;
}

export function SiteOverview({
  state,
  tiles,
  buildSignal,
  workspaceId,
}: {
  state: ProjectState;
  tiles: SiteOverviewTile[];
  /** Passed straight through: the stepper owns what a stopped build reads as. */
  buildSignal?: ClientBuildSignal | null;
  /**
   * Optional, and the only thing that switches the live build timeline on.
   * Without it this stays the server-renderable, fetch-free panel the design
   * gallery mounts against fixtures.
   */
  workspaceId?: string;
}) {
  return (
    <GlassSurface as="section" variant="panel">
      <div className="flex flex-col gap-5">
        <p
          className="fs-tone-text text-xs font-semibold uppercase tracking-widest"
          data-tone="accent"
        >
          Your site
        </p>
        <ProjectStateStepper state={state} buildSignal={buildSignal} />
        {/* Under the stepper, because it is the detail behind the stage the
            stepper has just named, not a subject of its own. It draws nothing
            until the build has written a step, so the panel above is unmoved
            for a build that has only just been claimed. */}
        {workspaceId && buildIsRunning(state) ? (
          <ClientBuildActivity workspaceId={workspaceId} live />
        ) : null}
      </div>

      {/* Five subjects into four columns left the fifth tile stranded on a row
          of its own, next to an empty half of the panel. Auto-fit asks for as
          many equal columns as will fit at a readable width instead of naming
          a number, so the row fills out whatever the client happens to have
          switched on and never orphans the last one. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:[grid-template-columns:repeat(auto-fit,minmax(10.5rem,1fr))]">
        {tiles.map((tile) => (
          <Tile key={tile.key} tile={tile} />
        ))}
      </div>
    </GlassSurface>
  );
}

function Tile({ tile }: { tile: SiteOverviewTile }) {
  const Icon = SUBJECT_ICON[tile.key];

  // The links are shortcuts to pages that authorize themselves; none of them
  // is a gate, so a tile is safe to render for anyone who reached this page.
  //
  // `data-tone` stays the rules value the tests and the rules module speak in
  // (ok | attention | muted). `data-palette`, which StatTile writes from the
  // `tone` prop, is the colour. Keeping them apart means a palette change can
  // never quietly rewrite what a test believes the rules decided.
  return (
    <StatTile
      label={tile.label}
      value={tile.value}
      note={tile.note}
      tone={tilePalette(tile)}
      // One loud tile per panel, and it is the one with something to do. The
      // rest stay neutral glass so this one is actually louder than them.
      emphasis={tile.tone === 'attention'}
      icon={<Icon size={15} strokeWidth={2.25} aria-hidden="true" />}
      href={tile.href}
      linkComponent={tile.href ? Link : undefined}
      data-testid="site-overview-tile"
      data-key={tile.key}
      data-tone={tile.tone}
    />
  );
}
