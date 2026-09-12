import { describe, expect, it } from 'vitest';
import {
  MAX_LABEL_LENGTH,
  SiteHostnameError,
  assertSiteLabel,
  finalHostname,
  finalSiteUrl,
  isPreviewHostname,
  isValidSiteLabel,
  labelFromFinalHostname,
  labelFromPreviewHostname,
  previewHostname,
  previewSiteUrl,
  previewZone,
  siteRootDomain,
} from '../site-hostnames';

/**
 * The whole point of this module is that a hostname is decided by a rule
 * rather than by whatever domain a request happened to arrive on, so every
 * test here states the environment it is describing.
 */
const DEV = { FLOWSTARTER_ENV: 'development' } as Record<
  string,
  string | undefined
>;
const TEST = { FLOWSTARTER_ENV: 'test' } as Record<string, string | undefined>;
const STAGING = { FLOWSTARTER_ENV: 'staging' } as Record<
  string,
  string | undefined
>;
const PROD = { FLOWSTARTER_ENV: 'production' } as Record<
  string,
  string | undefined
>;

describe('the platform domain each environment gets', () => {
  it('is flowstarter.dev everywhere but production', () => {
    expect(siteRootDomain({ env: DEV })).toBe('flowstarter.dev');
    expect(siteRootDomain({ env: TEST })).toBe('flowstarter.dev');
    expect(siteRootDomain({ env: STAGING })).toBe('flowstarter.dev');
  });

  it('is flowstarter.net in production', () => {
    expect(siteRootDomain({ env: PROD })).toBe('flowstarter.net');
  });

  it('lets an explicit PLATFORM_DOMAIN win over the environment', () => {
    expect(
      siteRootDomain({ env: { ...PROD, PLATFORM_DOMAIN: 'flowstarter.app' } })
    ).toBe('flowstarter.app');
  });

  it('is not derived from the hostname the app is served on', () => {
    // A development process reached over a production-looking host still
    // writes into the development zone. The alternative is a request choosing
    // which Cloudflare zone a DNS record lands in.
    expect(
      siteRootDomain({ env: { ...DEV, HOST: 'app.flowstarter.net' } })
    ).toBe('flowstarter.dev');
  });
});

describe('finalHostname', () => {
  it('is {slug}.{platformDomain}, with no preview namespace anywhere in it', () => {
    expect(finalHostname('acme', { env: PROD })).toBe('acme.flowstarter.net');
    expect(finalHostname('acme', { env: DEV })).toBe('acme.flowstarter.dev');
    expect(finalHostname('acme', { env: STAGING })).toBe(
      'acme.flowstarter.dev'
    );
    expect(finalHostname('acme', { env: PROD })).not.toContain('preview');
  });

  it('matches the shape a client site is already served at', () => {
    // `A lebadusul.flowstarter.net` is live today. The rule has to produce
    // exactly the name that already exists, not a near miss.
    expect(finalHostname('lebadusul', { env: PROD })).toBe(
      'lebadusul.flowstarter.net'
    );
  });

  it('gives an https URL', () => {
    expect(finalSiteUrl('acme', { env: PROD })).toBe(
      'https://acme.flowstarter.net'
    );
  });
});

describe('previewHostname', () => {
  it('is {previewId}.preview.{platformDomain}', () => {
    expect(previewHostname('p-0123456789abcdef', { env: PROD })).toBe(
      'p-0123456789abcdef.preview.flowstarter.net'
    );
    expect(previewHostname('p-0123456789abcdef', { env: DEV })).toBe(
      'p-0123456789abcdef.preview.flowstarter.dev'
    );
  });

  it('honours a pinned preview zone, because the wildcard record is pinned', () => {
    expect(
      previewZone({
        env: {
          ...DEV,
          FLOWSTARTER_PREVIEW_DOMAIN_SUFFIX: 'preview.flowstarter.net',
        },
      })
    ).toBe('preview.flowstarter.net');
    expect(
      previewHostname('p-0123456789abcdef', {
        env: {
          ...DEV,
          FLOWSTARTER_PREVIEW_DOMAIN_SUFFIX: 'preview.flowstarter.net',
        },
      })
    ).toBe('p-0123456789abcdef.preview.flowstarter.net');
  });

  it('gives an https URL', () => {
    expect(previewSiteUrl('p-0123456789abcdef', { env: PROD })).toBe(
      'https://p-0123456789abcdef.preview.flowstarter.net'
    );
  });

  it('is never the same namespace as a final hostname', () => {
    const preview = previewHostname('acme', { env: PROD });
    const final = finalHostname('acme', { env: PROD });
    expect(preview).not.toBe(final);
    expect(isPreviewHostname(preview, { env: PROD })).toBe(true);
    expect(isPreviewHostname(final, { env: PROD })).toBe(false);
  });
});

