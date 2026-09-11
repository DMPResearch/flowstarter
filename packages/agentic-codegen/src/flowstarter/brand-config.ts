import type { BrandConfig } from './types';

const HEX = /^#[0-9A-F]{6}$/;
const GOOGLE_FONT = /^[A-Za-z0-9][A-Za-z0-9 .+-]{0,79}$/;
// CSS fallback stacks legitimately contain commas and quoted family names. Keep
// the grammar deliberately smaller than arbitrary CSS so this value can never
// smuggle a declaration, function, or URL into a template token.
const FONT_FALLBACK_STACK = /^[A-Za-z0-9][A-Za-z0-9 .,'"+-]{0,199}$/;
const SECTION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class InvalidBrandConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid BrandConfig: ${issues.join('; ')}`);
    this.name = 'InvalidBrandConfigError';
  }
}

export function parseBrandConfig(raw: string, knownSourceIds: ReadonlySet<string>): BrandConfig {
  let value: unknown;
  try {
    value = JSON.parse(stripJsonFence(raw));
  } catch {
    throw new InvalidBrandConfigError(['response is not valid JSON']);
  }
  return validateBrandConfig(value, knownSourceIds);
}

/**
 * Models reliably instructed to emit bare JSON still wrap it in a markdown
 * fence when multimodal content is in context. Accept exactly one whole-string
 * fence; anything else (prose around JSON, partial fences) still fails parsing
 * so malformed output cannot slip through.
 */
export function stripJsonFence(raw: string): string {
  // Read rather than matched. The regex this replaces chained `\s*` against
  // `\n` and `[\s\S]*?`, which overlap, so a long model reply that is not a
  // clean fence cost time quadratic in its length before failing. The
  // acceptance rules below are the ones that regex encoded, unchanged.
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```')) return raw;

  // Opening fence: ``` then an optional `json` tag, then blanks that have to
  // contain at least one newline. The body may begin after any of those
  // newlines; the regex preferred the last and fell back towards the first,
  // so these are collected in that order.
  const bodyStarts: number[] = [];
  let cursor = trimmed.startsWith('json', 3) ? 7 : 3;
  while (cursor < trimmed.length && /\s/.test(trimmed[cursor]!)) {
    if (trimmed[cursor] === '\n') bodyStarts.push(cursor + 1);
    cursor += 1;
  }

  // Closing fence: the body ends at the first newline of the blank run that
  // runs into the backticks, which is the shortest body the regex would take.
  for (let index = bodyStarts.length - 1; index >= 0; index -= 1) {
    const inner = trimmed.slice(bodyStarts[index]!, trimmed.length - 3);
    const closerStart = inner.indexOf('\n', inner.trimEnd().length);
    if (closerStart !== -1) return inner.slice(0, closerStart);
  }
  return raw;
}

