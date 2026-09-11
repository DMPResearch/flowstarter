import assert from 'node:assert/strict';

// Check a newly started local container before switching the host Caddy route.
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:8088');
assert.equal(origin.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname));

const page = await fetch(origin, { signal: AbortSignal.timeout(5000) });
assert.equal(page.status, 200);
assert.equal(page.headers.get('cache-control'), 'no-cache');
assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
const html = await page.text();
assert.ok(html.includes('<customer-request>'));
const assetPath = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
assert.ok(assetPath, 'Expected a bundled native form script');
const assetUrl = new URL(assetPath, origin);
assert.equal(assetUrl.origin, origin.origin);
const asset = await fetch(assetUrl, { signal: AbortSignal.timeout(5000) });
assert.equal(asset.status, 200);
assert.equal(
  asset.headers.get('cache-control'),
  'public, max-age=31536000, immutable',
);
await asset.arrayBuffer();
const missing = await fetch(new URL('/not-a-real-page', origin), {
  signal: AbortSignal.timeout(5000),
});
assert.equal(missing.status, 404);
console.log(
  'PASS: static page, native form bundle, cache/security headers and 404',
);
