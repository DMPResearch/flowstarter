/**
 * GET /api/discovery/preview/live/stream?demoId=… — server-sent progress.
 *
 * Generation takes minutes and the model layer gives us no token stream, so
 * there is nothing to stream *from the model*. What we can stream is truthful
 * progress: each phase the moment the pipeline enters it, instead of whenever
 * a poll happens to land. Phases already recorded are replayed on connect, so
 * a late subscriber or a reconnect still sees the whole run.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '@/lib/discovery/live-jobs';
import { previewUrlForClient } from '@/lib/discovery/local-preview-frame';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_MS = 400;
/** Generation is minutes, not hours: give up rather than hold a socket open. */
const MAX_MS = 20 * 60_000;
const HEARTBEAT_MS = 15_000;

export async function GET(request: NextRequest): Promise<Response> {
  const demoId = request.nextUrl.searchParams.get('demoId') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(demoId)) {
    return new Response('Invalid demoId', { status: 400 });
  }
  if (!getJob(demoId)) {
    return new Response('Unknown demoId', { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      let lastHeartbeat = startedAt;
      let sentPhases = 0;
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed by the client */
        }
      };

      request.signal.addEventListener('abort', close);

      while (!closed) {
        const job = getJob(demoId);
        if (!job) {
          send('failed', { error: 'This preview is no longer available' });
          break;
        }

        // Replay anything the client has not seen, in order.
        const phases = job.phases ?? [];
        for (; sentPhases < phases.length; sentPhases += 1) {
          const entry = phases[sentPhases];
          send('phase', {
            phase: entry?.phase,
            at: entry?.at,
            index: sentPhases + 1,
          });
        }

        if (job.status === 'ready') {
          send('ready', {
            previewUrl: previewUrlForClient(demoId, job.previewUrl),
            personalized: job.personalized ?? false,
            seconds: Math.round((Date.now() - job.createdAt) / 1000),
          });
          break;
        }
        if (job.status === 'failed') {
          send('failed', { error: job.error ?? 'Generation failed' });
          break;
        }
        if (Date.now() - startedAt > MAX_MS) {
          send('failed', { error: 'Generation timed out' });
          break;
        }
        // Proxies drop an idle connection; a comment keeps it warm without
        // pretending progress happened.
        if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
          lastHeartbeat = Date.now();
          if (!closed) controller.enqueue(encoder.encode(': keep-alive\n\n'));
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      close();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
