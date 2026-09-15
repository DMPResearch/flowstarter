/**
 * Router/supervisor configuration, resolved from env with safe defaults.
 * In the editor Docker image these are baked/overridden via the
 * container env; the test harness overrides them per-case.
 */

export interface RouterConfig {
  /** Public port the router listens on (Caddy proxies here). */
  readonly listenPort: number;
  readonly listenHost: string;
  /** `EDITOR_PUBLIC_DOMAIN` for slug parsing (mirrors the gate). */
  readonly publicDomain: string | undefined;
  /**
   * Command to spawn for each workspace. The workspace cwd is appended
   * as the final positional arg (the editor server takes cwd as a
   * positional — cli.ts:725). Default runs the built server entry.
   * Overridable via `EDITOR_CHILD_CMD` (JSON array string).
   */
  readonly childCmd: ReadonlyArray<string>;
  /** Where each workspace's checked-out source lives: `<root>/<slug>`. */
  readonly workspacesRoot: string;
  /** Per-workspace editor state (SQLite/threads): `<root>/<slug>`. */
  readonly stateRoot: string;
  /** Inclusive port range for child editor processes. */
  readonly childPortStart: number;
  readonly childPortEnd: number;
  /** Kill a child after this long with no traffic; respawn on next hit. */
  readonly idleTtlMs: number;
  /** How often the idle reaper runs. */
  readonly reapIntervalMs: number;
  /** Give up waiting for a freshly spawned child to accept connections. */
  readonly readinessTimeoutMs: number;
  /** Hard cap on concurrent children (LRU-evict idle when exceeded). */
  readonly maxChildren: number;
  /**
   * Bearer secret the operator-session control plane (`control.ts`)
   * requires on every route except health. Undefined means the control
   * plane is unconfigured — every authenticated route then refuses with
   * 503 rather than defaulting open.
   */
  readonly controlSecret: string | undefined;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function resolveChildCmd(): ReadonlyArray<string> {
  const raw = process.env.EDITOR_CHILD_CMD;
  if (raw && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((p) => typeof p === "string")
      ) {
        return parsed;
      }
      throw new Error("EDITOR_CHILD_CMD must be a non-empty string[] JSON");
    } catch (err) {
      throw new Error(
        `Invalid EDITOR_CHILD_CMD: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const entry =
    process.env.EDITOR_SERVER_ENTRY ??
    "/app/apps/flowstarter-editor/server/dist/bin.mjs";
  return ["node", entry];
}

export function loadConfig(): RouterConfig {
  return {
    listenPort: num("ROUTER_PORT", 3773),
    listenHost: process.env.ROUTER_HOST ?? "0.0.0.0",
    publicDomain: process.env.EDITOR_PUBLIC_DOMAIN,
    childCmd: resolveChildCmd(),
    workspacesRoot: process.env.EDITOR_WORKSPACES_ROOT ?? "/workspaces",
    stateRoot: process.env.EDITOR_STATE_ROOT ?? "/state",
    childPortStart: num("EDITOR_CHILD_PORT_START", 4001),
    childPortEnd: num("EDITOR_CHILD_PORT_END", 4400),
    idleTtlMs: num("EDITOR_IDLE_TTL_MS", 15 * 60 * 1000),
    reapIntervalMs: num("EDITOR_REAP_INTERVAL_MS", 15 * 1000),
    readinessTimeoutMs: num("EDITOR_READINESS_TIMEOUT_MS", 45 * 1000),
    maxChildren: num("EDITOR_MAX_CHILDREN", 25),
    controlSecret: process.env.EDITOR_CONTROL_SECRET,
  };
}
