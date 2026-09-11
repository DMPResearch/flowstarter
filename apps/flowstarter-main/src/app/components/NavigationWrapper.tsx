'use client';

import { LoadingScreen } from '@flowstarter/flow-design-system';
import {
  getIsErrorPage,
  getIsErrorPageServerSnapshot,
  subscribeErrorPage,
} from '@/contexts/ErrorPageContext';
import { I18nProvider, useTranslations } from '@/lib/i18n';
import en from '@/locales/en';
import ro from '@/locales/ro';
import { useAuth } from '@clerk/nextjs';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ExternalNavigation, ExternalNavigationWithAuth } from './Navbar';

// Public page routes, mirroring middleware.ts's isPublicRoute matcher (the
// middleware is what actually decides auth; this list only decides whether
// the shell may render before Clerk finishes loading). Prefix-matched like
// the middleware's `(.*)` entries. The lists drifting apart is exactly how
// /unlock spent a day behind an infinite "Loading your experience" loader.
// The source of truth is PUBLIC_ROUTES in @/lib/route-manifest.
const publicRoutePrefixes = [
  '/workflow-showcase',
  '/about',
  '/login',
  '/sign-up',
  '/assistant',
  '/unlock',
  '/contact',
  '/help',
  '/privacy',
  '/terms',
  '/pricing',
  '/cookies',
  '/relaunch',
  '/faq',
  '/library',
  '/admin',
  '/design-gallery',
];

