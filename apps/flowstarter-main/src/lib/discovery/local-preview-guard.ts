/**
 * Whether the local-preview frame proxy (`/api/discovery/preview/live/frame`)
 * is allowed to serve anything at all.
 *
 * This is deliberately a standalone rule module rather than an inline `if` in
 * the route: the proxy fetches whatever local preview server the job store
 * points at and re-serves its HTML on the app's own origin, so a signed-in
 * visitor who reaches it gets that generated content running same-site as
 * the real app. That is only acceptable on a developer's own machine.
 *
 * Two conditions, and the environment one is not negotiable:
 *  - The resolved Flowstarter environment (see `lib/supabase-target.ts`,
 *    which already carries the staging/production distinction `NODE_ENV`
 *    alone cannot make) must be `development`. Staging and production run
 *    with a real Clerk session on the app origin; serving arbitrary
 *    generated HTML there would hand it that session's DOM.
 *  - There has to be a local preview to frame. That is true either because a
 *    developer set `FLOWSTARTER_LOCAL_PREVIEW=true` by hand, or because the
 *    publisher rule already chose `local-static` for this process — which it
 *    only ever does in development with no previews host configured. Asking
 *    the rule rather than duplicating its conditions is what keeps the proxy
 *    and the publisher from disagreeing about whether a local preview exists.
 */
import {
  resolveFlowstarterEnv,
  type FlowstarterEnv,
} from '@/lib/supabase-target';
import { resolvePreviewPublisher } from './preview-publisher-rule';

export function isLocalPreviewFrameAllowed(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const resolved: FlowstarterEnv = resolveFlowstarterEnv(env);
  if (resolved !== 'development') return false;
  if (env.FLOWSTARTER_LOCAL_PREVIEW === 'true') return true;
  return resolvePreviewPublisher(env).publisher === 'local-static';
}

/**
 * Throws when `FLOWSTARTER_LOCAL_PREVIEW=true` is set outside `development`.
 *
 * This is the same rule as `isLocalPreviewFrameAllowed` above, phrased as an
 * assertion instead of a boolean so it can be called from two places that
 * each need a different reaction to a bad value:
 *  - `src/env.ts` calls this during `createEnv`'s startup validation, so a
 *    staging or production deploy that inherits this flag from a shared
 *    `.env` file (or a copy-pasted local override) refuses to boot instead
 *    of quietly becoming willing to spawn `astro dev` on the app host.
 *  - `publishLocalPreview` in
 *    `app/api/discovery/preview/live/route.ts` calls this immediately
 *    before it spawns anything, so a sandbox failure can never fall through
 *    to native execution outside development even if the process somehow
 *    started with the flag set (for example a test harness that stubs
 *    `process.env` after startup).
 *
 * Kept here, next to `isLocalPreviewFrameAllowed`, so the two conditions are
 * defined once instead of being re-derived at each call site.
 */
export function assertLocalPreviewEnvAllowed(
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env.FLOWSTARTER_LOCAL_PREVIEW !== 'true') return;

  const resolved: FlowstarterEnv = resolveFlowstarterEnv(env);
  if (resolved === 'development') return;

  throw new Error(
    `FLOWSTARTER_LOCAL_PREVIEW=true is set, but the resolved Flowstarter environment is "${resolved}", not "development". ` +
      'This flag spawns `astro dev` over generated tenant source directly on the process running this app, ' +
      'and that child process would inherit every credential this app holds. That is only acceptable on a ' +
      'developer machine, never on staging or production. Fix this by removing FLOWSTARTER_LOCAL_PREVIEW from ' +
      "this environment's configuration, or, if this really is a local development machine, set " +
      'FLOWSTARTER_ENV=development (or leave both FLOWSTARTER_ENV and NODE_ENV unset, which also resolves to development).'
  );
}