describe('a label is validated so a hostname can never be malformed', () => {
  it('accepts lowercase letters, digits and inner hyphens', () => {
    for (const good of [
      'a',
      'acme',
      'acme-2',
      'p-0123456789abcdef',
      '9lives',
    ]) {
      expect(isValidSiteLabel(good)).toBe(true);
    }
  });

  it('rejects everything that would produce a name we did not mean', () => {
    const bad = [
      '', // nothing at all
      'ACME', // uppercase
      '-acme', // leading hyphen
      'acme-', // trailing hyphen
      'acme.com', // a dot escapes the label into another zone
      'acme com', // whitespace
      'acme_1', // underscore is not a DNS label character
      '*', // a wildcard is never a site
      'a'.repeat(MAX_LABEL_LENGTH + 1),
    ];
    for (const value of bad) {
      expect(isValidSiteLabel(value)).toBe(false);
      expect(() => finalHostname(value, { env: PROD })).toThrow(
        SiteHostnameError
      );
      expect(() => previewHostname(value, { env: PROD })).toThrow(
        SiteHostnameError
      );
    }
  });

  it('rejects a null or undefined slug rather than naming a site after it', () => {
    // `null.preview.flowstarter.net` was a real record request.
    expect(() => assertSiteLabel(null as unknown as string)).toThrow(
      SiteHostnameError
    );
    expect(() => assertSiteLabel(undefined as unknown as string)).toThrow(
      SiteHostnameError
    );
    expect(() => assertSiteLabel(12 as unknown as string)).toThrow(
      SiteHostnameError
    );
  });

  it('names the offending value and the kind in the message', () => {
    expect(() => assertSiteLabel('Acme', 'slug')).toThrow(/slug "Acme"/);
    expect(() => assertSiteLabel('Acme', 'preview id')).toThrow(
      /preview id "Acme"/
    );
  });

  it('accepts a label at the DNS limit and refuses one past it', () => {
    const atLimit = 'a'.repeat(MAX_LABEL_LENGTH);
    expect(finalHostname(atLimit, { env: PROD })).toBe(
      `${atLimit}.flowstarter.net`
    );
    expect(() =>
      finalHostname('a'.repeat(MAX_LABEL_LENGTH + 1), { env: PROD })
    ).toThrow(/longer than 63/);
  });
});

describe('reading a label back out of a hostname', () => {
  it('recovers a preview label only from the preview zone', () => {
    expect(
      labelFromPreviewHostname('p-0123456789abcdef.preview.flowstarter.net', {
        env: PROD,
      })
    ).toBe('p-0123456789abcdef');
    expect(
      labelFromPreviewHostname('p-0123456789abcdef.evil.example.com', {
        env: PROD,
      })
    ).toBeNull();
    // A final hostname is not a preview hostname, however much it looks like
    // a name we own.
    expect(
      labelFromPreviewHostname('acme.flowstarter.net', { env: PROD })
    ).toBeNull();
  });

  it('recovers a final label only from a single label in our own zone', () => {
    expect(labelFromFinalHostname('acme.flowstarter.net', { env: PROD })).toBe(
      'acme'
    );
    expect(
      labelFromFinalHostname('acme.preview.flowstarter.net', { env: PROD })
    ).toBeNull();
    expect(
      labelFromFinalHostname('acme.flowstarter.dev', { env: PROD })
    ).toBeNull();
    expect(labelFromFinalHostname('flowstarter.net', { env: PROD })).toBeNull();
  });

  it('is case-insensitive about the hostname it is handed', () => {
    expect(labelFromFinalHostname('ACME.FlowStarter.net', { env: PROD })).toBe(
      'acme'
    );
  });
});
