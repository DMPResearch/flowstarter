/**
 * Brand-specific site imagery, painted for one brief.
 *
 * A template ships with art direction that is genuinely good — and genuinely
 * about somebody else. A carpenter and a therapist get the same three abstract
 * gradients in their service cards, and the preview reads as a theme demo
 * rather than as their business. This stage closes that gap: it looks at the
 * slots the chosen template actually renders, picks a few worth repainting,
 * and asks an image model for pictures of *this* trade.
 *
 * The division of labour is the house rule. Which slots get regenerated, what
 * each prompt says, which aspect ratio it asks for and what may never be drawn
 * are all decided here, in code, from the brief. The model only paints. It is
 * never asked to choose a slot, judge a result, or write its own instructions.
 *
 * Everything here is best-effort. A slot whose image fails to generate, parse
 * or validate keeps the template's own artwork, which is a perfectly good
 * outcome — so no failure in this file may fail or stall a preview.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_ASSET_BYTES, SAFE_FILE_NAME } from './preview-assets';
import { assertSafeUploadedImage, type SiteImageSlot } from './site-media';

/** What a picture is for on the page. Decides its prompt and its shape. */
export type GeneratedAssetRole = 'hero' | 'service' | 'about';

/** Aspect each role is requested at, matching how templates crop the slot. */
const ROLE_ASPECT: Record<GeneratedAssetRole, string> = {
  hero: '16:9',
  service: '4:3',
  about: '3:2',
};

/**
 * Priority when more slots qualify than we are willing to pay for. A hero
 * carries the page, service cards carry the offer, mood art is decoration.
 */
const ROLE_PRIORITY: Record<GeneratedAssetRole, number> = {
  hero: 0,
  service: 1,
  about: 2,
};

/** Never regenerate more than this many slots for one preview. */
const MAX_GENERATED_SLOTS = 4;

/** The whole stage is abandoned past this, however many images are still out. */
const OVERALL_TIMEOUT_MS = 90_000;

const OPENROUTER_IMAGE_URL = 'https://openrouter.ai/api/v1/images';

/**
 * Verified against the live endpoint: honours `aspect_ratio`, returns PNG
 * bytes as `data[0].b64_json`, and reports spend on `usage.cost`.
 */
const DEFAULT_IMAGE_MODEL = 'google/gemini-2.5-flash-image';

// --------------------------------------------------------------------------
// Slot planning
// --------------------------------------------------------------------------

/**
 * The slot vocabulary below is exported rather than private.
 *
 * `portrait-slot.ts` decides where a client's own photograph may sit, which is
 * the same question asked from the other side: the slots this file refuses to
 * paint a person into are exactly the slots a real person belongs in. Two
 * copies of these patterns would be two definitions of what a testimonial
 * section is called, and they would drift the first time a template invents a
 * new name for one.
 */

/**
 * Keys that address a person rather than a place or a thing. We do not
 * fabricate people: a generated face on an "our founder" slot is a lie about
 * who the client is, and no amount of prompt hedging makes it not one.
 */
export const PERSON_KEY = /^(avatar|authorImage)$/i;

/** Sections that are about people, whatever the key on the line is called. */
export const PERSON_SECTION =
  /testimonial|review|author|team|staff|people|founder|member|client/i;

/** A wordmark slot is typography, not photography. */
const LOGO_KEY = /^logo$/i;

/** Roles, by the section or key the template filed the slot under. */
export const HERO_SECTION = /hero|banner|masthead|cover|jumbotron|splash/i;
const SERVICE_SECTION =
  /service|offer|feature|package|pricing|capabilit|process|project|work|portfolio|caseStud|journal|gallery/i;
const ABOUT_SECTION = /about|story|studio|space|mood|value|approach|why/i;

/**
 * Slots the asset policy already promises to the client's own photographs.
 * When the client gave us real media, generating competing artwork for these
 * would only invite the coding agent to pick the fake one.
 */
export const CLIENT_MEDIA_SECTION =
  /about|story|portrait|profile|founder|bio|team/i;

export interface PlannedAssetSlot {
  slot: SiteImageSlot;
  role: GeneratedAssetRole;
  aspectRatio: string;
}

/** One entry of the template's shipped-artwork manifest, as far as we read it. */
export interface AssetLibraryEntry {
  path?: string;
  kind?: string;
  [key: string]: unknown;
}

export interface SlotPlanInput {
  slots: readonly SiteImageSlot[];
  /**
   * The template's artwork manifest. An entry marked `photo-person` depicts a
   * human, so the slot rendering it is excluded whatever its key is named.
   */
  assetLibrary?: readonly AssetLibraryEntry[];
  /** True when the client supplied their own media for this build. */
  hasClientMedia?: boolean;
  /** Cap on regenerated slots; defaults to four. */
  limit?: number;
}

