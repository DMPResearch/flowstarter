import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertLocalPreviewEnvAllowed,
  isLocalPreviewFrameAllowed,
} from '../local-preview-guard';

describe('isLocalPreviewFrameAllowed', () => {
  it('allows when the flag is on and the resolved env is development', () => {
    expect(
      isLocalPreviewFrameAllowed({
        FLOWSTARTER_LOCAL_PREVIEW: 'true',
        NODE_ENV: 'development',
      })
    ).toBe(true);
  });

  it('allows when FLOWSTARTER_ENV explicitly says development, even if NODE_ENV does not', () => {
    expect(
      isLocalPreviewFrameAllowed({
        FLOWSTARTER_LOCAL_PREVIEW: 'true',
        FLOWSTARTER_ENV: 'development',
        NODE_ENV: 'production',
      })
    ).toBe(true);
  });

  // The flag is no longer the only way in. Since previews moved onto the
  // platform, a developer machine with no previews host configured publishes
  // to a local static server by rule, and the proxy is the only thing that can
  // frame it. Asking the publisher rule is what keeps the two from disagreeing
  // about whether a local preview exists at all.
  it('allows a development machine whose publisher rule chose local-static', () => {
    expect(
      isLocalPreviewFrameAllowed({
        FLOWSTARTER_LOCAL_PREVIEW: undefined,
        NODE_ENV: 'development',
      })
    ).toBe(true);
  });

  it('refuses in development once a previews host exists and the flag is off', () => {
    expect(
      isLocalPreviewFrameAllowed({
        FLOWSTARTER_LOCAL_PREVIEW: undefined,
        FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL: 'https://previews.example',
        FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET: 'shhh',
        NODE_ENV: 'development',
      })
    ).toBe(false);
  });

  it('refuses in development when the publisher is explicitly Daytona', () => {
    expect(
      isLocalPreviewFrameAllowed({
        FLOWSTARTER_LOCAL_PREVIEW: undefined,
        FLOWSTARTER_PREVIEW_PUBLISHER: 'daytona',
        DAYTONA_API_KEY: 'dtn',
        NODE_ENV: 'development',
      })
    ).toBe(false);
  });

  it('refuses in staging even with the flag on', () => {
    expect(
      isLocalPreviewFrameAllowed({
        FLOWSTARTER_LOCAL_PREVIEW: 'true',
        FLOWSTARTER_ENV: 'staging',
        NODE_ENV: 'production',
      })
    ).toBe(false);
  });

  it('refuses in production even with the flag on', () => {
    expect(
      isLocalPreviewFrameAllowed({
        FLOWSTARTER_LOCAL_PREVIEW: 'true',
        NODE_ENV: 'production',
      })
    ).toBe(false);
  });

  it('refuses a bogus truthy-looking flag value ("1" is not "true")', () => {
    expect(
      isLocalPreviewFrameAllowed({
        FLOWSTARTER_LOCAL_PREVIEW: '1',
        FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL: 'https://previews.example',
        FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET: 'shhh',
        NODE_ENV: 'development',
      })
    ).toBe(false);
  });
});

/**
 * The same rule as an assertion, which is what the publisher and the env
 * module need.
 *
 * `publishLocalPreview` spawns `astro dev` over generated tenant source on the
 * host running this app. Its only guard was the flag, so a staging deploy that
 * inherited `FLOWSTARTER_LOCAL_PREVIEW=true` from a shared `.env` would run
 * that source natively the first time the sandbox failed — beside the
 * service-role key, the Clerk secret and every tenant's data.
 */
describe('assertLocalPreviewEnvAllowed', () => {
  it('says nothing when the flag is not set at all', () => {
    expect(() =>
      assertLocalPreviewEnvAllowed({ NODE_ENV: 'production' })
    ).not.toThrow();
  });

  it('allows a developer machine to opt in', () => {
    expect(() =>
      assertLocalPreviewEnvAllowed({
        FLOWSTARTER_LOCAL_PREVIEW: 'true',
        NODE_ENV: 'development',
      })
    ).not.toThrow();
  });

  it('refuses staging and production, naming the variable to remove', () => {
    for (const env of [
      { FLOWSTARTER_LOCAL_PREVIEW: 'true', FLOWSTARTER_ENV: 'staging' },
      { FLOWSTARTER_LOCAL_PREVIEW: 'true', NODE_ENV: 'production' },
    ]) {
      expect(() =>
        assertLocalPreviewEnvAllowed(env as NodeJS.ProcessEnv)
      ).toThrow(/FLOWSTARTER_LOCAL_PREVIEW/);
    }
  });

  it('leaves no native preview publisher for a sandbox failure to fall back to', () => {
    // The regression the audit asked for, phrased against the code as it now
    // stands: previews publish on the platform, so the `astro dev` fallback
    // that used to run generated Astro source on this host — with
    // `env: process.env` — is gone from the route entirely. A flag left set in
    // staging has nothing left to switch on, and the rule above refuses the
    // flag there anyway.
    const source = readFileSync(
      join(__dirname, '../../../app/api/discovery/preview/live/route.ts'),
      'utf8'
    );
    expect(source).not.toContain('publishLocalPreview');
    expect(source).not.toContain('env: process.env');
  });

  it('is the environment every native preview child is assembled under', () => {
    // The one child process previews still spawn on this host. It is our own
    // runner rather than tenant code, and it still has no business holding the
    // service-role key, so it gets the same assembled environment.
    const source = readFileSync(
      join(__dirname, '../local-fast-edit.ts'),
      'utf8'
    );
    expect(source).toContain('env: scrubbedPreviewEnv(process.env, {');
    // The shape that handed it everything, gone from the spawn options.
    expect(source).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/);
  });

  it('is also the rule the env module enforces at startup', () => {
    const source = readFileSync(join(__dirname, '../../../env.ts'), 'utf8');
    expect(source).toContain('assertLocalPreviewEnvAllowed(process.env)');
  });
});
