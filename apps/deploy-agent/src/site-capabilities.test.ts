import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANAGED_INLINE_SCRIPT_SOURCES,
  scanHtmlCapabilities,
  scanSiteCapabilities,
} from './site-capabilities';

const BOOTSTRAP = MANAGED_INLINE_SCRIPT_SOURCES[0]!;

const LEAD_CAPTURE_BLOCK =
  '<div class="flowstarter-lead-capture" data-flowstarter-lead-capture="true">' +
  '<script>(function(){var endpoint="https://flowstarter.dev/api/leads/capture/tok";})();</script>' +
  '</div>';

function sha256(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value, 'utf8').digest('base64');
}

describe('scanHtmlCapabilities', () => {
  test('finds the layout bootstrap by its text', async () => {
    const found = await scanHtmlCapabilities(
      `<html><head><script>${BOOTSTRAP}</script></head><body></body></html>`,
    );
    expect(found.inlineScripts).toEqual([BOOTSTRAP]);
  });

  test('finds the bootstrap however a bundler reformatted it, and hashes the bytes actually shipped', async () => {
    // Astro's own build is free to emit this with double quotes and no
    // trailing semicolon. A build that reformats it must not lose its CSP
    // hash — that would leave a script the gate already allowed unable to
    // run in the browser. What gets hashed must be exactly this text, not
    // the canonical source: the CSP has to match the bytes the browser
    // fetches.
    const reformatted = BOOTSTRAP.replace(/'/g, '"').replace(/;$/, '');
    expect(reformatted).not.toBe(BOOTSTRAP);
    const found = await scanHtmlCapabilities(
      `<html><head><script>${reformatted}</script></head><body></body></html>`,
    );
    expect(found.inlineScripts).toEqual([reformatted]);
  });

  test('finds the lead-capture script by the block it lives in', async () => {
    const found = await scanHtmlCapabilities(
      `<html><body>${LEAD_CAPTURE_BLOCK}</body></html>`,
    );
    expect(found.inlineScripts).toHaveLength(1);
    expect(found.inlineScripts[0]).toContain('/api/leads/capture/tok');
  });

  test('gives an injected script no hash at all, so the browser refuses it', async () => {
    const found = await scanHtmlCapabilities(
      '<html><body><h1>Acme</h1><script>fetch("https://evil.example")</script></body></html>',
    );
    expect(found.inlineScripts).toEqual([]);
  });

  test('is not fooled by a script placed next to the managed block', async () => {
    const found = await scanHtmlCapabilities(
      '<html><body><div data-flowstarter-lead-capture="true"></div>' +
        '<script>fetch("https://evil.example")</script></body></html>',
    );
    expect(found.inlineScripts).toEqual([]);
  });

  test('ignores a bundled script, which needs no hash', async () => {
    const found = await scanHtmlCapabilities(
      '<html><body><script type="module" src="/_astro/page.js"></script></body></html>',
    );
    expect(found.inlineScripts).toEqual([]);
  });

  test('notes the origins the page frames, and only the allow-listed ones', async () => {
    const found = await scanHtmlCapabilities(
      '<html><body>' +
        '<iframe src="https://cal.com/acme/30min/embed"></iframe>' +
        '<iframe src="https://www.openstreetmap.org/export/embed.html?bbox=1"></iframe>' +
        '<iframe src="https://evil.example/phish"></iframe>' +
        '</body></html>',
    );
    expect(found.frameOrigins.sort()).toEqual([
      'https://cal.com',
      'https://www.openstreetmap.org',
    ]);
  });
});

describe('scanSiteCapabilities', () => {
  test('hashes every managed block across the site, once each', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowstarter-capabilities-'));
    try {
      await mkdir(join(root, 'contact'), { recursive: true });
      await writeFile(
        join(root, 'index.html'),
        `<html><head><script>${BOOTSTRAP}</script></head><body></body></html>`,
      );
      await writeFile(
        join(root, 'contact', 'index.html'),
        `<html><head><script>${BOOTSTRAP}</script></head><body>${LEAD_CAPTURE_BLOCK}` +
          '<iframe src="https://cal.com/acme/30min/embed"></iframe></body></html>',
      );
      // Not HTML, never parsed, never hashed.
      await writeFile(join(root, 'app.js'), 'console.log(1)');

      const capabilities = await scanSiteCapabilities(root);
      expect(capabilities.inlineScriptHashes).toHaveLength(2);
      expect(capabilities.inlineScriptHashes).toContain(sha256(BOOTSTRAP));
      expect(capabilities.frameOrigins).toEqual(['https://cal.com']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('returns nothing for a directory that is not there', async () => {
    const capabilities = await scanSiteCapabilities(
      join(tmpdir(), 'flowstarter-capabilities-missing-dir'),
    );
    expect(capabilities).toEqual({ inlineScriptHashes: [], frameOrigins: [] });
  });
});
