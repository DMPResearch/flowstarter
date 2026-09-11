'use client';

import { usePathname } from 'next/navigation';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { FlowBackground } from '@flowstarter/flow-design-system';

export default function TeamAdminLayoutClient({
  children,
  initialSidebarCollapsed,
}: {
  children: React.ReactNode;
  initialSidebarCollapsed: boolean;
}) {
  const pathname = usePathname();

  // `/admin/dashboard/**` renders its own liquid-glass atmosphere
  // (`MeshBackdrop` inside `DashboardBaseLayout`) — skip the marketing-style
  // `FlowBackground` there so the two do not stack and fight. Login and join
  // have nothing else behind them, so they keep it.
  const showFlowBackground = !pathname?.startsWith('/admin/dashboard');

  return (
    <SidebarProvider initialCollapsed={initialSidebarCollapsed}>
      <div className="relative min-h-screen">
        {showFlowBackground && (
          <FlowBackground
            variant="landing"
            style={{ position: 'fixed', inset: 0, zIndex: 0 }}
          />
        )}
        <div className="relative z-10">{children}</div>
      </div>
    </SidebarProvider>
  );
}
