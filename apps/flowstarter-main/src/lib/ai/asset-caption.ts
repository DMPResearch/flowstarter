import 'server-only';
/**
 * The bounded vision call behind an uncaptioned upload.
 *
 * A client who does not type a caption is not refusing to describe their
 * picture -- they are trusting us to look at it. Before this module existed,
 * that trust bought nothing: `assets.caption` stayed null, the operator's
 * change-request picker fell back to filename/dimensions/date, and the build
 * agent -- correctly forbidden from inventing what an uncaptioned file shows
 * -- described it as nothing at all. That silence is what let two screenshots
 * land on the wrong case study in workspace c009105e's job c8f48c1e: an
 * operator ticking identical "Untitled picture" boxes had no way to tell them
 * apart, and the agent, filling the gap the caption should have, guessed.
 *
 * `autoCaptionAsset` is the one call site allowed to guess instead, and it
 * only ever guesses at what is IN the picture (rules decide, models phrase):
 * a one-sentence subject, a closed `kind` vocabulary, whether a person is
 * shown, a visible product or company name if there plainly is one, and the
 * dominant colours. It never decides where a picture belongs on a site --
 * that placement rule lives in `@flowstarter/agentic-codegen`'s
 * change-request build, reading `caption`/`auto_caption` as evidence, never
 * producing it.
 *
 * Fails closed by construction: every error path below returns `null`, never
 * a partially-filled guess. A caption nobody can stand behind is worth
 * exactly as much as no caption -- which is to say, it is still `null`, and
 * the picture still reads "has no caption, so describe it only in general
 * terms" everywhere that string already means something.
 */
import { z } from 'zod';
import { callLlmObject, LlmBudgetExceededError } from './llm';

/** The only shapes an upload is ever sorted into. Closed on purpose: a build
 * agent's placement rule switches on this, and an open-ended kind would give
 * it nothing to switch on. */
export const AUTO_CAPTION_KINDS = [
  'screenshot',
  'photo',
  'logo',
  'document',
] as const;
export type AutoCaptionKind = (typeof AUTO_CAPTION_KINDS)[number];

/** A one-sentence subject is a caption, not a paragraph; this is generous
 * headroom for one, and matches the cap `change-request-build.ts` already
 * carries a client-typed caption under (`text(asset['caption'], 300)`), so
 * an auto-caption can never be the longer of the two kinds this column ever
 * holds. */
export const AUTO_CAPTION_SUBJECT_MAX_CHARS = 300;
/** A business name that shows up in a picture is a short string; this is
 * comfortably longer than any real one and short enough that a model's
 * hallucinated paragraph cannot pass for a name. */
export const AUTO_CAPTION_VISIBLE_NAME_MAX_CHARS = 120;
/** More than a template's palette ever asks for; a longer list is the model
 * padding, not more truth. */
export const AUTO_CAPTION_COLORS_MAX = 5;
/** One colour word or hex triplet, generous either way. */
export const AUTO_CAPTION_COLOR_MAX_CHARS = 40;
/** An upload response is a client waiting on their screen; this is long
 * enough for a real vision call and short enough that "the page is stuck" is
 * never the honest description of what is happening. */
export const AUTO_CAPTION_TIMEOUT_MS = 20_000;

export interface AutoCaption {
  /** What the picture shows, in one sentence. Never invented past this. */
  subject: string;
  kind: AutoCaptionKind;
  showsPerson: boolean;
  /** A product or company name plainly visible in the image, or null. */
  visibleName: string | null;
  /** Lowercase colour words or hex triplets, most prominent first. */
  dominantColors: string[];
}

const AutoCaptionSchema = z.object({
  subject: z.string().trim().min(1).max(AUTO_CAPTION_SUBJECT_MAX_CHARS),
  kind: z.enum(AUTO_CAPTION_KINDS),
  showsPerson: z.boolean(),
  visibleName: z
    .string()
    .trim()
    .max(AUTO_CAPTION_VISIBLE_NAME_MAX_CHARS)
    .nullable(),
  dominantColors: z
    .array(z.string().trim().max(AUTO_CAPTION_COLOR_MAX_CHARS))
    .max(AUTO_CAPTION_COLORS_MAX),
});

const CAPTION_SYSTEM_PROMPT =
  'You describe one image for a small-business website builder. Report only ' +
  'what is plainly visible. Never guess a business name, a person’s ' +
  'identity, or a location beyond what the picture itself shows. If nothing ' +
  'in the image names a product or company, say so with a null visibleName ' +
  'rather than inventing one.';

function captionPrompt(mime: string): string {
  return (
    `This is a ${mime} file a client uploaded to their own website project. ` +
    'Describe it: one plain sentence naming its subject; whether it is a ' +
    'screenshot, a photo, a logo, or a document; whether a person appears in ' +
    'it; any product or company name plainly visible in it (or null); and its ' +
    'dominant colours, most prominent first.'
  );
}

export interface AutoCaptionInput {
  bytes: Buffer;
  mime: string;
  /** Null for anonymous funnel traffic; threaded straight to the ledger. */
  workspaceId?: string | null;
}

/**
 * One bounded, budgeted, cost-accounted guess at what a picture shows, or
 * `null` on any failure -- a timeout, a budget breach, a malformed response,
 * a provider error. There is no partial success: a caller that gets `null`
 * stores no caption, exactly as if this function had never been called.
 *
 * Cost accounting and the token budget both come for free from `callLlm.ts`;
 * this function's only added responsibility is turning "the model said
 * something" into "the model said something we can trust the shape of",
 * which is what the zod schema and the bounds above are for.
 */
export async function autoCaptionAsset(
  input: AutoCaptionInput
): Promise<AutoCaption | null> {
  try {
    const result = await callLlmObject<AutoCaption>({
      action: 'caption_asset',
      workspaceId: input.workspaceId ?? null,
      system: CAPTION_SYSTEM_PROMPT,
      schema: AutoCaptionSchema,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: captionPrompt(input.mime) },
            { type: 'image', image: input.bytes, mediaType: input.mime },
          ],
        },
      ],
      abortSignal: AbortSignal.timeout(AUTO_CAPTION_TIMEOUT_MS),
    });
    return normalizeAutoCaption(result.object);
  } catch (error) {
    // A budget breach is still logged by `callLlm.ts` before it throws
    // (`settle` records the ledger row first); every other failure --
    // timeout, network, a response that does not parse -- is not this
    // function's to log loudly, because "no caption" is always a safe,
    // expected outcome here and a client's upload must never fail because
    // captioning did.
    if (!(error instanceof LlmBudgetExceededError)) {
      console.warn('[asset-caption] auto-caption failed, storing none', {
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
    return null;
  }
}

/**
 * Defensive re-clamping of an already-schema-validated object.
 *
 * The schema is the real gate; this exists because a model can return a
 * technically-valid string that is still untrimmed, or a colour list at the
 * cap that a future schema change might widen -- belt and braces, the same
 * posture `change-request-build.ts`'s own `text()`/`finiteInt()` helpers
 * take with a payload that already passed one round of validation.
 */
function normalizeAutoCaption(raw: AutoCaption): AutoCaption {
  return {
    subject: raw.subject.trim().slice(0, AUTO_CAPTION_SUBJECT_MAX_CHARS),
    kind: raw.kind,
    showsPerson: raw.showsPerson,
    visibleName: raw.visibleName?.trim() || null,
    dominantColors: raw.dominantColors
      .map((color) => color.trim().toLowerCase())
      .filter((color) => color.length > 0)
      .slice(0, AUTO_CAPTION_COLORS_MAX),
  };
}
