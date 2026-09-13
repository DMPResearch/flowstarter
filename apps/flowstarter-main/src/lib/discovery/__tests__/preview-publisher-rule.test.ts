/**
 * The rule that decides where a funnel preview is published.
 *
 * The reason it is a rule with its own test file: on 2026-09-12 the answer was
 * hardcoded to Daytona, Daytona's key was revoked, and 100% of previews failed
 * at the last phase with nothing on our side able to change it. The default is
 * now Flowstarter's own platform, and choosing anything else has to be typed
 * out by an operator on purpose.
 */
import { describe, expect, it } from 'vitest';
import {
  missingPreviewPublisherConfig,
  resolvePreviewPublisher,
} from '../preview-publisher-rule';

const PLATFORM = {
  FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL: 'https://fs-sites-01.example/previews',
  FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET: 'shhh',
};

describe('resolvePreviewPublisher', () => {
  it('publishes to the platform when the previews agent is configured', () => {
    const decision = resolvePreviewPublisher({
      ...PLATFORM,
      NODE_ENV: 'production',
    });
    expect(decision.publisher).toBe('platform');
    expect(decision.reason).toBe('platform-host-configured');
    expect(decision.missing).toEqual([]);
  });

  it('prefers the platform even in development, once a host exists', () => {
    expect(
      resolvePreviewPublisher({ ...PLATFORM, NODE_ENV: 'development' })
        .publisher
    ).toBe('platform');
  });

  it('uses Daytona only when an operator names it', () => {
    const decision = resolvePreviewPublisher({
      ...PLATFORM,
      FLOWSTARTER_PREVIEW_PUBLISHER: 'daytona',
      DAYTONA_API_KEY: 'dtn',
      NODE_ENV: 'production',
    });
    expect(decision.publisher).toBe('daytona');
    expect(decision.reason).toBe('daytona-requested');
    expect(decision.missing).toEqual([]);
  });

  it('never picks Daytona on its own, even with a key sitting in the env', () => {
    expect(
      resolvePreviewPublisher({
        ...PLATFORM,
        DAYTONA_API_KEY: 'dtn',
        NODE_ENV: 'production',
      }).publisher
    ).toBe('platform');
  });

  it('names the key a requested Daytona publisher is missing', () => {
    const decision = resolvePreviewPublisher({
      FLOWSTARTER_PREVIEW_PUBLISHER: 'DAYTONA',
      NODE_ENV: 'production',
    });
    expect(decision.publisher).toBe('daytona');
    expect(decision.missing).toEqual(['DAYTONA_API_KEY']);
  });

  it('serves the build locally on a developer machine with no host', () => {
    const decision = resolvePreviewPublisher({ NODE_ENV: 'development' });
    expect(decision.publisher).toBe('local-static');
    expect(decision.reason).toBe('development-without-platform-host');
    expect(decision.missing).toEqual([]);
  });

  it('never serves locally outside development, and says what is missing', () => {
    const decision = resolvePreviewPublisher({ NODE_ENV: 'production' });
    expect(decision.publisher).toBe('platform');
    expect(decision.reason).toBe('platform-host-missing');
    expect(decision.missing).toEqual([
      'FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL',
      'FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET',
    ]);
  });

  it('treats staging as not-development, whatever NODE_ENV says', () => {
    expect(
      resolvePreviewPublisher({
        FLOWSTARTER_ENV: 'staging',
        NODE_ENV: 'development',
      }).publisher
    ).toBe('platform');
  });

  it('takes FLOWSTARTER_ENV=development over a production NODE_ENV', () => {
    expect(
      resolvePreviewPublisher({
        FLOWSTARTER_ENV: 'development',
        NODE_ENV: 'production',
      }).publisher
    ).toBe('local-static');
  });

  it('needs both halves of the previews agent, not one', () => {
    expect(
      resolvePreviewPublisher({
        FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL:
          PLATFORM.FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL,
        NODE_ENV: 'production',
      }).missing
    ).toEqual(['FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET']);
  });

  it('is not satisfied by whitespace', () => {
    expect(
      resolvePreviewPublisher({
        FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL: '  ',
        FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET: '  ',
        NODE_ENV: 'production',
      }).publisher
    ).toBe('platform');
  });

  it('falls through to the default on a mistyped preference rather than throwing', () => {
    for (const requested of ['sandbox', 'DAYTONA_SANDBOX', '', '   ']) {
      expect(
        resolvePreviewPublisher({
          ...PLATFORM,
          FLOWSTARTER_PREVIEW_PUBLISHER: requested,
          NODE_ENV: 'production',
        }).publisher
      ).toBe('platform');
    }
  });

  it('reads process.env when nothing is passed', () => {
    expect(Array.isArray(missingPreviewPublisherConfig())).toBe(true);
  });
});

describe('missingPreviewPublisherConfig', () => {
  it('is empty for a configured platform and for a developer machine', () => {
    expect(missingPreviewPublisherConfig({ ...PLATFORM })).toEqual([]);
    expect(missingPreviewPublisherConfig({ NODE_ENV: 'development' })).toEqual(
      []
    );
  });
});
