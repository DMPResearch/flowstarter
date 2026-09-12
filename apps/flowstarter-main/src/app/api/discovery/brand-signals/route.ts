/**
 * POST /api/discovery/brand-signals — the colours and the voice, derived.
 *
 * The quick intake asks for an Instagram, a LinkedIn and a website. This route
 * is what those links are for: it reads whatever those pages expose to a
 * reader without a login, derives a palette from the pictures by rule, has a
 * model phrase a tone from the visitor's own words, and hands back both, plus
 * an honest list of which networks would not talk to us.
 *
 * Anonymous, rate limited, and it cannot fail the funnel. Every step degrades:
 * a profile that will not load costs a palette source, not a preview, and the
 * worst case is the tone chips the visitor already picked. There is no path
 * through here that returns a 500 to a visitor waiting on a preview.
 *
 * THE DIVISION OF LABOUR, which is the point of the file:
 *
 *   the network    `profile-fetch.ts` performs one GET per link, under a four
 *                  second budget, and reports what happened.
 *   the reading    `profile-signals.ts` decides, purely, whether what came
 *                  back is evidence or a login wall. A 200 is not a success.
 *   the palette    `brand-palette.ts` quantises the pictures and picks four
 *                  colours, deterministically, then walks each one until it
 *                  clears AA on the template's backgrounds.
 *   the tone       `brand-tone.ts` is the only step a model touches, and it
 *                  refuses to call one without the visitor's own prose.
 *
 * Nothing here invents. If we read nothing and the visitor gave no tone chips,
 * the answer says so and the wizard offers them the picture upload instead.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  DEFAULT_BACKGROUNDS,
  derivePalette,
  type Bitmap,
} from '@/lib/flowstarter/brand-palette';
import { phraseTone } from '@/lib/flowstarter/brand-tone';
import {
  listFunnelAssets,
  readFunnelAssetBytes,
  signFunnelAsset,
} from '@/lib/flowstarter/funnel-assets';
import {
  decodeBitmap,
  fetchImageBitmap,
} from '@/lib/flowstarter/profile-image';
import { readProfileSignals } from '@/lib/flowstarter/profile-fetch';
import { captureProfilePicture } from '@/lib/flowstarter/profile-picture';
import { parseProfileLinks } from '@/lib/flowstarter/profile-signals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Three profile fetches at four seconds each, in parallel, plus one model. */
export const maxDuration = 30;

const Schema = z.object({
  instagramUrl: z.string().max(500).optional().default(''),
  linkedinUrl: z.string().max(500).optional().default(''),
  websiteUrl: z.string().max(500).optional().default(''),
  /** The intake's tone chips, for the fallback. */
  brandTone: z.string().max(400).optional().default(''),
  /** The visitor's own prose. The only thing the model is allowed to read. */
  offer: z.string().max(2000).optional().default(''),
  description: z.string().max(2000).optional().default(''),
  /**
   * Set once generation has started, so a picture the visitor uploaded when
   * the profiles came back empty is folded into the palette.
   */
  previewId: z.string().uuid().optional(),
});

/**
 * Deliberately tighter than the intake graph's 30. Each call here is up to
 * four outbound requests and one model completion, so it is the most expensive
 * anonymous endpoint in the funnel, and a visitor answers the links question
 * once.
 */
