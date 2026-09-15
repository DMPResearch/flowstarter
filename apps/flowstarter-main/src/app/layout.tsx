// Polyfill localStorage/sessionStorage for Node.js 22+ SSR compatibility
import '@/lib/storage-polyfill';

import { DatabaseOfflineHandler } from '@/components/DatabaseOfflineHandler';
import { ErrorBoundaryWrapper } from '@/components/ErrorBoundary';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { I18nProvider } from '@/lib/i18n';
import ro from '@/locales/ro';
import { getServerT } from '@/lib/i18n-server';
import en from '@/locales/en';
import '@/styles/globals.css';
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/onest';
import '@fontsource/roboto-mono/latin.css';
import type { Metadata } from 'next';
import { ClerkThemeWrapper } from './components/ClerkThemeWrapper';
import { ClientLayout } from './components/ClientLayout';
import { NavigationWrapper } from './components/NavigationWrapper';

const plusJakartaSans = {
  variable: '--font-jakarta',
};

const roboto_mono = {
  variable: '--font-roboto-mono',
};

export async function generateMetadata(): Promise<Metadata> {
  // Get locale from headers or use default 'en'
  // In a real app, you'd get this from headers/cookies
  const locale = 'en';
  const t = await getServerT(locale);

  return {
    title: t('app.title'),
    description: t('app.description'),
    openGraph: {
      title: t('app.title'),
      description: t('app.description'),
      siteName: 'Flowstarter',
      type: 'website',
      url: 'https://flowstarter.dev',
    },
    twitter: {
      card: 'summary_large_image',
      title: t('app.title'),
      description: t('app.description'),
    },
    icons: {
      icon: [
        { url: '/favicon.svg', type: 'image/svg+xml' },
        { url: '/favicon.ico' },
        { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
        { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      ],
      apple: '/apple-touch-icon.png',
    },
  };
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // No per-request reads here on purpose: this layout must stay statically
  // renderable so marketing/legal pages prerender to the CDN (no cold start).
  // Theme is resolved entirely client-side by the inline <head> script below
  // (cookie → localStorage → system), guarded by the visibility:hidden rule
  // so there's no flash before the class is applied — the standard no-SSR
  // theme pattern. CSP runs with 'unsafe-inline' in prod, so the inline
  // script needs no nonce.
  //
  // Locale follows the same rule for the same reason: `<html lang>` is
  // corrected client-side by a second inline script below, and
  // `I18nProvider`'s locale corrects itself from the same `fs_locale` cookie
  // a moment later (see `src/lib/i18n.tsx`). `middleware.ts` is what
  // actually resolves it — an explicit switcher choice, or its own
  // Accept-Language inference — this layout only ever reads the cookie that
  // caches that decision, client-side, never per request.

  return (
    <html
      lang="en"
      className={`${plusJakartaSans.variable} ${roboto_mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Critical anti-flicker styles */}
        <style
          dangerouslySetInnerHTML={{
            __html: [
              // When no theme class is set (first visit, auto), hide body
              // until the inline script below adds .dark or .light.
              // The script runs synchronously before body parses, so
              // the user never sees the hidden state.
              'html:not(.dark):not(.light) body{visibility:hidden}',
              // Dark backgrounds — both explicit class and media query fallback
              'html.dark,html.dark body{background-color:#0a0a0f!important}',
              '@media(prefers-color-scheme:dark){html:not(.light),html:not(.light) body{background-color:#0a0a0f!important}}',
            ].join(''),
          }}
        />
        <noscript>
          <style>{`html:not(.dark):not(.light) body{visibility:visible}`}</style>
        </noscript>
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  // Read from shared cookie first (synced across subdomains)
                  var cookieTheme = document.cookie.split(';').map(function(c) { return c.trim(); })
                    .find(function(c) { return c.startsWith('flowstarter_theme='); });
                  var theme = cookieTheme ? cookieTheme.split('=')[1] : null;
                  // Fall back to localStorage, then default to system
                  if (!theme || !['light','dark','system'].includes(theme)) {
                    theme = localStorage.getItem('theme') || localStorage.getItem('flowstarter_theme') || 'system';
                  }
                  // Migrate localStorage to cookie
                  if (!cookieTheme && theme !== 'system') {
                    var parts = location.hostname.split('.');
                    var domain = parts.length > 2 ? '; domain=.' + parts.slice(-2).join('.') : '';
                    document.cookie = 'flowstarter_theme=' + theme + '; path=/; max-age=31536000; SameSite=Lax' + domain;
                  }
                  var systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                  var resolvedTheme = theme === 'system' ? systemTheme : theme;
                  document.documentElement.classList.remove('light', 'dark');
                  document.documentElement.classList.add(resolvedTheme);
                  document.documentElement.setAttribute('data-theme', resolvedTheme);
                  // Defer enabling the bg-color transition until AFTER the
                  // first frame is painted with the resolved theme. Without
                  // this, the SSR-rendered class="light" to "dark" flip
                  // animates the body bg on every first visit. See the
                  // html.theme-ready rule in styles/globals.css.
                  requestAnimationFrame(function() {
                    document.documentElement.classList.add('theme-ready');
                  });
                } catch (e) {}
              })();
            `,
          }}
        />
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  // Locale, resolved entirely client-side from the fs_locale
                  // cookie — the same "no per-request read in this layout"
                  // shape the theme script above uses, applied to <html
                  // lang> instead of a CSS class. middleware.ts guarantees
                  // this cookie is already set (an explicit switcher choice,
                  // or its own Accept-Language inference cached on first
                  // visit) by the time this response reaches the browser, so
                  // reading it here needs no header parsing of its own.
                  // Keep this list in sync with SUPPORTED_LOCALES in
                  // src/lib/locale-resolution.ts.
                  var supported = ['en', 'ro'];
                  var cookieLocale = document.cookie.split(';').map(function(c) { return c.trim(); })
                    .find(function(c) { return c.indexOf('fs_locale=') === 0; });
                  var locale = cookieLocale ? decodeURIComponent(cookieLocale.split('=')[1] || '') : null;
                  if (locale && supported.indexOf(locale) !== -1) {
                    document.documentElement.setAttribute('lang', locale);
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body
        className="font-sans min-h-screen"
        style={{ fontFamily: 'var(--font-jakarta)' }}
        suppressHydrationWarning
      >
        <ErrorBoundaryWrapper>
          <ThemeProvider>
            <I18nProvider initialLocale="en" initialMessages={{ en, ro }}>
              <ClerkThemeWrapper>
                <ClientLayout>
                  <DatabaseOfflineHandler>
                    <NavigationWrapper />
                    {children}
                  </DatabaseOfflineHandler>
                </ClientLayout>
              </ClerkThemeWrapper>
            </I18nProvider>
          </ThemeProvider>
        </ErrorBoundaryWrapper>
      </body>
    </html>
  );
}
