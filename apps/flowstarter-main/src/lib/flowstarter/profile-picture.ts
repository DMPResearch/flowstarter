import 'server-only';

/**
 * The visitor's own face, in their own preview.
 *
 * A preview that looks like a template convinces nobody. A preview with the
 * visitor's actual profile picture in the about section is the same site with
 * a completely different effect, and the picture is sitting in the OpenGraph
 * tag of a page they just gave us the address of. This module fetches it and
 * files it as a funnel asset so the generator can place it.
 *
 * WHAT ACTUALLY WORKS, measured 2026-09-12 against the real public pages
 * rather than assumed. Both requests read-only, one each:
 *
 *   instagram.com/darius.flowstarter
 *       HTTP 200, about 600 kB, zero `og:` tags of any kind, no meta
 *       description, `<title>Instagram</title>`. A login wall wearing a
 *       success code.
 *   instagram.com/darius.flowstarter/?__a=1&__d=dis
 *       HTTP 201 with a zero-byte body and `content-type: text/html`. The
 *       endpoint that used to return the profile JSON has been retired; it
 *       does not 404, it answers with nothing, which is worse because code
 *       that only checks the status believes it worked.
 *
 * So the `?__a=1` path is deliberately NOT implemented. It was measured, it
 * returns nothing to an anonymous reader, and adding a second outbound request
 * that is known never to succeed would be a cost with no upside and a comment
 * that would rot into a lie. If Instagram ever reopens it, the place to add it
 * is `profile-fetch.ts`, next to the HTML request, and the test to write first
 * is the one that asserts a 201-with-empty-body is treated as a failure.
 *
 * LinkedIn behaves the same way for the same reason: an anonymous request gets
 * an auth wall or an HTTP 999.
 *
 * A visitor's own website, on the other hand, usually has a perfectly good
 * `og:image`, and that is the path this module exists to serve.
 *
 * RIGHTS, which is the part that matters legally rather than technically.
 *
 * A picture fetched from somebody's public profile is not a picture they gave
 * us. It is filed with `rights_confirmed_at` NULL, which makes it invisible to
 * `loadUsableAssets` and therefore unpublishable on a paid site by
 * construction, not by anybody remembering. It is readable for two things
 * only: deriving a palette, and dressing the preview, which is a temporary
 * page shown to the person in the picture. The claim page asks one question
 * ("Use my profile picture on the site") and only that tap writes the
 * confirmation. Without it the build falls back to the placeholder and the
 * Brief asks for a photograph.
 */
import { probeImageSize } from '@flowstarter/agentic-codegen/src/flowstarter/preview-assets';
import { assertSafeUploadedImage } from '@flowstarter/agentic-codegen/src/flowstarter/site-media';

import { storeFunnelAsset, type FunnelAssetRow } from './funnel-assets';
import { IMAGE_FETCH_TIMEOUT_MS } from './profile-image';
import {
  isPublicHttpUrl,
  type ProfileNetwork,
  type ProfileReading,
} from './profile-signals';

/** A profile picture is a headshot, not a hero photograph. */
export const MAX_PICTURE_BYTES = 4 * 1024 * 1024;

/**
 * Below this on the long edge a picture is an avatar thumbnail. It can still
 * carry a palette, but placing it in an about section renders it blurry, so it
 * is filed without the `section` role that would let the generator place it.
 */
export const MIN_PLACEABLE_EDGE = 400;

/** The networks whose pictures we are willing to file, in preference order. */
const CAPTURE_ORDER: readonly ProfileNetwork[] = [
  'instagram',
  'linkedin',
  'website',
];

export type ProfilePictureOutcome =
  | { status: 'captured'; asset: FunnelAssetRow; network: ProfileNetwork }
  | {
      status: 'skipped';
      reason: 'no_image' | 'unreadable' | 'too_large' | 'not_an_image';
    };

/**
 * Fetches one exposed profile image and files it against the preview.
 *
 * Never throws. A picture we could not get is a preview that looks slightly
 * less like the visitor, which is a disappointment and not a failure.
 */
export async function captureProfilePicture(input: {
  previewId: string;
  readings: readonly ProfileReading[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ProfilePictureOutcome> {
  const exposed = CAPTURE_ORDER.map((network) =>
    input.readings.find(
      (reading) =>
        reading.status === 'exposed' &&
        reading.network === network &&
        reading.imageUrl
    )
  ).find(Boolean);

  if (!exposed || exposed.status !== 'exposed' || !exposed.imageUrl) {
    return { status: 'skipped', reason: 'no_image' };
  }
  if (!isPublicHttpUrl(exposed.imageUrl)) {
    return { status: 'skipped', reason: 'unreadable' };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS
  );
  let bytes: Buffer;
  try {
    const response = await fetchImpl(exposed.imageUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'image/*' },
    });
    if (!response.ok) return { status: 'skipped', reason: 'unreadable' };
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_PICTURE_BYTES) {
      return { status: 'skipped', reason: 'too_large' };
    }
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PICTURE_BYTES) {
      return { status: 'skipped', reason: 'too_large' };
    }
  } catch {
    return { status: 'skipped', reason: 'unreadable' };
  } finally {
    clearTimeout(timer);
  }

  // The same magic-byte check the client uploader uses. A social network's CDN
  // is not a trusted source of image bytes; nothing that arrives over the wire
  // is, and a content-type header is a claim rather than a fact.
  let verified;
  try {
    verified = assertSafeUploadedImage(bytes);
  } catch {
    return { status: 'skipped', reason: 'not_an_image' };
  }

  const size = probeImageSize(bytes);
  const longEdge = Math.max(size?.width ?? 0, size?.height ?? 0);

  try {
    const asset = await storeFunnelAsset({
      previewId: input.previewId,
      file: {
        bytes,
        extension: verified.extension,
        mime: verified.mime,
        sha256: verified.sha256,
        width: size?.width ?? null,
        height: size?.height ?? null,
      },
      kind: 'photo',
      source: exposed.network === 'website' ? 'og' : exposed.network,
      // Roles, not rights. A picture big enough to place is marked placeable
      // so the generator knows it could go in an about section; whether it may
      // is decided by the rights confirmation, which is not written here.
      usableFor: longEdge >= MIN_PLACEABLE_EDGE ? ['section', 'portrait'] : [],
      // The load-bearing line in this file. Fetched, not given: no
      // confirmation, so `loadUsableAssets` cannot see it and a paid build
      // cannot publish it until the visitor taps the claim page's one question.
      rights: null,
    });
    return { status: 'captured', asset, network: exposed.network };
  } catch {
    return { status: 'skipped', reason: 'unreadable' };
  }
}
