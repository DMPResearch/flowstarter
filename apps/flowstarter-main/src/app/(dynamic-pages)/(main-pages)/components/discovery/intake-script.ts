/**
 * The intake conversation, as a script.
 *
 * The discovery wizard used to be a form: six screens of labelled inputs. It
 * now reads as a conversation with an agent — one question at a time, in a
 * transcript, answered in a composer or by tapping a quick reply. This module
 * is the half of that which must never be improvised.
 *
 * The division of labour is the same one the rest of the intake follows:
 *
 *   rules decide, models phrase.
 *
 * Everything here is a rule. The order of the questions, which of them are
 * required, what counts as a valid answer, which wizard step an answer belongs
 * to, and when the conversation is finished are all decided by the data in this
 * file and the pure functions under it. No model is consulted — not to pick the
 * next question, not to judge an answer, and above all not to decide that the
 * intake is done. The only place a live model still speaks is the gap-filling
 * interview in `InfoAgentStep`, which runs *after* this script has run out of
 * questions and cannot change any of the decisions made here.
 *
 * Nothing in this module touches React, the network or storage: it maps
 * (DiscoveryData, answered ids) → the next question, and (question, raw text) →
 * the next DiscoveryData. That makes the whole flow testable without rendering
 * anything, which is the point — the conversation is the part of the funnel
 * that must not regress.
 *
 * The `DiscoveryData` shape is deliberately untouched. The conversation is a
 * new front end over exactly the same fields the form wrote, so everything
 * downstream of it (the preview, the claim, the generator) is unaffected.
 */
import {
  type CatalogSize,
  type CommerceMode,
  type DiscoveryData,
  type PageCount,
  type Step,
  type SubscriptionTier,
  type Tier,
  type TimelineId,
  GOAL_PRESETS,
  TONE_PRESETS,
  usesDedicatedSubscription,
} from './discovery.logic';

/** The last wizard step the scripted conversation covers. 7 is the info agent. */
export const CONVERSATION_LAST_STEP: Step = 6;

export type IntakeQuestionId =
  | 'fullName'
  | 'email'
  | 'businessName'
  | 'description'
  | 'industry'
  | 'targetAudience'
  | 'links'
  | 'goal'
  | 'brandTone'
  | 'pageCount'
  | 'timeline'
  | 'commerceMode'
  | 'catalogSize'
  | 'calComUrl'
  | 'customIntegrations'
  | 'selectedTier'
  | 'subscription';

/**
 * How the visitor answers.
 *
 *   text/longtext — typed, free-form.
 *   choice        — quick-reply chips; tapping one sends it as a message.
 *   multi         — several chips at once, plus their own words.
 *   panel         — the two commercial decisions (build package, monthly
 *                   plan). They keep their existing cards, shown inside the
 *                   conversation as the agent's own message, because a price
 *                   comparison is not something a chat bubble does well.
 */
export type IntakeQuestionKind =
  | 'text'
  | 'longtext'
  | 'choice'
  | 'multi'
  | 'panel';

export interface IntakeOption {
  value: string;
  /** English label, used when the key is absent and for typed-answer matching. */
  label: string;
  /** Preferred: a key in the locale catalogue. */
  labelKey?: string;
}

export interface IntakeQuestion {
  id: IntakeQuestionId;
  /** The wizard step this answer belongs to, so `canProceed` stays the gate. */
  step: Step;
  kind: IntakeQuestionKind;
  /** Locale key for the agent's line. May contain {name} / {business}. */
  promptKey: string;
  placeholderKey?: string;
  /** Required questions cannot be skipped — these are exactly `canProceed`'s. */
  required: boolean;
  options?: readonly IntakeOption[];
  /** A choice question that also accepts words the chips do not cover. */
  freeText?: boolean;
  /** Asked only when this holds. Absent means always. */
  when?: (data: DiscoveryData) => boolean;
  /** null when the answer is acceptable, else a locale key for the correction. */
  validate?: (raw: string) => string | null;
  /** The answer, folded into the wizard's data. Pure. */
  apply: (data: DiscoveryData, raw: string) => DiscoveryData;
  /** What is stored right now — prefills an edit, and draws the visitor's bubble. */
  value: (data: DiscoveryData) => string;
  /** Overrides the visitor's bubble text when the stored value is not the label. */
  describe?: (data: DiscoveryData, t: (key: string) => string) => string;
}

