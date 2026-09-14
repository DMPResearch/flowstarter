import { describe, expect, it } from 'vitest';
import {
  assertPublicPlatformOrigin,
  isLoopbackHostname,
  isLoopbackUrl,
  isPublicHttpsOrigin,
  publicAppOrigin,
  publicCallbackOrigin,
  UnsafePlatformOriginError,
  type PublicOriginEnvInput,
} from '../src/public-origin';

/** A deployed production process: real zone, no override needed. */
const PRODUCTION: PublicOriginEnvInput = {
  flowstarterEnv: 'production',
  nodeEnv: 'production',
  platformDomain: 'flowstarter.net',
};

/** The shared staging box's `main` slot: production-shaped Node, dev zone. */
const STAGING: PublicOriginEnvInput = {
  flowstarterEnv: 'staging',
  nodeEnv: 'production',
};

/** A laptop, with nothing named. */
const DEVELOPMENT: PublicOriginEnvInput = {
  flowstarterEnv: 'development',
  nodeEnv: 'development',
};

describe('publicAppOrigin', () => {
  it('is the bare platform domain in production', () => {
    expect(publicAppOrigin(PRODUCTION)).toBe('https://flowstarter.net');
  });

  it('is staging.{domain} in staging, not the bare apex nothing answers on', () => {
    expect(publicAppOrigin(STAGING)).toBe('https://staging.flowstarter.dev');
  });

  it('respects a PLATFORM_DOMAIN override in both staging and production', () => {
    expect(
      publicAppOrigin({ ...STAGING, platformDomain: 'flowstarter.app' }),
    ).toBe('https://staging.flowstarter.app');
    expect(
      publicAppOrigin({ ...PRODUCTION, platformDomain: 'flowstarter.app' }),
    ).toBe('https://flowstarter.app');
  });

  it('falls back to NODE_ENV=production when FLOWSTARTER_ENV is unset', () => {
    expect(
      publicAppOrigin({
        nodeEnv: 'production',
        platformDomain: 'flowstarter.net',
      }),
    ).toBe('https://flowstarter.net');
  });

  it('never treats NODE_ENV=production alone as staging: staging must be named', () => {
    // Staging runs with NODE_ENV=production like a real production build, so
    // NODE_ENV can never disambiguate the two on its own.
    expect(
      publicAppOrigin({
        nodeEnv: 'production',
        platformDomain: 'flowstarter.net',
      }),
    ).toBe('https://flowstarter.net');
  });

  it('uses NEXT_PUBLIC_SITE_URL in development, not the platform domain', () => {
    expect(
      publicAppOrigin({
        ...DEVELOPMENT,
        siteUrl: 'http://192.168.1.5:3000/',
      }),
    ).toBe('http://192.168.1.5:3000');
  });

  it('falls back to http://localhost:{PORT} in development with nothing else set', () => {
    expect(publicAppOrigin({ ...DEVELOPMENT, port: '3100' })).toBe(
      'http://localhost:3100',
    );
  });

  it('falls back to http://localhost:3000 in development with no PORT either', () => {
    expect(publicAppOrigin(DEVELOPMENT)).toBe('http://localhost:3000');
  });

  it('treats an unset FLOWSTARTER_ENV and non-production NODE_ENV as development', () => {
    // The exact shape a plain `vitest` process runs under: NODE_ENV=test.
    expect(publicAppOrigin({ nodeEnv: 'test' })).toBe('http://localhost:3000');
  });

  it('FLOWSTARTER_PUBLIC_APP_ORIGIN wins outright over every other rule', () => {
    expect(
      publicAppOrigin({
        ...PRODUCTION,
        publicAppOrigin: 'https://pr-7.staging.flowstarter.dev/',
      }),
    ).toBe('https://pr-7.staging.flowstarter.dev');
    expect(
      publicAppOrigin({
        ...DEVELOPMENT,
        siteUrl: 'http://192.168.1.5:3000',
        publicAppOrigin: 'https://tunnel.example.com',
      }),
    ).toBe('https://tunnel.example.com');
  });

  it('reads live process.env when called with no argument', () => {
    const previous = {
      FLOWSTARTER_ENV: process.env.FLOWSTARTER_ENV,
      FLOWSTARTER_PUBLIC_APP_ORIGIN: process.env.FLOWSTARTER_PUBLIC_APP_ORIGIN,
    };
    try {
      process.env.FLOWSTARTER_ENV = 'production';
      process.env.FLOWSTARTER_PUBLIC_APP_ORIGIN = 'https://example.test';
      expect(publicAppOrigin()).toBe('https://example.test');
    } finally {
      if (previous.FLOWSTARTER_ENV === undefined) {
        delete process.env.FLOWSTARTER_ENV;
      } else {
        process.env.FLOWSTARTER_ENV = previous.FLOWSTARTER_ENV;
      }
      if (previous.FLOWSTARTER_PUBLIC_APP_ORIGIN === undefined) {
        delete process.env.FLOWSTARTER_PUBLIC_APP_ORIGIN;
      } else {
        process.env.FLOWSTARTER_PUBLIC_APP_ORIGIN =
          previous.FLOWSTARTER_PUBLIC_APP_ORIGIN;
      }
    }
  });
});

