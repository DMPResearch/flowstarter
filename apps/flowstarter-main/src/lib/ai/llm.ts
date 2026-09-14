import 'server-only';

/**
 * The single LLM seam for the whole app.
 *
 * Every model call — text, structured object, or stream — goes through here so
 * that exactly one place owns:
 *
 *   1. a per-action token budget (enforced before AND after the call),
 *   2. a usage ledger row in `llm_usage` keyed by workspace + action,
 *   3. prompt caching on the static system prefix,
 *   4. a cost estimate from a small per-model price table.
 *
 * Nothing else in `src/` may import `generateText` / `generateObject` /
 * `streamText` from `ai`, or build its own OpenRouter provider. A vitest guard
 * (`__tests__/no-unbudgeted-llm-calls.test.ts`) fails the build if that rule is
 * broken, so "there is no unbudgeted call path" is a checked property, not a
 * convention.
 *
 * The ledger write is fire-and-forget-with-logging: accounting must never fail
 * a user's request.
 */

import {
  generateObject,
  generateText,
  streamText,
  type LanguageModel,
  type ModelMessage,
} from 'ai';

import { getModel } from './client';
import { recordGenerationCost, type GenerationKind } from './funnel-cost';

// ---------------------------------------------------------------------------
// Actions + budgets (ONE config object)
// ---------------------------------------------------------------------------

export const LLM_ACTIONS = [
  'recommend_tier',
  'classify_project',
  'classify_client_request',
  /** Standard site or custom work, before any generation budget is spent. */
  'classify_scope',
  'extract_brief',
  'moderate',
  'site_copy',
  'preview_edit',
  'support_chat',
  /** The Pi coding-agent preview pipeline (usage arrives via a sink). */
  'preview_generate',
  'intake_interview',
  /** Natural-language intake graph (LangGraph HITL phrasing + extract). */
  'intake_graph',
  'business_naming',
  /**
   * The acceptable-use gate's classifier tier (`src/lib/policy/`). One small,
   * cheap, temperature-zero call per submission, on a tight budget: it reads a
   * capped window and answers with four fields, so a generous ceiling here
   * would only ever hide a bug.
   */
  'acceptable_use',
] as const;

export type LlmAction = (typeof LLM_ACTIONS)[number];

export interface LlmActionConfig {
  /**
   * Hard ceiling on `tokens_in + tokens_out` for ONE call of this action.
   * Exceeding it (or a provider-reported truncation) throws
   * {@link LlmBudgetExceededError} *after* the usage row is recorded.
   */
  maxTokens: number;
  /**
   * Completion cap sent to the provider before the call. This is the cheap
   * half of the enforcement: it stops runaway output rather than detecting it.
   */
  maxOutputTokens?: number;
  /** OpenRouter model id this action runs on unless the caller overrides it. */
  model: string;
}

/** Budget used for any action not listed (and the floor for env overrides). */
export const LLM_DEFAULT_BUDGET_TOKENS = 8_000;

const SONNET = 'anthropic/claude-sonnet-4';

/**
 * Per-action budgets, output caps and model routing.
 *
 * Ops can override any field without a deploy:
 *   LLM_BUDGET_<ACTION>       total-token budget, e.g. LLM_BUDGET_SITE_COPY=20000
 *   LLM_MAX_OUTPUT_<ACTION>   completion cap,     e.g. LLM_MAX_OUTPUT_SITE_COPY=3000
 *   LLM_MODEL_<ACTION>        model id,           e.g. LLM_MODEL_MODERATE=openai/gpt-4o-mini
 *   LLM_BUDGET_DEFAULT        fallback total-token budget for every action
 */