// ---------------------------------------------------------------------------
// Validators and parsers — every one of them deterministic
// ---------------------------------------------------------------------------

/** Same expression the wizard's `canProceed` uses for step 1. */
const EMAIL_RE = /^\S+@\S+\.\S+$/;

const INSTAGRAM_RE = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/[^\s,]+/i;
const LINKEDIN_RE = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[^\s,]+/i;

const ERROR_KEY = 'landing.discovery.chat.errors.';

function trimmed(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** A pasted profile link, normalised so the stored value is always absolute. */
function absoluteUrl(match: string | undefined): string {
  if (!match) return '';
  const url = match.trim().replace(/[.,)]+$/, '');
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Matches typed words against a question's chips. Case- and space-insensitive
 * against both the stored value and the English label, so "not sure", "Not
 * Sure" and the chip itself all land on the same option.
 */
export function matchOption(
  options: readonly IntakeOption[] | undefined,
  raw: string
): string | null {
  if (!options) return null;
  const needle = trimmed(raw).toLowerCase();
  if (!needle) return null;
  const hit = options.find(
    (option) =>
      option.value.toLowerCase() === needle ||
      option.label.toLowerCase() === needle
  );
  return hit ? hit.value : null;
}

/** A chip's visible text: the catalogue's word when it has one. */
export function optionLabel(
  option: IntakeOption,
  t: (key: string) => string
): string {
  return option.labelKey ? t(option.labelKey) : option.label;
}

function choiceValidator(options: readonly IntakeOption[]) {
  return (raw: string): string | null =>
    matchOption(options, raw) ? null : `${ERROR_KEY}choice`;
}

function choiceApplier<K extends keyof DiscoveryData>(
  key: K,
  options: readonly IntakeOption[]
) {
  return (data: DiscoveryData, raw: string): DiscoveryData => {
    const value = matchOption(options, raw);
    if (value === null) return data;
    const next: DiscoveryData = { ...data };
    next[key] = value as DiscoveryData[K];
    return next;
  };
}

function textApplier<K extends keyof DiscoveryData>(key: K) {
  return (data: DiscoveryData, raw: string): DiscoveryData => {
    const next: DiscoveryData = { ...data };
    next[key] = trimmed(raw) as DiscoveryData[K];
    return next;
  };
}

// ---------------------------------------------------------------------------
// Option sets
// ---------------------------------------------------------------------------

/** The industries the old select offered, verbatim. Free text still wins. */
const INDUSTRY_OPTIONS: readonly IntakeOption[] = [
  'Coaching',
  'Consulting',
  'Therapy & wellness',
  'Photography',
  'Creative & design',
  'Fashion & style',
  'Fitness & training',
  'Beauty & salon',
  'Hospitality & food',
  'Retail & products',
  'Online store / ecommerce',
  'Professional services',
].map((label) => ({ value: label, label }));

const PAGE_OPTIONS: ReadonlyArray<IntakeOption & { value: PageCount }> = [
  {
    value: 'lt-5',
    label: 'Under 5',
    labelKey: 'landing.discovery.options.pages.lt-5.label',
  },
  {
    value: '5-7',
    label: '5 – 7',
    labelKey: 'landing.discovery.options.pages.5-7.label',
  },
  {
    value: '8-15',
    label: '8 – 15',
    labelKey: 'landing.discovery.options.pages.8-15.label',
  },
  {
    value: '15+',
    label: '15+',
    labelKey: 'landing.discovery.options.pages.15+.label',
  },
  {
    value: 'unsure',
    label: 'Not sure',
    labelKey: 'landing.discovery.options.pages.unsure.label',
  },
];

const TIMELINE_OPTIONS: ReadonlyArray<IntakeOption & { value: TimelineId }> = [
  {
    value: 'asap',
    label: 'ASAP',
    labelKey: 'landing.discovery.options.timeline.asap',
  },
  {
    value: '4-weeks',
    label: 'Within 4 weeks',
    labelKey: 'landing.discovery.options.timeline.4-weeks',
  },
  {
    value: '1-3-months',
    label: '1 – 3 months',
    labelKey: 'landing.discovery.options.timeline.1-3-months',
  },
  {
    value: 'flexible',
    label: 'Flexible',
    labelKey: 'landing.discovery.options.timeline.flexible',
  },
];

const COMMERCE_OPTIONS: ReadonlyArray<IntakeOption & { value: CommerceMode }> =
  [
    {
      value: 'none',
      label: 'No products',
      labelKey: 'landing.discovery.options.commerce.none.label',
    },
    {
      value: 'few-services',
      label: 'A few paid offers',
      labelKey: 'landing.discovery.options.commerce.few-services.label',
    },
    {
      value: 'digital',
      label: 'Digital products',
      labelKey: 'landing.discovery.options.commerce.digital.label',
    },
    {
      value: 'physical',
      label: 'Physical products',
      labelKey: 'landing.discovery.options.commerce.physical.label',
    },
    {
      value: 'mixed',
      label: 'Mix of both',
      labelKey: 'landing.discovery.options.commerce.mixed.label',
    },
  ];

const CATALOG_OPTIONS: ReadonlyArray<IntakeOption & { value: CatalogSize }> = [
  {
    value: '1-5',
    label: '1 – 5',
    labelKey: 'landing.discovery.options.catalog.1-5',
  },
  {
    value: '6-25',
    label: '6 – 25',
    labelKey: 'landing.discovery.options.catalog.6-25',
  },
  {
    value: '26-100',
    label: '26 – 100',
    labelKey: 'landing.discovery.options.catalog.26-100',
  },
  {
    value: '100+',
    label: '100+',
    labelKey: 'landing.discovery.options.catalog.100+',
  },
  {
    value: 'unsure',
    label: 'Not sure',
    labelKey: 'landing.discovery.options.catalog.unsure',
  },
];

const TIER_OPTIONS: ReadonlyArray<IntakeOption & { value: Tier }> = [
  {
    value: 'starter',
    label: 'Starter',
    labelKey: 'landing.discovery.tiers.starter.name',
  },
  { value: 'pro', label: 'Pro', labelKey: 'landing.discovery.tiers.pro.name' },
  {
    value: 'commerce',
    label: 'Commerce',
    labelKey: 'landing.discovery.tiers.commerce.name',
  },
  {
    value: 'custom',
    label: 'Custom',
    labelKey: 'landing.discovery.tiers.custom.name',
  },
];

const PLAN_OPTIONS: ReadonlyArray<IntakeOption & { value: SubscriptionTier }> =
  [
    {
      value: 'starter',
      label: 'Starter',
      labelKey: 'landing.discovery.subscription.tiers.starter',
    },
    {
      value: 'pro',
      label: 'Pro',
      labelKey: 'landing.discovery.subscription.tiers.pro',
    },
    {
      value: 'max',
      label: 'Max',
      labelKey: 'landing.discovery.subscription.tiers.max',
    },
  ];

const GOAL_OPTIONS: readonly IntakeOption[] = GOAL_PRESETS.map((label) => ({
  value: label,
  label,
}));

const TONE_OPTIONS: readonly IntakeOption[] = TONE_PRESETS.map((label) => ({
  value: label,
  label,
}));

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

const Q = 'landing.discovery.chat.q.';

/**
 * The questions, in the order the agent asks them.
 *
 * `required` here is exactly `canProceed`'s definition of a passable step, so
 * the conversation can never walk past a step the wizard would have blocked,
 * and can never block on something the form would have let through.
 */
export const INTAKE_SCRIPT: readonly IntakeQuestion[] = [
  {
    id: 'fullName',
    step: 1,
    kind: 'text',
    promptKey: `${Q}fullName.prompt`,
    placeholderKey: 'landing.discovery.placeholders.fullName',
    required: true,
    validate: (raw) =>
      trimmed(raw).length >= 2 ? null : `${ERROR_KEY}fullName`,
    apply: textApplier('fullName'),
    value: (data) => data.fullName,
  },
  {
    id: 'email',
    step: 1,
    kind: 'text',
    promptKey: `${Q}email.prompt`,
    placeholderKey: 'landing.discovery.placeholders.email',
    required: true,
    validate: (raw) =>
      EMAIL_RE.test(trimmed(raw)) ? null : `${ERROR_KEY}email`,
    apply: textApplier('email'),
    value: (data) => data.email,
  },
  {
    id: 'businessName',
    step: 1,
    kind: 'text',
    promptKey: `${Q}businessName.prompt`,
    placeholderKey: 'landing.discovery.placeholders.businessName',
    required: false,
    apply: textApplier('businessName'),
    value: (data) => data.businessName,
  },
  {
    id: 'description',
    step: 2,
    kind: 'longtext',
    promptKey: `${Q}description.prompt`,
    placeholderKey: 'landing.discovery.placeholders.description',
    required: true,
    validate: (raw) =>
      trimmed(raw).length >= 10 ? null : `${ERROR_KEY}description`,
    apply: textApplier('description'),
    value: (data) => data.description,
  },
  {
    id: 'industry',
    step: 2,
    kind: 'choice',
    promptKey: `${Q}industry.prompt`,
    placeholderKey: 'landing.discovery.placeholders.industryOther',
    required: false,
    options: INDUSTRY_OPTIONS,
    // Anything they type is their industry — the chips are a shortcut, not a
    // closed list, and a business that does not fit one is not an error.
    freeText: true,
    apply: (data, raw) => ({
      ...data,
      industry: matchOption(INDUSTRY_OPTIONS, raw) ?? trimmed(raw),
    }),
    value: (data) => data.industry,
  },
  {
    id: 'targetAudience',
    step: 2,
    kind: 'longtext',
    promptKey: `${Q}targetAudience.prompt`,
    placeholderKey: 'landing.discovery.placeholders.targetAudience',
    required: false,
    apply: textApplier('targetAudience'),
    value: (data) => data.targetAudience,
  },
  {
    id: 'links',
    step: 2,
    kind: 'text',
    promptKey: `${Q}links.prompt`,
    placeholderKey: `${Q}links.placeholder`,
    required: false,
    // One question, two fields: asking for "your Instagram" and then "your
    // LinkedIn" as separate turns is how a form sounds.
    apply: (data, raw) => ({
      ...data,
      instagramUrl: absoluteUrl(INSTAGRAM_RE.exec(raw)?.[0]),
      linkedinUrl: absoluteUrl(LINKEDIN_RE.exec(raw)?.[0]),
    }),
    value: (data) =>
      [data.instagramUrl, data.linkedinUrl].filter(Boolean).join(' · '),
  },
  {
    id: 'goal',
    step: 3,
    kind: 'multi',
    promptKey: `${Q}goal.prompt`,
    placeholderKey: `${Q}goal.placeholder`,
    required: true,
    options: GOAL_OPTIONS,
    validate: (raw) => (trimmed(raw) ? null : `${ERROR_KEY}goal`),
    apply: textApplier('goal'),
    value: (data) => data.goal,
  },
  {
    id: 'brandTone',
    step: 3,
    kind: 'multi',
    promptKey: `${Q}brandTone.prompt`,
    placeholderKey: `${Q}brandTone.placeholder`,
    required: false,
    options: TONE_OPTIONS,
    apply: textApplier('brandTone'),
    value: (data) => data.brandTone,
  },
  {
    id: 'pageCount',
    step: 3,
    kind: 'choice',
    promptKey: `${Q}pageCount.prompt`,
    required: false,
    options: PAGE_OPTIONS,
    validate: choiceValidator(PAGE_OPTIONS),
    apply: choiceApplier('pageCount', PAGE_OPTIONS),
    value: (data) => data.pageCount,
  },
  {
    id: 'timeline',
    step: 3,
    kind: 'choice',
    promptKey: `${Q}timeline.prompt`,
    required: false,
    options: TIMELINE_OPTIONS,
    validate: choiceValidator(TIMELINE_OPTIONS),
    apply: choiceApplier('timeline', TIMELINE_OPTIONS),
    value: (data) => data.timeline,
  },
  {
    id: 'commerceMode',
    step: 4,
    kind: 'choice',
    promptKey: `${Q}commerceMode.prompt`,
    required: true,
    options: COMMERCE_OPTIONS,
    validate: choiceValidator(COMMERCE_OPTIONS),
    // Mirrors the old CommerceStep: picking "nothing to sell" clears a catalog
    // size the visitor may have given before changing their mind.
    apply: (data, raw) => {
      const mode = matchOption(COMMERCE_OPTIONS, raw) as CommerceMode | null;
      if (mode === null) return data;
      const sells =
        mode === 'digital' || mode === 'physical' || mode === 'mixed';
      return {
        ...data,
        commerceMode: mode,
        catalogSize: sells
          ? data.catalogSize === 'na'
            ? '1-5'
            : data.catalogSize
          : 'na',
      };
    },
    value: (data) => data.commerceMode,
  },
  {
    id: 'catalogSize',
    step: 4,
    kind: 'choice',
    promptKey: `${Q}catalogSize.prompt`,
    required: false,
    options: CATALOG_OPTIONS,
    when: (data) =>
      data.commerceMode === 'digital' ||
      data.commerceMode === 'physical' ||
      data.commerceMode === 'mixed',
    validate: choiceValidator(CATALOG_OPTIONS),
    apply: choiceApplier('catalogSize', CATALOG_OPTIONS),
    value: (data) => (data.catalogSize === 'na' ? '' : data.catalogSize),
  },
  {
    id: 'calComUrl',
    step: 4,
    kind: 'text',
    promptKey: `${Q}calComUrl.prompt`,
    placeholderKey: 'landing.discovery.placeholders.calComUrl',
    required: false,
    apply: textApplier('calComUrl'),
    value: (data) => data.calComUrl,
  },
  {
    id: 'customIntegrations',
    step: 4,
    kind: 'longtext',
    promptKey: `${Q}customIntegrations.prompt`,
    placeholderKey: 'landing.discovery.placeholders.customIntegrations',
    required: false,
    apply: textApplier('customIntegrations'),
    value: (data) => data.customIntegrations,
  },
  {
    id: 'selectedTier',
    step: 5,
    kind: 'panel',
    promptKey: `${Q}selectedTier.prompt`,
    required: true,
    options: TIER_OPTIONS,
    // The panel's own cards have normally written `selectedTier` long before
    // this runs and confirming just files the question away. Applying the
    // value anyway keeps the script self-contained: the same rules produce
    // the same DiscoveryData whether the answer came from a card or a chip.
    apply: choiceApplier('selectedTier', TIER_OPTIONS),
    value: (data) => data.selectedTier,
  },
  {
    id: 'subscription',
    step: 6,
    kind: 'panel',
    promptKey: `${Q}subscription.prompt`,
    required: true,
    options: PLAN_OPTIONS,
    // A Commerce build confirms with 'commerce', which is not one of the three
    // plans — `choiceApplier` leaves the field alone, which is right: that
    // build has a dedicated store plan and nothing to pick.
    apply: choiceApplier('subscription', PLAN_OPTIONS),
    value: (data) =>
      usesDedicatedSubscription(data.selectedTier)
        ? 'commerce'
        : data.subscription,
    // A Commerce build has no plan to pick — it has the store plan. Saying so
    // in the visitor's own bubble is more honest than showing a blank.
    describe: (data, t) =>
      usesDedicatedSubscription(data.selectedTier)
        ? t('landing.discovery.subscription.storeName')
        : '',
  },
];

// ---------------------------------------------------------------------------
// Reading the script
// ---------------------------------------------------------------------------

export function questionById(id: string): IntakeQuestion | undefined {
  return INTAKE_SCRIPT.find((question) => question.id === id);
}

/** The questions this visitor is actually asked, given what they have said. */
export function applicableQuestions(data: DiscoveryData): IntakeQuestion[] {
  return INTAKE_SCRIPT.filter((question) => question.when?.(data) ?? true);
}

/**
 * The question on screen: the first applicable one not yet answered.
 *
 * `null` means the scripted conversation is over — and *that* is what ends the
 * intake. No model is asked whether there is more to talk about, and there is
 * no way to reach that `null` without every applicable `required` question
 * (the two commercial panels included) having a stored answer: the preview
 * only ever starts once the script itself is spent.
 */
export function nextQuestion(
  data: DiscoveryData,
  answered: readonly string[]
): IntakeQuestion | null {
  const pool = applicableQuestions(data);
  return pool.find((question) => !answered.includes(question.id)) ?? null;
}

/**
 * The transcript's spine: the questions already dealt with, in the order the
 * visitor dealt with them. Filtered by `when`, so a question that stopped
 * applying (a catalog size, after they said they sell nothing) quietly leaves
 * the conversation instead of lingering as a wrong answer.
 */
export function answeredQuestions(
  data: DiscoveryData,
  answered: readonly string[]
): IntakeQuestion[] {
  const applicable = applicableQuestions(data);
  return answered
    .map((id) => applicable.find((question) => question.id === id))
    .filter((question): question is IntakeQuestion => question !== undefined);
}

/**
 * How far along the conversation is. Both numbers move as `when` changes: a
 * catalog-size question that stopped applying (the visitor said they sell
 * nothing) drops out of the total the moment it does.
 */
export function conversationProgress(
  data: DiscoveryData,
  answered: readonly string[]
): { done: number; total: number } {
  const pool = applicableQuestions(data);
  return {
    done: pool.filter((question) => answered.includes(question.id)).length,
    total: pool.length,
  };
}

/**
 * The wizard step the conversation is currently on. When the script is spent
 * this is `finishedStep`, which is how the wizard learns to move on.
 */
export function stepForConversation(
  data: DiscoveryData,
  answered: readonly string[],
  finishedStep: Step
): Step {
  return nextQuestion(data, answered)?.step ?? finishedStep;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * Fills {tokens} in a catalogue string. Deliberately tiny and deliberately
 * not a model: an agent that says the visitor's name back to them is worth a
 * regex, not a completion.
 */
export function interpolate(
  template: string,
  values: Record<string, string | number>
): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole
  );
}

