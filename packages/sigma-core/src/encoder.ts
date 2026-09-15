/**
 * The local multilingual encoder: no network at inference, ever.
 *
 * Transformers.js is configured with `allowRemoteModels = false` and a local
 * model path, so a cache miss throws at load rather than reaching for
 * huggingface.co inside somebody's request. The files get there at install or
 * build time via `scripts/fetch-model.mjs`, pinned by revision and verified
 * by sha256.
 *
 * Three properties the rest of the package relies on:
 *
 *   1. **Warm-up is explicit.** `warm()` pays the cold ONNX session cost
 *      (~1s) off the request path. A caller that forgets will blow the
 *      per-call budget on its first text and fail open — degraded, not
 *      broken, and visible in the trace.
 *   2. **The budget is per call.** `embed` races the work against
 *      `budgetMs`; over it, it resolves to null and the cascade moves to the
 *      next tier. A timeout cannot cancel ONNX, so the slow call still
 *      completes and still populates the cache: the next text is fast.
 *   3. **The cache is keyed by content hash**, not by the text, so nothing
 *      holds a user's prose in a long-lived map.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EncoderConfig } from './artifacts.js';
import { loadEncoderConfig, resolveCacheDir } from './artifacts.js';

/** The one thing the tiers need. Stub it in tests; it is a seam on purpose. */
export interface Encoder {
  /** L2-normalised vectors, one per text, in order. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbedOutcome {
  vector: Float32Array | null;
  ms: number;
  cacheHit: boolean;
  error?: string;
}

export class EncoderArtifactsMissingError extends Error {
  constructor(dir: string, model: string) {
    super(
      `sigma encoder artifacts are missing under ${dir} for ${model}. ` +
        `Run "pnpm --filter @flowstarter/sigma-core fetch-model" at install or ` +
        `build time; the runtime never fetches inside a request.`,
    );
    this.name = 'EncoderArtifactsMissingError';
  }
}

/** Where the pinned files must already be, for a given config. */
export function modelDir(config: EncoderConfig = loadEncoderConfig()): string {
  return join(resolveCacheDir(config), ...config.model.split('/'));
}

/** Whether every pinned file is present. Cheap; does not hash. */
export function encoderCacheIsPopulated(
  config: EncoderConfig = loadEncoderConfig(),
): boolean {
  const dir = modelDir(config);
  return config.files.every((file) => existsSync(join(dir, ...file.path.split('/'))));
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ dims: number[]; data: Float32Array | number[] }>;

/**
 * The real encoder. One process-wide instance is the normal case; construct
 * your own only when you want an independent cache.
 */
export class LocalSentenceEncoder implements Encoder {
  private extractor: FeatureExtractor | undefined;
  private loading: Promise<FeatureExtractor> | undefined;
  /** content hash -> vector. Insertion-ordered, evicted oldest-first. */
  private readonly cache = new Map<string, Float32Array>();

  constructor(readonly config: EncoderConfig = loadEncoderConfig()) {}

  /** sha256 of the prefixed text: the cache key, and never the text itself. */
  private key(text: string): string {
    return createHash('sha256')
      .update(`${this.config.model}@${this.config.revision}:${text}`)
      .digest('hex');
  }

  private async load(): Promise<FeatureExtractor> {
    if (this.extractor) return this.extractor;
    this.loading ??= (async () => {
      const dir = modelDir(this.config);
      if (!encoderCacheIsPopulated(this.config)) {
        throw new EncoderArtifactsMissingError(dir, this.config.model);
      }
      const { env, pipeline } = await import('@huggingface/transformers');
      // The whole point: no request may ever become an HTTP call.
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = resolveCacheDir(this.config);
      if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = 1;
      const extractor = (await pipeline('feature-extraction', this.config.model, {
        dtype: this.config.dtype as 'q8',
        local_files_only: true,
      })) as unknown as FeatureExtractor;
      this.extractor = extractor;
      return extractor;
    })();
    try {
      return await this.loading;
    } catch (error) {
      // A failed load must not be cached as a pending promise forever; the
      // next call should get the same clear error, not an unhandled rejection.
      this.loading = undefined;
      throw error;
    }
  }

  /**
   * Pay the cold-session cost now, off the request path. Throws when the
   * artifacts are missing: a process that could only ever fail open should
   * fail at startup, not serve every request degraded.
   */
  async warm(probe = 'warm up the sigma encoder'): Promise<void> {
    await this.load();
    await this.embed([probe]);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const prefixed = texts.map((text) => this.config.queryPrefix + (text ?? ''));
    const keys = prefixed.map((text) => this.key(text));
    const out = new Array<Float32Array | undefined>(texts.length);
    const missing: number[] = [];
    keys.forEach((key, index) => {
      const hit = this.cache.get(key);
      if (hit) out[index] = hit;
      else missing.push(index);
    });

    if (missing.length > 0) {
      const extractor = await this.load();
      const batch = missing.map((index) => prefixed[index] as string);
      const tensor = await extractor(batch, { pooling: 'mean', normalize: true });
      const dim = tensor.dims[tensor.dims.length - 1] as number;
      const data = tensor.data as Float32Array;
      missing.forEach((index, position) => {
        const vector = Float32Array.prototype.slice.call(
          data,
          position * dim,
          (position + 1) * dim,
        ) as Float32Array;
        out[index] = vector;
        this.remember(keys[index] as string, vector);
      });
    }
    return out as Float32Array[];
  }