describe('publicCallbackOrigin', () => {
  it('defaults to the app origin in production', () => {
    expect(publicCallbackOrigin(PRODUCTION)).toBe('https://flowstarter.net');
  });

  it('defaults to the app origin in staging', () => {
    expect(publicCallbackOrigin(STAGING)).toBe(
      'https://staging.flowstarter.dev',
    );
  });

  it('defaults to the app origin in development too, LAN address and all', () => {
    expect(
      publicCallbackOrigin({
        ...DEVELOPMENT,
        siteUrl: 'http://192.168.1.5:3000',
      }),
    ).toBe('http://192.168.1.5:3000');
  });

  it('is overridable on its own, for a tunnel in front of a laptop', () => {
    expect(
      publicCallbackOrigin({
        ...DEVELOPMENT,
        siteUrl: 'http://192.168.1.5:3000',
        publicCallbackOrigin: 'https://my-tunnel.trycloudflare.com/',
      }),
    ).toBe('https://my-tunnel.trycloudflare.com');
  });

  it('does not let FLOWSTARTER_PUBLIC_APP_ORIGIN silently double as the callback origin override', () => {
    // Setting the app origin override alone still routes the callback
    // through publicAppOrigin(), which is the documented default -- this
    // just pins that neither name accidentally reads the other's env var.
    expect(
      publicCallbackOrigin({
        ...PRODUCTION,
        publicAppOrigin: 'https://app-only.example.com',
      }),
    ).toBe('https://app-only.example.com');
  });
});

describe('isLoopbackHostname / isLoopbackUrl', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])(
    'treats %s as loopback',
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(true);
    },
  );

  it.each(['flowstarter.dev', 'staging.flowstarter.dev', '192.168.1.5'])(
    'does not treat %s as loopback',
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(false);
    },
  );

  it('reads the hostname out of a full URL', () => {
    expect(isLoopbackUrl('http://localhost:3005/api/leads/capture/x')).toBe(
      true,
    );
    expect(isLoopbackUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isLoopbackUrl('https://staging.flowstarter.dev')).toBe(false);
  });

  it('is false, not throwing, for a value that is not a URL at all', () => {
    expect(isLoopbackUrl('not-a-url')).toBe(false);
  });
});

describe('isPublicHttpsOrigin', () => {
  it('accepts a real https origin', () => {
    expect(isPublicHttpsOrigin('https://flowstarter.dev')).toBe(true);
    expect(
      isPublicHttpsOrigin(
        'https://staging.flowstarter.dev/api/leads/capture/tok',
      ),
    ).toBe(true);
  });

  it('refuses plain http even on a real host', () => {
    expect(isPublicHttpsOrigin('http://flowstarter.dev')).toBe(false);
  });

  it('refuses every loopback shape regardless of scheme', () => {
    expect(isPublicHttpsOrigin('http://localhost:3005')).toBe(false);
    expect(isPublicHttpsOrigin('https://localhost:3005')).toBe(false);
    expect(isPublicHttpsOrigin('http://127.0.0.1:3000')).toBe(false);
  });

  it('refuses a value that is not a URL', () => {
    expect(isPublicHttpsOrigin('definitely not a url')).toBe(false);
  });
});

describe('assertPublicPlatformOrigin', () => {
  it('is a no-op when the target is not a platform host', () => {
    expect(() =>
      assertPublicPlatformOrigin({
        variable: 'FLOWSTARTER_PUBLIC_APP_ORIGIN',
        value: 'http://localhost:3005/api/leads/capture/x',
        targetIsPlatformHost: false,
      }),
    ).not.toThrow();
  });

  it('is a no-op for a null or empty value, whatever the target', () => {
    expect(() =>
      assertPublicPlatformOrigin({
        variable: 'FLOWSTARTER_PUBLIC_APP_ORIGIN',
        value: null,
        targetIsPlatformHost: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertPublicPlatformOrigin({
        variable: 'FLOWSTARTER_PUBLIC_APP_ORIGIN',
        value: '  ',
        targetIsPlatformHost: true,
      }),
    ).not.toThrow();
  });

  it('passes a public https origin against a platform host', () => {
    expect(() =>
      assertPublicPlatformOrigin({
        variable: 'FLOWSTARTER_PUBLIC_APP_ORIGIN',
        value: 'https://staging.flowstarter.dev/api/leads/capture/x',
        targetIsPlatformHost: true,
      }),
    ).not.toThrow();
  });

  it('refuses a loopback origin against a platform host, naming the variable', () => {
    let caught: unknown;
    try {
      assertPublicPlatformOrigin({
        variable: 'FLOWSTARTER_PUBLIC_APP_ORIGIN',
        value: 'http://localhost:3005/api/leads/capture/x',
        targetIsPlatformHost: true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsafePlatformOriginError);
    const error = caught as InstanceType<typeof UnsafePlatformOriginError>;
    expect(error.variable).toBe('FLOWSTARTER_PUBLIC_APP_ORIGIN');
    expect(error.message).toContain('FLOWSTARTER_PUBLIC_APP_ORIGIN');
    expect(error.message).toContain(
      'http://localhost:3005/api/leads/capture/x',
    );
  });

  it('refuses plain http against a platform host even off a real hostname', () => {
    expect(() =>
      assertPublicPlatformOrigin({
        variable: 'FLOWSTARTER_PUBLIC_APP_ORIGIN',
        value: 'http://flowstarter.dev',
        targetIsPlatformHost: true,
      }),
    ).toThrow(UnsafePlatformOriginError);
  });
});
