/**
 * Flowstarter's two label sets. Nothing else in this package invents a label.
 *
 * Both are CLOSED sets, and nothing here is a matcher: there is no keyword
 * list, no regex floor and no denylist anywhere in this package. Flowstarter's
 * guardrails are a system prompt and a classifier, and a classifier is a
 * geometry over embeddings, not a string search. Seed phrases do exist (see
 * src/training/phrases.ts) but they are averaged into centroids at train time
 * and never consulted at request time — the only thing that touches a user's
 * text in production is the tokenizer.
 */

/* ── head 1: acceptable use ───────────────────────────────────────────── */

/** Categories that must never reach a build, when we are confident. */
export const PROHIBITED_CATEGORIES = [
  'illegal_drugs',
  'prostitution_escort',
  'adult_content',
  'weapons_ammunition',
  'unlicensed_gambling',
  'counterfeit_goods',
  'hate_harassment',
  'scams_impersonation',
  'unlicensed_medical_financial_claims',
] as const;

/**
 * Lawful, but only with paperwork we cannot see from a text box. These are
 * not "almost prohibited": a licensed pharmacy is a real customer. They go to
 * a human because the licence, not the sentence, decides.
 */
export const SENSITIVE_CATEGORIES = [
  'licensed_pharmacy',
  'legal_cannabis',
  'firearms_training',
  'sexual_health',
  'licensed_betting',
  'adult_adjacent_retail',
] as const;

export const CLEAN_CATEGORY = 'clean';

export const ACCEPTABLE_USE_CATEGORIES = [
  ...PROHIBITED_CATEGORIES,
  ...SENSITIVE_CATEGORIES,
  CLEAN_CATEGORY,
] as const;

export type ProhibitedCategory = (typeof PROHIBITED_CATEGORIES)[number];
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];
export type AcceptableUseCategory = (typeof ACCEPTABLE_USE_CATEGORIES)[number];
export type CategoryClass = 'prohibited' | 'sensitive' | 'clean';

const PROHIBITED_SET: ReadonlySet<string> = new Set(PROHIBITED_CATEGORIES);
const SENSITIVE_SET: ReadonlySet<string> = new Set(SENSITIVE_CATEGORIES);

export function categoryClass(category: AcceptableUseCategory): CategoryClass {
  if (PROHIBITED_SET.has(category)) return 'prohibited';
  if (SENSITIVE_SET.has(category)) return 'sensitive';
  return 'clean';
}

export function isAcceptableUseCategory(value: unknown): value is AcceptableUseCategory {
  return (
    typeof value === 'string' &&
    (ACCEPTABLE_USE_CATEGORIES as readonly string[]).includes(value)
  );
}

/* ── head 2: commercial scope ─────────────────────────────────────────── */

/**
 * `standard-site` is what the self-serve funnel builds unattended: brochure,
 * portfolio, services, local business, restaurant, clinic, coach, a small
 * shop with a simple catalogue. A contact form or an intro-call booking
 * widget is PART of a standard site, not a reason to escalate.
 *
 * `custom-work` has to be contracted through DMPResearch after a discovery
 * call: web and mobile apps, SaaS, marketplaces, anything with user logins or
 * an admin panel, booking or payment systems past a simple form, custom
 * integrations and APIs, multi-tenant or multi-language enterprise sites, and
 * migrations of large existing systems.
 *
 * `unclear` is a real trained label, not just the abstention: "we need a
 * digital presence" is a genuinely underspecified request, and the funnel
 * should ask rather than guess. The abstention lands on the same action, so
 * the product behaves identically either way.
 */
export const SCOPE_CATEGORIES = ['standard-site', 'custom-work', 'unclear'] as const;
export type ScopeCategory = (typeof SCOPE_CATEGORIES)[number];

export function isScopeCategory(value: unknown): value is ScopeCategory {
  return typeof value === 'string' && (SCOPE_CATEGORIES as readonly string[]).includes(value);
}

/* ── heads ────────────────────────────────────────────────────────────── */

/** Decision names, as they appear in the committed model files. */
export const ACCEPTABLE_USE_HEAD = 'acceptable_use';
export const SCOPE_HEAD = 'scope';

export const HEADS = [ACCEPTABLE_USE_HEAD, SCOPE_HEAD] as const;
export type HeadName = (typeof HEADS)[number];

export const HEAD_LABELS: Record<HeadName, readonly string[]> = {
  [ACCEPTABLE_USE_HEAD]: ACCEPTABLE_USE_CATEGORIES,
  [SCOPE_HEAD]: SCOPE_CATEGORIES,
};

/* ── actions ──────────────────────────────────────────────────────────── */

export type AcceptableUseAction = 'allow' | 'review' | 'refuse';
export type ScopeAction = 'standard' | 'custom' | 'unclear';

/** The six languages both heads are trained and evaluated in. */
export const LANGUAGES = ['en', 'ro', 'de', 'fr', 'es', 'it'] as const;
export type Language = (typeof LANGUAGES)[number];
