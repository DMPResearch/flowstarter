'use client';

import '@flowstarter/flow-design-system/styles/landing.css';
import Footer from '@/components/Footer';
import { FlowBackground } from '@flowstarter/flow-design-system';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export default function MainPagesLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isLandingPage = pathname === '/';
  const isLoggedInPage =
    pathname?.startsWith('/dashboard') ||
    pathname?.startsWith('/profile') ||
    pathname?.startsWith('/projects/') ||
    pathname?.startsWith('/help');
  // /relaunch renders its own chrome (SiteHeader + Footer) via MarketingShell,
  // so the route-group layout must not stack a second Footer on top.
  const isRelaunchPage = pathname?.startsWith('/relaunch');

  // Hide footer on landing page (has its own) and logged-in pages
  const hideFooter = isLandingPage || isLoggedInPage || isRelaunchPage;

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[9999] focus:px-4 focus:py-2 focus:bg-white focus:text-gray-900 focus:rounded-lg focus:font-medium focus:shadow-lg"
      >
        Skip to main content
      </a>
      <div className="relative flex min-h-screen flex-col">
        <FlowBackground
          variant="landing"
          style={{ position: 'fixed', inset: 0, zIndex: 0 }}
        />
        <div className="relative z-10 flex flex-1 flex-col">{children}</div>
      </div>
      {!hideFooter && <Footer />}
    </>
  );
}
