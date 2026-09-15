'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import {
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '@/lib/locale-resolution';

const LABEL_KEY: Record<
  SupportedLocale,
  'nav.language.en' | 'nav.language.ro'
> = {
  en: 'nav.language.en',
  ro: 'nav.language.ro',
};

const SWITCH_TO_KEY: Record<
  SupportedLocale,
  'nav.language.switchTo.en' | 'nav.language.switchTo.ro'
> = {
  en: 'nav.language.switchTo.en',
  ro: 'nav.language.switchTo.ro',
};

/**
 * The whole switcher: two quiet text links, no flags (a flag names a
 * country, not a language, and we ship exactly two languages). Plain links
 * to `/api/locale`, not a button with a client-side `fetch` — they work
 * before any JS has loaded, and a real navigation is what lets the visitor's
 * next request pick up the cookie the route just wrote.
 *
 * `useI18n` rather than `useOptionalI18n`: everywhere this mounts is already
 * inside the app's `I18nProvider` (see `SiteHeader.tsx`), and a switcher that
 * silently renders nothing when the provider is missing is worse than one
 * that fails loudly in development.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { locale, t } = useI18n();
  const pathname = usePathname() || '/';
  const searchParams = useSearchParams();
  const search = searchParams?.toString();
  const next = search ? `${pathname}?${search}` : pathname;

  return (
    <div
      role="group"
      aria-label={t('nav.language')}
      className={[
        'inline-flex items-center gap-0.5 rounded-full border border-[var(--fs-rule)] p-0.5 text-xs font-semibold',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {SUPPORTED_LOCALES.map((code) => {
        const isActive = locale === code;
        return (
          <a
            key={code}
            href={`/api/locale?locale=${code}&next=${encodeURIComponent(next)}`}
            aria-current={isActive ? 'true' : undefined}
            aria-label={t(SWITCH_TO_KEY[code])}
            className={[
              'rounded-full px-2.5 py-1 uppercase tracking-wide transition-colors no-underline',
              isActive
                ? 'bg-[var(--fs-ink)]/[0.06] text-[var(--fs-ink)] dark:bg-white/10 dark:text-white'
                : 'text-[var(--fs-ink-faint)] hover:text-[var(--fs-ink)] dark:hover:text-white',
            ].join(' ')}
          >
            {code}
          </a>
        );
      })}
    </div>
  );
}