export const LLM_BUDGETS: Record<LlmAction, LlmActionConfig> = {
  recommend_tier: {
    maxTokens: 4_000,
    maxOutputTokens: 120,
    model: 'meta-llama/llama-3.1-70b-instruct',
  },
  classify_project: { maxTokens: 4_000, maxOutputTokens: 150, model: SONNET },
  classify_client_request: {
    maxTokens: 6_000,
    maxOutputTokens: 600,
    model: SONNET,
  },
  // Three fields out of a few hundred words in. The output cap is the real
  // bound here: an answer longer than this is not a classification, it is the
  // model explaining itself into a JSON parse failure.
  classify_scope: { maxTokens: 6_000, maxOutputTokens: 250, model: SONNET },
  extract_brief: { maxTokens: 8_000, maxOutputTokens: 700, model: SONNET },
  moderate: { maxTokens: 4_000, maxOutputTokens: 800, model: 'openai/gpt-4o' },
  site_copy: { maxTokens: 12_000, maxOutputTokens: 2_000, model: SONNET },
  preview_edit: { maxTokens: 30_000, maxOutputTokens: 8_000, model: SONNET },
  support_chat: { maxTokens: 6_000, maxOutputTokens: 220, model: SONNET },
  // The Pi coding agent runs many turns inside one preview; the cap is a
  // whole-run total enforced inside `@flowstarter/agentic-codegen`.
  // Uncached tokens for the whole Pi run (cache reads excluded); a real
  // preview needs ~300-400k uncached, so 1M leaves headroom for repairs.
  preview_generate: { maxTokens: 1_000_000, model: 'z-ai/glm-5.2' },
  intake_interview: { maxTokens: 8_000, maxOutputTokens: 800, model: SONNET },
  intake_graph: { maxTokens: 10_000, maxOutputTokens: 1_200, model: SONNET },
  business_naming: { maxTokens: 6_000, maxOutputTokens: 600, model: SONNET },
  // A small fast model on purpose. This call sits in front of the live
  // preview, the checkout and the brief save, so its latency is a visitor
  // waiting; and it runs on every submission, so its price is a per-visitor
  // cost rather than a per-build one.
  acceptable_use: {
    maxTokens: 6_000,
    maxOutputTokens: 300,
    model: 'openai/gpt-4o-mini',
  },
};

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Effective config for an action, after env overrides. */
export function llmActionConfig(action: LlmAction): LlmActionConfig {
  const base = LLM_BUDGETS[action] ?? {
    maxTokens: LLM_DEFAULT_BUDGET_TOKENS,
    model: SONNET,
  };
  const key = action.toUpperCase();
  return {
    maxTokens:
      envNumber(`LLM_BUDGET_${key}`) ??
      envNumber('LLM_BUDGET_DEFAULT') ??
      base.maxTokens,
    maxOutputTokens: envNumber(`LLM_MAX_OUTPUT_${key}`) ?? base.maxOutputTokens,
    model: process.env[`LLM_MODEL_${key}`]?.trim() || base.model,
  };
}

// ---------------------------------------------------------------------------
// Price table (USD per 1M tokens). Unknown model → null cost, never 0.
// ---------------------------------------------------------------------------

interface ModelPrice {
  in: number;
  out: number;
  /** Price of a cache *read*, when the provider discounts it. */
  cachedIn?: number;
}

const MODEL_PRICES: Record<string, ModelPrice> = {
  'anthropic/claude-sonnet-4': { in: 3, out: 15, cachedIn: 0.3 },
  'anthropic/claude-3.7-sonnet': { in: 3, out: 15, cachedIn: 0.3 },
  'anthropic/claude-3.5-haiku': { in: 0.8, out: 4, cachedIn: 0.08 },
  'openai/gpt-4o': { in: 2.5, out: 10, cachedIn: 1.25 },
  'openai/gpt-4o-mini': { in: 0.15, out: 0.6, cachedIn: 0.075 },
  'meta-llama/llama-3.1-70b-instruct': { in: 0.3, out: 0.4 },
  'deepseek/deepseek-r1': { in: 0.5, out: 2.15 },
};

/**
 * USD estimate for one call, or `null` when the model is not in the table.
 * Null is deliberate: a fabricated 0 would read as "this call was free".
 */
