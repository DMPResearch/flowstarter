/**
 * The cookie inventory, checked against the code that sets the cookies.
 *
 * Three specific past failures are pinned here, because all three were prose
 * that had never been read next to the source:
 *
 *   `fs_country` was missing from a table calling itself complete.
 *   `NEXT_LOCALE` was listed and is set by nothing.
 *   `flowstarter_cookie_consent` was listed as a cookie and lives in
 *   localStorage, and the page told readers to clear it from their cookie
 *   settings, which would have done nothing at all.
 *
 * And the fourth: the analytics paragraph said "we currently use Plausible"
 * and "we do not run Google Analytics" two lines apart, while `src/env.ts`
 * declared a GA measurement id and `src/lib/google-analytics.ts` held the
 * event helpers. Both dead paths are gone, and the last test here is the gate
 * that keeps them gone.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONSENT_STORAGE_NOTE,
  COOKIE_INVENTORY,
  analyticsDisclosure,
} from '../cookies';
import { LOCALE_COOKIE_NAME } from '../../locale-resolution';

/** Surrogate-pair range: the app's ES target predates \p{} escapes. */
const EMOJI =
  /[\uD83C-\uDBFF][\uDC00-\uDFFF]|\uFE0F|[\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF]/;

const APP_ROOT = path.resolve(__dirname, '../../../..');

function readSource(relative: string): string {
  return readFileSync(path.join(APP_ROOT, relative), 'utf8');
}

describe('the inventory', () => {
  const names = COOKIE_INVENTORY.map((row) => row.name);

  it('lists fs_country, which the middleware sets and the old table missed', () => {
    expect(names).toContain('fs_country');
    expect(readSource('src/middleware.ts')).toContain(
      "cookies.set('fs_country'"
    );
  });

  it('lists flowstarter_theme, which the root layout writes', () => {
    expect(names).toContain('flowstarter_theme');
    expect(readSource('src/app/layout.tsx')).toContain('flowstarter_theme=');
  });

  it('does not list NEXT_LOCALE, which nothing in the app sets', () => {
    expect(names).not.toContain('NEXT_LOCALE');
  });

  it('lists fs_locale, set by middleware.ts (its own inference) and the /api/locale switcher (an explicit choice)', () => {
    expect(names).toContain('fs_locale');
    expect(LOCALE_COOKIE_NAME).toBe('fs_locale');
    expect(readSource('src/middleware.ts')).toContain(
      'res.cookies.set(LOCALE_COOKIE_NAME'
    );
    expect(readSource('src/app/api/locale/route.ts')).toContain(
      'response.cookies.set(LOCALE_COOKIE_NAME'
    );
  });

  it('does not list the consent choice, which is localStorage and not a cookie', () => {
    expect(names).not.toContain('flowstarter_cookie_consent');
    const consent = readSource('src/components/CookieConsent.tsx');
    expect(consent).toContain('localStorage.setItem');
    expect(consent).not.toContain('document.cookie');
  });

  it('says so, and says what actually resets the banner', () => {
    expect(CONSENT_STORAGE_NOTE).toMatch(/local\s*storage/i);
    expect(CONSENT_STORAGE_NOTE).toMatch(/Clearing site\s*data/i);
  });

  it('names nothing twice and describes everything it names', () => {
    expect(new Set(names).size).toBe(names.length);
    for (const row of COOKIE_INVENTORY) {
      expect(row.purpose.length).toBeGreaterThan(20);
      expect(row.duration.length).toBeGreaterThan(2);
      expect(row.setBy.length).toBeGreaterThan(3);
    }
  });

  it('writes no em dash and no emoji', () => {
    const prose = COOKIE_INVENTORY.map((row) => row.purpose).join(' ');
    expect(prose).not.toContain('—');
    expect(prose).not.toMatch(EMOJI);
    expect(CONSENT_STORAGE_NOTE).not.toContain('—');
  });
});