  private remember(key: string, vector: Float32Array): void {
    const limit = Math.max(1, this.config.embeddingCacheSize);
    if (this.cache.size >= limit) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, vector);
  }

  /** Whether this exact text is already embedded. For the trace, not logic. */
  has(text: string): boolean {
    return this.cache.has(this.key(this.config.queryPrefix + (text ?? '')));
  }

  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * `getEncoder()`'s singleton, on `globalThis` rather than a plain module-level
 * `let` — reproduced and fixed 2026-09-15 (staging, `flowstarter-staging-main`):
 * `src/instrumentation.ts` warms the encoder at boot through
 * `warmSigmaOrWarn()` and logs "[sigma] warm: model ready" (and `/api/health`
 * agreed, `sigma: "ready"`), yet the FIRST real `/api/discovery/scope` request
 * against a genuinely NEW, never-before-classified brief still abstained with
 * `encoder_timeout` — sixteen minutes after boot, nowhere near a cold-start
 * race. A `docker exec` replay on the box (composing the exact request text
 * with the app's own `intakeSubject`) showed the composed text was fine and
 * classified confidently (`clean`, margin 0.13) once run against the
 * warmed-in-that-process singleton; a **second, independently constructed**
 * `LocalSentenceEncoder` in the SAME script paid the full cold ONNX-session
 * cost again (~2s, comfortably over the 400ms per-call budget) — proving two
 * distinct encoder instances existed where the design assumes one.
 *
 * `apps/flowstarter-main/src/lib/sigma/warm.ts` documents the identical
 * failure shape for its own module state (`getSigmaHealth()` stuck at
 * `'missing'` while a sibling copy of the same file had already warmed) and
 * fixes it exactly this way: Turbopack's production build can give a route
 * handler's chunk and `src/instrumentation.ts`'s chunk their own independent
 * copies of a module's top-level state, so `warmSigma()` warming ONE copy's
 * singleton leaves every OTHER copy — including whichever one real request
 * traffic actually reaches — cold. `globalThis` is the one thing every
 * module-graph copy shares regardless of how a bundler split the code that
 * reaches it; `Symbol.for` (not a bare object key) so this survives even a
 * `globalThis` that itself got re-initialised per chunk.
 */
const GLOBAL_ENCODER_KEY = Symbol.for('flowstarter.sigma-core.encoder');

type GlobalWithEncoder = typeof globalThis & {
  [GLOBAL_ENCODER_KEY]?: LocalSentenceEncoder;
};

function getGlobal(): GlobalWithEncoder {
  return globalThis as GlobalWithEncoder;
}

/** The process-wide encoder. */
export function getEncoder(config?: EncoderConfig): LocalSentenceEncoder {
  const global = getGlobal();
  global[GLOBAL_ENCODER_KEY] ??= new LocalSentenceEncoder(config);
  return global[GLOBAL_ENCODER_KEY];
}

/** Load the model and run one embed, off the request path. */
export async function warmEncoder(config?: EncoderConfig): Promise<void> {
  await getEncoder(config).warm();
}

/** Tests only. */
export function resetEncoder(): void {
  delete getGlobal()[GLOBAL_ENCODER_KEY];
}

/**
 * One text, one vector, under a wall-clock budget.
 *
 * Never throws: an over-budget or broken encoder is a reason to fall through
 * to the next tier, not a reason to break the request. The reason travels in
 * the outcome so the trace can say which it was.
 */
export async function embedWithinBudget(
  encoder: Encoder,
  text: string,
  budgetMs: number,
): Promise<EmbedOutcome> {
  const cacheHit = encoder instanceof LocalSentenceEncoder ? encoder.has(text) : false;
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolvePromise) => {
      timer = setTimeout(() => resolvePromise(null), Math.max(1, budgetMs));
    });
    const work = encoder.embed([text]).then((vectors) => vectors[0] ?? null);
    // The loser of this race is NOT cancelled: ONNX has no cancellation, and
    // letting the slow call finish is what warms the cache for the next one.
    const vector = await Promise.race([work, timeout]);
    work.catch(() => undefined);
    return {
      vector,
      ms: performance.now() - started,
      cacheHit,
      ...(vector === null ? { error: 'encoder_timeout' } : {}),
    };
  } catch (error) {
    return {
      vector: null,
      ms: performance.now() - started,
      cacheHit,
      error: error instanceof Error ? error.name : 'encoder_error',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
