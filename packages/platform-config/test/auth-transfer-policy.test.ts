import { describe, expect, it } from 'vitest';

import {
  authTransferAllowList,
  decideAuthTransferDestination,
  readAuthTransferEnvFromProcess,
  type AuthTransferEnvInput,
} from '../src/auth-transfer-policy';

/** A deployed production process: real zone, no http anywhere. */
const PRODUCTION: AuthTransferEnvInput = {
  flowstarterEnv: 'production',
  nodeEnv: 'production',
  platformDomain: 'flowstarter.net',
};

/** A staging slot: production-shaped Node, dev zone, still not development. */
const STAGING: AuthTransferEnvInput = {
  flowstarterEnv: 'staging',
  nodeEnv: 'production',
  platformDomain: 'flowstarter.dev',
  appOrigin: 'https://staging.flowstarter.dev',
};

/** A laptop, with the dev origins it actually runs on named in the env. */
const DEVELOPMENT: AuthTransferEnvInput = {
  flowstarterEnv: 'development',
  nodeEnv: 'development',
  platformDomain: 'flowstarter.dev',
  appOrigin: 'http://localhost:3000',
  editorOrigin: 'http://localhost:5733',
};

function reason(url: string, env: AuthTransferEnvInput) {
  const decision = decideAuthTransferDestination(url, env);
  return decision.allowed ? 'allowed' : decision.reason;
}

describe('authTransferAllowList', () => {
  it('names the app, both editor hosts and the library, over https', () => {
    expect(authTransferAllowList(PRODUCTION).map((e) => e.origin)).toEqual([
      'https://flowstarter.net',
      'https://code.flowstarter.net',
      'https://editor.flowstarter.net',
      'https://library.flowstarter.net',
    ]);
  });

  it('carries no http origin outside development', () => {
    for (const env of [PRODUCTION, STAGING]) {
      const http = authTransferAllowList({
        ...env,
        editorOrigin: 'http://localhost:5733',
      }).filter((e) => e.origin.startsWith('http://'));
      expect(http).toEqual([]);
    }
  });

  it('adds the configured http origins in development only', () => {
    expect(authTransferAllowList(DEVELOPMENT).map((e) => e.origin)).toContain(
      'http://localhost:5733',
    );
  });

  it('refuses a configured origin that names a PR slot or a preview', () => {
    const origins = authTransferAllowList({
      ...PRODUCTION,
      appOrigin: 'https://pr-7.staging.flowstarter.dev',
      editorOrigin: 'https://p-abc.preview.flowstarter.net',
    }).map((e) => e.origin);
    expect(origins).not.toContain('https://pr-7.staging.flowstarter.dev');
    expect(origins).not.toContain('https://p-abc.preview.flowstarter.net');
  });
});

describe('decideAuthTransferDestination — operator surfaces', () => {
  it('allows the editor origin', () => {
    const decision = decideAuthTransferDestination(
      'https://code.flowstarter.net/projects/abc',
      PRODUCTION,
    );
    expect(decision).toMatchObject({
      allowed: true,
      surface: 'editor',
      origin: 'https://code.flowstarter.net',
    });
  });

  it('allows the editor deep link on the editor.* host too', () => {
    expect(
      reason('https://editor.flowstarter.net/settings/general', PRODUCTION),
    ).toBe('allowed');
  });

  it('allows the library', () => {
    const decision = decideAuthTransferDestination(
      'https://library.flowstarter.net/agency-portfolio',
      PRODUCTION,
    );
    expect(decision).toMatchObject({ allowed: true, surface: 'library' });
  });

  it('allows an authenticated page of the app itself', () => {
    expect(reason('https://flowstarter.net/admin/dashboard', PRODUCTION)).toBe(
      'allowed',
    );
  });
});

describe('decideAuthTransferDestination — refused destination classes', () => {
  it('refuses a tenant site on the platform domain', () => {
    expect(reason('https://attacker.flowstarter.net/collect', PRODUCTION)).toBe(
      'untrusted-origin',
    );
  });

  it('refuses a hosted preview', () => {
    expect(
      reason('https://p-4f2a9c1d.preview.flowstarter.net/', PRODUCTION),
    ).toBe('untrusted-origin');
  });

  it('refuses a PR staging slot', () => {
    expect(reason('https://pr-73.staging.flowstarter.dev/', STAGING)).toBe(
      'untrusted-origin',
    );
  });

  it('refuses http on an otherwise allowed origin', () => {
    expect(reason('http://code.flowstarter.net/projects/a', PRODUCTION)).toBe(
      'insecure-scheme',
    );
  });

  it('refuses a path outside the surface allow-list', () => {
    expect(reason('https://flowstarter.net/', PRODUCTION)).toBe(
      'path-not-allowed',
    );
    expect(reason('https://flowstarter.net/pricing', PRODUCTION)).toBe(
      'path-not-allowed',
    );
  });

  it('refuses an API path on every surface', () => {
    expect(
      reason('https://code.flowstarter.net/api/clerk/me', PRODUCTION),
    ).toBe('path-not-allowed');
    expect(
      reason('https://library.flowstarter.net/api/anything', PRODUCTION),
    ).toBe('path-not-allowed');
  });

  it('refuses a prefix that only looks like one', () => {
    expect(reason('https://flowstarter.net/adminx', PRODUCTION)).toBe(
      'path-not-allowed',
    );
  });

  it('refuses a non-http scheme', () => {
    expect(reason('javascript:alert(1)', PRODUCTION)).toBe('insecure-scheme');
    expect(reason('data:text/html,<script>', PRODUCTION)).toBe(
      'insecure-scheme',
    );
  });
});

