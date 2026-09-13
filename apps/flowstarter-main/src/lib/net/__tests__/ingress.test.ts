// @vitest-environment node
/**
 * The ingress limits, on bodies that arrive the way an attacker sends them.
 *
 * Codex F07 is one sentence — "size checks happen after buffering" — and every
 * case below is written so that it would pass against the old code if the
 * check were merely in the wrong place, and fails unless the bytes are counted
 * as they arrive. Which is why none of these requests carries a
 * `Content-Length`: the old route trusted that header and read its absence as
 * `'0'`, so a test that sets one honestly proves nothing at all.
 *
 * The pixel case is the other half, and it is the one a byte cap can never
 * catch: the body below is a few hundred bytes and would decode to about six
 * gigabytes, so the only place to refuse it is the header.
 */
import { describe, expect, it } from 'vitest';

import {
  createGate,
  imageDecodeGate,
  imagePixelBudget,
  readBodyCapped,
  readFormDataCapped,
  readJsonCapped,
  readStreamCapped,
} from '../ingress';
import { ingressConfig } from '../net-config';

const encoder = new TextEncoder();

/** A body that arrives in pieces and never says how many there will be. */
function chunked(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** A body that never ends, so only the reader can stop it. */
function endless(block: Uint8Array): {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
  cancelled: () => boolean;
} {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(block);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

function request(
  body: string | Uint8Array | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {}
): Request {
  return new Request('https://ingress.test/upload', {
    method: 'POST',
    headers,
    body: body as BodyInit,
    // Required by the platform for a streamed request body.
    duplex: 'half',
  } as RequestInit);
}

describe('readStreamCapped', () => {
  it('reads a body that fits', async () => {
    const outcome = await readStreamCapped(
      chunked([encoder.encode('one'), encoder.encode('two')]),
      1024
    );
    expect(outcome).toEqual({ status: 'ok', bytes: Buffer.from('onetwo') });
  });

  it('aborts at the cap and stops pulling, with no length anywhere', async () => {
    const source = endless(new Uint8Array(16 * 1024));
    const outcome = await readStreamCapped(source.stream, 64 * 1024);
    expect(outcome).toEqual({ status: 'too_large' });
    // The assertion that separates a cap from a complaint. The source is
    // endless: had the reader kept pulling, this number would keep climbing
    // and the buffer with it. Five chunks of sixteen kilobytes is the cap plus
    // the one chunk that crossed it, which is the most any streaming reader
    // can avoid holding.
    expect(source.pulled()).toBeLessThanOrEqual(6);
  });

  it('counts cumulative bytes, not per-chunk ones', async () => {
    const kilobyte = new Uint8Array(1024);
    const outcome = await readStreamCapped(
      chunked(new Array(10).fill(kilobyte)),
      4 * 1024
    );
    expect(outcome).toEqual({ status: 'too_large' });
  });
});

describe('readBodyCapped', () => {
  it('refuses a body with no content-length that runs past the cap', async () => {
    const source = endless(new Uint8Array(16 * 1024));
    const outcome = await readBodyCapped(request(source.stream), 64 * 1024);
    expect(outcome).toEqual({ status: 'too_large' });
  });

  it('refuses an honest oversized content-length before reading anything', async () => {
    const source = endless(new Uint8Array(1024));
    const outcome = await readBodyCapped(
      request(source.stream, { 'content-length': '99999999' }),
      1024
    );
    expect(outcome).toEqual({ status: 'too_large' });
    // At most the one chunk the platform reads ahead when the body is attached
    // to the request; the reader itself never asked for any.
    expect(source.pulled()).toBeLessThanOrEqual(1);
  });

  it('does not believe a content-length that understates the body', async () => {
    // The lie that the old check could not see through: a small declared
    // length and a large body.
    const source = endless(new Uint8Array(16 * 1024));
    const outcome = await readBodyCapped(
      request(source.stream, { 'content-length': '10' }),
      64 * 1024
    );
    expect(outcome).toEqual({ status: 'too_large' });
  });
});

describe('readJsonCapped', () => {
  it('parses a body that fits', async () => {
    const outcome = await readJsonCapped(
      request(JSON.stringify({ hello: 'there' }), {
        'content-type': 'application/json',
      }),
      1024
    );
    expect(outcome).toEqual({ status: 'ok', value: { hello: 'there' } });
  });

  it('refuses an oversized chunked JSON body', async () => {
    const source = endless(encoder.encode('{"a":"' + 'x'.repeat(4096) + '",'));
    const outcome = await readJsonCapped(request(source.stream), 16 * 1024);
    expect(outcome).toEqual({ status: 'too_large' });
  });

  it('reports malformed JSON separately from an oversized one', async () => {
    const outcome = await readJsonCapped(request('{not json'), 1024);
    expect(outcome).toEqual({ status: 'invalid' });
  });
});

describe('readFormDataCapped', () => {
  const BOUNDARY = 'flowstarterfixtureboundary';

  function multipart(fileBytes: Uint8Array): Uint8Array {
    const head = encoder.encode(
      `--${BOUNDARY}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="logo.png"\r\n' +
        'Content-Type: image/png\r\n\r\n'
    );
    const tail = encoder.encode(`\r\n--${BOUNDARY}--\r\n`);
    const out = new Uint8Array(
      head.byteLength + fileBytes.byteLength + tail.byteLength
    );
    out.set(head, 0);
    out.set(fileBytes, head.byteLength);
    out.set(tail, head.byteLength + fileBytes.byteLength);
    return out;
  }

  it('parses an upload that fits', async () => {
    const outcome = await readFormDataCapped(
      request(multipart(encoder.encode('pretend png')), {
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      }),
      1024 * 1024
    );
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    const file = outcome.form.get('file');
    expect(file).toBeInstanceOf(File);
    expect(await (file as File).text()).toBe('pretend png');
  });

  it('aborts an oversized chunked upload that declares no length', async () => {
    // The exact request the finding describes: multipart, no content-length,
    // more bytes than the cap. The old route read this into memory in full and
    // then measured the file.
    const source = endless(new Uint8Array(32 * 1024));
    const outcome = await readFormDataCapped(
      request(source.stream, {
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      }),
      128 * 1024
    );
    expect(outcome).toEqual({ status: 'too_large' });
    // Bounded, on a body that never ends and never said how long it was.
    expect(source.pulled()).toBeLessThanOrEqual(6);
  });

  it('refuses a body that is not multipart at all', async () => {
    const outcome = await readFormDataCapped(
      request('{}', { 'content-type': 'application/json' }),
      1024
    );
    expect(outcome).toEqual({ status: 'invalid' });
  });
});

describe('imagePixelBudget', () => {
  /** A PNG header that claims `width` by `height`, and nothing else. */
  function pngHeader(width: number, height: number): Buffer {
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
    header.writeUInt32BE(13, 8);
    header.write('IHDR', 12, 'ascii');
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    return header;
  }

  it('refuses a decompression bomb from its header alone', async () => {
    // 33 bytes on the wire. About six gigabytes of RGBA if anything decodes
    // it, which no byte-length cap in the product would have noticed.
    const bomb = pngHeader(40_000, 40_000);
    expect(bomb.byteLength).toBeLessThan(64);
    expect(imagePixelBudget(bomb).status).toBe('too_many_pixels');
  });

  it('accepts a picture a person would actually upload', () => {
    expect(imagePixelBudget(pngHeader(1200, 900))).toEqual({
      status: 'ok',
      width: 1200,
      height: 900,
    });
  });

  it('reads the ceiling from configuration rather than from a literal', () => {
    const tight = ingressConfig({ FLOWSTARTER_MAX_IMAGE_PIXELS: '100' });
    expect(imagePixelBudget(pngHeader(10, 10), tight.maxImagePixels)).toEqual({
      status: 'ok',
      width: 10,
      height: 10,
    });
    expect(
      imagePixelBudget(pngHeader(20, 20), tight.maxImagePixels).status
    ).toBe('too_many_pixels');
    // And the same picture is fine under the default, so the refusal above is
    // the configuration talking and not the picture.
    expect(imagePixelBudget(pngHeader(20, 20)).status).toBe('ok');
  });

  it('says so when the header carries no dimensions, rather than guessing', () => {
    // A WebP, or a text file. The magic-byte check downstream is the one
    // qualified to refuse it, and the decoder carries its own pixel ceiling.
    expect(imagePixelBudget(Buffer.from('not an image at all'))).toEqual({
      status: 'unknown',
    });
  });
});

describe('createGate', () => {
  it('never runs more than the configured number at once', async () => {
    const gate = createGate(2);
    let peak = 0;
    const release: Array<() => void> = [];
    const work = () =>
      gate.run(async () => {
        peak = Math.max(peak, gate.active);
        await new Promise<void>((resolve) => release.push(resolve));
        return 1;
      });

    const all = [work(), work(), work(), work(), work()];
    // Let the first two start and prove the other three are waiting.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gate.active).toBe(2);
    while (release.length > 0) {
      release.pop()?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Promise.all(all);
    expect(peak).toBe(2);
    expect(gate.active).toBe(0);
  });

  it('frees its slot when the work throws', async () => {
    const gate = createGate(1);
    await expect(
      gate.run(async () => {
        throw new Error('decode failed');
      })
    ).rejects.toThrow('decode failed');
    expect(gate.active).toBe(0);
    await expect(gate.run(async () => 'next')).resolves.toBe('next');
  });
});

describe('imageDecodeGate', () => {
  it('is one gate for the whole process, not one per caller', () => {
    // The memory a decode spends belongs to the process, so a limit each
    // route counted separately would not be a limit on the thing that runs
    // out.
    expect(imageDecodeGate()).toBe(imageDecodeGate());
  });

  it('runs the work it is given and reports itself idle afterwards', async () => {
    const gate = imageDecodeGate();
    await expect(gate.run(async () => 'decoded')).resolves.toBe('decoded');
    expect(gate.active).toBe(0);
  });
});
