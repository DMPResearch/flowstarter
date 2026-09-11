'use client';

/**
 * The admin half of the gallery: two embeds, one per real route.
 *
 * Everything in here is client-only: `DashboardBaseLayout` reads sidebar
 * state, `AdminDashboardSidebar` reads i18n and theme state, and none of the
 * three providers those need is mounted outside `/admin/dashboard/**`. This
 * subtree brings its own copies rather than depending on the real app shell,
 * so `page.tsx` above it can stay a plain server component with a `metadata`
 * export.
 *
 * `transform: translateZ(0)` on each wrapper is load-bearing, not decorative:
 * it gives `DashboardBaseLayout`'s `position: fixed` header, mesh and sidebar
 * a containing block, so they stay inside their own embed instead of pinning
 * to the real browser viewport and covering the sections above.
 *
 * Each embed is full-bleed — no rounded card, no border, no max-width column
 * around it — because the point of the gallery is to show the surface at the
 * width it actually has. Boxed into a reading column, the pipeline board lost
 * roughly half its width and read as six clipped columns on a scrollbar,
 * which is a picture of the gallery's own wrapper, not of the product.
 */
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { I18nProvider } from '@/lib/i18n';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { DashboardBaseLayout } from '@/components/ui/dashboard-base-layout';
import { columnToneStyle } from '@/lib/flowstarter/pipeline/job-labels';
import en from '@/locales/en';
import { AdminDashboardSidebar } from '../admin/components/AdminDashboardSidebar';
import { StatsStrip } from '../admin/dashboard/components/StatsStrip';
import { Panel } from '../admin/dashboard/components/Panel';
import { ProjectsTable } from '../admin/dashboard/components/ProjectsTable';
import { TeamDashboardShell } from '../admin/dashboard/components/TeamDashboardShell';
import {
  PipelineBoard,
  STATE_LABEL,
} from '../admin/dashboard/pipeline/PipelineColumns';
import { projectStateTone } from '../admin/dashboard/components/dashboard.constants';
import {
  galleryStats,
  galleryClientCount,
  galleryProjectRows,
  galleryPipelineColumns,
} from './fixtures';

function noop() {}

/**
 * One embed of the real admin chrome. Every gallery section that stands in
 * for an `/admin/dashboard/**` route goes through here, so they cannot drift
 * apart in how they mount their providers or contain their fixed chrome.
 */
function AdminEmbed({ children }: { children: React.ReactNode }) {
  // `ProjectsTable`'s row menu calls `useTeamRenameProject`/`useTeamDeleteProject`,
  // both React Query mutations, so this subtree needs its own client the same
  // way it needs its own theme, i18n and sidebar state.
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider initialLocale="en" initialMessages={{ en }}>
          <SidebarProvider>
            <div
              className="relative isolate w-full overflow-hidden"
              style={{ transform: 'translateZ(0)' }}
            >
              <DashboardBaseLayout sidebar={<AdminDashboardSidebar />} embedded>
                {children}
              </DashboardBaseLayout>
            </div>
          </SidebarProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

/** `/admin/dashboard`: the stats strip over the projects table. */
export function AdminDashboardGallery() {
  return (
    <AdminEmbed>
      <div className="ls-scope ls-admin-dashboard flex flex-col gap-6 px-4 pb-16 pt-8 sm:px-6 lg:px-8">
        <StatsStrip
          stats={galleryStats}
          loading={false}
          error={false}
          clientCount={galleryClientCount}
          clientsLoading={false}
        />

        {/* `data-testid` scopes the gallery's own assertions to this table's
            rows, past the pipeline board in the section below, whose fixture
            cards are deliberately different businesses but would otherwise
            risk sharing a name with one of these rows and turning a
            `getByText` ambiguous. */}
        <div data-testid="design-gallery-projects-table">
          <Panel eyebrow="Pipeline" title="Projects" flush>
            <ProjectsTable
              rows={galleryProjectRows}
              loading={false}
              onOpen={noop}
            />
          </Panel>
        </div>
      </div>
    </AdminEmbed>
  );
}

/**
 * The six column colours with the state each one belongs to.
 *
 * The board's own colour vocabulary and nothing besides: the four steps of
 * the accent ladder for the four progress states, then the two exceptions,
 * `warn` for the state that will not move without an operator and `ok` for
 * the finished one. It replaces a row of three loose `Badge` samples ("All
 * good", "Needs attention", "Not started") that sat under the board wearing
 * green, amber and grey — three colours the board does not use, in a
 * position that read as the board's key.
 */
function ColumnToneLegend() {
  return (
    <div
      data-testid="design-gallery-legend"
      className="flex flex-wrap items-center gap-x-5 gap-y-2"
    >
      <span className="text-xs font-semibold text-[var(--ls-ink-dim)]">
        Column colour
      </span>
      {galleryPipelineColumns.map((column) => (
        <span
          key={column.state}
          className="flex items-center gap-1.5 text-xs text-[var(--ls-ink-dim)]"
        >
          <span
            aria-hidden
            className="h-2 w-2 rounded-full"
            style={{
              background: columnToneStyle(projectStateTone(column.state)).rule
                .background,
            }}
          />
          {STATE_LABEL[column.state as ProjectState]}
        </span>
      ))}
    </div>
  );
}

/** `/admin/dashboard/pipeline`: the same shell, header and board as the route. */
export function AdminPipelineGallery() {
  const total = galleryPipelineColumns.reduce(
    (sum, column) => sum + column.cards.length,
    0
  );
  const stalled = galleryPipelineColumns.reduce(
    (sum, column) => sum + column.stalledCount,
    0
  );

  return (
    <AdminEmbed>
      <TeamDashboardShell
        title="Pipeline"
        subtitle={`${total} project${total === 1 ? '' : 's'} · ${stalled} need${
          stalled === 1 ? 's' : ''
        } attention`}
        icon={<GitBranch className="h-5 w-5" aria-hidden />}
        maxWidth="full"
      >
        <div className="flex flex-col gap-4">
          {/* The route's own grid component, not a copy of its classes: a
              gallery whose board is laid out by a second class string is a
              screenshot of the gallery, not of the board. */}
          <PipelineBoard columns={galleryPipelineColumns} />
          <ColumnToneLegend />
        </div>
      </TeamDashboardShell>
    </AdminEmbed>
  );
}