describe('decideAuthTransferDestination — open-redirect shapes', () => {
  it('refuses a protocol-relative URL', () => {
    expect(reason('//attacker.flowstarter.net/collect', PRODUCTION)).toBe(
      'malformed',
    );
  });

  it('refuses an authority hidden behind userinfo', () => {
    // `code.flowstarter.net` is the username here; the host is the attacker.
    expect(
      reason(
        'https://code.flowstarter.net@attacker.example/collect',
        PRODUCTION,
      ),
    ).toBe('embedded-credentials');
    expect(reason('https://user:pass@code.flowstarter.net/a', PRODUCTION)).toBe(
      'embedded-credentials',
    );
  });

  it('reports the real host, not the disguise, when it refuses userinfo', () => {
    const decision = decideAuthTransferDestination(
      'https://code.flowstarter.net@attacker.example/collect',
      PRODUCTION,
    );
    expect(decision).toEqual({
      allowed: false,
      reason: 'embedded-credentials',
      origin: 'https://attacker.example',
    });
  });

  it('refuses backslash authorities', () => {
    expect(
      reason('https://code.flowstarter.net\\@evil.example', PRODUCTION),
    ).toBe('malformed');
    expect(reason('\\\\attacker.flowstarter.net/collect', PRODUCTION)).toBe(
      'malformed',
    );
  });

  it('refuses encoded separators', () => {
    expect(
      reason('https://code.flowstarter.net/%2f%2fattacker.example', PRODUCTION),
    ).toBe('malformed');
    expect(
      reason('https://code.flowstarter.net/%5c%5cattacker.example', PRODUCTION),
    ).toBe('malformed');
  });

  it('refuses a unicode homograph of an allowed host', () => {
    // Cyrillic "с" in place of the ASCII "c" of `code`.
    expect(reason('https://сode.flowstarter.net/projects/a', PRODUCTION)).toBe(
      'untrusted-origin',
    );
  });

  it('refuses empty, non-string and relative candidates', () => {
    expect(reason('', PRODUCTION)).toBe('malformed');
    expect(reason('   ', PRODUCTION)).toBe('malformed');
    expect(reason('/admin/dashboard', PRODUCTION)).toBe('malformed');
    for (const value of [null, undefined, 42, {}]) {
      const decision = decideAuthTransferDestination(value, PRODUCTION);
      expect(decision).toEqual({
        allowed: false,
        reason: 'malformed',
        origin: null,
      });
    }
  });
});

describe('decideAuthTransferDestination — localhost by environment', () => {
  it('allows a configured localhost origin in development', () => {
    expect(reason('http://localhost:5733/projects/a', DEVELOPMENT)).toBe(
      'allowed',
    );
    expect(reason('http://localhost:3000/admin/dashboard', DEVELOPMENT)).toBe(
      'allowed',
    );
  });

  it('refuses localhost in staging and production, configured or not', () => {
    const configured = { editorOrigin: 'http://localhost:5733' };
    expect(
      reason('http://localhost:5733/projects/a', {
        ...PRODUCTION,
        ...configured,
      }),
    ).toBe('insecure-scheme');
    expect(
      reason('http://localhost:5733/projects/a', { ...STAGING, ...configured }),
    ).toBe('insecure-scheme');
  });

  it('refuses an https localhost that nothing configured', () => {
    expect(reason('https://localhost/projects/a', DEVELOPMENT)).toBe(
      'untrusted-origin',
    );
  });
});

describe('readAuthTransferEnvFromProcess', () => {
  it('prefers the dedicated names over the general ones', () => {
    expect(
      readAuthTransferEnvFromProcess({
        AUTH_TRANSFER_EDITOR_ORIGIN: 'https://editor.example',
        NEXT_PUBLIC_EDITOR_URL: 'https://other.example',
        AUTH_TRANSFER_APP_ORIGIN: 'https://app.example',
        NEXT_PUBLIC_SITE_URL: 'https://site.example',
        AUTH_TRANSFER_LIBRARY_ORIGIN: 'https://library.example',
      }),
    ).toMatchObject({
      editorOrigin: 'https://editor.example',
      appOrigin: 'https://app.example',
      libraryOrigin: 'https://library.example',
    });
  });

  it('falls back to the existing public URL names', () => {
    expect(
      readAuthTransferEnvFromProcess({
        NEXT_PUBLIC_SITE_URL: 'https://site.example',
        NEXT_PUBLIC_EDITOR_URL: 'https://other.example',
      }),
    ).toMatchObject({
      appOrigin: 'https://site.example',
      editorOrigin: 'https://other.example',
      libraryOrigin: undefined,
    });
  });
});
