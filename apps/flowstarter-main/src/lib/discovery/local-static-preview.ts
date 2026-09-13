import 'server-only';

/**
 * Serving a built preview on a developer's own machine, with no child process.
 *
 * This replaces the `astro dev` fallback, and the reason it exists in this
 * shape is the bug that fallback shipped. Astro 7 hands its dev server off to
 * a detached background daemon and the foreground command exits immediately;
 * the old readiness loop broke on `child.exitCode !== null` before the daemon
 * had bound its port, declared the preview dead, killed the shim that was
 * already gone, and then deleted the directory the surviving daemon was
 * serving. One of those daemons was found still answering 500s three days
 * later. The leak was silent from the day the templates moved to Astro 7
 * until Daytona's key died and made the fallback load-bearing.
 *
 * So: no child process at all. The site is already built by
 * `static-preview-build.ts` — that is the whole point of the platform
 * publisher — and a compiled site is a map of paths to bytes. Serving it is
 * a `node:http` server in this process, holding the files in memory, bound to
 * loopback. `close()` is the entire teardown, there is nothing left to orphan
 * when it is not called, and the directory the build ran in is nobody's
 * dependency because the bytes were read out of it first.
 *
 * Dev only, by construction and by rule: `local-preview-guard.ts` decides who
 * may frame it, and `preview-publisher-rule.ts` only ever selects this
 * publisher on a machine with no previews host configured.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { contentTypeForPath } from '@/lib/flowstarter/site-preview';
import type { ArchiveFile } from '@/lib/hosting/site-archive';

/** Loopback only. A generated site never listens on a LAN interface. */
const LOCAL_PREVIEW_HOST = '127.0.0.1';

export interface LocalStaticPreview {
  /** `http://127.0.0.1:<port>` — what the job stores as its upstream URL. */
  url: string;
  port: number;
  /** Replaces the served bytes in place, for a rebuild after a free edit. */
  update: (files: readonly ArchiveFile[]) => void;
  /** Idempotent. Closes the listener and drops every open socket. */
  close: () => Promise<void>;
}

/**
 * The path a request resolves to inside the build.
 *
 * Astro's static output is directory-shaped: `/about` is `about/index.html`.
 * A request for something that does not exist gets `404.html` when the build
 * produced one and a plain 404 otherwise — never `index.html`, because
 * silently serving the home page for a missing route is how a broken link in
 * a generated site looks fine in the preview and 404s once it is deployed.
 */
export function resolveStaticPreviewPath(
  files: ReadonlyMap<string, ArchiveFile>,
  requestPath: string
): ArchiveFile | undefined {
  const clean = requestPath.split('?')[0]?.split('#')[0] ?? '/';
  const decoded = (() => {
    try {
      return decodeURIComponent(clean);
    } catch {
      return clean;
    }
  })();
  const segments = decoded.split('/').filter(Boolean);
  // `..`, NUL and backslashes cannot escape a Map lookup, but refusing them
  // keeps this the same shape as every other preview path resolver we own.
  if (
    segments.some(
      (segment) =>
        segment === '.' ||
        segment === '..' ||
        segment.includes('\\') ||
        segment.includes('\u0000')
    )
  ) {
    return undefined;
  }
  const joined = segments.join('/');
  const candidates = joined
    ? [joined, `${joined}/index.html`, `${joined}.html`]
    : ['index.html'];
  for (const candidate of candidates) {
    const hit = files.get(candidate);
    if (hit) return hit;
  }
  return undefined;
}

function bodyOf(file: ArchiveFile): Buffer {
  return file.encoding === 'base64'
    ? Buffer.from(file.content, 'base64')
    : Buffer.from(file.content, 'utf8');
}

function indexBy(
  files: readonly ArchiveFile[]
): ReadonlyMap<string, ArchiveFile> {
  return new Map(files.map((file) => [file.path, file]));
}

/**
 * Starts the server and resolves once it is actually listening. There is no
 * readiness poll: `listen` either calls back or errors, which is the whole
 * difference between this and what it replaces.
 */
export async function serveStaticPreview(
  files: readonly ArchiveFile[]
): Promise<LocalStaticPreview> {
  let index = indexBy(files);
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    const hit = resolveStaticPreviewPath(index, req.url ?? '/');
    if (!hit) {
      const notFound = index.get('404.html');
      const body = notFound ? bodyOf(notFound) : Buffer.from('Not found');
      res.writeHead(404, {
        'content-type': notFound ? 'text/html; charset=utf-8' : 'text/plain',
        'content-length': body.byteLength,
      });
      res.end(body);
      return;
    }
    const body = bodyOf(hit);
    res.writeHead(200, {
      'content-type': contentTypeForPath(hit.path),
      'content-length': body.byteLength,
      // A preview is generated content that nobody has approved. It is
      // noindex on the hosted path too (see site-archive.ts); here it costs
      // one header and closes the gap for anything that reaches loopback.
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'cache-control': 'no-store',
    });
    res.end(body);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, LOCAL_PREVIEW_HOST, () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? 0;
  if (!port) {
    await new Promise<void>((done) => server.close(() => done()));
    throw new Error('the local preview server did not get a port');
  }

  let closed = false;
  return {
    url: `http://${LOCAL_PREVIEW_HOST}:${port}`,
    port,
    update: (next) => {
      index = indexBy(next);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      // A keep-alive connection from the wizard iframe would hold `close()`
      // open forever, which is exactly the class of "teardown that does not
      // tear down" this module exists to end.
      sockets.forEach((socket) => socket.destroy());
      sockets.clear();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
