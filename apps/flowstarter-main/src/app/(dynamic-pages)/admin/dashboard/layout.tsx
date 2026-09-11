'use client';

import '@flowstarter/flow-design-system/styles/landing.css';
import { AdminDashboardSidebar } from '../components/AdminDashboardSidebar';
import { DashboardBaseLayout } from '@/components/ui/dashboard-base-layout';

// Operator dashboard sits on `DashboardBaseLayout`'s MeshBackdrop — the same
// liquid-glass atmosphere the client dashboard uses — so admin reads as the
// same product rather than a separate marketing-styled shell.

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
