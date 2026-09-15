import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  bestSupportedLocaleFromAcceptLanguage,
  isSupportedLocale,
  resolveLocale,
} from '../locale-resolution';

describe('resolveLocale', () => {
  it('an explicit cookie choice wins over any header', () => {
    expect(
      resolveLocale({ cookie: 'en', acceptLanguage: 'ro-RO,ro;q=0.9' })
    ).toBe('en');
    expect(
      resolveLocale({ cookie: 'ro', acceptLanguage: 'en-US,en;q=0.9' })
    ).toBe('ro');
  });

  it("the header's best supported match wins when there is no cookie", () => {
    expect(
      resolveLocale({ cookie: null, acceptLanguage: 'ro-RO,ro;q=0.9,en;q=0.5' })
    ).toBe('ro');
  });

  it('an unsupported header falls back to the default, English', () => {
    expect(
      resolveLocale({ cookie: null, acceptLanguage: 'fr-FR,fr;q=0.9' })
    ).toBe(DEFAULT_LOCALE);
    expect(resolveLocale({ cookie: null, acceptLanguage: null })).toBe(
      DEFAULT_LOCALE
    );
  });

  it('an unsupported or garbage cookie value is not trusted, and falls through to the header', () => {
    expect(resolveLocale({ cookie: 'fr', acceptLanguage: 'ro;q=1' })).toBe(
      'ro'
    );
    expect(resolveLocale({ cookie: '<script>', acceptLanguage: null })).toBe(
      DEFAULT_LOCALE
    );
  });
});

describe('bestSupportedLocaleFromAcceptLanguage', () => {
  it('matches the primary subtag of a regional tag', () => {
    expect(bestSupportedLocaleFromAcceptLanguage('ro-RO')).toBe('ro');
  });

  it('picks the highest-quality supported tag, not the first in the list', () => {
    expect(
      bestSupportedLocaleFromAcceptLanguage('fr;q=0.9,ro;q=0.8,en;q=0.4')
    ).toBe('ro');
  });

  it('returns null when nothing in the header is supported', () => {
    expect(bestSupportedLocaleFromAcceptLanguage('fr-FR,de;q=0.8')).toBeNull();
  });

  it('returns null for an empty or missing header', () => {
    expect(bestSupportedLocaleFromAcceptLanguage(null)).toBeNull();
    expect(bestSupportedLocaleFromAcceptLanguage(undefined)).toBeNull();
    expect(bestSupportedLocaleFromAcceptLanguage('')).toBeNull();
  });

  it('tolerates malformed q-values instead of throwing', () => {
    expect(bestSupportedLocaleFromAcceptLanguage('ro;q=notanumber')).toBe('ro');
  });
});

describe('isSupportedLocale', () => {
  it('accepts exactly the two shipped locales', () => {
    expect(isSupportedLocale('en')).toBe(true);
    expect(isSupportedLocale('ro')).toBe(true);
  });

  it('rejects anything else, including empty and undefined', () => {
    expect(isSupportedLocale('fr')).toBe(false);
    expect(isSupportedLocale('')).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
  });
});