function isPublicPath(pathname: string): boolean {
  if (pathname === '/') return true;
  return publicRoutePrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

// Routes where we hide the default navbar (they have their own header)
const noNavbarRoutes = [
  '/',
  '/workflow-showcase',
  '/404',
  // Auth screens render their own <SiteHeader mode="auth" /> via AuthLayout —
  // without these the global ExternalNavigation stacks a second header on top.
  '/login',
  '/sign-up',
  '/admin',
  '/admin/login',
  '/admin/dashboard',
  '/admin/dashboard/new',
  // Marketing pages with their own MarketingShell header
  '/help',
  '/contact',
  '/about',
  '/faq',
  '/relaunch',
  '/privacy',
  '/terms',
  '/pricing',
  '/cookies',
  '/custom-inquiry',
];

export function NavigationWrapper() {
  const pathname = usePathname() || '';

  // Check for team routes early - they have their own layout
  const isTeamRoute = pathname.startsWith('/admin');

  const { isLoaded } = useAuth();
  const [isMounted, setIsMounted] = useState(false);
  const [isDraftLoading, setIsDraftLoading] = useState(false);
  const loaderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPublicRoute = isPublicPath(pathname) || isTeamRoute;

  // Clerk failing to load must degrade to a rendered page, never to a loader
  // that outlives the visitor's patience: a broken auth handshake once held a
  // fully server-rendered page behind the spinner indefinitely. After the
  // grace period the shell renders and auth-dependent chrome hydrates
  // whenever Clerk recovers.
  const CLERK_LOAD_GRACE_MS = 5_000;
  const [authWaitExpired, setAuthWaitExpired] = useState(false);
  useEffect(() => {
    if (isLoaded) return;
    const timer = setTimeout(
      () => setAuthWaitExpired(true),
      CLERK_LOAD_GRACE_MS
    );
    return () => clearTimeout(timer);
  }, [isLoaded]);
  const authSettled = isLoaded || authWaitExpired;
  const { t } = useTranslations();
  const [hasSeenInitial, setHasSeenInitial] = useState(false);
  const isDashboardRoute = pathname === '/dashboard';
  const isClientDashboard = pathname.startsWith('/dashboard'); // Client dashboard has its own header
  const isLibraryRoute = pathname.startsWith('/library'); // Library has its own editorial Mast
  // The design gallery embeds the real admin shell — its own header, its own
  // sidebar — so it is treated exactly like `/admin`: no marketing chrome on
  // top of it. Prefix-matched rather than listed literally, so a future
  // `/design-gallery/<surface>` sub-page needs no second entry.
  const isDesignGalleryRoute = pathname.startsWith('/design-gallery');
  const isNoNavbarRoute =
    noNavbarRoutes.includes(pathname) ||
    isTeamRoute ||
    isClientDashboard ||
    isLibraryRoute ||
    isDesignGalleryRoute;
  // Subscribed rather than polled: the flag is published by ErrorPageLayout in
  // a layout effect, so this re-renders before paint and the two headers never
  // appear together.
  const errorPageFlag = useSyncExternalStore(
    subscribeErrorPage,
    getIsErrorPage,
    getIsErrorPageServerSnapshot
  );
  const shouldHideNavbar = errorPageFlag || isNoNavbarRoute;

  // Prevent SSR flash by waiting for client-side mounting
  useEffect(() => {
    setIsMounted(true);
    if (typeof window !== 'undefined') {
      try {
        setHasSeenInitial(
          Boolean(window.sessionStorage.getItem('fs_seen_initial_v1'))
        );
      } catch {
        // no-op
      }
    }
  }, []);

  // Listen for draft loading events dispatched by pages
  // Don't show global loading screen for draft fetches on dashboard page
  useEffect(() => {
    const handleStart = (e: Event) => {
      const customEvent = e as CustomEvent;
      // Skip showing loader if we're on dashboard and it's just a draft fetch
      if (isDashboardRoute && customEvent.detail?.scope === 'draftFetch') {
        return;
      }
      setIsDraftLoading(true);
    };
    const handleEnd = () => setIsDraftLoading(false);
    window.addEventListener('draft-loading-start', handleStart);
    window.addEventListener('draft-loading-end', handleEnd);

    return () => {
      window.removeEventListener('draft-loading-start', handleStart);
      window.removeEventListener('draft-loading-end', handleEnd);
    };
  }, [isDashboardRoute]);

  // Remove route-driven loader; rely solely on query events
  useEffect(() => {
    return () => {
      if (loaderTimeoutRef.current) {
        clearTimeout(loaderTimeoutRef.current);
        loaderTimeoutRef.current = null;
      }
    };
  }, []);

  // Persist that we've already shown the initial loader once per tab session
  useEffect(() => {
    if (!hasSeenInitial && isMounted && (isPublicRoute || authSettled)) {
      try {
        window.sessionStorage.setItem('fs_seen_initial_v1', '1');
      } catch {
        // ignore
      }
      setHasSeenInitial(true);
    }
  }, [hasSeenInitial, isMounted, authSettled, isPublicRoute]);

  // Show the general app loader once on the very first load of the app (public or protected)
  // Never show for team routes - they handle their own loading
  const shouldShowInitial =
    !isTeamRoute && !hasSeenInitial && (!isMounted || !authSettled);

  // Consolidate all loading conditions to prevent duplicate loading screens
  // Never show for team routes
  const showLoading =
    !isTeamRoute &&
    (shouldShowInitial ||
      isDraftLoading ||
      !isMounted ||
      (!isPublicRoute && !authSettled));

  // Don't render navigation for template previews, error pages, or team routes
  // Check this FIRST before any loading logic to prevent flicker
  if (shouldHideNavbar) {
    return null;
  }

  // Don't render navbar until client is mounted - prevents SSR hydration flash
  if (!isMounted) {
    return null;
  }

  if (showLoading && !shouldHideNavbar) {
    // Determine message based on context and priority
    let message = t('app.loadingExperience');

    if (isDraftLoading && !shouldShowInitial) {
      message = t('draft.restoringDraft');
    } else if (isDashboardRoute) {
      message = t('dashboard.loading');
    }

    return <LoadingScreen message={message} />;
  }

  return isPublicRoute ? (
    <I18nProvider initialLocale="en" initialMessages={{ en, ro }}>
      <ExternalNavigation />
    </I18nProvider>
  ) : (
    <I18nProvider initialLocale="en" initialMessages={{ en, ro }}>
      <ExternalNavigationWithAuth />
    </I18nProvider>
  );
}
