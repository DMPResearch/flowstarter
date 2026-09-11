/**
 * The atmosphere behind a client's own pages.
 *
 * Until now the client dashboard rendered a bare <main> on a flat background
 * while admin and the marketing pages both sat on a gradient. That made the
 * one surface a paying client actually looks at the plainest thing in the
 * product, and it made the glass panels on it read as grey boxes, because
 * there was nothing behind them to refract.
 *
 * The mesh is decorative and hook-free, so this layout stays a server
 * component: it is imported from its own module rather than the package
 * barrel, which keeps the client components in that barrel out of the tree.
 */
import { MeshBackdrop } from '@flowstarter/flow-design-system/components/backgrounds/MeshBackdrop';
import type { ReactNode } from 'react';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-screen">
      <MeshBackdrop variant="app" />
      <div className="relative z-10">{children}</div>
    </div>
  );
}
