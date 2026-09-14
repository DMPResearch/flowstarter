'use client';

/**
 * The client's view of their own build, polled.
 *
 * Modelled on `useBuildJobLog` in `usePipeline.ts`, and for the same reasons:
 * the worker writes to Supabase from another host, so there is nothing to
 * stream from this process, and the dashboard already polls. Five seconds is
 * the same cadence the operator board uses, so a client and an operator
 * looking at the same build never see it more than one tick apart.
 *
 * The failure behaviour is deliberate. A build with no timeline yet, a route
 * that is not deployed, a dropped connection: none of those is news a client
 * needs, and all three resolve to `null` so the dashboard simply carries on
 * showing what it showed before the agent started. The one thing this hook
 * must never do is put an error where a progress panel was.
 */
import { useQuery } from '@tanstack/react-query';
// Deep path, not the package root: the root re-exports the Pi SDK and the
// whole generation graph, which has no business in a browser bundle.
import type { AgentActivityEvent } from '@flowstarter/agentic-codegen/src/flowstarter/activity';

export interface ClientBuildActivity {
  status: 'running' | 'done' | 'failed';
  events: AgentActivityEvent[];
}

/** How often a live build's timeline is re-read. */
export const CLIENT_BUILD_ACTIVITY_INTERVAL_MS = 5_000;

export const clientBuildActivityQueryKey = (workspaceId: string | undefined) =>
  ['client-build-activity', workspaceId] as const;

export function useClientBuildActivity(
  workspaceId: string | undefined,
  options: { live: boolean }
) {
  return useQuery({
    queryKey: clientBuildActivityQueryKey(workspaceId),
    enabled: Boolean(workspaceId),
    queryFn: async (): Promise<ClientBuildActivity | null> => {
      let res: Response;
      try {
        res = await fetch(`/api/client/site/${workspaceId}/activity`, {
          cache: 'no-store',
        });
      } catch {
        // Offline, a DNS hiccup, the route not deployed yet. None of that is
        // the client's problem to read as a failure.
        return null;
      }
      if (!res.ok) return null;
      try {
        return (await res.json()) as ClientBuildActivity;
      } catch {
        return null;
      }
    },
    staleTime: 2_000,
    refetchInterval: options.live ? CLIENT_BUILD_ACTIVITY_INTERVAL_MS : false,
    retry: 1,
  });
}
