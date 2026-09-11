'use client';

/**
 * The admin half of the gallery.
 *
 * Everything in here is client-only: `DashboardBaseLayout` reads sidebar
 * state, `AdminDashboardSidebar` reads i18n and theme state, and none of the
 * three providers those need is mounted outside `/admin/dashboard/**`. This
 * subtree brings its own copies rather than depending on the real app shell,
 * so `page.tsx` above it can stay a plain server component with a `metadata`
 * export.
 *
 * `transform: translateZ(0)` on the wrapper is load-bearing, not decorative:
 * it gives `DashboardBaseLayout`'s `position: fixed` header, mesh and sidebar
 * a containing block, so they stay inside this card instead of pinning to the
 * real browser viewport and covering the "Client dashboard" section above.
 */
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { I18nProvider } from '@/lib/i18n';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { DashboardBaseLayout } from '@/components/ui/dashboard-base-layout';
import { Badge } from '@/components/ui/badge';
import en from '@/locales/en';
import { AdminDashboardSidebar } from '../../admin/components/AdminDashboardSidebar';
import { StatsStrip } from '../../admin/dashboard/components/StatsStrip';
import { Panel } from '../../admin/dashboard/components/Panel';
import { ProjectsTable } from '../../admin/dashboard/components/ProjectsTable';
import { PipelineBoardColumn } from '../../admin/dashboard/pipeline/PipelineColumns';
import {
  galleryStats,
  galleryClientCount,
  galleryProjectRows,
  galleryPipelineColumns,
} from './fixtures';

function noop() {}

export function AdminGallerySection() {
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
              className="relative isolate overflow-hidden rounded-2xl border border-[var(--fs-glass-edge)]"
              style={{ transform: 'translateZ(0)' }}
            >
              <DashboardBaseLayout sidebar={<AdminDashboardSidebar />} embedded>
                <div className="ls-scope ls-admin-dashboard flex flex-col gap-6 px-4 pb-16 pt-8 sm:px-6 lg:px-8">
                  <StatsStrip
                    stats={galleryStats}
                    loading={false}
                    error={false}
                    clientCount={galleryClientCount}
                    clientsLoading={false}
                  />

                  {/* `data-testid` scopes the gallery's own assertions to
                      this table's rows, past the Pipeline board below, whose
                      fixture cards are deliberately different businesses but
                      would otherwise risk sharing a name with one of these
                      rows and turning a `getByText` ambiguous. */}
                  <div data-testid="design-gallery-projects-table">
                    <Panel eyebrow="Pipeline" title="Projects" flush>
                      <ProjectsTable
                        rows={galleryProjectRows}
                        loading={false}
                        onOpen={noop}
                      />
                    </Panel>
                  </div>

                  {/* Not wrapped in `Panel`: `PipelineBoardColumn` is already
                      its own `GlassSurface` panel, and a panel nested inside
                      a panel loses the card-on-panel brightness inversion
                      that makes the stack read as depth. A plain heading is
                      enough to label the section, the same way the pipeline
                      board itself sits under `TeamDashboardShell` with no
                      extra panel around its grid of columns. */}
                  <div
                    data-testid="design-gallery-pipeline-section"
                    className="flex flex-col gap-3"
                  >
                    <h3 className="text-sm font-semibold text-[var(--fs-ink-dim)]">
                      Pipeline
                    </h3>
                    <div
                      data-testid="design-gallery-pipeline-board"
                      className="-mx-1 grid grid-flow-col auto-cols-[minmax(240px,1fr)] items-start gap-4 overflow-x-auto px-1 pb-2"
                    >
                      {galleryPipelineColumns.map((column) => (
                        <PipelineBoardColumn
                          key={column.state}
                          state={column.state}
                          cards={column.cards}
                          stalledCount={column.stalledCount}
                        />
                      ))}
                    </div>
                  </div>

                  {/* `data-testid` scopes the gallery's own assertions past
                      the table's stage/tier badges, which reuse some of the
                      same words ("Live" for a launched or care-stage row). */}
                  <div
                    data-testid="design-gallery-badges"
                    className="flex flex-wrap gap-3"
                  >
                    <Badge variant="tone" tone="ok">
                      All good
                    </Badge>
                    <Badge variant="tone" tone="warn">
                      Needs attention
                    </Badge>
                    <Badge variant="tone" tone="neutral">
                      Not started
                    </Badge>
                  </div>
                </div>
              </DashboardBaseLayout>
            </div>
          </SidebarProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