export function validateBrandConfig(
  value: unknown,
  knownSourceIds: ReadonlySet<string> = new Set()
): BrandConfig {
  const issues: string[] = [];
  if (!isRecord(value)) throw new InvalidBrandConfigError(['root must be an object']);

  const expectedRoot = ['schemaVersion', 'colors', 'typography', 'voice', 'ideas', 'evidence'];
  exactKeys(value, expectedRoot, 'root', issues);
  if (value.schemaVersion !== '1.0') issues.push('schemaVersion must be 1.0');

  const colors = recordAt(value, 'colors', issues);
  const colorKeys = [
    'primary',
    'onPrimary',
    'secondary',
    'onSecondary',
    'accent',
    'onAccent',
    'background',
    'surface',
    'text',
    'mutedText',
  ];
  exactKeys(colors, colorKeys, 'colors', issues);
  for (const key of colorKeys) {
    if (typeof colors[key] !== 'string' || !HEX.test(colors[key])) {
      issues.push(`colors.${key} must be uppercase #RRGGBB`);
    }
  }

  checkContrast(colors, 'text', 'background', 4.5, issues);
  checkContrast(colors, 'mutedText', 'background', 4.5, issues);
  checkContrast(colors, 'text', 'surface', 4.5, issues);
  checkContrast(colors, 'mutedText', 'surface', 4.5, issues);
  checkContrast(colors, 'onPrimary', 'primary', 4.5, issues);
  checkContrast(colors, 'onSecondary', 'secondary', 4.5, issues);
  checkContrast(colors, 'onAccent', 'accent', 4.5, issues);

  const typography = recordAt(value, 'typography', issues);
  exactKeys(typography, ['headingFont', 'bodyFont', 'fallbackStack', 'source'], 'typography', issues);
  for (const key of ['headingFont', 'bodyFont']) {
    if (typeof typography[key] !== 'string' || !GOOGLE_FONT.test(typography[key])) {
      issues.push(`typography.${key} is invalid`);
    }
  }
  if (
    typeof typography.fallbackStack !== 'string' ||
    !FONT_FALLBACK_STACK.test(typography.fallbackStack)
  ) {
    issues.push('typography.fallbackStack is invalid');
  }
  if (typography.source !== 'google_fonts' && typography.source !== 'system') {
    issues.push('typography.source is invalid');
  }

  const voice = recordAt(value, 'voice', issues);
  exactKeys(
    voice,
    [
      'formality',
      'warmth',
      'energy',
      'playfulness',
      'directness',
      'adjectives',
      'avoidPhrases',
      'sampleHeadline',
      'sampleBody',
      'primaryCta',
    ],
    'voice',
    issues
  );
  for (const key of ['formality', 'warmth', 'energy', 'playfulness', 'directness']) {
    const score = voice[key];
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
      issues.push(`voice.${key} must be between 0 and 1`);
    }
  }
  stringArray(voice.adjectives, 'voice.adjectives', issues, { exact: 3 });
  stringArray(voice.avoidPhrases, 'voice.avoidPhrases', issues, { max: 20 });
  for (const key of ['sampleHeadline', 'sampleBody', 'primaryCta']) {
    nonEmptyString(voice[key], `voice.${key}`, issues, 500);
  }

  const ideas = recordAt(value, 'ideas', issues);
  exactKeys(ideas, ['positioning', 'heroAngle', 'sections', 'contentThemes'], 'ideas', issues);
  nonEmptyString(ideas.positioning, 'ideas.positioning', issues, 1000);
  nonEmptyString(ideas.heroAngle, 'ideas.heroAngle', issues, 1000);
  stringArray(ideas.contentThemes, 'ideas.contentThemes', issues, { max: 12 });
  if (!Array.isArray(ideas.sections) || ideas.sections.length === 0 || ideas.sections.length > 16) {
    issues.push('ideas.sections must contain 1 to 16 sections');
  } else {
    const seen = new Set<string>();
    ideas.sections.forEach((section, index) => {
      if (!isRecord(section)) {
        issues.push(`ideas.sections[${index}] must be an object`);
        return;
      }
      exactKeys(section, ['id', 'purpose', 'evidenceSourceIds'], `ideas.sections[${index}]`, issues);
      if (typeof section.id !== 'string' || !SECTION_ID.test(section.id) || seen.has(section.id)) {
        issues.push(`ideas.sections[${index}].id must be unique kebab-case`);
      } else {
        seen.add(section.id);
      }
      nonEmptyString(section.purpose, `ideas.sections[${index}].purpose`, issues, 500);
      validateSourceIds(
        section.evidenceSourceIds,
        `ideas.sections[${index}].evidenceSourceIds`,
        knownSourceIds,
        issues,
        true
      );
    });
  }

  const evidence = recordAt(value, 'evidence', issues);
  exactKeys(evidence, ['textSourceIds', 'imageSourceIds', 'assumptions'], 'evidence', issues);
  validateSourceIds(evidence.textSourceIds, 'evidence.textSourceIds', knownSourceIds, issues, false);
  validateSourceIds(evidence.imageSourceIds, 'evidence.imageSourceIds', knownSourceIds, issues, false);
  stringArray(evidence.assumptions, 'evidence.assumptions', issues, {
    max: 20,
    itemMax: 500,
  });

  if (issues.length > 0) throw new InvalidBrandConfigError(issues);
  return value as unknown as BrandConfig;
}

export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function checkContrast(
  colors: Record<string, unknown>,
  foreground: string,
  background: string,
  minimum: number,
  issues: string[]
): void {
  const fg = colors[foreground];
  const bg = colors[background];
  if (typeof fg === 'string' && typeof bg === 'string' && HEX.test(fg) && HEX.test(bg)) {
    if (contrastRatio(fg, bg) < minimum) {
      issues.push(`colors.${foreground}/colors.${background} must meet ${minimum}:1 contrast`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordAt(parent: Record<string, unknown>, key: string, issues: string[]): Record<string, unknown> {
  const value = parent[key];
  if (!isRecord(value)) {
    issues.push(`${key} must be an object`);
    return {};
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  issues: string[]
): void {
  const actual = Object.keys(value);
  for (const key of expected) if (!(key in value)) issues.push(`${path}.${key} is required`);
  for (const key of actual) if (!expected.includes(key)) issues.push(`${path}.${key} is not allowed`);
}

function nonEmptyString(value: unknown, path: string, issues: string[], max: number): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    issues.push(`${path} must be a non-empty string up to ${max} characters`);
  }
}

function stringArray(
  value: unknown,
  path: string,
  issues: string[],
  bounds: { exact?: number; max?: number; itemMax?: number }
): value is string[] {
  const itemMax = bounds.itemMax ?? 200;
  if (
    !Array.isArray(value) ||
    (bounds.exact !== undefined && value.length !== bounds.exact) ||
    (bounds.max !== undefined && value.length > bounds.max) ||
    value.some((item) =>
      typeof item !== 'string' || item.trim().length === 0 || item.length > itemMax
    )
  ) {
    issues.push(`${path} must be a bounded array of non-empty strings`);
    return false;
  }
  return true;
}

function validateSourceIds(
  value: unknown,
  path: string,
  knownSourceIds: ReadonlySet<string>,
  issues: string[],
  requireOne: boolean
): void {
  if (!stringArray(value, path, issues, { max: 100 })) return;
  if (requireOne && value.length === 0) issues.push(`${path} must contain at least one source ID`);
  if (knownSourceIds.size > 0) {
    for (const id of value) if (!knownSourceIds.has(id)) issues.push(`${path} contains unknown source ID ${id}`);
  }
}
