/**
 * The operator-session control plane, served by the router BEFORE slug
 * routing (server.ts calls this first on every request). This is what
 * turns `<workspacesRoot>/<slug>` from an empty directory `mkdir`-ed by
 * the supervisor into a real git worktree an operator can edit and ship
 * — see worktree.ts for the materialize/read/commit mechanics this
 * wraps in HTTP.
 *
 * Two rules make exposing this safe, both enforced in `authorize` below:
 *
 * 1. Every route except health requires a bearer secret
 *    (`EDITOR_CONTROL_SECRET`), compared in constant time. No secret
 *    configured means every authenticated route refuses with 503 —
 *    NEVER defaults open just because the operator forgot to set one.
 * 2. The control plane must never be reachable from the public tenant
 *    vhost. Caddy proxies `<slug>.<domain>/editor/*` here with
 *    `handle_path`, which strips the `/editor` prefix — so a browser on
 *    the public vhost CAN reach `/__router/...` on this same port. Caddy
 *    stamps `X-Forwarded-Host` (and usually `X-Forwarded-For`) on
 *    everything it forwards; the router's own loopback caller
 *    (flowstarter-main, hitting the container's control port directly)
 *    never sets either. So either header present means "this did not
 *    arrive on the container's own loopback port" and the request is
 *    refused outright, regardless of whether the bearer was right.
 */

import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { RouterConfig } from "./config.ts";
import { parseWorkspaceSlugFromHost } from "./slug.ts";
import type { Supervisor } from "./supervisor.ts";
import {
  assertSafeManifestPath,
  commitWorktree,
  materializeWorktree,
  readWorktreeFiles,
  type ManifestFile,
} from "./worktree.ts";

const CONTROL_PREFIX = "/__router/";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 200;
const MAX_MANIFEST_FILES = 3000;
// Bun.serve's own maxRequestBodySize (server.ts) is a server-wide 256 MB,
// set once for the whole listener including the slug-routed reverse
// proxy. The control plane wants a tighter cap on its own JSON bodies;
// checked against Content-Length up front so an oversized body is
// rejected before it is ever read into memory.
const CONTROL_BODY_CAP_BYTES = 128 * 1024 * 1024;

export interface SessionRecord {
  readonly sessionId: string;
  readonly slug: string;
  readonly worktreePath: string;
  /**
   * The `site_versions.version` the worktree was cut from. A NUMBER, and 0 for
   * a workspace with no version yet. It was typed as a string here once, which
   * meant the control plane answered 400 to every real call flowstarter-main
   * made -- the app sends the integer straight off the column. Caught against
   * the running container, not by a unit test, because the test sent "v1".
   */
  readonly baseVersion: number | null;
  readonly createdAt: number;
}

/**
 * In-memory session table — deliberately not persisted anywhere. The
 * database row in flowstarter-main is the record of truth for an
 * operator session; a router restart just means the next ship call has
 * to re-open the session (flowstarter-main re-materialises via
 * POST /sessions again). That is strictly better than the router holding
 * a second, stale copy of the truth that could disagree with the
 * database after a restart.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();

  register(record: SessionRecord): void {
    this.sessions.set(record.sessionId, record);
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  get size(): number {
    return this.sessions.size;
  }
}

export interface ControlDeps {
  readonly sessions: SessionRegistry;
  /** Supplies the health route's `children` list without importing Supervisor's full surface. */
  readonly liveSlugs: () => string[];
  readonly supervisor: Pick<Supervisor, "stopSlug">;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function badRequest(message: string): Response {
  return jsonResponse(400, { error: message });
}

/**
 * Constant-time bearer check. `a === b` short-circuits on the first
 * differing byte, which leaks how many leading characters a guess got
 * right through response timing. SHA-256 both sides first — fixed
 * 32-byte output regardless of input length, so the buffers handed to
 * `timingSafeEqual` (which requires equal-length input) are always
 * comparable, and the comparison itself is constant-time by design.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = new Bun.CryptoHasher("sha256").update(a).digest();
  const digestB = new Bun.CryptoHasher("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function isPrintableAscii(s: string): boolean {
  return /^[\x20-\x7e]+$/.test(s);
}

function bodyTooLarge(req: Request): boolean {
  const len = req.headers.get("content-length");
  if (!len) return false; // no length header — manifest/message caps still apply after parsing
  const n = Number(len);
  return Number.isFinite(n) && n > CONTROL_BODY_CAP_BYTES;
}

/** Null when authorized; a Response to return immediately otherwise. */
function authorize(req: Request, cfg: RouterConfig): Response | null {
  if (!cfg.controlSecret) {
    return jsonResponse(503, {
      error: "this editor host has no EDITOR_CONTROL_SECRET configured; refusing every control route rather than defaulting open",
    });
  }
  if (req.headers.has("x-forwarded-host") || req.headers.has("x-forwarded-for")) {
    // Looks exactly like every other unrouted path to a prober on the
    // public vhost — 404, not 401, gives nothing away about there being
    // a control plane to authenticate against at all.
    return new Response("Not found", { status: 404 });
  }
  const auth = req.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(auth);
  if (!match || !match[1] || !timingSafeStringEqual(match[1], cfg.controlSecret)) {
    return jsonResponse(401, { error: "missing or invalid control bearer token" });
  }
  return null;
}

