'use client';

import type { ReactNode } from 'react';
import { FlowBackground } from '@flowstarter/flow-design-system';
import { SiteHeader } from '@/components/SiteHeader';
import Footer from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { BookingModalProvider } from '@/app/(dynamic-pages)/(main-pages)/components/BookingModalProvider';

// Make sure ls-* design tokens + marketing primitives are available on every
// marketing page. The landing route group imports landing-design.css via its
// own layout; pages outside that group need an explicit import.
import '@flowstarter/flow-design-system/styles/landing.css';
import './marketing.css';

interface MarketingShellProps {
  children: ReactNode;
  /**
   * Whether to render the booking modal provider so the SiteHeader CTA
   * ("Book a free discovery call") opens the modal. Defaults to true.
   * Set to false for pages that render their own modal (e.g. /relaunch).
   */
  withBookingModal?: boolean;
  /**
   * Whether to render the FlowBackground. Defaults to true. Set to false
   * when the parent layout already paints a background (e.g. pages inside
   * the (main-pages) route group).
   */
  withBackground?: boolean;
}

/**
 * Shared shell for every non-landing public marketing page. Provides the
 * same chrome as the landing — FlowBackground, SiteHeader (public mode),
 * Footer, CookieConsent, and the booking-modal provider so the header CTA
 * works everywhere. Wraps children in `ls-scope` so the editorial design
 * tokens apply to anything inside.
 */
export function MarketingShell({
  children,
  withBookingModal = true,
  withBackground = true,
}: MarketingShellProps) {
  return (
    <div className="relative flex min-h-screen flex-col font-display text-[var(--fs-ink)]">
      {withBackground && (
        <FlowBackground
          variant="landing"
          style={{ position: 'fixed', inset: 0, zIndex: 0 }}
        />
      )}
      <SiteHeader mode="public" />
      <div className="ls-scope relative z-10 flex flex-1 flex-col">
        {children}
      </div>
      {withBookingModal && <BookingModalProvider />}
      <Footer />
      <CookieConsent />
    </div>
  );
}
