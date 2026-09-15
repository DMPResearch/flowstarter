/**
 * Recovering a structured answer the model actually gave but the SDK could not
 * read.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * `generateObject` asks the provider for a JSON object and then `JSON.parse`s
 * whatever came back. Which provider mode it gets is not ours to choose: for
 * `anthropic/*` through OpenRouter there is no native json_schema response
 * format, so the SDK falls back to instructing the model in the prompt and
 * parsing plain text. Claude answers that instruction with a correct object
 * wrapped in a markdown fence:
 *
 *     ```json
 *     { "scope": "standard", "confidence": 0.9, "evidence": [...] }
 *     ```
 *
 * which is a perfectly good answer and not valid JSON. The SDK throws
 * `NoObjectGeneratedError: could not parse the response`, every caller's
 * fail-closed branch fires, and on the scope gate that meant 100% of visitors
 * were classified `unclear` and no visitor could reach a preview. Setting
 * `structuredOutputs: true` on the provider does not change it, because the
 * provider does not offer the mode for this model family in the first place.
 *
 * ── What this is allowed to do ────────────────────────────────────────────
 * Recover, never invent. It unwraps a fence and takes the outermost balanced
 * JSON object out of the text, and that is all. It does not repair broken
 * JSON, it does not guess missing fields, and it hands what it finds back to
 * the caller's own schema, which is still the thing that decides whether the
 * answer is usable. A truncated or genuinely absent object yields `null` and
 * the caller's failure branch runs exactly as before.
 *
 * Pure and synchronous, so the rule is unit-testable against the raw string a
 * real provider actually returned.
 */

/**
 * The text inside a markdown code fence, or the text unchanged.
 *
 * Only a fence that wraps the whole answer is unwrapped. A fence in the middle
 * of prose is somebody's example, not their answer, and taking it would be
 * guessing.
 */
export function stripCodeFence(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith('```')) return text;

  const firstNewline = text.indexOf('\n');
  if (firstNewline === -1) return text;

  // The opening line is ``` plus an optional language tag and nothing else.
  const infoString = text.slice(3, firstNewline).trim();
  if (infoString.includes('`')) return text;

  const closing = text.lastIndexOf('```');
  if (closing <= firstNewline) return text;
  // Anything after the closing fence is commentary, and commentary after a
  // complete answer is not a reason to refuse the answer.
  return text.slice(firstNewline + 1, closing).trim();
}

/**
 * The outermost balanced `{...}` in the text, or null.
 *
 * Braces inside string literals do not count, which is why this walks the text
 * rather than matching the first `{` against the last `}`: an evidence
 * fragment quoting a visitor's own `{` would otherwise move the boundary.
 */
export function extractJsonObject(raw: string): string | null {
  const text = raw;
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * The object a model meant to return, parsed, or null when there is not one.
 *
 * `null` is not an error condition here. It is "this text does not contain a
 * complete JSON object", which is exactly what a truncated completion looks
 * like, and the caller's existing failure path is the right answer to it.
 */
export function parseObjectFromText(raw: string | undefined): unknown {
  if (!raw) return null;
  const unfenced = stripCodeFence(raw);
  const candidate = extractJsonObject(unfenced);
  if (!candidate) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The narrow slice of a zod schema this module needs.
 *
 * Structural rather than an import of `z.ZodType`: `callLlmObject` takes its
 * schema as `unknown` so that the seam does not force a zod version on its
 * callers, and this keeps that true.
 */
interface SafeParsing {
  safeParse(value: unknown): { success: boolean; data?: unknown };
}

function canSafeParse(schema: unknown): schema is SafeParsing {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    typeof (schema as SafeParsing).safeParse === 'function'
  );
}

/**
 * Recover a schema-valid object from the raw completion, or null.
 *
 * The schema still decides. A recovered object that does not satisfy it is not
 * an answer, and pretending otherwise would be the failure this whole module
 * is here to stop happening quietly.
 */
export function recoverObject<T>(
  rawText: string | undefined,
  schema: unknown
): T | null {
  const parsed = parseObjectFromText(rawText);
  if (parsed === null) return null;
  if (!canSafeParse(schema)) return parsed as T;
  const result = schema.safeParse(parsed);
  return result.success ? (result.data as T) : null;
}
