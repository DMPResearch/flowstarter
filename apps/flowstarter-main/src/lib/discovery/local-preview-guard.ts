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
