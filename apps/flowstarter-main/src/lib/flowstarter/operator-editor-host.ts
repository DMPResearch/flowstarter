import 'server-only';
/**
 * Talking to the editor host.
 *
 * The editor is one container on the sites box running the router/supervisor
 * (`apps/flowstarter-editor/router`). It listens on loopback; Caddy proxies
 * `<slug>.<domain>/editor/*` to it for browsers, and this module reaches its
 * control plane on the same loopback port for the two things a browser must
 * never be able to ask for: materialise this workspace's worktree, and hand
 * back what is in it.
 *
 * Three rules, and they are the reason this is a module rather than two fetch
 * calls in a route:
 *
 *   1. **Loopback or HTTPS, never plain http to somewhere else.** The control
 *      secret is a bearer credential and the manifest is a client's whole
 *      site. The same rule `dispatch.ts` applies to the build worker, applied
 *      here, because it is the same class of call.
 *   2. **Failures are plain words, not statuses.** Every caller is an operator
 *      standing at a button. "The editor host is not configured on this
 *      deployment" is something they can act on; "502" is not.
 *   3. **Nothing here decides anything.** It moves bytes. Whether a session
 *      may be opened, and whether what comes back may be published, are
 *      `operator-editor.ts` and the build's own gates respectively.
 */

export class EditorHostError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = 'EditorHostError';
  }
}

export interface EditorManifestFile {
  path: string;
  content: string;
  encoding?: 'base64';
}

/** How long we wait on the host. Materialising a site is seconds, not minutes. */
const HOST_TIMEOUT_MS = 30_000;

function controlBase(): { url: URL; secret: string } {
  const endpoint = process.env.EDITOR_HOST_URL;
  const secret = process.env.EDITOR_CONTROL_SECRET;
  if (!endpoint || !secret) {
    throw new EditorHostError(
      'The editor host is not configured on this deployment, so a session ' +
        'cannot be opened. Set EDITOR_HOST_URL and EDITOR_CONTROL_SECRET on ' +
        'the app and try again.',
      'EDITOR_HOST_UNCONFIGURED',
      503
    );
  }
  if (secret.length < 32) {
    throw new EditorHostError(
      'EDITOR_CONTROL_SECRET must be at least 32 characters. The editor host ' +
        'control plane is refusing to be reached with a short one.',
      'EDITOR_HOST_WEAK_SECRET',
      503
    );
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new EditorHostError(
      'EDITOR_HOST_URL is not a URL, so there is nowhere to send this.',
      'EDITOR_HOST_UNCONFIGURED',
      503
    );
  }
  if (
    url.protocol !== 'https:' &&
    url.hostname !== '127.0.0.1' &&
    url.hostname !== 'localhost'
  ) {
    throw new EditorHostError(
      'The editor host must be reached over HTTPS or on loopback. The ' +
        'control secret and a client’s whole site travel on this call.',
      'EDITOR_HOST_INSECURE',
      503
    );
  }
  return { url, secret };
}

async function call<T>(
  path: string,
  init: { method: string; body?: unknown }
): Promise<T> {
  const { url, secret } = controlBase();
  const target = new URL(path, url);
  let response: Response;
  try {
    response = await fetch(target, {
      method: init.method,
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (error) {
    throw new EditorHostError(
      'The editor host did not answer. It may be restarting; try again in a ' +
        `moment. (${error instanceof Error ? error.message : 'unknown'})`,
      'EDITOR_HOST_UNREACHABLE',
      502
    );
  }
  if (!response.ok) {
    // The host's own message, when it sent one. It writes plain words too, and
    // repeating them is more useful to an operator than a status code.
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new EditorHostError(
      `The editor host refused this with ${response.status}` +
        (detail ? `: ${detail}` : '.'),
      'EDITOR_HOST_REFUSED',
      502
    );
  }
  return (await response.json()) as T;
}

/**
 * Cuts a fresh worktree for this session out of the manifest we hand it.
 *
 * The files are the workspace's newest published manifest, read here and sent
 * over — the host never reaches into our database, and we never reach into its
 * disk. That is what keeps "the operator worked on a copy of the published
 * site, never on the client's live files" a fact about the wiring rather than
 * a promise in a comment.
 */
export async function materializeEditorWorktree(input: {
  sessionId: string;
  slug: string;
  baseVersion: number;
  files: readonly EditorManifestFile[];
}): Promise<{ worktreePath: string; commitSha: string; fileCount: number }> {
  return call('/__router/sessions', {
    method: 'POST',
    body: {
      sessionId: input.sessionId,
      slug: input.slug,
      baseVersion: input.baseVersion,
      files: input.files,
    },
  });
}

/**
 * Commits the operator's worktree and reads it back.
 *
 * The commit message is decided here, by the build commit policy, and passed
 * in: the host writes what it is told and invents nothing, so a subject the
 * policy would refuse cannot appear in a client's history by way of a box
 * nobody is watching.
 */
export async function shipEditorWorktree(input: {
  sessionId: string;
  message: string;
}): Promise<{
  commitSha: string;
  changed: boolean;
  files: EditorManifestFile[];
}> {
  return call(
    `/__router/sessions/${encodeURIComponent(input.sessionId)}/ship`,
    { method: 'POST', body: { message: input.message } }
  );
}

/**
 * Forgets a session on the host and stops that workspace's editor process, so
 * the next operator gets a clean one rather than inheriting the last one's
 * open files and half-finished agent thread.
 *
 * Best effort by contract: the caller has already closed the row, and a host
 * that could not be reached must not stop an operator from opening a new
 * session. The stale worktree is overwritten by the next materialise anyway.
 */
export async function forgetEditorSession(sessionId: string): Promise<void> {
  try {
    await call(`/__router/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  } catch (error) {
    console.warn(
      '[operator-editor] could not tell the editor host to forget session ' +
        `${sessionId}:`,
      error instanceof Error ? error.message : error
    );
  }
}