export function estimateCostUsd(
  model: string | null | undefined,
  usage: Pick<LlmUsage, 'tokensIn' | 'tokensOut' | 'cachedTokens'>
): number | null {
  if (!model) return null;
  const price = MODEL_PRICES[model];
  if (!price) return null;
  const cached = Math.min(usage.cachedTokens, usage.tokensIn);
  const fresh = usage.tokensIn - cached;
  const cachedRate = price.cachedIn ?? price.in;
  return (
    (fresh / 1_000_000) * price.in +
    (cached / 1_000_000) * cachedRate +
    (usage.tokensOut / 1_000_000) * price.out
  );
}

// ---------------------------------------------------------------------------
// Errors + usage shape
// ---------------------------------------------------------------------------

export type LlmBudgetExceededReason =
  | 'total_tokens'
  | 'truncated'
  | 'workspace_daily_cap';

export class LlmBudgetExceededError extends Error {
  readonly name = 'LlmBudgetExceededError';
  constructor(
    readonly action: LlmAction,
    readonly reason: LlmBudgetExceededReason,
    readonly budgetTokens: number,
    readonly usedTokens: number
  ) {
    super(
      `LLM budget exceeded for action "${action}" (${reason}): used ${usedTokens} of ${budgetTokens} tokens`
    );
  }
}

export interface LlmUsage {
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  totalTokens: number;
}

const ZERO_USAGE: LlmUsage = {
  tokensIn: 0,
  tokensOut: 0,
  cachedTokens: 0,
  totalTokens: 0,
};

/** Shape the AI SDK (v5 and legacy) may hand back. */
interface RawUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedInputTokens?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

export function normalizeLlmUsage(raw: unknown): LlmUsage {
  if (!raw || typeof raw !== 'object') return { ...ZERO_USAGE };
  const u = raw as RawUsage;
  const tokensIn = num(u.inputTokens) || num(u.promptTokens);
  const tokensOut = num(u.outputTokens) || num(u.completionTokens);
  const cachedTokens = Math.min(num(u.cachedInputTokens), tokensIn);
  return {
    tokensIn,
    tokensOut,
    cachedTokens,
    totalTokens: num(u.totalTokens) || tokensIn + tokensOut,
  };
}

// ---------------------------------------------------------------------------
// The `llm_usage` ledger
// ---------------------------------------------------------------------------

export interface LlmUsageRecord {
  workspaceId?: string | null;
  projectId?: string | null;
  action: LlmAction | string;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  costEstimate?: number | null;
}

/**
 * The `llm_usage` table is owned by the Phase 0 migration and may not be in
 * `database.types.ts` yet, so the client is narrowed structurally rather than
 * through the generated `Database` type.
 */
