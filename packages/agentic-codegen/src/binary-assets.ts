/**
 * The gate that stops a site shipping with its images written as text.
 *
 * A generated site carries its raster assets as base64 through several hops:
 * the preview manifest, the job artifacts row, the agent's own file writes.
 * Every hop has to carry the `encoding` flag alongside the string, and when
 * one of them drops it the base64 is decoded by nobody and written to disk as
 * an ASCII file whose name still ends in `.png`. Nothing downstream notices:
 * the build succeeds, the tarball packs, the deploy goes live, and the client
 * opens a site where every image is a broken icon.
 *
 * That defect shipped once (a whole portfolio's PNGs and WebPs were ASCII
 * base64 in the published `dist`). The cause was fixed upstream; this is the
 * gate that makes the class of defect unshippable rather than trusting the
 * fix. It is deliberately dumb and deterministic: read the first bytes of
 * every file whose extension claims a raster format and compare them against
 * that format's magic number. No model, no heuristic on image quality, no
 * network.
 *
 * SVG is a text format and is not checked here; an SVG that is ASCII is an
 * SVG that is correct.
 */

/** The error code a failed job reports, so an operator can grep for it. */
export const ASSET_NOT_BINARY = 'ASSET_NOT_BINARY';

/**
 * Extensions this gate owns. Every one of them is a container format with a
 * fixed signature in its first bytes, which is what makes the check exact
 * rather than a guess.
 */
export const RASTER_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'avif',
  'ico',
]);

/** The shortest prefix any check below needs. Read at most this much. */
export const ASSET_SNIFF_BYTES = 32;

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = start; i < start + length && i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i] as number);
  }
  return out;
}

/** ISO base media brands that legitimately end up behind an `.avif` name. */
const AVIF_BRANDS = new Set(['avif', 'avis', 'mif1', 'msf1', 'miaf', 'mA1B']);

/**
 * One predicate per extension: does this byte prefix belong to that format?
 *
 * `jpeg` accepts only `FF D8 FF`, the SOI marker plus the first marker byte;
 * `webp` demands both the RIFF header and the `WEBP` form type, because RIFF
 * alone is also WAV and AVI; `ico` accepts the icon and cursor reserved words.
 */
const SIGNATURES: Record<string, (bytes: Uint8Array) => boolean> = {
  png: (bytes) =>
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  jpeg: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  gif: (bytes) =>
    ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a',
  webp: (bytes) =>
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === 'RIFF' &&
    ascii(bytes, 8, 4) === 'WEBP',
  avif: (bytes) =>
    bytes.length >= 12 &&
    ascii(bytes, 4, 4) === 'ftyp' &&
    AVIF_BRANDS.has(ascii(bytes, 8, 4)),
  ico: (bytes) =>
    startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) ||
    startsWith(bytes, [0x00, 0x00, 0x02, 0x00]),
};

/**
 * The raster extension a path claims, lowercased, or null when the path is
 * not one this gate owns. Query strings and hashes are stripped: a build can
 * emit `logo.png?v=2` into a manifest.
 */
export function rasterExtension(path: string): string | null {
  const name = path.split(/[?#]/)[0] ?? '';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return RASTER_EXTENSIONS.has(ext) ? ext : null;
}

/**
 * True when every byte is one a text editor would print. This is the shape the
 * defect actually takes — a file of base64, or of JSON, or of an error page —
 * and it is reported separately from a plain signature mismatch because the
 * two have different causes: printable ASCII means a decode never happened,
 * while arbitrary wrong bytes mean the wrong file was written.
 */
export function isPrintableAscii(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] as number;
    const printable =
      (byte >= 0x20 && byte <= 0x7e) ||
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0d;
    if (!printable) return false;
  }
  return true;
}

export interface AssetProblem {
  path: string;
  /** The extension that made this file this gate's business. */
  extension: string;
  reason: 'printable-ascii' | 'wrong-magic' | 'empty';
  /** Operator-readable, already carrying the code. */
  message: string;
}

/**
 * Checks one file's leading bytes against what its extension promises.
 *
 * Returns null when the file is fine. Pass at least {@link ASSET_SNIFF_BYTES}
 * bytes; passing the whole file is fine and makes the printable-ASCII verdict
 * exact rather than a sample.
 */
export function inspectRasterAsset(
  path: string,
  bytes: Uint8Array,
): AssetProblem | null {
  const extension = rasterExtension(path);
  if (!extension) return null;

  if (bytes.length === 0) {
    return {
      path,
      extension,
      reason: 'empty',
      message: `${ASSET_NOT_BINARY}: ${path} is an empty file but its name claims ${extension}`,
    };
  }

  const matches = SIGNATURES[extension]?.(bytes) ?? false;
  if (matches) return null;

  if (isPrintableAscii(bytes)) {
    return {
      path,
      extension,
      reason: 'printable-ascii',
      message:
        `${ASSET_NOT_BINARY}: ${path} is printable text, not ${extension} data. ` +
        'A base64 payload was written without being decoded, so this image ' +
        'would be broken on the published site.',
    };
  }

  return {
    path,
    extension,
    reason: 'wrong-magic',
    message:
      `${ASSET_NOT_BINARY}: ${path} does not start with the ${extension} ` +
      'magic number, so it is not the format its name claims.',
  };
}

/** A file as the packagers carry it: text inline, or base64 with a flag. */
export interface EncodedAssetFile {
  path: string;
  content: string;
  encoding?: 'base64';
}

/**
 * The same check over an in-memory manifest rather than a directory.
 *
 * A file the packager marked `base64` is decoded before it is inspected, which
 * is exactly what the deploy side will do with it. A file with no flag is
 * inspected as UTF-8 bytes, which is the failing case this gate exists for:
 * base64 that lost its flag is printable ASCII and is reported as such.
 */
export function findNonBinaryAssets(
  files: readonly EncodedAssetFile[],
): AssetProblem[] {
  const problems: AssetProblem[] = [];
  for (const file of files) {
    if (!rasterExtension(file.path)) continue;
    const bytes =
      file.encoding === 'base64'
        ? new Uint8Array(Buffer.from(file.content, 'base64'))
        : new Uint8Array(Buffer.from(file.content, 'utf8'));
    const problem = inspectRasterAsset(file.path, bytes);
    if (problem) problems.push(problem);
  }
  return problems;
}

/** One message for a whole batch, so a job log names every broken file. */
export function describeAssetProblems(
  problems: readonly AssetProblem[],
): string {
  const head =
    problems.length === 1
      ? '1 image in the build output is not binary'
      : `${problems.length} images in the build output are not binary`;
  return `${ASSET_NOT_BINARY}: ${head}. ${problems
    .map((problem) => problem.message.replace(`${ASSET_NOT_BINARY}: `, ''))
    .join(' ')}`;
}
