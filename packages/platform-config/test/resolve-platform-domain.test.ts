import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPlatformDomain, resolvePlatformDomain } from '../src/index';

describe('resolvePlatformDomain', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('mints flowstarter.net for production', () => {
    expect(resolvePlatformDomain({ flowstarterEnv: 'production' })).toBe(
      'flowstarter.net',
    );
  });

  it('mints flowstarter.dev for development', () => {
    expect(resolvePlatformDomain({ flowstarterEnv: 'development' })).toBe(
      'flowstarter.dev',
    );
  });

  it('mints flowstarter.dev for test', () => {
    expect(resolvePlatformDomain({ flowstarterEnv: 'test' })).toBe(
      'flowstarter.dev',
    );
  });

  it('mints flowstarter.dev for staging', () => {
    expect(resolvePlatformDomain({ flowstarterEnv: 'staging' })).toBe(
      'flowstarter.dev',
    );
  });

  it('falls back to flowstarter.dev for an environment value it does not recognise', () => {
    expect(resolvePlatformDomain({ flowstarterEnv: 'made-up-env' })).toBe(
      'flowstarter.dev',
    );
  });

  it('falls back to NODE_ENV when flowstarterEnv is not given', () => {
    expect(resolvePlatformDomain({ nodeEnv: 'production' })).toBe(
      'flowstarter.net',
    );
    expect(resolvePlatformDomain({ nodeEnv: 'development' })).toBe(
      'flowstarter.dev',
    );
    expect(resolvePlatformDomain({})).toBe('flowstarter.dev');
  });

  it('prefers flowstarterEnv over nodeEnv when both are given', () => {
    expect(
      resolvePlatformDomain({
        flowstarterEnv: 'production',
        nodeEnv: 'development',
      }),
    ).toBe('flowstarter.net');
    expect(
      resolvePlatformDomain({
        flowstarterEnv: 'staging',
        nodeEnv: 'production',
      }),
    ).toBe('flowstarter.dev');
  });

  it('an explicit override always wins, in production or otherwise', () => {
    expect(
      resolvePlatformDomain({
        flowstarterEnv: 'production',
        override: 'flowstarter.example',
      }),
    ).toBe('flowstarter.example');
    expect(
      resolvePlatformDomain({
        flowstarterEnv: 'development',
        override: 'flowstarter.example',
      }),
    ).toBe('flowstarter.example');
  });

  it('reads PLATFORM_DOMAIN from process.env when called with no arguments', () => {
    vi.stubEnv('PLATFORM_DOMAIN', 'custom.example');
    vi.stubEnv('FLOWSTARTER_ENV', 'production');
    expect(resolvePlatformDomain()).toBe('custom.example');
  });

  it('reads NEXT_PUBLIC_PLATFORM_DOMAIN as the override when PLATFORM_DOMAIN is unset', () => {
    vi.stubEnv('PLATFORM_DOMAIN', '');
    vi.stubEnv('NEXT_PUBLIC_PLATFORM_DOMAIN', 'next-custom.example');
    expect(resolvePlatformDomain()).toBe('next-custom.example');
  });

  it('reads FLOWSTARTER_ENV / NODE_ENV from process.env when called with no arguments', () => {
    vi.stubEnv('PLATFORM_DOMAIN', '');
    vi.stubEnv('NEXT_PUBLIC_PLATFORM_DOMAIN', '');
    vi.stubEnv('FLOWSTARTER_ENV', 'production');
    expect(resolvePlatformDomain()).toBe('flowstarter.net');

    vi.stubEnv('FLOWSTARTER_ENV', 'staging');
    expect(resolvePlatformDomain()).toBe('flowstarter.dev');
  });
});

describe('getPlatformDomain', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('derives the root domain from an explicit hostname over the env-based default', () => {
    vi.stubEnv('PLATFORM_DOMAIN', '');
    vi.stubEnv('NEXT_PUBLIC_PLATFORM_DOMAIN', '');
    vi.stubEnv('FLOWSTARTER_ENV', 'production');
    expect(getPlatformDomain('code.flowstarter.dev')).toBe('flowstarter.dev');
  });

  it('falls back to the env-resolved zone when there is no hostname', () => {
    vi.stubEnv('PLATFORM_DOMAIN', '');
    vi.stubEnv('NEXT_PUBLIC_PLATFORM_DOMAIN', '');
    vi.stubEnv('FLOWSTARTER_ENV', 'production');
    expect(getPlatformDomain()).toBe('flowstarter.net');

    vi.stubEnv('FLOWSTARTER_ENV', 'development');
    expect(getPlatformDomain()).toBe('flowstarter.dev');
  });

  it('an explicit PLATFORM_DOMAIN override wins over both hostname and env', () => {
    vi.stubEnv('PLATFORM_DOMAIN', 'override.example');
    vi.stubEnv('FLOWSTARTER_ENV', 'production');
    expect(getPlatformDomain('flowstarter.net')).toBe('override.example');
  });
});
