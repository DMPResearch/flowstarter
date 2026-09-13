import { describe, expect, it } from 'vitest';
import { isLocalPreviewFrameAllowed } from '../local-preview-guard';

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
