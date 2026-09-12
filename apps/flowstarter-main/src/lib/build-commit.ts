import { execFileSync } from 'node:child_process';
import { resolveFlowstarterEnv } from '@/lib/supabase-target';

/**
 * Names the commit /api/health is answering for, so a caller waiting on a
 * Hetzner slot (see .github/scripts/wait-for-staging-slot.sh) can tell "the
 * process is up" apart from "the process is up and running the commit I just
 * pushed" -- a rollout in progress answers healthy on the previous commit for
 * as long as the build takes, which is exactly the race that field exists to
 * close.
 *
 * `FLOWSTARTER_BUILD_COMMIT` is the source of truth everywhere that matters:
 * the Hetzner image is built with it as a build arg (see
 * deploy/hetzner-staging/Dockerfile), populated from the git SHA the Depot
 * workflows already build against, and deploy-slot.sh additionally sets it at
 * deploy time from the image tag (also a SHA for every staging slot), which
 * takes effect even for an image built before this field existed.
 *
 * A local `next dev` server has no such build step, so outside production and
 * staging it falls back to the working tree's current HEAD when git is on
 * PATH and this is a checkout, and to the literal string "dev" otherwise.
 *
 * Never throws, and never returns a value that would make a health check fail
 * on its account: an unset commit is reported as `undefined` (the route omits
 * the field) rather than as an error.
 */
export function resolveBuildCommit(
  env: NodeJS.ProcessEnv = process.env,
  readHead: () => string | undefined = readGitHeadSync
): string | undefined {
  const fromEnv = env.FLOWSTARTER_BUILD_COMMIT?.trim();
  if (fromEnv) return fromEnv;

  // A built image (staging or production) with no build arg and no override
  // from deploy-slot.sh means genuinely unknown here; guessing at a git
  // checkout inside a container image that never copied .git would be
  // misleading, so the field is left off for either of those environments.
  // Only `development` (and `test`, which behaves like it for this purpose)
  // is a real git checkout on someone's machine, where reading HEAD directly
  // is both possible and meaningful.
  const resolvedEnv = resolveFlowstarterEnv(env);
  if (resolvedEnv === 'production' || resolvedEnv === 'staging') {
    return undefined;
  }

  return readHead() ?? 'dev';
}

function readGitHeadSync(): string | undefined {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}