function classifyRole(
  slot: SiteImageSlot,
  order: number,
): GeneratedAssetRole | undefined {
  const haystack = `${slot.section} ${slot.key}`;
  if (HERO_SECTION.test(haystack)) return 'hero';
  if (SERVICE_SECTION.test(haystack)) return 'service';
  if (ABOUT_SECTION.test(haystack)) return 'about';
  // Templates that never open a top-level `hero:` key leave their banner image
  // as the first line of the content file, which site-media files under the
  // default "general" section. That first image is the hero in every template
  // we ship. Anything later in an unrecognised section stays untouched: an
  // unnamed slot is not an invitation to invent something for it.
  if (order === 0 && slot.section === 'general') return 'hero';
  return undefined;
}

/**
 * Chooses the slots worth repainting, deterministically.
 *
 * No model is consulted. Given the same template and the same client media
 * flag this returns the same slots in the same order every time, which is what
 * makes the exclusions below auditable rather than aspirational.
 */
export function planGeneratedAssetSlots(
  input: SlotPlanInput,
): PlannedAssetSlot[] {
  const personArtwork = new Set(
    (input.assetLibrary ?? [])
      .filter((entry) => String(entry.kind ?? '') === 'photo-person')
      .map((entry) => String(entry.path ?? ''))
      .filter(Boolean),
  );

  const candidates: Array<PlannedAssetSlot & { order: number }> = [];
  input.slots.forEach((slot, order) => {
    if (LOGO_KEY.test(slot.key)) return;
    if (PERSON_KEY.test(slot.key)) return;
    if (PERSON_SECTION.test(slot.section)) return;
    // The manifest knows what the shipped file actually depicts; a slot
    // currently holding a person is a person-shaped slot.
    if (personArtwork.has(slot.currentPath)) return;

    const role = classifyRole(slot, order);
    // An unrecognised section is not a licence to invent something for it.
    if (!role) return;
    // Portrait and about slots are reserved for real client media when there
    // is any; the preview prompt rules hand those slots to cachedAssets.
    if (input.hasClientMedia && CLIENT_MEDIA_SECTION.test(slot.section)) return;

    candidates.push({
      slot,
      role,
      aspectRatio: ROLE_ASPECT[role],
      order,
    });
  });

  const limit = input.limit ?? MAX_GENERATED_SLOTS;
  let heroTaken = false;
  return candidates
    .sort((a, b) => ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role] || a.order - b.order)
    .filter((candidate) => {
      // A page has one hero. A second "hero" slot is a duplicate parse, not a
      // second banner, and repainting it wastes a generation.
      if (candidate.role !== 'hero') return true;
      if (heroTaken) return false;
      heroTaken = true;
      return true;
    })
    .slice(0, limit)
    .map(({ slot, role, aspectRatio }) => ({ slot, role, aspectRatio }));
}

// --------------------------------------------------------------------------
// Prompt assembly
// --------------------------------------------------------------------------

/** What each role asks the camera to do. Fixed text; only the brief varies. */
const ROLE_DIRECTION: Record<GeneratedAssetRole, string> = {
  hero:
    'Wide establishing shot of the environment this work happens in, shot from a natural standing eye level, with calm uncluttered space across the upper third where a headline will sit over the image.',
  service:
    'Close detail shot of the tools, materials, surfaces or setting behind one service this business offers, one clear subject, shallow depth of field, nothing staged or stock-like.',
  about:
    'Quiet mood shot of the working space itself: room, light, surfaces and the everyday objects of this trade, nobody in frame.',
};

/**
 * Non-negotiables appended to every prompt.
 *
 * Text and logos are barred because an image model spells badly and a
 * hallucinated wordmark on a client's hero is worse than no image at all.
 * Faces are barred because this artwork is decorative — it must never be
 * mistakable for a photograph of the client, their team or their customers.
 */
const CONSTRAINTS =
  'Photographic and realistic, natural light, documentary style. ' +
  'Absolutely no text, no lettering, no words, no numbers, no captions, ' +
  'no logos, no signage, no watermarks and no user interface. ' +
  'No recognizable faces and no identifiable people. ' +
  'Not an illustration, not a 3D render, not a collage.';

/**
 * Strips untrusted client prose down to one safe clause of prompt material.
 * The brief is scraped and self-reported text; it reaches a paid API here, so
 * it is flattened to a single line and hard-capped rather than trusted.
 */
function clean(value: string | undefined, maxLength: number): string {
  if (!value) return '';
  const flat = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= maxLength) return flat;
  const cut = flat.slice(0, maxLength);
  const boundary = cut.lastIndexOf(' ');
  return (boundary > maxLength * 0.6 ? cut.slice(0, boundary) : cut).trim();
}

