/**
 * The control plane end to end, through the real router (createRouterServer
 * + stub child, same harness as pipeline.test.ts): health is open, every
 * other route needs the bearer secret, the public-vhost tell
 * (X-Forwarded-Host/-For) is refused with 404 even with the right bearer,
 * a session opens a real worktree on disk, ship commits and returns the
 * files back, and DELETE forgets the session and kills its child.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createRouterServer } from "../src/server.ts";

const STUB = join(import.meta.dir, "stub-child.ts");
const SECRET = "test-control-secret-do-not-use-in-prod";

let workspacesRoot: string;
let stateRoot: string;
let handle: ReturnType<typeof createRouterServer>;
let base: string;

beforeAll(async () => {
  workspacesRoot = await mkdtemp(join(tmpdir(), "fse-ctl-ws-"));
  stateRoot = await mkdtemp(join(tmpdir(), "fse-ctl-st-"));

  process.env.ROUTER_PORT = "0";
  process.env.EDITOR_PUBLIC_DOMAIN = "flowstarter.net";
  process.env.EDITOR_CHILD_CMD = JSON.stringify(["bun", STUB]);
  process.env.EDITOR_WORKSPACES_ROOT = workspacesRoot;
  process.env.EDITOR_STATE_ROOT = stateRoot;
  process.env.EDITOR_CHILD_PORT_START = "47110";
  process.env.EDITOR_CHILD_PORT_END = "47190";
  process.env.EDITOR_IDLE_TTL_MS = "60000";
  process.env.EDITOR_REAP_INTERVAL_MS = "5000";
  process.env.EDITOR_READINESS_TIMEOUT_MS = "8000";
  process.env.EDITOR_CONTROL_SECRET = SECRET;

  handle = createRouterServer(loadConfig());
  base = `http://127.0.0.1:${handle.server.port}`;
});

afterAll(async () => {
  await handle.stop();
  await rm(workspacesRoot, { recursive: true, force: true });
  await rm(stateRoot, { recursive: true, force: true });
});

function uuid(n: number): string {
  // Deterministic, canonical-shaped UUIDs — one per test to avoid
  // cross-test session collisions.
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

describe("GET /__router/health", () => {
  test("is open, no bearer required", async () => {
    const res = await fetch(`${base}/__router/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.children)).toBe(true);
  });
});

describe("bearer auth", () => {
  test("POST /__router/sessions without a bearer is 401", async () => {
    const res = await fetch(`${base}/__router/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: uuid(1), slug: "acme", files: [{ path: "a.txt", content: "x" }] }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /__router/sessions with a wrong bearer is 401", async () => {
    const res = await fetch(`${base}/__router/sessions`, {
      method: "POST",
      headers: { authorization: "Bearer nope", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: uuid(2), slug: "acme", files: [{ path: "a.txt", content: "x" }] }),
    });
    expect(res.status).toBe(401);
  });

  test("a request carrying X-Forwarded-Host is 404 even with the right bearer", async () => {
    const res = await fetch(`${base}/__router/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
        "x-forwarded-host": "acme.flowstarter.net",
      },
      body: JSON.stringify({ sessionId: uuid(3), slug: "acme", files: [{ path: "a.txt", content: "x" }] }),
    });
    expect(res.status).toBe(404);
  });

  test("a request carrying X-Forwarded-For is 404 even with the right bearer", async () => {
    const res = await fetch(`${base}/__router/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
        "x-forwarded-for": "1.2.3.4",
      },
      body: JSON.stringify({ sessionId: uuid(4), slug: "acme", files: [{ path: "a.txt", content: "x" }] }),
    });
    expect(res.status).toBe(404);
  });
});

describe("session lifecycle", () => {
  test("open materialises the worktree under workspacesRoot/slug", async () => {
    const sessionId = uuid(10);
    const res = await fetch(`${base}/__router/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        slug: "lifecycle",
        // A site_versions number, exactly as flowstarter-main sends it off
        // the column. This read "v1" once, and the router's validator was
        // written to match the test rather than the caller: every real open
        // answered 400 until a probe against the running container found it.
        baseVersion: 4,
        files: [{ path: "src/pages/about.astro", content: "<h1>About</h1>" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.worktreePath).toBe(join(workspacesRoot, "lifecycle"));
    expect(body.fileCount).toBe(1);
    expect(typeof body.commitSha).toBe("string");

    const onDisk = await readFile(join(workspacesRoot, "lifecycle", "src/pages/about.astro"), "utf8");
    expect(onDisk).toBe("<h1>About</h1>");

    expect(handle.sessions.get(sessionId)?.slug).toBe("lifecycle");
    expect(handle.sessions.get(sessionId)?.baseVersion).toBe(4);
  });

  test("open accepts 0 (a workspace with no version yet) and refuses nonsense", async () => {
    const send = (baseVersion: unknown) =>
      fetch(`${base}/__router/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: uuid(20),
          slug: "basever",
          baseVersion,
          files: [{ path: "src/pages/index.astro", content: "<h1>Hi</h1>" }],
        }),
      });

    // 0 is the honest value for a workspace whose site has never been
    // versioned, and it must not be confused with "absent".
    expect((await send(0)).status).toBe(200);
    expect((await send(undefined)).status).toBe(200);
    expect((await send("v1")).status).toBe(400);
    expect((await send(-1)).status).toBe(400);
    expect((await send(1.5)).status).toBe(400);
  });

  test("ship commits the change and returns the files back", async () => {
    const sessionId = uuid(11);
    await fetch(`${base}/__router/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        slug: "shipme",
        files: [{ path: "src/pages/about.astro", content: "<h1>About</h1>" }],
      }),
    });

    const worktreePath = join(workspacesRoot, "shipme");
    await Bun.write(join(worktreePath, "src/pages/about.astro"), "<h1>About us</h1>");

    const res = await fetch(`${base}/__router/sessions/${sessionId}/ship`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "Update about copy" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.changed).toBe(true);
    expect(typeof body.commitSha).toBe("string");
    const shippedFile = (body.files as Array<{ path: string; content: string }>).find(
      (f) => f.path === "src/pages/about.astro",
    );
    expect(shippedFile?.content).toBe("<h1>About us</h1>");
  });

  test("DELETE forgets the session and kills the child", async () => {
    const sessionId = uuid(12);
    await fetch(`${base}/__router/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        slug: "deleteme",
        files: [{ path: "a.txt", content: "x" }],
      }),
    });
    // Spin up a child for that slug so we can observe it get killed.
    await fetch(`${base}/whoami`, { headers: { Host: "deleteme.flowstarter.net" } });
    expect(handle.supervisor.liveSlugs()).toContain("deleteme");

    const res = await fetch(`${base}/__router/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);

    expect(handle.sessions.get(sessionId)).toBeUndefined();
    expect(handle.supervisor.liveSlugs()).not.toContain("deleteme");
  });
});

describe("input validation", () => {
  test("a non-UUID sessionId is 400", async () => {
    const res = await fetch(`${base}/__router/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "not-a-uuid", slug: "acme", files: [{ path: "a.txt", content: "x" }] }),
    });
    expect(res.status).toBe(400);
  });

  test("a bad slug is 400", async () => {
    const res = await fetch(`${base}/__router/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: uuid(20), slug: "-nope-", files: [{ path: "a.txt", content: "x" }] }),
    });
    expect(res.status).toBe(400);
  });

  test("an unsafe manifest path is 400", async () => {
    const res = await fetch(`${base}/__router/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: uuid(21), slug: "acme", files: [{ path: "../escape.txt", content: "x" }] }),
    });
    expect(res.status).toBe(400);
  });

  test("ship with a non-UUID sessionId is 400", async () => {
    const res = await fetch(`${base}/__router/sessions/not-a-uuid/ship`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("no EDITOR_CONTROL_SECRET configured", () => {
  test("authenticated routes return 503, not defaulting open", async () => {
    const saved = process.env.EDITOR_CONTROL_SECRET;
    delete process.env.EDITOR_CONTROL_SECRET;
    const unauthedHandle = createRouterServer(loadConfig());
    try {
      const res = await fetch(`http://127.0.0.1:${unauthedHandle.server.port}/__router/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: uuid(99), slug: "acme", files: [{ path: "a.txt", content: "x" }] }),
      });
      expect(res.status).toBe(503);

      // Health stays open regardless.
      const healthRes = await fetch(`http://127.0.0.1:${unauthedHandle.server.port}/__router/health`);
      expect(healthRes.status).toBe(200);
    } finally {
      await unauthedHandle.stop();
      process.env.EDITOR_CONTROL_SECRET = saved;
    }
  });
});