const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return (
    forwarded?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

/** The most pictures we will decode for one palette. */
const MAX_BITMAPS = 4;

/**
 * The pictures, from both places one can come from: an image a profile page
 * exposed, and a logo the visitor uploaded when no profile would talk to us.
 *
 * Uploads come first in the list, deliberately. The palette rule pools samples
 * and the heaviest colour wins, so a logo the visitor chose on purpose ought
 * to outweigh whatever crop a social network puts in its OpenGraph tag.
 */
async function collectBitmaps(input: {
  previewId?: string;
  imageUrls: readonly string[];
}): Promise<Bitmap[]> {
  const bitmaps: Bitmap[] = [];

  if (input.previewId) {
    try {
      const uploads = await listFunnelAssets(input.previewId);
      for (const upload of uploads) {
        if (bitmaps.length >= MAX_BITMAPS) break;
        if (!upload.storagePath) continue;
        const bytes = await readFunnelAssetBytes(upload.storagePath);
        if (!bytes) continue;
        const bitmap = await decodeBitmap(bytes);
        if (bitmap) bitmaps.push(bitmap);
      }
    } catch {
      // An unreadable upload costs a palette source, nothing more.
    }
  }

  for (const url of input.imageUrls) {
    if (bitmaps.length >= MAX_BITMAPS) break;
    const bitmap = await fetchImageBitmap(url);
    if (bitmap) bitmaps.push(bitmap);
  }
  return bitmaps;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isRateLimited(clientIp(request))) {
    return NextResponse.json(
      { error: 'Too many requests', code: 'RATE_LIMITED' },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Body must be JSON', code: 'BAD_REQUEST' },
      { status: 400 }
    );
  }

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Those links do not look right', code: 'BAD_REQUEST' },
      { status: 400 }
    );
  }
  const input = parsed.data;

  try {
    const links = parseProfileLinks(input);
    const signals =
      links.length > 0
        ? await readProfileSignals(links)
        : {
            readings: [],
            anyExposed: false,
            bioText: '',
            imageUrls: [],
            unavailable: [],
          };

    // The visitor's own face, filed against the preview so the generator can
    // put it in the about section. Deliberately before the palette, so a
    // picture captured on this request is one of the pictures the palette is
    // read from rather than arriving a request too late.
    //
    // Filed WITHOUT a rights confirmation: a picture read off a public profile
    // is not one the visitor handed us, so it dresses the preview and nothing
    // else until the claim page asks. See `profile-picture.ts`.
    const picture = input.previewId
      ? await captureProfilePicture({
          previewId: input.previewId,
          readings: signals.readings,
        })
      : ({ status: 'skipped', reason: 'no_image' } as const);

    const bitmaps = await collectBitmaps({
      previewId: input.previewId,
      imageUrls: signals.imageUrls,
    });

    const palette = derivePalette({
      bitmaps,
      brandTone: input.brandTone,
      backgrounds: DEFAULT_BACKGROUNDS,
    });

    const tone = await phraseTone({
      offer: input.offer,
      description: input.description,
      bioText: signals.bioText,
      brandTone: input.brandTone,
      workspaceId: null,
    });

    return NextResponse.json({
      palette: {
        primary: palette.primary,
        secondary: palette.secondary,
        accent: palette.accent,
        neutral: palette.neutral,
        source: palette.source,
      },
      tone,
      /** One entry per network that would not talk to us, with why. */
      unavailable: signals.unavailable,
      anyExposed: signals.anyExposed,
      /**
       * The profile picture, when a network let us have one. `network` is what
       * the claim page names when it asks whether we may publish it.
       */
      picture:
        picture.status === 'captured'
          ? {
              assetId: picture.asset.id,
              network: picture.network,
              width: picture.asset.width,
              height: picture.asset.height,
              // Signed, and short lived. The object is in a private bucket
              // outside `tenant/`, so this is the only way the visitor can be
              // shown the picture we took off their own profile, which is what
              // the claim page's one question is asking about.
              url: picture.asset.storagePath
                ? await signFunnelAsset(picture.asset.storagePath)
                : null,
            }
          : null,
      /**
       * True when we read nothing at all and the visitor is worth offering the
       * picture upload to. A rule, decided here, so the wizard does not have
       * to reimplement "was any of that useful".
       */
      offerPictureUpload: !signals.anyExposed && bitmaps.length === 0,
    });
  } catch (error) {
    // The contract: a visitor waiting on a preview never sees a 500 from the
    // brand step. A palette is a nicety; the funnel is not.
    console.error(
      '[brand-signals] derivation failed, falling back to the tone chips:',
      error instanceof Error ? error.message : 'unknown error'
    );
    const palette = derivePalette({ brandTone: input.brandTone });
    return NextResponse.json({
      palette: {
        primary: palette.primary,
        secondary: palette.secondary,
        accent: palette.accent,
        neutral: palette.neutral,
        source: palette.source,
      },
      tone: { adjectives: [], voice: '', source: 'default' },
      unavailable: [],
      anyExposed: false,
      picture: null,
      offerPictureUpload: true,
    });
  }
}
