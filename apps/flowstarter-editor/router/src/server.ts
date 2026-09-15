/**
 * The router HTTP/WS front. Caddy proxies `<slug>.<domain>/editor/*`
 * here (DEPLOY_AGENT_EDITOR_UPSTREAM = editor:3773). We parse the slug
 * from the preserved `Host`, ensure that workspace's child editor
 * process is up, and reverse-proxy HTTP **and** websockets to it. The
 * child still runs its own clerkGate membership check — the router
 * only routes; auth stays in the editor.
 */

import type { RouterConfig } from "./config.ts";
import { handleControlRequest, SessionRegistry } from "./control.ts";
import { parseWorkspaceSlugFromHost } from "./slug.ts";
import { Supervisor } from "./supervisor.ts";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface SocketData {
  readonly targetUrl: string;
  readonly headers: Record<string, string>;
  upstream: WebSocket | null;
  /** client→upstream frames received before upstream is open. */
  readonly pending: Array<string | Uint8Array>;
}

function forwardedHeaders(req: Request, host: string): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) return;
    if (k === "content-length") return; // re-derived by the runtime
    out[k] = value;
  });
  // Preserve the original Host so the child's clerkGate sees the slug.
  out.host = host;
  const xff = req.headers.get("x-forwarded-for");
  out["x-forwarded-for"] = xff ? `${xff}` : "router";
  out["x-forwarded-host"] = host;
  out["x-forwarded-proto"] =
    req.headers.get("x-forwarded-proto") ?? "https";
  return out;
}

export function createRouterServer(cfg: RouterConfig) {
  const supervisor = new Supervisor(cfg);
  supervisor.start();
  const sessions = new SessionRegistry();

  const server = Bun.serve<SocketData>({
    port: cfg.listenPort,
    hostname: cfg.listenHost,
    // Long-lived agent turns + big uploads.
    idleTimeout: 0,
    maxRequestBodySize: 256 * 1024 * 1024,

    async fetch(req, srv) {
      const url = new URL(req.url);

      // Operator-session control plane (open/ship/close a worktree) —
      // checked before slug routing since it lives under its own
      // `/__router/` path, not a tenant subdomain. Returns null for any
      // request that isn't a control-plane path.
      const control = await handleControlRequest(req, cfg, {
        sessions,
        liveSlugs: () => supervisor.liveSlugs(),
        supervisor,
      });
      if (control) return control;

      const host = req.headers.get("host");
      const slug = parseWorkspaceSlugFromHost(host, cfg.publicDomain);
      if (!slug) {
        return new Response(
          "No Flowstarter workspace in host. Expected <slug>." +
            (cfg.publicDomain ?? "flowstarter.net"),
          { status: 404, headers: { "content-type": "text/plain" } },
        );
      }

      let port: number;
      try {
        port = await supervisor.ensureChild(slug);
      } catch (err) {
        return new Response(
          `Editor unavailable for "${slug}": ${
            err instanceof Error ? err.message : String(err)
          }`,
          { status: 502, headers: { "content-type": "text/plain" } },
        );
      }

      const headers = forwardedHeaders(req, host ?? slug);

      // WebSocket upgrade → hand off to the websocket handlers.
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const targetUrl = `ws://127.0.0.1:${port}${url.pathname}${url.search}`;
        const ok = srv.upgrade(req, {
          data: { targetUrl, headers, upstream: null, pending: [] },
        });
        if (ok) return undefined;
        return new Response("WebSocket upgrade failed", { status: 426 });
      }

      // Plain HTTP reverse proxy.
      const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      let upstream: Response;
      try {
        upstream = await fetch(target, {
          method: req.method,
          headers,
          body: hasBody ? req.body : undefined,
          redirect: "manual",
          // Stream the request body through.
          ...(hasBody ? { duplex: "half" } : {}),
        } as RequestInit);
      } catch (err) {
        return new Response(
          `Upstream error for "${slug}": ${
            err instanceof Error ? err.message : String(err)
          }`,
          { status: 502 },
        );
      }

      const respHeaders = new Headers();
      upstream.headers.forEach((value, key) => {
        const k = key.toLowerCase();
        if (HOP_BY_HOP.has(k)) return;
        // fetch already decoded the body; let the runtime re-frame it.
        if (k === "content-encoding" || k === "content-length") return;
        respHeaders.set(key, value);
      });
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });
    },

    websocket: {
      open(ws) {
        const { targetUrl, headers } = ws.data;
        const upstream = new WebSocket(targetUrl, { headers });
        upstream.binaryType = "arraybuffer";
        ws.data.upstream = upstream;

        upstream.addEventListener("open", () => {
          for (const frame of ws.data.pending) upstream.send(frame);
          ws.data.pending.length = 0;
        });
        upstream.addEventListener("message", (ev: MessageEvent) => {
          const d = ev.data;
          if (typeof d === "string") ws.send(d);
          else if (d instanceof ArrayBuffer) ws.send(new Uint8Array(d));
          else ws.send(d as Uint8Array);
        });
        upstream.addEventListener("close", (ev: CloseEvent) => {
          try {
            ws.close(ev.code || 1000, ev.reason || "");
          } catch {
            /* already closed */
          }
        });
        upstream.addEventListener("error", () => {
          try {
            ws.close(1011, "upstream error");
          } catch {
            /* already closed */
          }
        });
      },
      message(ws, message) {
        const frame =
          typeof message === "string"
            ? message
            : message instanceof Uint8Array
              ? message
              : new Uint8Array(message as ArrayBuffer);
        const up = ws.data.upstream;
        if (up && up.readyState === WebSocket.OPEN) up.send(frame);
        else ws.data.pending.push(frame);
      },
      close(ws, code, reason) {
        const up = ws.data.upstream;
        if (up) {
          try {
            up.close(code || 1000, reason || "");
          } catch {
            /* already closed */
          }
        }
      },
    },
  });

  return {
    server,
    supervisor,
    sessions,
    async stop() {
      await supervisor.shutdown();
      server.stop(true);
    },
  };
}
