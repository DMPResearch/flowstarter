/**
 * The call to the editor host: what it refuses to do, and what it says when
 * the host is not there. The rules that matter are all refusals — this module
 * moves a client's whole site and a bearer secret in one request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  EditorHostError,
  forgetEditorSession,
  materializeEditorWorktree,
  shipEditorWorktree,
} from '../operator-editor-host';

const SESSION = 'bb0ce0b6-2f22-4c2c-9a5a-1111aaaa2222';
const SECRET = 'x'.repeat(48);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubEnv('EDITOR_HOST_URL', 'http://127.0.0.1:3773');
  vi.stubEnv('EDITOR_CONTROL_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('configuration refusals', () => {
  it('says plainly when the host is not configured', async () => {
    vi.stubEnv('EDITOR_HOST_URL', '');
    await expect(
      materializeEditorWorktree({
        sessionId: SESSION,
        slug: 'acme',
        baseVersion: 1,
        files: [],
      })
    ).rejects.toThrow(/not configured on this deployment/);
  });

  it('refuses a short control secret rather than sending it', async () => {
    vi.stubEnv('EDITOR_CONTROL_SECRET', 'short');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(forgetEditorSessionThrowing()).rejects.toThrow(
      /at least 32 characters/
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses plain http to anywhere but loopback', async () => {
    vi.stubEnv('EDITOR_HOST_URL', 'http://editor.example.com');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      shipEditorWorktree({ sessionId: SESSION, message: 'build: x' })
    ).rejects.toThrow(/HTTPS or on loopback/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts https to a real host', async () => {
    vi.stubEnv('EDITOR_HOST_URL', 'https://editor.internal');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ commitSha: 'abc', changed: true, files: [] })
    );
    await expect(
      shipEditorWorktree({ sessionId: SESSION, message: 'build: x' })
    ).resolves.toMatchObject({ commitSha: 'abc' });
  });

  it('refuses a host URL that is not a URL', async () => {
    vi.stubEnv('EDITOR_HOST_URL', 'not a url');
    await expect(
      shipEditorWorktree({ sessionId: SESSION, message: 'build: x' })
    ).rejects.toThrow(/not a URL/);
  });
});

/** `forgetEditorSession` swallows by contract, so the config check needs a peer. */
async function forgetEditorSessionThrowing(): Promise<void> {
  await materializeEditorWorktree({
    sessionId: SESSION,
    slug: 'acme',
    baseVersion: 0,
    files: [],
  });
}

describe('materializeEditorWorktree', () => {
  it('sends the manifest with the bearer secret and returns the worktree', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        worktreePath: '/workspaces/acme',
        commitSha: 'abc1234',
        fileCount: 2,
      })
    );
    const result = await materializeEditorWorktree({
      sessionId: SESSION,
      slug: 'acme',
      baseVersion: 3,
      files: [{ path: 'src/pages/index.astro', content: 'x' }],
    });
    expect(result.worktreePath).toBe('/workspaces/acme');

    const [url, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('http://127.0.0.1:3773/__router/sessions');
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      `Bearer ${SECRET}`
    );
    const body = JSON.parse(init.body as string);
    expect(body.slug).toBe('acme');
    expect(body.baseVersion).toBe(3);
    expect(body.files).toHaveLength(1);
  });

  it('repeats the host’s own words when it refuses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('slug does not route here', { status: 400 })
    );
    await expect(
      materializeEditorWorktree({
        sessionId: SESSION,
        slug: 'acme',
        baseVersion: 0,
        files: [],
      })
    ).rejects.toThrow(/slug does not route here/);
  });

  it('says the host did not answer rather than surfacing a network errno', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    try {
      await materializeEditorWorktree({
        sessionId: SESSION,
        slug: 'acme',
        baseVersion: 0,
        files: [],
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EditorHostError);
      expect((error as EditorHostError).code).toBe('EDITOR_HOST_UNREACHABLE');
      expect((error as EditorHostError).message).toMatch(/did not answer/);
    }
  });
});

describe('shipEditorWorktree', () => {
  it('passes the commit message through and never invents one', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse({ commitSha: 'feed123', changed: true, files: [] })
      );
    await shipEditorWorktree({
      sessionId: SESSION,
      message: 'build: ship operator editor session to site abc',
    });
    const [url, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe(`/__router/sessions/${SESSION}/ship`);
    expect(JSON.parse(init.body as string).message).toBe(
      'build: ship operator editor session to site abc'
    );
  });
});

describe('forgetEditorSession', () => {
  it('never throws: the row is already closed and the next open overwrites', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(forgetEditorSession(SESSION)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('asks the host to drop the session', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ ok: true }));
    await forgetEditorSession(SESSION);
    const [url, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe(`/__router/sessions/${SESSION}`);
    expect(init.method).toBe('DELETE');
  });
});
