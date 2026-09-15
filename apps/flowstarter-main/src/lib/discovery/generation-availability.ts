/**
 * Whether this process can actually run the live preview pipeline.
 *
 * `POST /api/discovery/preview/live` used to learn this the hard way: it
 * created the job, told the visitor a build was "building", and only then
 * checked, inside the detached worker, whether Pi, the MCP template library
 * and the publish step were configured. In production none of them are (no
 * previews deploy-agent, no `FLOWSTARTER_MCP_URL`, no
 * `FLOWSTARTER_MCP_INTERNAL_TOKEN`), so every job failed a few hundred
 * milliseconds after it started, and the visitor watched "Getting your build
 * started" turn into "The build stopped", a real-looking failure for a
 * situation that was never going to work.
 *
 * This check runs before the job exists, so the route can tell the truth
 * up front instead of narrating a doomed attempt.
 *
 * Checking that `FLOWSTARTER_MCP_URL` is merely *set* turned out not to be
 * enough: a real run died with `StreamableHTTPClientTransport already
 * started!` because the MCP server behind that URL simply was not running,
 * and the honest connection-refused got masked by the client's own retry
 * path (see `template-library-mcp.ts`). So when the URL is configured this
 * module now also probes it — a bounded `GET /health` against the server's
 * root, not the MCP path itself — before calling the prerequisite satisfied.
 * That probe is a real network call, so every function here is async.
 */
import { missingPreviewPublisherConfig } from './preview-publisher-rule';

export interface GenerationPrerequisite {
  /** The name reported in logs and tests; not a secret value. */
  readonly name: string;
  readonly present: boolean;
}

/** Long enough for a same-host or same-network health check, short enough that a dead server fails fast. */
export const DEFAULT_MCP_HEALTH_TIMEOUT_MS = 2_000;

/**
 * A plain env-shaped record rather than `NodeJS.ProcessEnv`: Next.js
 * augments that global interface with a required `NODE_ENV`
 * (`next/types/global.d.ts`), which would force every test fixture below to
 * carry a field this module never reads. `process.env` itself still
 * satisfies this looser shape.
 */
type EnvLike = Record<string, string | undefined>;

function trimmed(value: string | undefined): string {
  return value?.trim() ?? '';
}

/**
 * The MCP server's health endpoint lives at its ROOT, not under whatever
 * path `FLOWSTARTER_MCP_URL` points the MCP protocol itself at (typically
 * `/mcp`) — so this replaces the pathname rather than concatenating onto the
 * full URL, which would ask for `/mcp/health` and always miss.
 */
function healthCheckUrl(mcpUrl: string): string | null {
  try {
    const url = new URL(mcpUrl);
    url.pathname = '/health';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A bounded `GET` against the MCP server's `/health`. Anything other than a
 * clean 2xx inside the timeout — refused connection, DNS failure, a hang, a
 * 5xx — counts as "not answering": the point is to catch exactly the
 * "server isn't running" case that a mere `Boolean(url)` check let through.
 *
 * Exported (originally #142's private helper) so `/api/health` can reuse the
 * exact same probe for its `templateLibrary` field instead of growing a
 * second, possibly-diverging implementation.
 */
export async function probeMcpHealth(
  mcpUrl: string,
  env: EnvLike = process.env
): Promise<boolean> {
  const url = healthCheckUrl(mcpUrl);
  if (!url) return false;
  const configuredTimeout = Number(
    env.FLOWSTARTER_MCP_HEALTH_TIMEOUT_MS?.trim()
  );
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_MCP_HEALTH_TIMEOUT_MS;
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Every prerequisite the live pipeline reads before it can start a run,
 * mirrored from the checks in `preview/live/route.ts`. `PI_API_KEY` and
 * `OPENROUTER_API_KEY` are one requirement: either satisfies it.
 *
 * `FLOWSTARTER_MCP_URL` being set is necessary but not sufficient — when it
 * is set, this also probes the server's `/health` before trusting it. A
 * failed probe adds its own prerequisite entry (`template library not
 * answering at ${url}`) alongside, rather than replacing, the "is it
 * configured at all" entry, so the two failure modes stay distinguishable
 * in the missing list.
 */
export async function generationPrerequisites(
  env: EnvLike = process.env
): Promise<GenerationPrerequisite[]> {
  const mcpUrl = trimmed(env.FLOWSTARTER_MCP_URL);

  const prerequisites: GenerationPrerequisite[] = [
    {
      name: 'PI_API_KEY or OPENROUTER_API_KEY',
      present: Boolean(
        trimmed(env.PI_API_KEY) || trimmed(env.OPENROUTER_API_KEY)
      ),
    },
    {
      name: 'FLOWSTARTER_MCP_URL',
      present: Boolean(mcpUrl),
    },
  ];

  if (mcpUrl) {
    const healthy = await probeMcpHealth(mcpUrl, env);
    if (!healthy) {
      prerequisites.push({
        name: `template library not answering at ${mcpUrl}`,
        present: false,
      });
    }
  }

  prerequisites.push({
    name: 'FLOWSTARTER_MCP_INTERNAL_TOKEN',
    present: Boolean(trimmed(env.FLOWSTARTER_MCP_INTERNAL_TOKEN)),
  });

  // The publish step's requirement is whatever the publisher this process
  // resolved to needs — the previews deploy-agent for the platform
  // publisher, `DAYTONA_API_KEY` only when an operator asked for Daytona by
  // name, and nothing at all on a developer machine, which serves its own
  // build. It used to be a flat `DAYTONA_API_KEY`, which is how a revoked
  // third-party key came to fail 100% of previews at the last phase.
  prerequisites.push(
    ...missingPreviewPublisherConfig(env).map((name) => ({
      name,
      present: false,
    }))
  );

  return prerequisites;
}

/** Names only, never a value, so this is safe in a log line. */
export async function missingGenerationPrerequisites(
  env: EnvLike = process.env
): Promise<string[]> {
  return (await generationPrerequisites(env))
    .filter((p) => !p.present)
    .map((p) => p.name);
}

export async function canRunPreviewGeneration(
  env: EnvLike = process.env
): Promise<boolean> {
  return (await missingGenerationPrerequisites(env)).length === 0;
}