describe('analyticsDisclosure', () => {
  it('states plainly that nothing counts your visit, with no id set', () => {
    const disclosure = analyticsDisclosure({});
    expect(disclosure.running).toBe(false);
    expect(disclosure.statement).toMatch(/no analytics at all/i);
    expect(disclosure.statement).not.toMatch(/plausible/i);
  });

  it('treats an empty or whitespace id as no analytics', () => {
    expect(
      analyticsDisclosure({ NEXT_PUBLIC_GA_MEASUREMENT_ID: '' }).running
    ).toBe(false);
    expect(
      analyticsDisclosure({ NEXT_PUBLIC_GA_MEASUREMENT_ID: '   ' }).running
    ).toBe(false);
  });

  it('discloses Google Analytics when an id is set, rather than denying it', () => {
    const disclosure = analyticsDisclosure({
      NEXT_PUBLIC_GA_MEASUREMENT_ID: 'G-TEST123',
    });
    expect(disclosure.running).toBe(true);
    if (!disclosure.running) throw new Error('unreachable');
    expect(disclosure.measurementId).toBe('G-TEST123');
    expect(disclosure.statement).toMatch(/Google Analytics/);
    expect(disclosure.statement).not.toMatch(/We do not run Google Analytics/);
  });
});

/**
 * Every absolute URL in a source file, as parsed URLs.
 *
 * Parsing rather than substring-searching the text matters for the same
 * reason it matters in the product: `source.includes('googletagmanager.com')`
 * is satisfied by `notgoogletagmanager.com.evil.test` and misses a host
 * written with a port or in a template literal. Comparing a parsed
 * `hostname` exactly is both the correct check and not the shape CodeQL reads
 * as an incomplete URL sanitization.
 */
function urlsIn(source: string): URL[] {
  const found: URL[] = [];
  for (const raw of source.match(/https?:\/\/[^\s'"`)]+/g) ?? []) {
    try {
      found.push(new URL(raw));
    } catch {
      // Not a URL after all (a regex fragment, a truncated string). Ignore.
    }
  }
  return found;
}

/** Google's script hosts, matched exactly on hostname. */
const ANALYTICS_HOSTS = new Set([
  'www.googletagmanager.com',
  'googletagmanager.com',
  'www.google-analytics.com',
  'google-analytics.com',
]);

describe('the "no analytics" claim is true of the build, not just the copy', () => {
  it('loads no gtag or tag-manager script anywhere in src', () => {
    // The CSP allowlist in utils/security-headers.ts still names Google's
    // hosts, and that is fine: an allowance is not a load. What must not
    // exist is code that actually pulls the script in, so a URL only counts
    // as an offender when its parsed hostname is one of Google's AND it is
    // being fetched rather than listed in a policy.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (full.includes(`${path.sep}__tests__${path.sep}`)) continue;
        // The CSP policy file is the one place these hosts are named on
        // purpose, as an allowance rather than a fetch.
        if (full.endsWith(path.join('utils', 'security-headers.ts'))) continue;
        const source = readFileSync(full, 'utf8');
        const loadsScript = urlsIn(source).some(
          (url) =>
            ANALYTICS_HOSTS.has(url.hostname) && url.pathname.includes('gtag')
        );
        if (loadsScript || source.includes('window.gtag =')) {
          offenders.push(full);
        }
      }
    };
    walk(path.join(APP_ROOT, 'src'));
    expect(offenders).toEqual([]);
  });

  it('would catch a loader if one came back', () => {
    // The guard above is only worth having if it fires, so prove it does,
    // including on a host that merely contains Google's as a substring and
    // must NOT count.
    const loader = `<script src="https://www.googletagmanager.com/gtag/js?id=G-X" />`;
    const lookalike = `fetch('https://notgoogletagmanager.com.evil.test/gtag/js')`;
    const matches = (source: string) =>
      urlsIn(source).some(
        (url) =>
          ANALYTICS_HOSTS.has(url.hostname) && url.pathname.includes('gtag')
      );
    expect(matches(loader)).toBe(true);
    expect(matches(lookalike)).toBe(false);
  });

  it('no longer declares the measurement id in the validated env', () => {
    expect(readSource('src/env.ts')).not.toContain(
      'NEXT_PUBLIC_GA_MEASUREMENT_ID'
    );
  });
});
