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
      className={`fixed bottom-0 left-0 right-0 z-[100] p-4 sm:p-6 transition-all duration-300 ${
        isClosing ? 'translate-y-full opacity-0' : 'translate-y-0 opacity-100'
      }`}
    >
      <div className="max-w-3xl mx-auto">
        <div className="relative bg-white/90 dark:bg-[var(--glass-surface)]/90 backdrop-blur-2xl backdrop-saturate-150 rounded-2xl border-t border-l border-white/50 dark:border-white/[0.08] border-b border-r border-black/[0.06] dark:border-black/[0.2] shadow-[0_12px_48px_rgba(0,0,0,0.12),0_1px_0_rgba(255,255,255,0.9)_inset] dark:shadow-[0_12px_48px_rgba(0,0,0,0.5),0_1px_0_rgba(255,255,255,0.06)_inset] overflow-hidden">
          <div className="p-5 sm:p-6">
            <div className="flex items-start gap-4">
              {/* Icon */}
              <div className="w-10 h-10 rounded-xl bg-[var(--purple)]/10 flex items-center justify-center flex-shrink-0">
                <Cookie className="w-5 h-5 text-[var(--purple)]" />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 pr-6">
                <h3 className="text-sm font-semibold text-[var(--fs-ink)] mb-1">
                  {t('cookie.title')}
                </h3>
                <p className="text-sm text-gray-500 dark:text-white/60 leading-relaxed mb-4">
                  {t('cookie.description')}{' '}
                  <Link
                    href="/cookies"
                    className="text-[var(--purple)] hover:underline"
                  >
                    {t('cookie.learnMore')}
                  </Link>
                </p>

                {/* Buttons */}
                <div className="flex items-center gap-2">
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
                </div>
              </div>

              {/* Close button */}
              <button
                onClick={handleEssentialOnly}
                className="absolute top-4 right-4 p-1.5 rounded-lg text-gray-300 dark:text-white/30 hover:text-gray-500 dark:hover:text-white/60 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
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
