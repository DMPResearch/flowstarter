'use client';

import en from '@/locales/en';
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { LOCALE_COOKIE_NAME, isSupportedLocale } from './locale-resolution';

type Messages = Record<string, string>;
type En = typeof en;
export type TranslationKeys = keyof En;

// Extract placeholder names inside {curly} braces from a template string
type ExtractParams<S extends string> =
  S extends `${string}{${infer P}}${infer R}` ? P | ExtractParams<R> : never;
type ParamsFor<K extends TranslationKeys> = ExtractParams<En[K]>;
export type VarsFor<K extends TranslationKeys> = [ParamsFor<K>] extends [never]
  ? undefined
  : Partial<Record<ParamsFor<K>, string | number>>;
export type TranslationFn = <K extends TranslationKeys>(
  key: K,
  vars?: VarsFor<K>
) => string;

// Re-export server types and functions from the server-only module
export type {
  TranslationKeys as ServerTranslationKeys,
  VarsFor as ServerVarsFor,
} from './i18n-server';

interface I18nContextValue {
  locale: string;
  messages: Messages;
  t: TranslationFn;
  setLocale: (locale: string) => void;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

export function I18nProvider({
  children,
  initialLocale = 'en',
  initialMessages,
}: {
  children: React.ReactNode;
  initialLocale?: string;
  initialMessages: Record<string, Record<TranslationKeys, string>>;
}) {
  const [locale, setLocale] = useState(initialLocale);

  // The provider always mounts with `initialLocale` (English by default —
  // see `app/layout.tsx`'s own comment on why it never reads cookies itself)
  // so server and first client render match exactly and there is no
  // hydration mismatch. Once mounted, this corrects to whatever
  // `middleware.ts` resolved for this visitor — an explicit switcher choice,
  // or its own Accept-Language inference — cached in the `fs_locale` cookie.
  // A visitor whose resolved locale differs from English sees a brief,
  // one-time correction rather than a permanently wrong language; this is
  // the same "resolved client-side from a cookie" shape `app/layout.tsx`
  // already uses for theme, applied here to locale instead of a CSS class.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const match = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${LOCALE_COOKIE_NAME}=`));
    const cookieLocale = match
      ? decodeURIComponent(match.split('=')[1] ?? '')
      : null;
    if (isSupportedLocale(cookieLocale) && cookieLocale !== locale) {
      setLocale(cookieLocale);
    }
    // Runs once, on mount, to pick up the resolved value — not on every
    // `locale` change, which would fight `setLocale` calls made explicitly
    // elsewhere (the switcher itself sets the cookie AND navigates, so it
    // does not depend on this effect at all).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const t = useMemo(() => {
    const enMessages = (initialMessages.en || {}) as Record<
      TranslationKeys,
      string
    >;
    const localeOverlay = (initialMessages[locale] || {}) as Partial<
      Record<TranslationKeys, string>
    >;
    // Merge: English as base, locale overrides only the keys it defines.
    const messages = { ...enMessages, ...localeOverlay } as Record<
      TranslationKeys,
      string
    >;
    return (<K extends TranslationKeys>(key: K, vars?: VarsFor<K>) => {
      let template = messages[key] ?? (key as string);
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          template = template.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
      }
      return template;
    }) as I18nContextValue['t'];
  }, [locale, initialMessages]);

  const value: I18nContextValue = {
    locale,
    messages: {
      ...((initialMessages.en || {}) as Record<string, string>),
      ...((initialMessages[locale] || {}) as Partial<
        Record<TranslationKeys, string>
      >),
    } as Record<TranslationKeys, string>,
    t,
    setLocale,
  };

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}

/**
 * The dictionary when there is a provider above, and undefined when there is
 * not, instead of throwing.
 *
 * For a component that can be dropped into a surface that threads `t` down as
 * a prop rather than mounting a provider -- the discovery wizard does exactly
 * that -- and that must not be able to take the page down simply by being
 * mounted there. A caller that genuinely requires the dictionary still uses
 * `useI18n`, which still throws.
 */
export function useOptionalI18n() {
  return useContext(I18nContext);
}

export const useTranslations = useI18n;
