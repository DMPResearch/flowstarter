/**
 * Per-workspace process supervisor.
 *
 * The editor server is single-project-per-process (one `cwd` per
 * process — serverRuntimeStartup.ts:169-195), so each workspace gets
 * its own child editor process, pinned to `<workspacesRoot>/<slug>`
 * with its own state dir and port. Children are spawned on first
 * request and idle-stopped to bound memory; state in `<stateRoot>/
 * <slug>` survives a restart.
 */

import { mkdir } from "node:fs/promises";
import type { RouterConfig } from "./config.ts";

interface Child {
  readonly slug: string;
  readonly port: number;
  readonly proc: Bun.Subprocess;
  ready: Promise<void>;
  lastActive: number;
  stopping: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolve once a TCP connection to 127.0.0.1:port succeeds. */
async function probePort(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data() {}, open() {}, error() {}, close() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

export class Supervisor {
  private readonly children = new Map<string, Child>();
  private reaper: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor(private readonly cfg: RouterConfig) {}

  start(): void {
    if (this.reaper) return;
    this.reaper = setInterval(
      () => this.reapIdle(),
      this.cfg.reapIntervalMs,
    );
  }

  /** Live children (excludes ones mid-shutdown). For tests/observability. */
  liveSlugs(): string[] {
    return [...this.children.values()]
      .filter((c) => !c.stopping)
      .map((c) => c.slug);
  }

  get(slug: string): Child | undefined {
    return this.children.get(slug);
  }

  /**
   * Kill this slug's child, if one is running, so the next `ensureChild`
   * spawns fresh against whatever is now on disk. Used by the control
   * plane's session DELETE: an operator session ending is exactly the
   * moment the on-disk worktree changed out from under a live process,
   * and that process must not keep serving the stale one.
   */
  stopSlug(slug: string): void {
    const child = this.children.get(slug);
    if (child) this.kill(child);
  }

  /**
   * Ensure a ready child for `slug`; returns its loopback port. Retries
   * a couple of times if a child dies before becoming ready (e.g. a
   * transient port clash).
   */
  async ensureChild(slug: string): Promise<number> {
    if (this.shuttingDown) throw new Error("supervisor shutting down");

    const existing = this.children.get(slug);
    if (existing && !existing.stopping && existing.proc.exitCode === null) {
      existing.lastActive = Date.now();
      await existing.ready;
      return existing.port;
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const child = await this.spawnChild(slug);
        await child.ready;
        child.lastActive = Date.now();
        return child.port;
      } catch (err) {
        lastErr = err;
        await sleep(150);
      }
    }
    throw new Error(
      `failed to start editor for "${slug}": ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }

  private allocatePort(): number {
    const used = new Set<number>();
    for (const c of this.children.values()) used.add(c.port);
    for (let p = this.cfg.childPortStart; p <= this.cfg.childPortEnd; p++) {
      if (!used.has(p)) return p;
    }
    throw new Error("no free child port in configured range");
  }

  private async spawnChild(slug: string): Promise<Child> {
    if (this.children.size >= this.cfg.maxChildren) {
      this.evictLru(slug);
    }

    const cwd = `${this.cfg.workspacesRoot}/${slug}`;
    const stateDir = `${this.cfg.stateRoot}/${slug}`;
    await mkdir(cwd, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const port = this.allocatePort();

    // Child env: inherit, strip router-only vars, pin the editor to a
    // loopback port + its own state, force the cwd-bootstrap path.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k.startsWith("ROUTER_") || k.startsWith("EDITOR_CHILD_")) continue;
      env[k] = v;
    }
    env.T3CODE_PORT = String(port);
    env.T3CODE_HOST = "127.0.0.1";
    env.T3CODE_HOME = stateDir;
    env.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = "true";

    const proc = Bun.spawn({
      cmd: [...this.cfg.childCmd, cwd],
      cwd,
      env,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    });

    const child: Child = {
      slug,
      port,
      proc,
      lastActive: Date.now(),
      stopping: false,
      ready: Promise.resolve(),
    };
    this.children.set(slug, child);

    // Drop the child if it exits on its own.
    void proc.exited.then(() => {
      const cur = this.children.get(slug);
      if (cur && cur.proc === proc) this.children.delete(slug);
    });

    child.ready = this.waitUntilReady(child);
    return child;
  }

  private async waitUntilReady(child: Child): Promise<void> {
    const deadline = Date.now() + this.cfg.readinessTimeoutMs;
    while (Date.now() < deadline) {
      if (child.proc.exitCode !== null) {
        throw new Error(
          `editor process for "${child.slug}" exited (code ${child.proc.exitCode}) before ready`,
        );
      }
      if (await probePort(child.port)) return;
      await sleep(100);
    }
    this.kill(child);
    throw new Error(
      `editor process for "${child.slug}" did not become ready within ${this.cfg.readinessTimeoutMs}ms`,
    );
  }

  private evictLru(except: string): void {
    let victim: Child | null = null;
    for (const c of this.children.values()) {
      if (c.slug === except || c.stopping) continue;
      if (!victim || c.lastActive < victim.lastActive) victim = c;
    }
    if (victim) this.kill(victim);
  }

  private kill(child: Child): void {
    if (child.stopping) return;
    child.stopping = true;
    this.children.delete(child.slug);
    try {
      child.proc.kill();
    } catch {
      /* already gone */
    }
    // Hard-kill if it ignores SIGTERM.
    const proc = child.proc;
    setTimeout(() => {
      if (proc.exitCode === null) {
        try {
          proc.kill(9);
        } catch {
          /* gone */
        }
      }
    }, 5000);
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const child of [...this.children.values()]) {
      if (child.stopping) continue;
      if (now - child.lastActive > this.cfg.idleTtlMs) this.kill(child);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    const procs = [...this.children.values()].map((c) => c.proc);
    for (const child of [...this.children.values()]) this.kill(child);
    await Promise.allSettled(procs.map((p) => p.exited));
  }
}
