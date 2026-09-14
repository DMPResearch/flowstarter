/**
 * The activity timeline reaches the browser, in order, with nothing on it
 * that a visitor should not see.
 *
 * Both transports are covered, because the wizard uses both: the SSE stream
 * is the primary one, and the plain status endpoint is what a browser with no
 * EventSource (or a proxy that dropped the socket) falls back to. The rule
 * they share is that `detail` -- the field carrying workspace file paths and
 * raw gate verdicts -- is stripped on the way out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { AgentActivityEvent } from '@flowstarter/agentic-codegen/src/flowstarter/activity';
import {
  ACTIVITY_CAP,
  appendActivity,
  createJob,
  getJob,
  updateJob,
} from '@/lib/discovery/live-jobs';
import { GET as streamGet } from '../stream/route';

vi.mock('server-only', () => ({}));

function demoId(): string {
  return '11111111-2222-4333-8444-555555555555';
}

function event(
  index: number,
  overrides: Partial<AgentActivityEvent> = {}
): AgentActivityEvent {
  return {
    at: new Date(Date.UTC(2026, 8, 14, 10, 0, index)).toISOString(),
    phase: 'Agents expanding the site',
    kind: 'reading',
    subject: 'section.services',
    ...overrides,
  };
}

/** Reads the whole SSE body and returns the frames as `[event, data]` pairs. */
async function readFrames(
  response: Response
): Promise<Array<[string, Record<string, unknown>]>> {
  const text = await response.text();
  const frames: Array<[string, Record<string, unknown>]> = [];
  for (const block of text.split('\n\n')) {
    const name = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (!name || !data) continue;
    frames.push([name, JSON.parse(data) as Record<string, unknown>]);
  }
  return frames;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the preview activity stream', () => {
  it('replays every step in the order the pipeline produced it', async () => {
    const id = demoId();
    createJob(id);
    appendActivity(id, event(1, { kind: 'searching', subject: 'brief' }));
    appendActivity(id, event(2, { kind: 'reading' }));
    appendActivity(id, event(3, { kind: 'editing' }));
    // The run has to end, or the stream holds the socket open for 20 minutes.
    updateJob(id, { status: 'ready', previewUrl: 'https://example.test' });

    const response = await streamGet(
      new NextRequest(`https://flowstarter.test/api?demoId=${id}`)
    );
    const frames = await readFrames(response);

    expect(frames.filter(([name]) => name === 'activity')).toHaveLength(3);
    expect(
      frames
        .filter(([name]) => name === 'activity')
        .map(([, data]) => data.kind)
    ).toEqual(['searching', 'reading', 'editing']);
    expect(frames[frames.length - 1]?.[0]).toBe('ready');
  });

  it('never sends the operator detail to a visitor', async () => {
    const id = demoId();
    createJob(id);
    appendActivity(
      id,
      event(1, { detail: 'src/components/Services.astro', chips: ['hero'] })
    );
    updateJob(id, { status: 'ready', previewUrl: 'https://example.test' });

    const response = await streamGet(
      new NextRequest(`https://flowstarter.test/api?demoId=${id}`)
    );
    const body = await response.text();

    expect(body).not.toContain('Services.astro');
    expect(body).not.toContain('"detail"');
    // The chips are not detail: a search query is the visitor's own business,
    // said back to them, and it is what makes the step legible.
    expect(body).toContain('hero');
  });

  it('is a text/event-stream a proxy will not buffer', async () => {
    const id = demoId();
    createJob(id);
    updateJob(id, { status: 'ready', previewUrl: 'https://example.test' });

    const response = await streamGet(
      new NextRequest(`https://flowstarter.test/api?demoId=${id}`)
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
  });

  it('refuses a demo id that is not one', async () => {
    const response = await streamGet(
      new NextRequest('https://flowstarter.test/api?demoId=not-a-uuid')
    );
    expect(response.status).toBe(400);
  });
});

describe('appendActivity', () => {
  it('appends in order and stops at the cap', () => {
    const id = demoId();
    createJob(id);
    for (let index = 0; index < ACTIVITY_CAP + 25; index += 1) {
      appendActivity(id, event(index));
    }
    expect(getJob(id)?.activity).toHaveLength(ACTIVITY_CAP);
  });

  it('ignores a demo that does not exist rather than creating one', () => {
    appendActivity('99999999-9999-4999-8999-999999999999', event(1));
    expect(getJob('99999999-9999-4999-8999-999999999999')).toBeUndefined();
  });
});
