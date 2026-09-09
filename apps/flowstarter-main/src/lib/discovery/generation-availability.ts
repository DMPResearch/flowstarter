/**
 * Whether this process can actually run the live preview pipeline.
 *
 * `POST /api/discovery/preview/live` used to learn this the hard way: it
 * created the job, told the visitor a build was "building", and only then
 * checked, inside the detached worker, whether Pi, the MCP template library
 * and Daytona were configured. On Netlify Functions none of them are (no
 * `DAYTONA_API_KEY`, no `FLOWSTARTER_MCP_URL`, no
 * `FLOWSTARTER_MCP_INTERNAL_TOKEN`), so every job failed a few hundred
 * milliseconds after it started, and the visitor watched "Getting your build
 * started" turn into "The build stopped", a real-looking failure for a
 * situation that was never going to work.
 *
 * This check runs before the job exists, so the route can tell the truth
 * up front instead of narrating a doomed attempt.
 */
export interface GenerationPrerequisite {
  /** The name reported in logs and tests; not a secret value. */
  readonly name: string;
  readonly present: boolean;
}

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
 * Every prerequisite the live pipeline reads before it can start a run,
 * mirrored from the checks in `preview/live/route.ts`. `PI_API_KEY` and
 * `OPENROUTER_API_KEY` are one requirement: either satisfies it.
 */
export function generationPrerequisites(
  env: EnvLike = process.env
): GenerationPrerequisite[] {
  return [
    {
      name: 'PI_API_KEY or OPENROUTER_API_KEY',
      present: Boolean(
        trimmed(env.PI_API_KEY) || trimmed(env.OPENROUTER_API_KEY)
      ),
    },
    {
      name: 'FLOWSTARTER_MCP_URL',
      present: Boolean(trimmed(env.FLOWSTARTER_MCP_URL)),
    },
    {
      name: 'FLOWSTARTER_MCP_INTERNAL_TOKEN',
      present: Boolean(trimmed(env.FLOWSTARTER_MCP_INTERNAL_TOKEN)),
    },
    {
      name: 'DAYTONA_API_KEY',
      present: Boolean(trimmed(env.DAYTONA_API_KEY)),
    },
  ];
}

/** Names only, never a value, so this is safe in a log line. */
export function missingGenerationPrerequisites(
  env: EnvLike = process.env
): string[] {
  return generationPrerequisites(env)
    .filter((p) => !p.present)
    .map((p) => p.name);
}

export function canRunPreviewGeneration(env: EnvLike = process.env): boolean {
  return missingGenerationPrerequisites(env).length === 0;
}
