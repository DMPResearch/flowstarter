'use client';

import '@flowstarter/flow-design-system/styles/landing.css';
import { AdminDashboardSidebar } from '../components/AdminDashboardSidebar';
import { DashboardBaseLayout } from '@/components/ui/dashboard-base-layout';

// Operator dashboard inherits the `landing` FlowBackground variant from
// DashboardBaseLayout so the brand orbs read at the same intensity as
// auth + editor. Cards still supply depth on top — the atmosphere
// overlays self-quiet when the landing variant is in play.

export default function AdminDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DashboardBaseLayout sidebar={<AdminDashboardSidebar />}>
      {children}
    </DashboardBaseLayout>
  );
}
