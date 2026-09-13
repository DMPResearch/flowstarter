/**
 * What a local preview's child process is allowed to know.
 *
 * `astro dev` over a generated site is tenant code executing. It was spawned
 * with `env: process.env`, so a build-time module in that site only had to read
 * `process.env` to have this app's service-role key, its Clerk secret and every
 * provider token it holds.
 */
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_ENV_ALLOWLIST,
  scrubbedPreviewEnv,
} from '../local-preview-env';

const HOST_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/dev',
  NODE_ENV: 'development',
  FLOWSTARTER_LOCAL_PREVIEW: 'true',
  FLOWSTARTER_LOCAL_PREVIEW_HOST: '192.168.1.5',
  // Obvious fakes standing in for the real thing, which is the point: none of
  // these may appear in the child.
  SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
  CLERK_SECRET_KEY: 'fake-clerk-secret',
  STRIPE_SECRET_KEY: 'fake-stripe',
  OPENROUTER_API_KEY: 'fake-openrouter',
  AWS_SESSION_TOKEN: 'fake-aws',
} as NodeJS.ProcessEnv;

describe('scrubbedPreviewEnv', () => {
  it('carries the toolchain, the locale and the preview values, and nothing else', () => {
    const child = scrubbedPreviewEnv(HOST_ENV);
    expect(child.PATH).toBe('/usr/bin:/bin');
    expect(child.HOME).toBe('/home/dev');
    expect(child.NODE_ENV).toBe('development');
    expect(child.FLOWSTARTER_LOCAL_PREVIEW).toBe('true');
    expect(child.FLOWSTARTER_LOCAL_PREVIEW_HOST).toBe('192.168.1.5');
  });

  it('carries no credential this app holds', () => {
    const child = scrubbedPreviewEnv(HOST_ENV);
    for (const key of [
      'SUPABASE_SERVICE_ROLE_KEY',
      'CLERK_SECRET_KEY',
      'STRIPE_SECRET_KEY',
      'OPENROUTER_API_KEY',
      'AWS_SESSION_TOKEN',
    ]) {
      expect(child[key], key).toBeUndefined();
    }
    // Said as a property rather than as a list of the secrets of the day: the
    // child's keys are the allow-list, the preview values and the fixed
    // settings, and a new secret in this app's environment cannot widen it.
    const unexpected = Object.keys(child).filter(
      (key) =>
        !PREVIEW_ENV_ALLOWLIST.includes(key) &&
        !key.startsWith('FLOWSTARTER_LOCAL_PREVIEW') &&
        !['CI', 'ASTRO_TELEMETRY_DISABLED', 'DO_NOT_TRACK'].includes(key)
    );
    expect(unexpected).toEqual([]);
  });

  it('lets the caller add a preview-specific value explicitly', () => {
    const child = scrubbedPreviewEnv(HOST_ENV, { ASTRO_PORT: '4321' });
    expect(child.ASTRO_PORT).toBe('4321');
  });

  it('never invents a value the host did not have', () => {
    const child = scrubbedPreviewEnv({
      PATH: '/usr/bin',
    } as unknown as NodeJS.ProcessEnv);
    expect(child.HOME).toBeUndefined();
    expect(child.NODE_ENV).toBeUndefined();
  });
});
