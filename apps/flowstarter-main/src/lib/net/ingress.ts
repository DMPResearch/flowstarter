/**
 * Reading a stranger's request body without agreeing to hold all of it first.
 *
 * The mirror image of `safe-fetch.ts`: that module is the rules for bytes we
 * go and get, this one is the rules for bytes that arrive. The bug is the same
 * bug in both directions, and it is worth naming precisely because it reads as
 * a working limit right up until somebody tests it.
 *
 *   const declared = Number(request.headers.get('content-length') ?? '0');
 *   if (declared > MAX) return tooLarge();
 *   const form = await request.formData();   // <- the whole body, in memory
 *   if (file.size > MAX) return tooLarge();  // <- the cap, after the cost
 *
 * `Content-Length` is a claim by the sender. A chunked request does not carry
 * one at all, so `?? '0'` reads "no header" as "no bytes" and waves it
 * through, and `formData()` then buffers whatever actually arrives — which the
 * sender chooses. The check is not weak, it is in the wrong place: the two
 * lines that matter are separated by the allocation they exist to prevent.
 *
 * So everything here counts bytes as they stream and stops pulling the moment
 * the total passes the cap, whatever the headers said and whether or not there
 * were any. The refusal costs one buffer of the cap's size, once, instead of
 * one buffer of the attacker's choosing.
 *
 * AND THEN THE SECOND COST, which is the one a byte cap cannot see. A PNG
 * whose header declares 40000x40000 is a few kilobytes on the wire and about
 * six gigabytes of RGBA once decoded. Every size limit in the product passes
 * it. `imagePixelBudget` therefore reads the dimensions out of the file's
 * header — a fixed number of bytes at a fixed offset, no decoder involved —
 * and refuses before anything allocates a pixel. What survives that runs
 * through a small gate, because the resource a decode exhausts is memory, and
 * memory is the resource that takes the whole process down rather than one
 * request.
 *
 * Pure where it can be: `imagePixelBudget` and the gate are functions of their
 * arguments, and the readers take a body rather than reaching for one.
 */
import { probeImageSize } from '@flowstarter/agentic-codegen/src/flowstarter/preview-assets';

import { ingressConfig, type IngressConfig } from './net-config';

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export type BodyOutcome =
  | { status: 'ok'; bytes: Buffer }
  /** Cumulative bytes passed the cap. The stream was abandoned, not read. */
  | { status: 'too_large' }
  /** The connection broke, or the caller aborted. */
  | { status: 'error' };

/**
 * Reads a stream to the end, or abandons it at the cap.
 *
 * ABANDONS, NOT CANCELS, and that word is deliberate. Releasing the reader
 * stops us pulling, which is what bounds the memory and the work — the
 * property the cap exists for. Calling `cancel()` on top of that would tear
 * the transfer down a few milliseconds sooner, and on a real socket the
 * runtime does that anyway the moment the 413 is returned. It is not called
 * because Node's in-memory body pump can still be mid-`enqueue` when the
 * stream closes underneath it, which surfaces as an unhandled rejection in an
 * unrelated part of the process; a refusal that destabilises the server is a
 * worse refusal than one that lets the last chunk arrive. The outbound side
 * has no such constraint and does abort its socket outright: see
 * `safe-fetch.ts`.
 */
export async function readStreamCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<BodyOutcome> {
  if (!stream) return { status: 'ok', bytes: Buffer.alloc(0) };
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.releaseLock();
        return { status: 'too_large' };
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    reader.releaseLock();
    return { status: 'error' };
  }
  return { status: 'ok', bytes: Buffer.concat(chunks) };
}

/**
 * The body of a request, capped.
 *
 * `Content-Length` is consulted only as an early refusal, and only when it is
 * both present and already over the cap — an honest sender saying "this is too
 * big" is worth believing, because believing it costs nothing and refuses
 * sooner. A dishonest one is caught by the stream anyway, which is why the
 * header is never the only check.
 */
export async function readBodyCapped(
  request: Request,
  maxBytes: number
): Promise<BodyOutcome> {
  const declared = Number(request.headers.get('content-length') ?? '');
  // Before `request.body` is so much as read, because touching that getter is
  // what starts the platform feeding the stream. Refusing a declared length
  // should cost a header parse and nothing else.
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { status: 'too_large' };
  }
  return await readStreamCapped(
    request.body as ReadableStream<Uint8Array> | null,
    maxBytes
  );
}