export interface AssetBrief {
  /** The trade or industry, e.g. "carpentry" or "physiotherapy". */
  industry: string;
  /** What the business does, in the client's own words. */
  description?: string;
  /** Who it is for. */
  targetAudience?: string;
  /** Brand tone adjectives; the first three are used. */
  brandTone?: readonly string[];
  /** Where the business works, when it shapes what the place looks like. */
  location?: string;
}

/**
 * Builds one image prompt from the brief and the slot's role.
 *
 * The business *name* is deliberately absent. Naming the brand tempts the
 * model to paint the name onto a wall or a van door, which is exactly the
 * lettering the constraints forbid.
 */
export function buildAssetPrompt(
  brief: AssetBrief,
  role: GeneratedAssetRole,
): string {
  const industry = clean(brief.industry, 80) || 'independent service';
  const sentences = [`Photograph for the website of an independent ${industry} business.`];

  // The client's own prose usually ends in a full stop already; the template
  // supplies its own, so trailing punctuation is trimmed rather than doubled.
  const sentence = (text: string) => text.replace(/[\s.,;:!?-]+$/, '');

  const description = clean(brief.description, 220);
  if (description) sentences.push(`The business: ${sentence(description)}.`);

  const audience = clean(brief.targetAudience, 120);
  if (audience) sentences.push(`It serves ${sentence(audience)}.`);

  const location = clean(brief.location, 80);
  if (location) sentences.push(`Based in ${sentence(location)}.`);

  const tone = (brief.brandTone ?? [])
    .slice(0, 3)
    .map((word) => clean(word, 24).toLowerCase())
    .filter(Boolean);
  if (tone.length > 0) sentences.push(`Visual tone: ${tone.join(', ')}.`);

  sentences.push(ROLE_DIRECTION[role]);
  sentences.push(CONSTRAINTS);
  return sentences.join(' ');
}

// --------------------------------------------------------------------------
// Generation
// --------------------------------------------------------------------------

/** One picture that survived generation, decoding and the safety rules. */
export interface GeneratedAssetEntry {
  publicPath: string;
  slotId: string;
  role: GeneratedAssetRole;
  width?: number;
  height?: number;
  prompt: string;
}

export interface GeneratedAssetsResult {
  entries: GeneratedAssetEntry[];
  /** Accumulated spend across every attempt, including the failed ones. */
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  /** Set when the stage chose not to run; entries is then empty. */
  skippedReason?: string;
}

const EMPTY: GeneratedAssetsResult = {
  entries: [],
  costUsd: 0,
  promptTokens: 0,
  completionTokens: 0,
};

export interface GenerateSiteAssetsInput {
  workspaceRoot: string;
  brief: AssetBrief;
  slots: readonly SiteImageSlot[];
  assetLibrary?: readonly AssetLibraryEntry[];
  hasClientMedia?: boolean;
  /**
   * The run is on a reduced budget; imagery is the first thing to drop
   * because the template's own art is a working fallback.
   */
  budgetDegraded?: boolean;
  /** Overrides for tests and for operators pinning a model. */
  apiKey?: string;
  model?: string;
  limit?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onPhase?: (phase: string) => void;
}

interface ImageApiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
}

interface ImageApiResponse {
  data?: Array<{
    b64_json?: string;
    media_type?: string;
    // Tolerated for forward compatibility: some OpenRouter surfaces hand back
    // a data URL instead of raw base64.
    image_url?: { url?: string } | string;
  }>;
  usage?: ImageApiUsage;
}

/** Pulls base64 image bytes out of whichever field the payload used. */
function extractBase64(entry: NonNullable<ImageApiResponse['data']>[number]): string | undefined {
  if (typeof entry?.b64_json === 'string' && entry.b64_json.length > 0) {
    return entry.b64_json;
  }
  const url =
    typeof entry?.image_url === 'string' ? entry.image_url : entry?.image_url?.url;
  if (typeof url !== 'string') return undefined;
  const match = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(url.trim());
  return match?.[1];
}

/** File name for a role, kept inside the shared safe-name rule. */
function assetFileName(
  role: GeneratedAssetRole,
  index: number,
  extension: string,
): string {
  const suffix = index === 0 ? '' : `-${index + 1}`;
  return `generated-${role}${suffix}.${extension}`;
}

interface Attempt {
  planned: PlannedAssetSlot;
  prompt: string;
  fileName: string;
}

/**
 * Paints brand-matched artwork for a handful of the template's image slots and
 * writes it into the workspace alongside the client's own media.
 *
 * Returns whatever survived. An empty result is an ordinary outcome, not an
 * error: the caller carries on and the site keeps its template artwork.
 */
