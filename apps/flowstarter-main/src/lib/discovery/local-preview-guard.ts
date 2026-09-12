/**
 * Whether the local-preview frame proxy (`/api/discovery/preview/live/frame`)
 * is allowed to serve anything at all.
 *
 * This is deliberately a standalone rule module rather than an inline `if` in
 * the route: the proxy fetches whatever `astro dev` process the job store
 * points at and re-serves its HTML on the app's own origin, so a signed-in
 * visitor who reaches it gets that generated content running same-site as
 * the real app. That is only acceptable on a developer's own machine.
 *
 * Both conditions below are required:
 *  - `FLOWSTARTER_LOCAL_PREVIEW=true` is the explicit opt-in a developer sets
 *    to run `astro dev` previews locally instead of the Daytona sandbox path.
 *  - The resolved Flowstarter environment (see `lib/supabase-target.ts`,
 *    which already carries the staging/production distinction `NODE_ENV`
 *    alone cannot make) must be `development`. Staging and production run
 *    with a real Clerk session on the app origin; serving arbitrary
 *    generated HTML there would hand it that session's DOM.
 */
import {
  resolveFlowstarterEnv,
  type FlowstarterEnv,
} from '@/lib/supabase-target';

export function isLocalPreviewFrameAllowed(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const resolved: FlowstarterEnv = resolveFlowstarterEnv(env);
  return env.FLOWSTARTER_LOCAL_PREVIEW === 'true' && resolved === 'development';
}
