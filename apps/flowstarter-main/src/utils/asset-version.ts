/**
 * Appends a version query to a static asset path so a content change forces a
 * fresh fetch through Cloudflare (which caches /showcase/*.png and the
 * /_next/image optimized variants with a long s-maxage, keyed on the URL).
 *
 * Cloudflare's cache key includes the query string, so bumping ASSET_VERSION
 * changes the key for every versioned asset and the edge refetches from the
 * origin (the Hetzner `prod` slot). Next.js serves the file ignoring the
 * query, so the param is purely a cache-busting token. Bump ASSET_VERSION
 * whenever showcase thumbnails (or other versioned static assets) are
 * regenerated.
 */
export const ASSET_VERSION = '3';

export function withAssetVersion(path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}v=${ASSET_VERSION}`;
}