/** The agent's line for a question, with the visitor's own words folded in. */
export function promptText(
  question: IntakeQuestion,
  data: DiscoveryData,
  t: (key: string) => string
): string {
  const firstName = data.fullName.trim().split(/\s+/)[0] ?? '';
  return interpolate(t(question.promptKey), {
    name: firstName || t('landing.discovery.chat.tokens.you'),
    business:
      data.businessName.trim() || t('landing.discovery.chat.tokens.business'),
  });
}

/**
 * The visitor's own bubble. Empty means they skipped — the caller draws that
 * as "skipped", not as a silent gap.
 */
export function answerText(
  question: IntakeQuestion,
  data: DiscoveryData,
  t: (key: string) => string
): string {
  const described = question.describe?.(data, t);
  if (described) return described;
  const raw = question.value(data);
  if (!raw) return '';
  const option = question.options?.find((entry) => entry.value === raw);
  return option ? optionLabel(option, t) : raw;
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/**
 * What the agent says back before it asks the next thing.
 *
 * A questionnaire moves straight from one field to the next. A conversation
 * acknowledges what was just said, and the acknowledgement is specific: it
 * picks up the answer, or the consequence of the answer, and only then moves
 * on. Every reaction here is a rule, not a completion: the phrasing lives in
 * the locale catalogue, the choice of phrasing is decided by the stored
 * value, and the visitor's own words are folded in with `interpolate`.
 *
 * Resolution order, all in the catalogue:
 *
 *   skipped answer   → `…q.<id>.reflect.skipped`, else a rotating generic
 *   chip with a value → `…q.<id>.reflect.<value>`, else `…q.<id>.reflect`
 *   anything else    → `…q.<id>.reflect`
 *
 * A question with no catalogue entry at all reacts with nothing, which is a
 * legitimate choice: the next question can be the reaction (the way "good to
 * meet you, Maria" is), and an agent that says "got it" seventeen times in a
 * row is a form with extra steps.
 */
export function reflectionText(
  question: IntakeQuestion,
  data: DiscoveryData,
  t: (key: string) => string
): string {
  const lookup = (key: string): string | null => {
    const text = t(key);
    return text === key ? null : text;
  };
  const base = `${Q}${question.id}.reflect`;
  const raw = question.value(data);
  const said = answerText(question, data, t);

  if (!raw && !said) {
    const index = INTAKE_SCRIPT.findIndex((entry) => entry.id === question.id);
    return (
      lookup(`${base}.skipped`) ??
      lookup(
        `landing.discovery.chat.reflect.skipped.${
          Math.max(index, 0) % SKIPPED_REFLECTION_VARIANTS
        }`
      ) ??
      ''
    );
  }

  const option = question.options?.find((entry) => entry.value === raw);
  const template =
    (option ? lookup(`${base}.${option.value}`) : null) ?? lookup(base);
  if (!template) return '';

  const firstName = data.fullName.trim().split(/\s+/)[0] ?? '';
  return interpolate(template, {
    name: firstName || t('landing.discovery.chat.tokens.you'),
    business:
      data.businessName.trim() || t('landing.discovery.chat.tokens.business'),
    answer: said,
    quote: firstSentence(raw),
    list: humanList(said, t),
  });
}

/** How many generic "skipped" lines the catalogue rotates through. */
export const SKIPPED_REFLECTION_VARIANTS = 3;

/** Longest quote the agent reads back, so a pasted essay stays a sentence. */
const MAX_QUOTE_CHARS = 110;

/**
 * The first sentence of a prose answer, cut to a length that still reads as
 * a quote. Reading their own line back is the most specific reaction there is
 * and needs no model to produce.
 */
export function firstSentence(text: string): string {
  const flat = trimmed(text);
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  const clean = sentence.replace(/[.!?]+$/, '');
  if (clean.length <= MAX_QUOTE_CHARS) return clean;
  const cut = clean.slice(0, MAX_QUOTE_CHARS);
  const atWord = cut.lastIndexOf(' ');
  return `${atWord > 40 ? cut.slice(0, atWord) : cut}…`;
}

/**
 * "A, B and C" from a comma-joined multi answer, lower-cased so it sits
 * inside a sentence. Single items pass through untouched.
 */
export function humanList(joined: string, t: (key: string) => string): string {
  const items = joined
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.charAt(0).toLowerCase() + item.slice(1));
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  const and = t('landing.discovery.chat.tokens.and');
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`;
}

/** The keyboard shortcut for a quick reply: A, B, C… in the order shown. */
export function shortcutLetter(index: number): string {
  return String.fromCharCode(65 + (index % 26));
}
