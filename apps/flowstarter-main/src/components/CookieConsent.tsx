'use client';

import { useState, useEffect } from 'react';
import { X, Cookie } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useTranslations } from '@/lib/i18n';

const COOKIE_CONSENT_KEY = 'flowstarter_cookie_consent';

export function CookieConsent() {
  const { t } = useTranslations();
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    const consent = localStorage.getItem(COOKIE_CONSENT_KEY);
    if (!consent) {
      const timer = setTimeout(() => setIsVisible(true), 1500);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleAccept = () => {
    localStorage.setItem(
      COOKIE_CONSENT_KEY,
      JSON.stringify({
        essential: true,
        analytics: true,
        functional: true,
        timestamp: new Date().toISOString(),
      })
    );
    closeWithAnimation();
  };

  const handleEssentialOnly = () => {
    localStorage.setItem(
      COOKIE_CONSENT_KEY,
      JSON.stringify({
        essential: true,
        analytics: false,
        functional: false,
        timestamp: new Date().toISOString(),
      })
    );
    closeWithAnimation();
  };

  const closeWithAnimation = () => {
    setIsClosing(true);
    setTimeout(() => setIsVisible(false), 300);
  };

  if (!isVisible) return null;

  return (
    <div
      data-testid="cookie-consent-banner"
      className={`fixed bottom-0 left-0 right-0 z-[100] p-2 sm:p-6 transition-all duration-300 ${
        isClosing ? 'translate-y-full opacity-0' : 'translate-y-0 opacity-100'
      }`}
    >
      <div className="max-w-3xl mx-auto">
        {/* The shared liquid glass material on its near-opaque `--overlay`
            fill: this pane floats over page content that is not behind a
            scrim (see the class's own doc comment in
            packages/flow-design-system/src/styles/index.css), so the text
            beneath must not read through. `.fs-glass` supplies its own
            background, radius, blur and refractive edge, so the old flat
            white/dark fill, border and shadow are dropped rather than
            layered underneath it. */}
        <div className="fs-glass fs-glass--overlay relative overflow-hidden">
          <div className="p-2 sm:p-6">
            <div className="flex items-start gap-3 sm:gap-4">
              {/* Icon — dropped on phones, where every row of height matters;
                  restored from `sm:` up. */}
              <div className="hidden h-10 w-10 flex-shrink-0 rounded-xl bg-[var(--purple)]/10 sm:flex sm:items-center sm:justify-center">
                <Cookie className="h-5 w-5 text-[var(--purple)]" />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 pr-6">
                <h3 className="text-sm font-semibold text-[var(--fs-ink)] mb-0 sm:mb-1">
                  {t('cookie.title')}
                </h3>
                {/* Clamped to a single line on phones only, where the
                    banner's full height can cover the hero CTA underneath
                    it (see the Playwright proof in __tests__). "Learn more"
                    moves into the button row below rather than staying
                    inline in this paragraph, so clamping the description can
                    never clip the link out of the hit area. */}
                <p className="text-sm text-gray-500 dark:text-white/60 leading-relaxed mb-1 line-clamp-1 sm:mb-2 sm:line-clamp-none">
                  {t('cookie.description')}
                </p>

                {/* Buttons + the "Learn more" link, one compact row on
                    phones so the banner never grows tall enough to reach a
                    CTA sitting higher up the page. */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={handleAccept} variant="default" size="sm">
                    {t('cookie.acceptAll')}
                  </Button>
                  <Button
                    onClick={handleEssentialOnly}
                    variant="outline"
                    size="sm"
                  >
                    {t('cookie.essentialOnly')}
                  </Button>
                  <Link
                    href="/cookies"
                    className="text-sm text-[var(--purple)] hover:underline"
                  >
                    {t('cookie.learnMore')}
                  </Link>
                </div>
              </div>

              {/* Close button */}
              <button
                onClick={handleEssentialOnly}
                className="absolute top-2 right-2 p-1.5 rounded-lg text-gray-300 dark:text-white/30 hover:text-gray-500 dark:hover:text-white/60 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors sm:top-4 sm:right-4"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
