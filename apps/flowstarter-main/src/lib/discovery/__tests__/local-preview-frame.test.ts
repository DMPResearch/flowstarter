import { describe, expect, it } from 'vitest';
import {
  framedPreviewBaseHref,
  framedPreviewPath,
  injectFrameBase,
  isLocalPreviewUrl,
  previewUrlForClient,
  rewriteRootAbsoluteUrls,
} from '../local-preview-frame';

describe('local preview frame helpers', () => {
  it('detects loopback preview origins', () => {
    expect(isLocalPreviewUrl('http://127.0.0.1:8910')).toBe(true);
    expect(isLocalPreviewUrl('http://localhost:4321/')).toBe(true);
    expect(isLocalPreviewUrl('https://abc.daytonaproxy01.net')).toBe(false);
    expect(isLocalPreviewUrl('https://www.flowstarter.dev')).toBe(false);
  });

  it('rewrites only local URLs for the wizard client', () => {
    const id = 'e691fc76-1489-404f-9ff5-73cd4910d9c5';
    expect(previewUrlForClient(id, 'http://127.0.0.1:8910')).toBe(
      framedPreviewPath(id)
    );
    expect(previewUrlForClient(id, 'https://abc.daytonaproxy01.net/site')).toBe(
      'https://abc.daytonaproxy01.net/site'
    );
    expect(previewUrlForClient(id, undefined)).toBeUndefined();
  });

  it('rewrites path-absolute asset URLs onto the frame (base alone cannot)', () => {
    const id = 'e691fc76-1489-404f-9ff5-73cd4910d9c5';
    const frame = framedPreviewPath(id);
    const html = rewriteRootAbsoluteUrls(
      [
        '<img src="/flowstarter-assets/generated-service.png" alt="x">',
        '<link href="/_astro/index.css">',
        '<a href="https://fonts.googleapis.com/css">ext</a>',
        '<img src="//cdn.example/a.png">',
        `url('/images/hero.jpg')`,
        `srcset="/a.png 1x, /b.png 2x"`,
      ].join('\n'),
      frame
    );
    expect(html).toContain(
      `src="${frame}/flowstarter-assets/generated-service.png"`
    );
    expect(html).toContain(`href="${frame}/_astro/index.css"`);
    expect(html).toContain('https://fonts.googleapis.com/css');
    expect(html).toContain('src="//cdn.example/a.png"');
    expect(html).toContain(`url('${frame}/images/hero.jpg')`);
    expect(html).toContain(`srcset="${frame}/a.png 1x, ${frame}/b.png 2x"`);
    // Idempotent — a second pass must not double-prefix.
    expect(rewriteRootAbsoluteUrls(html, frame)).toBe(html);
  });

  it('injects a base tag so path-relative assets stay under the frame', () => {
    const id = 'e691fc76-1489-404f-9ff5-73cd4910d9c5';
    const base = framedPreviewBaseHref(id);
    const withHead = injectFrameBase(
      '<html><head><title>x</title></head><body></body></html>',
      base
    );
    expect(withHead).toContain(`<base href="${base}">`);
    expect(withHead.indexOf('<base')).toBeLessThan(withHead.indexOf('<title'));

    const replaced = injectFrameBase(
      '<html><head><base href="/old/"></head></html>',
      base
    );
    expect(replaced).toContain(`<base href="${base}">`);
    expect(replaced).not.toContain('/old/');
  });
});
