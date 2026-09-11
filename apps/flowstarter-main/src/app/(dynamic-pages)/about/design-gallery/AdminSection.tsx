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
import {
  galleryStats,
  galleryClientCount,
  galleryProjectRows,
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
              <DashboardBaseLayout sidebar={<AdminDashboardSidebar />}>
                <div className="ls-scope ls-admin-dashboard flex flex-col gap-6 px-4 pb-16 pt-8 sm:px-6 lg:px-8">
                  <StatsStrip
                    stats={galleryStats}
                    loading={false}
                    error={false}
                    clientCount={galleryClientCount}
                    clientsLoading={false}
                  />

                  <Panel eyebrow="Pipeline" title="Projects" flush>
                    <ProjectsTable
                      rows={galleryProjectRows}
                      loading={false}
                      onOpen={noop}
                    />
                  </Panel>

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
