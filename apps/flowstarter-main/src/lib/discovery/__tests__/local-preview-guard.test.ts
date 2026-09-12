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

  it('refuses when the flag is off, even in development', () => {
    expect(
      isLocalPreviewFrameAllowed({
        FLOWSTARTER_LOCAL_PREVIEW: undefined,
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
        NODE_ENV: 'development',
      })
    ).toBe(false);
  });
});