interface UsageTableClient {
  from(table: string): {
    insert(values: Record<string, unknown>): PromiseLike<{ error: unknown }>;
    select(columns: string): {
      eq(
        column: string,
        value: string
      ): {
        gte(
          column: string,
          value: string
        ): PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
}

async function usageClient(): Promise<UsageTableClient | null> {
  try {
    const { createSupabaseServiceRoleClient } = await import(
      '@/supabase-clients/server'
    );
    return createSupabaseServiceRoleClient() as unknown as UsageTableClient;
  } catch (error) {
    console.warn('[llm] usage client unavailable', error);
    return null;
  }
}

/**
 * Write one ledger row. Never throws and never rejects — a failed accounting
 * insert must not fail the user's request. Prompt contents are never logged.
 */
export async function recordLlmUsage(record: LlmUsageRecord): Promise<void> {
  try {
    const sb = await usageClient();
    if (!sb) return;
    const costEstimate =
      record.costEstimate === undefined
        ? estimateCostUsd(record.model, {
            tokensIn: record.tokensIn,
            tokensOut: record.tokensOut,
            cachedTokens: record.cachedTokens,
          })
        : record.costEstimate;
    const { error } = await sb.from('llm_usage').insert({
      workspace_id: record.workspaceId ?? null,
      project_id: record.projectId ?? null,
      action: record.action,
      model: record.model,
      tokens_in: record.tokensIn,
      tokens_out: record.tokensOut,
      cached_tokens: record.cachedTokens,
      cost_estimate: costEstimate,
    });
    if (error) console.warn('[llm] usage insert failed', error);
  } catch (error) {
    console.warn('[llm] usage insert threw', error);
  }
}

/**
 * Optional rolling per-workspace cap.
 *
 * OFF by default. Set `LLM_WORKSPACE_DAILY_TOKEN_CAP` to a positive integer to
 * refuse further calls once a workspace has burned that many tokens in the
 * trailing 24h. Fail-safe: any accounting failure allows the call.
 */
async function workspaceCapExceeded(
  workspaceId: string | null | undefined
): Promise<{ exceeded: boolean; used: number; cap: number }> {
  const cap = envNumber('LLM_WORKSPACE_DAILY_TOKEN_CAP');
  if (!cap || !workspaceId) return { exceeded: false, used: 0, cap: 0 };
  try {
    const sb = await usageClient();
    if (!sb) return { exceeded: false, used: 0, cap };
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await sb
      .from('llm_usage')
      .select('tokens_in,tokens_out')
      .eq('workspace_id', workspaceId)
      .gte('created_at', since);
    if (error || !Array.isArray(data)) return { exceeded: false, used: 0, cap };
    const used = (
      data as Array<{ tokens_in?: number; tokens_out?: number }>
    ).reduce((sum, row) => sum + num(row.tokens_in) + num(row.tokens_out), 0);
    return { exceeded: used > cap, used, cap };
  } catch {
    return { exceeded: false, used: 0, cap };
  }
}

// ---------------------------------------------------------------------------
// Prompt caching
// ---------------------------------------------------------------------------

/**
 * `@openrouter/ai-sdk-provider` reads `providerOptions.openrouter.cacheControl`
 * (or `.cache_control`, or the `anthropic` equivalent) off each message and
 * emits `cache_control` on the outgoing OpenRouter message — verified in
 * `convert-to-openrouter-chat-messages` in the installed provider build.
 *
 * Only providers that honour explicit breakpoints benefit. Anthropic models do.
 * OpenAI and DeepSeek cache automatically with no marker, and Llama via
 * OpenRouter has no prompt cache at all, so we do not pretend otherwise: the
 * marker is only attached for models that actually use it.
 */
const CACHE_CONTROL_PREFIXES = ['anthropic/'];

function supportsExplicitCaching(modelId: string | null): boolean {
  if (!modelId) return false;
  return CACHE_CONTROL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

const CACHE_PROVIDER_OPTIONS = {
  openrouter: { cacheControl: { type: 'ephemeral' } },
} as const;

/**
 * Mark the static system prefix as cacheable. Anthropic only caches prefixes
 * above its own minimum length; short system prompts are silently ignored by
 * the provider rather than erroring, so no length gate is needed here.
 */
function withCachedSystemPrefix(
  messages: ModelMessage[],
  modelId: string | null
): ModelMessage[] {
  if (!supportsExplicitCaching(modelId)) return messages;
  let marked = false;
  return messages.map((message) => {
    if (marked || message.role !== 'system') return message;
    marked = true;
    return {
      ...message,
      providerOptions: {
        ...(message.providerOptions ?? {}),
        ...CACHE_PROVIDER_OPTIONS,
      },
    } as ModelMessage;
  });
}

// ---------------------------------------------------------------------------
// Call options
// ---------------------------------------------------------------------------

export interface CallLlmOptions {
  action: LlmAction;
  /** Null for anonymous funnel traffic — the ledger column is nullable. */
  workspaceId?: string | null;
  projectId?: string | null;
  /** OpenRouter model id, or a pre-built model. Defaults to the action's. */
  model?: string | LanguageModel;
  /** Overrides the action's `maxTokens` for this call only. */
  budgetTokens?: number;
  /** Overrides the action's completion cap for this call only. */
  maxOutputTokens?: number;
  system?: string;
  prompt?: string;
  messages?: ModelMessage[];
  temperature?: number;
  abortSignal?: AbortSignal;
  /**
   * Accept a completion that stopped at the output cap instead of treating it
   * as a budget breach. Only for call sites where a clipped answer is still
   * usable (a chat reply), never where the output must parse (JSON).
   */
  allowTruncation?: boolean;
  /**
   * Opt-in: also record this call against the discovery funnel's monthly €
   * kill-switch ledger (`demo_generation_costs`). Only set it where the route
   * does NOT already call `recordGenerationCost` itself, or spend is counted
   * twice.
   */
  funnel?: { kind: GenerationKind; demoId?: string | null; ip?: string | null };
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
  model: string | null;
  finishReason?: string;
  costEstimate: number | null;
}

export interface LlmObjectResult<T> extends Omit<LlmResult, 'text'> {
  object: T;
}

interface Prepared {
  modelId: string | null;
  model: LanguageModel;
  budgetTokens: number;
  maxOutputTokens?: number;
  args: Record<string, unknown>;
}

function resolveModel(
  action: LlmAction,
  override: CallLlmOptions['model']
): { model: LanguageModel; modelId: string | null } {
  if (override && typeof override !== 'string') {
    const id = (override as { modelId?: string }).modelId ?? null;
    return { model: override, modelId: id };
  }
  const id = override ?? llmActionConfig(action).model;
  return { model: getModel(id) as LanguageModel, modelId: id };
}

async function prepare(options: CallLlmOptions): Promise<Prepared> {
  const config = llmActionConfig(options.action);
  const budgetTokens = options.budgetTokens ?? config.maxTokens;
  const { model, modelId } = resolveModel(options.action, options.model);

  const cap = await workspaceCapExceeded(options.workspaceId);
  if (cap.exceeded) {
    throw new LlmBudgetExceededError(
      options.action,
      'workspace_daily_cap',
      cap.cap,
      cap.used
    );
  }

  const maxOutputTokens = options.maxOutputTokens ?? config.maxOutputTokens;

  const args: Record<string, unknown> = { model };
  if (options.messages) {
    args.messages = withCachedSystemPrefix(options.messages, modelId);
  } else if (options.system) {
    // A `system` string alone cannot carry provider options, so it is promoted
    // into a system message where the cache breakpoint can be attached.
    args.messages = withCachedSystemPrefix(
      [
        { role: 'system', content: options.system },
        { role: 'user', content: options.prompt ?? '' },
      ],
      modelId
    );
  } else {
    args.prompt = options.prompt ?? '';
  }
  if (options.temperature !== undefined) args.temperature = options.temperature;
  if (maxOutputTokens !== undefined) args.maxOutputTokens = maxOutputTokens;
  if (options.abortSignal) args.abortSignal = options.abortSignal;
  // Ask OpenRouter for full usage accounting (cached-token split + real cost).
  args.providerOptions = { openrouter: { usage: { include: true } } };

  return { modelId, model, budgetTokens, maxOutputTokens, args };
}

/** Real provider cost, when OpenRouter usage accounting reports one. */
function providerCostUsd(providerMetadata: unknown): number | null {
  const meta = providerMetadata as
    | { openrouter?: { usage?: { cost?: number } } }
    | undefined;
  const cost = meta?.openrouter?.usage?.cost;
  return typeof cost === 'number' && cost >= 0 ? cost : null;
}

/**
 * Record the call, then enforce. The row is written FIRST so an over-budget
 * call is always visible in the ledger, even though the caller sees a throw.
 */
async function settle(
  options: CallLlmOptions,
  prepared: Prepared,
  raw: { usage?: unknown; finishReason?: string; providerMetadata?: unknown }
): Promise<{ usage: LlmUsage; costEstimate: number | null }> {
  const usage = normalizeLlmUsage(raw.usage);
  const costEstimate =
    providerCostUsd(raw.providerMetadata) ??
    estimateCostUsd(prepared.modelId, usage);

  await recordLlmUsage({
    workspaceId: options.workspaceId ?? null,
    projectId: options.projectId ?? null,
    action: options.action,
    model: prepared.modelId,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    cachedTokens: usage.cachedTokens,
    costEstimate,
  });

  if (options.funnel) {
    await recordGenerationCost({
      kind: options.funnel.kind,
      model: prepared.modelId ?? undefined,
      usage: { inputTokens: usage.tokensIn, outputTokens: usage.tokensOut },
      costUsd: costEstimate ?? undefined,
      demoId: options.funnel.demoId ?? null,
      ip: options.funnel.ip ?? null,
    });
  }

  if (usage.totalTokens > prepared.budgetTokens) {
    console.warn(
      `[llm] budget exceeded action=${options.action} model=${prepared.modelId} used=${usage.totalTokens} budget=${prepared.budgetTokens}`
    );
    throw new LlmBudgetExceededError(
      options.action,
      'total_tokens',
      prepared.budgetTokens,
      usage.totalTokens
    );
  }
  if (raw.finishReason === 'length' && !options.allowTruncation) {
    console.warn(
      `[llm] output truncated at the budget cap action=${options.action} model=${prepared.modelId}`
    );
    throw new LlmBudgetExceededError(
      options.action,
      'truncated',
      prepared.budgetTokens,
      usage.totalTokens
    );
  }

  return { usage, costEstimate };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Budgeted, logged, cache-primed `generateText`. */
export async function callLlm(options: CallLlmOptions): Promise<LlmResult> {
  const prepared = await prepare(options);
  const result = (await generateText(
    prepared.args as Parameters<typeof generateText>[0]
  )) as unknown as {
    text: string;
    usage?: unknown;
    finishReason?: string;
    providerMetadata?: unknown;
  };
  const { usage, costEstimate } = await settle(options, prepared, result);
  return {
    text: result.text ?? '',
    usage,
    model: prepared.modelId,
    finishReason: result.finishReason,
    costEstimate,
  };
}

/** Budgeted, logged, cache-primed `generateObject`. */
export async function callLlmObject<T>(
  options: CallLlmOptions & { schema: unknown }
): Promise<LlmObjectResult<T>> {
  const prepared = await prepare(options);
  const result = (await generateObject({
    ...prepared.args,
    schema: options.schema,
  } as Parameters<typeof generateObject>[0])) as unknown as {
    object: T;
    usage?: unknown;
    finishReason?: string;
    providerMetadata?: unknown;
  };
  const { usage, costEstimate } = await settle(options, prepared, result);
  return {
    object: result.object,
    usage,
    model: prepared.modelId,
    finishReason: result.finishReason,
    costEstimate,
  };
}

/**
 * Budgeted, logged, cache-primed `streamText`.
 *
 * The pre-call output cap still applies, but a stream cannot be un-sent: the
 * post-call check runs in `onFinish`, where it records the row and logs the
 * overage instead of throwing at a caller that has already flushed bytes.
 */
export async function streamLlm(options: CallLlmOptions) {
  const prepared = await prepare(options);
  return streamText({
    ...prepared.args,
    onFinish: (event: {
      usage?: unknown;
      finishReason?: string;
      providerMetadata?: unknown;
    }) => {
      void settle(options, prepared, event).catch((error) => {
        if (error instanceof LlmBudgetExceededError) {
          console.warn(`[llm] ${error.message} (stream already delivered)`);
          return;
        }
        console.warn('[llm] stream accounting failed', error);
      });
    },
  } as Parameters<typeof streamText>[0]);
}
