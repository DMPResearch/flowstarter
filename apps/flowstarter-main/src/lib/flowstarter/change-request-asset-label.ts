/**
 * How an operator's change-request asset picker labels one of a client's
 * pictures.
 *
 * PR #119 shipped a picker that fell back to
 * `asset.storagePath.split('/').pop()` when a client had not typed a
 * caption. `storagePath` is `tenant/{workspaceId}/assets/{sha256}.{ext}`
 * (`assetObjectPath`), a content hash chosen so a retried upload can never
 * fork the object it wrote — exactly the property that makes it useless as a
 * name. An operator ticking a box on a paid change request saw a 64-character
 * hex string instead of any hint about what the picture actually is.
 *
 * This function is the fix, made impossible to regress by construction: it
 * does not accept a storage path as an argument at all, so there is nothing
 * for a future edit to fall back to. It takes only the things about a
 * picture a client actually told us or that we can read off the file itself.
 *
 * Deliberately free of any server-only or Next.js import, so a unit test can
 * call it directly with no framework or database around it.
 */

export interface ChangeRequestAssetLabelInput {
  caption: string | null;
  originalName: string | null;
  width: number | null;
  height: number | null;
  createdAt: string | null;
}

/** Shown when a picture has neither a caption nor a filename to go by. */
const UNTITLED_PICTURE = 'Untitled picture';

/** Joins the filename/dimensions/date fallback pieces into one label. */
const FALLBACK_JOINER = ' — ';

/**
 * Month names, written out rather than left to `Intl`.
 *
 * `Intl.DateTimeFormat('en-GB', { month: 'short' })` is the obvious way to do
 * this and it is not stable: the ICU build shipped with one Node version
 * renders September as `Sep` and another as `Sept`, which makes an assertion
 * about an operator's screen a statement about the runtime. Three letters, in
 * one language, is not worth that.
 */
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * A short "12 Sep 2026" date, read in UTC so the same `created_at` renders
 * identically in a test runner and in production, whatever timezone either
 * happens to be in.
 */
function formatUploadDate(createdAt: string | null): string | null {
  if (!createdAt) return null;
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return (
    `${parsed.getUTCDate()} ${MONTHS[parsed.getUTCMonth()]} ` +
    `${parsed.getUTCFullYear()}`
  );
}

/**
 * The label an operator sees on one of a client's pictures.
 *
 * Rules, in order:
 *  1. A non-empty trimmed caption is the whole label — it is the client's own
 *     words about their own picture, and nothing else competes with that.
 *  2. Otherwise: the original filename (or `Untitled picture` if there is
 *     none), then `{width}x{height}` when both are known, then a short
 *     upload date when it is known — joined with " — ".
 */
export function changeRequestAssetLabel(
  asset: ChangeRequestAssetLabelInput
): string {
  const caption = asset.caption?.trim();
  if (caption) return caption;

  const parts: string[] = [];

  const filename = asset.originalName?.trim();
  parts.push(filename || UNTITLED_PICTURE);

  if (asset.width !== null && asset.height !== null) {
    parts.push(`${asset.width}x${asset.height}`);
  }

  const uploadDate = formatUploadDate(asset.createdAt);
  if (uploadDate) parts.push(uploadDate);

  return parts.join(FALLBACK_JOINER);
}
