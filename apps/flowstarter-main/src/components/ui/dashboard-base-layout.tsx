'use client';

import { MeshBackdrop } from '@flowstarter/flow-design-system';
import { useSidebar } from '@/contexts/SidebarContext';
import { AppHeader } from '@/components/ui/app-header';
import { useEffect, type ReactNode } from 'react';

type DashboardBaseLayoutProps = {
  children: ReactNode;
  sidebar?: ReactNode;
  hideSidebar?: boolean;
};

/**
 * The chrome every /admin/dashboard/** page sits inside: the mesh the glass
 * refracts, the header, the sidebar and a scrollable main.
 *
 * The atmosphere is `MeshBackdrop` variant="app" — the same field the client
 * dashboard sits on (see `src/app/(dynamic-pages)/dashboard/layout.tsx`), so
 * admin and the client product read as one material. This used to also
 * render `FlowBackground` plus a pair of `.dashboard-atmosphere-*` tint/grain
 * overlays tuned to fight it; both are gone; the overlay CSS stays in
 * globals.css for now in case something else still reaches for it.
 */
export function DashboardBaseLayout({
  children,
  sidebar,
  hideSidebar = false,
}: DashboardBaseLayoutProps) {
  const { isCollapsed } = useSidebar();

  useEffect(() => {
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
    };
  }, []);

  return (
    <div className="h-[100dvh] flex flex-col overflow-hidden">
      <MeshBackdrop
        variant="app"
        style={{ position: 'fixed', inset: 0, zIndex: 0 }}
      />

      <AppHeader />
      {!hideSidebar && sidebar}
      <main
        className={`flex-1 pt-16 relative z-10 min-w-0 overflow-y-auto overflow-x-hidden ${
          hideSidebar ? '' : isCollapsed ? 'md:ml-[72px]' : 'md:ml-52 lg:ml-60'
        }`}
      >
        {children}
      </main>
    </div>
  );
}
