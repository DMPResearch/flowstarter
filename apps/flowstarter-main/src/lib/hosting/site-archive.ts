/**
 * Turning a generated manifest into something the deploy-agent can extract.
 *
 * The agent's contract is a gzipped tarball it fetches over HTTPS (or receives
 * as raw bytes), extracts into a staging dir, and renames into place.
 * Everything upstream of it (the funnel pipeline, the build worker) speaks in
 * `{path, content}` files, so this is the seam that converts one into the
 * other.
 *
 * The tar writer itself lives in `@flowstarter/agentic-codegen` because the
 * build worker packs the same archives from outside this app and the two must
 * emit identical bytes. What stays here is the policy this app owns: NO-INDEX.
 *
 * NO-INDEX is applied at packaging time rather than left to the web server
 * alone. A preview is a real, publicly reachable site carrying a real
 * business's name and copy we generated for them; it must never end up in a
 * search index and outrank the site they eventually pay for. The Caddy snippet
 * sets `X-Robots-Tag`, and this sets the `<meta name="robots">` — two
 * independent mechanisms, because a header is lost the moment somebody saves
 * or re-serves the file and a meta tag is lost the moment a crawler only reads
 * headers.
 */

import {
  packSiteTarball,
  SiteArchiveError,
  type ArchiveFile,
  type PackOptions,
} from '@flowstarter/agentic-codegen/src/flowstarter/site-tarball';

export { packSiteTarball, SiteArchiveError };
export type { ArchiveFile, PackOptions };

/** The tag injected into every HTML document in a preview. */
export const NOINDEX_META =
  '<meta name="robots" content="noindex, nofollow, noarchive" />';

/** The header the previews Caddy snippet sets on every response. */
export const NOINDEX_HEADER_VALUE = 'noindex, nofollow, noarchive';

/** True for the documents a crawler would index. */
export function isHtmlPath(path: string): boolean {
  return /\.x?html?$/i.test(path.trim());
}

/**
 * Adds the robots meta to one HTML document.
 *
 * Placed immediately after `<head>` when there is one (so it is inside the
 * element the spec requires it in and early enough that a crawler which stops
 * reading has still seen it), prepended otherwise — a fragment without a head
 * is still served as a document, and a tag before `<html>` is honoured in
 * practice by every crawler that honours the tag at all.
 *
 * Idempotent: a document that already carries a robots meta is returned
 * unchanged rather than given a second, possibly contradicting, one.
 */
export function injectNoindex(html: string): string {
  if (/<meta[^>]+name\s*=\s*["']?robots["']?/i.test(html)) return html;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}\n    ${NOINDEX_META}${html.slice(at)}`;
  }
  return `${NOINDEX_META}\n${html}`;
}

/**
 * Applies {@link injectNoindex} to every HTML file in a manifest.
 *
 * Spreads rather than rebuilding `{path, content}` by hand: a binary entry's
 * `encoding: 'base64'` marker used to get dropped here, which packed its
 * base64 text as UTF-8 bytes instead of decoding it — every image or font
 * that passed through this on its way into a tarball came out corrupted.
 */
export function withNoindex(files: readonly ArchiveFile[]): ArchiveFile[] {
  return files.map((file) =>
    isHtmlPath(file.path)
      ? { ...file, content: injectNoindex(file.content) }
      : file
  );
}

/**
 * The whole packaging step in one call: noindex every HTML document, then
 * pack. Used by the preview publisher so the two can never drift apart.
 */
export function packPreviewTarball(
  files: readonly ArchiveFile[],
  options: PackOptions = {}
): Uint8Array {
  return packSiteTarball(withNoindex(files), options);
}
