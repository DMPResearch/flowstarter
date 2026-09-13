import 'server-only';

/**
 * Turning bytes into pixels, so the palette rule has something to read.
 *
 * `brand-palette.ts` is pure arithmetic over an RGBA buffer and knows nothing
 * about file formats. This is the adapter that gets it one: it decodes a JPEG,
 * PNG, WebP or GIF with `sharp` and hands back a `Bitmap`. It is the only file
 * in the brand pipeline that touches a codec, and it decides nothing beyond
 * "these bytes are or are not a picture we can read".
 *
 * Two details that matter for the rule downstream.
 *
 * NEAREST NEIGHBOUR, NOT AVERAGING. `sharp`'s default resize kernel is a
 * Lanczos, which is right for making a picture look good and wrong for reading
 * a brand colour out of one: a red logo on a white field averages to pink, and
 * pink is precisely the colour the site must not wear. The decode therefore
 * asks for `kernel: 'nearest'`, which keeps every sampled pixel a colour that
 * was actually in the source.
 *
 * AN INTERMEDIATE SIZE, NOT THE FINAL ONE. It decodes down to at most
 * `DECODE_EDGE` and lets `sampleBitmap` do the final stride to its own grid.
 * Two stages rather than one because the palette rule owns its sampling grid:
 * if this file resized straight to 64 the rule's own `SAMPLE_EDGE` would
 * silently stop meaning anything, and a change to it would have no effect.
 *
 * Determinism survives both: `sharp` with a fixed kernel and a fixed target
 * size is a pure function of its input, so the same file always produces the
 * same swatches.
 */
import { imageDecodeGate, imagePixelBudget } from '@/lib/net/ingress';
import { ingressConfig } from '@/lib/net/net-config';
import { fetchPublicResource, type FetchLike } from '@/lib/net/safe-fetch';

import type { Bitmap } from './brand-palette';
import { isPublicHttpUrl } from './profile-signals';

/**
 * The size we decode to before the palette rule samples. Large enough that a
 * narrow accent band survives, small enough that the raw buffer is a quarter
 * of a megabyte rather than a hundred.
 */
export const DECODE_EDGE = 256;

/** The largest picture we will pull over the wire for a palette. */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** A profile picture that is slow to arrive is not worth the visitor's wait. */
export const IMAGE_FETCH_TIMEOUT_MS = 4_000;

/**
 * Decodes bytes into an RGBA bitmap, or null when they are not a picture we
 * can read.
 *
 * Never throws. A corrupt upload, a TIFF, an SVG, a PDF someone renamed: all
 * of them are "no palette from this file", which is a fact the caller already
 * knows how to handle, and none of them is worth failing a funnel over.
 */
export async function decodeBitmap(
  bytes: Buffer | Uint8Array
): Promise<Bitmap | null> {
  const buffer = Buffer.from(bytes);
  const limits = ingressConfig();

  // Before the decoder, not after it. A PNG whose IHDR declares 40000x40000 is
  // a few kilobytes on the wire and about six gigabytes of RGBA in memory, so
  // every byte-length cap upstream passes it and the process dies here. The
  // header carries the dimensions; reading them costs nothing. Codex F07.
  if (
    imagePixelBudget(buffer, limits.maxImagePixels).status === 'too_many_pixels'
  ) {
    return null;
  }

  // One gate for the whole process. A decode is the most expensive thing an
  // anonymous request can ask this server to do and the resource it spends is
  // memory, which is the one that takes the process down rather than the
  // request.
  return await imageDecodeGate(limits).run(async () => {
    try {
      // Imported lazily so a route that never derives a palette does not pay
      // for loading a native module, and so this file can be imported in a
      // test environment where the binary is not available.
      const sharp = (await import('sharp')).default;
      const pipeline = sharp(buffer, {
        // A malicious GIF or WebP can declare hundreds of frames; we want the
        // first one and nothing else.
        animated: false,
        failOn: 'error',
        // The backstop for the formats whose dimensions the header probe
        // cannot read — WebP, chiefly. sharp refuses rather than allocates.
        limitInputPixels: limits.maxImagePixels,
      });
      const { data, info } = await pipeline
        .resize(DECODE_EDGE, DECODE_EDGE, {
          fit: 'inside',
          withoutEnlargement: true,
          kernel: 'nearest',
        })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      if (info.channels !== 4 || info.width <= 0 || info.height <= 0) {
        return null;
      }
      return { width: info.width, height: info.height, data };
    } catch {
      return null;
    }
  });
}

/**
 * Fetches a picture and decodes it, under the same budget and the same host
 * rules the profile fetch uses.
 *
 * The url has already been through `isPublicHttpUrl` once, inside
 * `readProfileHtml`, and is checked again here: this is a second outbound
 * request built from a string a third party put in a meta tag, which is one
 * more hop than the visitor's own link and deserves the same suspicion.
 */
export async function fetchImageBitmap(
  url: string,
  options: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    maxBytes?: number;
  } = {}
): Promise<Bitmap | null> {
  if (!isPublicHttpUrl(url)) return null;
  const outcome = await fetchPublicResource({
    url,
    headers: { accept: 'image/*' },
    maxBytes: options.maxBytes ?? MAX_IMAGE_BYTES,
    timeoutMs: options.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
    // A public page may point at anything at all. We asked for a picture, so a
    // response that says it is a 400 MB log file is refused before its body is
    // read rather than after.
    expect: 'image',
  });
  if (outcome.status !== 'ok') return null;
  if (outcome.httpStatus < 200 || outcome.httpStatus >= 300) return null;
  return await decodeBitmap(outcome.bytes);
}

/**
 * Decodes several pictures, dropping the ones that will not read.
 *
 * Order is preserved because the palette rule's primary is the heaviest colour
 * across the pooled samples, and pooling in a stable order is what makes the
 * whole derivation reproducible.
 */
export async function decodeBitmaps(
  sources: ReadonlyArray<Buffer | Uint8Array>
): Promise<Bitmap[]> {
  const decoded = await Promise.all(
    sources.map((bytes) => decodeBitmap(bytes))
  );
  return decoded.filter((bitmap): bitmap is Bitmap => bitmap !== null);
}
