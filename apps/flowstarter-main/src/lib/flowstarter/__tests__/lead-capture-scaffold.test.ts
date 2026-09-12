// @vitest-environment node
/**
 * The preview half of lead capture.
 *
 * A funnel preview belongs to no workspace, so the honest contact form is one
 * that says so when somebody tries it rather than one that silently does
 * nothing. These assert that a preview gets the same injected script the paid
 * build gets, pointed at a token the endpoint provably refuses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  injectLeadCapturePreviewIntoScaffoldFiles,
  previewLeadCaptureEndpoint,
} from '../lead-capture-scaffold';
import { PREVIEW_TOKEN_PREFIX, isLeadCaptureToken } from '../lead-capture';

vi.mock('server-only', () => ({}));

const PREVIEW_ID = '3a5b7c9d-1e2f-4a3b-8c5d-6e7f8a9b0c1d';

const page = [
  '<main class="contact-page">',
  '  <form data-contact-form></form>',
  '  <div class="contact-page__lead-capture" data-flowstarter-lead-capture-slot></div>',
  '</main>',
].join('\n');

beforeEach(() => {
  process.env.PLATFORM_DOMAIN = 'flowstarter.test';
});

describe('previewLeadCaptureEndpoint', () => {
  it('carries a preview token, which is not a real one', () => {
    const endpoint = previewLeadCaptureEndpoint(PREVIEW_ID);
    expect(endpoint).toBe(
      `https://flowstarter.test/api/leads/capture/${PREVIEW_TOKEN_PREFIX}${PREVIEW_ID}`
    );
    const token = endpoint.split('/capture/')[1]!;
    expect(isLeadCaptureToken(token)).toBe(false);
  });
});

describe('injectLeadCapturePreviewIntoScaffoldFiles', () => {
  const files = [{ path: 'src/pages/contact.astro', content: page }];

  it('fills the slot with the capture script', () => {
    const [injected] = injectLeadCapturePreviewIntoScaffoldFiles(
      files,
      PREVIEW_ID
    );
    expect(injected?.content).toContain('data-flowstarter-lead-capture="true"');
    expect(injected?.content).toContain(
      `/api/leads/capture/${PREVIEW_TOKEN_PREFIX}${PREVIEW_ID}`
    );
    expect(injected?.content).toContain('<script is:inline>');
  });

  it('leaves the files alone with no preview id', () => {
    expect(injectLeadCapturePreviewIntoScaffoldFiles(files, '')).toBe(files);
  });

  it('is idempotent', () => {
    const once = injectLeadCapturePreviewIntoScaffoldFiles(files, PREVIEW_ID);
    const twice = injectLeadCapturePreviewIntoScaffoldFiles(once, PREVIEW_ID);
    expect(twice[0]?.content).toBe(once[0]?.content);
    expect(
      twice[0]?.content.split('data-flowstarter-lead-capture="true"')
    ).toHaveLength(2);
  });
});
