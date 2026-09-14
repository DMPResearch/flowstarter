'use client';

/**
 * The "Custom work" lane on the pipeline board, and its one action.
 *
 * A separate query from `usePipelineBoard` on purpose: the lane's rows are not
 * projects and do not live in `workspaces`, so folding them into that endpoint
 * would have meant one handler doing two unrelated reads and one failure mode
 * taking down both. An operator who cannot load the lane should still see the
 * board.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CustomWorkCard,
  CustomWorkLane,
} from '@/lib/flowstarter/pipeline/custom-work-lane';

export type { CustomWorkCard, CustomWorkLane };

export const customWorkLaneQueryKey = ['custom-work-lane'] as const;

async function readError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(body?.error || fallback);
}

export function useCustomWorkLane() {
  return useQuery({
    queryKey: customWorkLaneQueryKey,
    queryFn: async (): Promise<CustomWorkLane> => {
      const res = await fetch('/api/admin/custom-work-leads', {
        cache: 'no-store',
      });
      if (!res.ok) await readError(res, 'Failed to load the custom work lane');
      return res.json();
    },
    staleTime: 30_000,
    refetchInterval: 120_000,
    retry: 1,
  });
}

export function useMarkCustomWorkContacted() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<{ lead: CustomWorkCard }> => {
      const res = await fetch(`/api/admin/custom-work-leads/${id}/contacted`, {
        method: 'POST',
      });
      if (!res.ok) await readError(res, 'Could not update the lead');
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: customWorkLaneQueryKey });
    },
  });
}