export async function generateSiteAssets(
  input: GenerateSiteAssetsInput,
): Promise<GeneratedAssetsResult> {
  const apiKey = input.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { ...EMPTY, skippedReason: 'no OPENROUTER_API_KEY configured' };
  }
  if (process.env.FLOWSTARTER_GENERATED_ASSETS === 'off') {
    return { ...EMPTY, skippedReason: 'FLOWSTARTER_GENERATED_ASSETS=off' };
  }
  if (input.budgetDegraded) {
    return { ...EMPTY, skippedReason: 'run is on a degraded budget' };
  }

  const planned = planGeneratedAssetSlots({
    slots: input.slots,
    ...(input.assetLibrary ? { assetLibrary: input.assetLibrary } : {}),
    ...(input.hasClientMedia === undefined
      ? {}
      : { hasClientMedia: input.hasClientMedia }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  if (planned.length === 0) {
    return { ...EMPTY, skippedReason: 'no eligible image slots' };
  }

  const perRole = new Map<GeneratedAssetRole, number>();
  const attempts: Attempt[] = planned.map((slot) => {
    const seen = perRole.get(slot.role) ?? 0;
    perRole.set(slot.role, seen + 1);
    return {
      planned: slot,
      prompt: buildAssetPrompt(input.brief, slot.role),
      // Extension is provisional; the verified bytes get the final say below.
      fileName: assetFileName(slot.role, seen, 'png'),
    };
  });

  input.onPhase?.('Painting artwork for your trade');

  const directory = join(input.workspaceRoot, 'public', 'flowstarter-assets');
  await mkdir(directory, { recursive: true }).catch(() => undefined);

  const doFetch = input.fetchImpl ?? globalThis.fetch;
  const model = input.model ?? DEFAULT_IMAGE_MODEL;
  const controller = new AbortController();
  // One clock for the whole stage. A single slow provider must not hold a
  // client's preview open past the point the rest of the pipeline is ready.
  const timer = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? OVERALL_TIMEOUT_MS,
  );

  const totals = { costUsd: 0, promptTokens: 0, completionTokens: 0 };
  const failures: string[] = [];

  const settled = await Promise.allSettled(
    attempts.map(async (attempt): Promise<GeneratedAssetEntry> => {
      const response = await doFetch(OPENROUTER_IMAGE_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt: attempt.prompt,
          aspect_ratio: attempt.planned.aspectRatio,
          output_format: 'png',
        }),
      });
      if (!response.ok) {
        throw new Error(`image request failed with HTTP ${response.status}`);
      }

      const payload = (await response.json()) as ImageApiResponse;
      // Spend is recorded before the payload is judged: a malformed response
      // we reject was still billed.
      if (payload?.usage) {
        totals.costUsd += Number(payload.usage.cost) || 0;
        totals.promptTokens += Number(payload.usage.prompt_tokens) || 0;
        totals.completionTokens += Number(payload.usage.completion_tokens) || 0;
      }

      const base64 = extractBase64(payload?.data?.[0] ?? {});
      if (!base64) throw new Error('response carried no image data');

      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) {
        throw new Error(`image is empty or larger than ${MAX_ASSET_BYTES} bytes`);
      }
      // Same gate a client upload passes: real raster magic bytes, sane
      // dimensions, no SVG. Model output is not more trusted than a scrape.
      const verified = assertSafeUploadedImage(bytes);
      const fileName = attempt.fileName.replace(/\.png$/, `.${verified.extension}`);
      if (!SAFE_FILE_NAME.test(fileName)) {
        throw new Error(`unsafe generated file name: ${fileName}`);
      }

      await writeFile(join(directory, fileName), bytes, { mode: 0o644 });
      return {
        publicPath: `/flowstarter-assets/${fileName}`,
        slotId: attempt.planned.slot.id,
        role: attempt.planned.role,
        ...(verified.width === undefined ? {} : { width: verified.width }),
        ...(verified.height === undefined ? {} : { height: verified.height }),
        prompt: attempt.prompt,
      };
    }),
  );
  clearTimeout(timer);

  const entries: GeneratedAssetEntry[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      entries.push(outcome.value);
      return;
    }
    const reason = outcome.reason;
    failures.push(
      `${attempts[index]?.planned.slot.id ?? 'slot'}: ${
        reason instanceof Error ? reason.message : String(reason)
      }`,
    );
  });

  // One line, whatever went wrong. A slot that fails keeps the template's own
  // artwork, so this is information for us and a non-event for the client.
  if (failures.length > 0) {
    console.warn(
      `[generated-assets] ${failures.length} of ${attempts.length} images unavailable: ${failures
        .join('; ')
        .slice(0, 500)}`,
    );
  }
  console.info(
    `[generated-assets] ${entries.length} image(s) generated, cost $${totals.costUsd.toFixed(4)}`,
  );

  return { entries, ...totals };
}