/** Validates a raw `files` field into ManifestFile[], or returns an error string. */
function validateManifestFiles(files: unknown): ManifestFile[] | string {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_MANIFEST_FILES) {
    return `files must be an array of 1..${MAX_MANIFEST_FILES} entries`;
  }
  const out: ManifestFile[] = [];
  for (const entry of files) {
    if (typeof entry !== "object" || entry === null) return "each file entry must be an object";
    const { path, content, encoding } = entry as Record<string, unknown>;
    if (typeof path !== "string") return "each file entry needs a string path";
    if (typeof content !== "string") return "each file entry needs string content";
    if (encoding !== undefined && encoding !== "base64") return `unsupported encoding for "${path}"`;
    try {
      assertSafeManifestPath(path);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    out.push(encoding === "base64" ? { path, content, encoding: "base64" } : { path, content });
  }
  return out;
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | string> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return "request body must be JSON";
  }
  if (typeof body !== "object" || body === null) return "request body must be a JSON object";
  return body as Record<string, unknown>;
}

async function handleCreateSession(req: Request, cfg: RouterConfig, sessions: SessionRegistry): Promise<Response> {
  if (bodyTooLarge(req)) return jsonResponse(413, { error: `request body exceeds the ${CONTROL_BODY_CAP_BYTES}-byte cap` });

  const body = await readJsonBody(req);
  if (typeof body === "string") return badRequest(body);
  const { sessionId, slug, baseVersion, files } = body;

  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
    return badRequest("sessionId must be a canonical UUID");
  }
  if (typeof slug !== "string") return badRequest("slug must be a string");

  // Reuse the real routing rule so the control plane can never create a
  // worktree the router itself would refuse to route to.
  const domain = cfg.publicDomain ?? "flowstarter.net";
  const parsedSlug = parseWorkspaceSlugFromHost(`${slug}.${domain}`, cfg.publicDomain);
  if (!parsedSlug) {
    return badRequest(`"${slug}" is not a routable workspace slug`);
  }

  if (
    baseVersion !== undefined &&
    baseVersion !== null &&
    (typeof baseVersion !== "number" ||
      !Number.isInteger(baseVersion) ||
      baseVersion < 0)
  ) {
    return badRequest(
      "baseVersion must be a non-negative integer when present",
    );
  }

  const filesOrError = validateManifestFiles(files);
  if (typeof filesOrError === "string") return badRequest(filesOrError);

  let materialized: { path: string; commitSha: string; fileCount: number };
  try {
    materialized = await materializeWorktree({
      workspacesRoot: cfg.workspacesRoot,
      root: join(cfg.workspacesRoot, parsedSlug),
      files: filesOrError,
      label: `session ${sessionId}: open`,
    });
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }

  sessions.register({
    sessionId,
    slug: parsedSlug,
    worktreePath: materialized.path,
    baseVersion: typeof baseVersion === "number" ? baseVersion : null,
    createdAt: Date.now(),
  });

  return jsonResponse(200, {
    worktreePath: materialized.path,
    commitSha: materialized.commitSha,
    fileCount: materialized.fileCount,
  });
}

async function handleShip(req: Request, sessionId: string, sessions: SessionRegistry): Promise<Response> {
  if (!UUID_RE.test(sessionId)) return badRequest("sessionId must be a canonical UUID");
  const session = sessions.get(sessionId);
  if (!session) return jsonResponse(404, { error: `no open session "${sessionId}"` });

  if (bodyTooLarge(req)) return jsonResponse(413, { error: `request body exceeds the ${CONTROL_BODY_CAP_BYTES}-byte cap` });

  const body = await readJsonBody(req);
  if (typeof body === "string") return badRequest(body);
  const { message } = body;
  if (typeof message !== "string" || message.length < 1 || message.length > MAX_MESSAGE_LENGTH || !isPrintableAscii(message)) {
    return badRequest(`message must be 1..${MAX_MESSAGE_LENGTH} chars of printable ASCII`);
  }

  let result: { commitSha: string; changed: boolean };
  try {
    result = await commitWorktree({ root: session.worktreePath, message });
  } catch (err) {
    return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
  }
  const files = await readWorktreeFiles(session.worktreePath);
  return jsonResponse(200, { commitSha: result.commitSha, changed: result.changed, files });
}

function handleDeleteSession(sessionId: string, deps: ControlDeps): Response {
  if (!UUID_RE.test(sessionId)) return badRequest("sessionId must be a canonical UUID");
  const session = deps.sessions.get(sessionId);
  if (session) {
    deps.sessions.forget(sessionId);
    // The on-disk worktree just changed out from under whatever child
    // process is serving that slug (or is about to be re-materialised
    // for the next session) — kill it so the next hit spawns fresh.
    deps.supervisor.stopSlug(session.slug);
  }
  return jsonResponse(200, { ok: true });
}

/**
 * Entry point: returns null when `req` is not a control-plane path (the
 * caller falls through to slug routing), a Response otherwise.
 */
export async function handleControlRequest(
  req: Request,
  cfg: RouterConfig,
  deps: ControlDeps,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith(CONTROL_PREFIX)) return null;

  if (url.pathname === "/__router/health") {
    // Unauthenticated on purpose, same as before this module existed —
    // Caddy's own healthcheck hits this, and it leaks nothing but
    // "the router is up and these slugs are warm".
    return jsonResponse(200, { ok: true, children: deps.liveSlugs() });
  }

  const denied = authorize(req, cfg);
  if (denied) return denied;

  if (url.pathname === "/__router/sessions" && req.method === "POST") {
    return handleCreateSession(req, cfg, deps.sessions);
  }

  const shipMatch = /^\/__router\/sessions\/([^/]+)\/ship$/.exec(url.pathname);
  if (shipMatch && req.method === "POST") {
    return handleShip(req, shipMatch[1] ?? "", deps.sessions);
  }

  const sessionMatch = /^\/__router\/sessions\/([^/]+)$/.exec(url.pathname);
  if (sessionMatch && req.method === "DELETE") {
    return handleDeleteSession(sessionMatch[1] ?? "", deps);
  }

  return jsonResponse(404, { error: `no control route for ${req.method} ${url.pathname}` });
}