export type JsonOutcome =
  | { status: 'ok'; value: unknown }
  | { status: 'too_large' }
  | { status: 'invalid' };

/** A JSON body, capped. Prose and ids, never a file. */
export async function readJsonCapped(
  request: Request,
  maxBytes: number = ingressConfig().maxJsonBodyBytes
): Promise<JsonOutcome> {
  const body = await readBodyCapped(request, maxBytes);
  if (body.status === 'too_large') return { status: 'too_large' };
  if (body.status === 'error') return { status: 'invalid' };
  try {
    return { status: 'ok', value: JSON.parse(body.bytes.toString('utf8')) };
  } catch {
    return { status: 'invalid' };
  }
}

export type FormOutcome =
  | { status: 'ok'; form: FormData }
  | { status: 'too_large' }
  | { status: 'invalid' };

/**
 * A multipart body, capped, parsed from bytes we already agreed to hold.
 *
 * The re-wrapped `Request` is not ceremony: the platform's multipart parser is
 * only reachable through `formData()`, and calling it on the original request
 * is what buffers an unbounded body. Handing it a buffer that is already
 * bounded gets the same parser with the cap in front of it rather than behind
 * it.
 */
export async function readFormDataCapped(
  request: Request,
  maxBytes: number = ingressConfig().maxAnonBodyBytes
): Promise<FormOutcome> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return { status: 'invalid' };
  }
  const body = await readBodyCapped(request, maxBytes);
  if (body.status === 'too_large') return { status: 'too_large' };
  if (body.status === 'error') return { status: 'invalid' };
  try {
    const bounded = new Request('https://ingress.invalid/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: new Uint8Array(body.bytes),
    });
    return { status: 'ok', form: await bounded.formData() };
  } catch {
    return { status: 'invalid' };
  }
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

export type PixelBudget =
  | { status: 'ok'; width: number; height: number }
  /** The header declares more pixels than we will ever decode. */
  | { status: 'too_many_pixels'; width: number; height: number }
  /**
   * No dimensions in the header we can read — a WebP, or something that is not
   * an image at all. Not a refusal: the format check downstream is the one
   * qualified to say so, and it reads the same bytes. The decoder is given its
   * own pixel ceiling for exactly this case.
   */
  | { status: 'unknown' };

/**
 * Whether a picture may be decoded, decided from its header alone.
 *
 * This runs before any decoder touches the bytes, which is the whole point: a
 * decompression bomb is small on the wire and enormous in memory, so the only
 * cheap moment to refuse it is while it is still a few bytes of header.
 */
export function imagePixelBudget(
  bytes: Buffer,
  maxPixels: number = ingressConfig().maxImagePixels
): PixelBudget {
  const size = probeImageSize(bytes);
  if (!size || size.width <= 0 || size.height <= 0)
    return { status: 'unknown' };
  if (size.width * size.height > maxPixels) {
    return {
      status: 'too_many_pixels',
      width: size.width,
      height: size.height,
    };
  }
  return { status: 'ok', width: size.width, height: size.height };
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

export interface Gate {
  /** Runs `work` when a slot is free. Rejects only if `work` rejects. */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** How many are running right now. For tests and for a health endpoint. */
  readonly active: number;
}

/**
 * A counting gate: at most `limit` pieces of work at once, the rest queued in
 * arrival order.
 *
 * Deliberately not a rate limit. A rate limit says how often something may
 * start; this says how many may be in memory at the same moment, which is the
 * quantity that decides whether a burst of anonymous uploads is a slow queue
 * or an out-of-memory.
 */
export function createGate(limit: number): Gate {
  const waiting: Array<() => void> = [];
  let active = 0;

  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };

  return {
    get active() {
      return active;
    },
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (active >= limit) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      active += 1;
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}

let sharedImageGate: Gate | null = null;

/**
 * The process-wide gate every image decode goes through.
 *
 * One gate rather than one per route: the memory is the process's, so a limit
 * that each route counts separately is not a limit on the thing that runs out.
 */
export function imageDecodeGate(config: IngressConfig = ingressConfig()): Gate {
  if (!sharedImageGate) {
    sharedImageGate = createGate(config.imageDecodeConcurrency);
  }
  return sharedImageGate;
}
