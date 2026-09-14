'use client';

/**
 * Operator access to the Flowstarter editor on one project: what session is
 * open, opening one, shipping it, closing it.
 *
 * Hits `/api/admin/*` rather than `/api/team/*` for the same reason every
 * other operator hook does — the two trees are the same handlers, and the
 * dashboard has always called the admin one.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OperatorEditorState } from '@/lib/flowstarter/operator-editor-api';
import type { OperatorEditorSessionView } from '@/lib/flowstarter/operator-editor';

export type { OperatorEditorState, OperatorEditorSessionView };

export const operatorEditorQueryKey = (id: string | undefined) =>
  ['operator-editor', id] as const;

/**
 * The open session, its history, and whether one may be opened at all.
 *
 * Polled while something is in flight, because `opening` and `shipping` both
 * resolve elsewhere — on the editor host and in the build worker respectively
 * — and an operator staring at a stale card is how a second session gets
 * opened over a first.
 */
export function useOperatorEditor(id: string | undefined) {
  return useQuery({
    queryKey: operatorEditorQueryKey(id),
    enabled: Boolean(id),
    queryFn: async (): Promise<OperatorEditorState> => {
      const res = await fetch(`/api/admin/projects/${id}/editor`, {
        cache: 'no-store',
      });
      if (!res.ok) await readError(res, 'Failed to load the editor session');
      return res.json();
    },
    refetchInterval: (query) => {
      const status = query.state.data?.open?.status;
      return status === 'opening' || status === 'shipping' ? 4_000 : false;
    },
    staleTime: 5_000,
    retry: 1,
  });
}

async function readError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(body?.error || fallback);
}

interface OpenResult extends OperatorEditorState {
  /** The editor URL with a one-minute sign-in ticket on it, or null. */
  url: string | null;
  /** True when this call joined a session somebody already had open. */
  joined: boolean;
}

export function useOpenOperatorEditor(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<OpenResult> => {
      if (!id) throw new Error('Missing project id');
      const res = await fetch(`/api/admin/projects/${id}/editor`, {
        method: 'POST',
        cache: 'no-store',
      });
      if (!res.ok) await readError(res, 'Could not open the editor');
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: operatorEditorQueryKey(id) });
    },
  });
}

interface ShipResult extends OperatorEditorState {
  jobId: string;
  dispatched: boolean;
  files: number;
}

export function useShipOperatorEditor(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { note?: string }): Promise<ShipResult> => {
      if (!id) throw new Error('Missing project id');
      const res = await fetch(`/api/admin/projects/${id}/editor/ship`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: input.note ?? '' }),
        cache: 'no-store',
      });
      if (!res.ok) await readError(res, 'Could not ship the editor session');
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: operatorEditorQueryKey(id) });
      // The ship queues a build, so the pipeline board is stale too.
      void qc.invalidateQueries({ queryKey: ['pipeline-detail', id] });
    },
  });
}

export function useCloseOperatorEditor(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<OperatorEditorState> => {
      if (!id) throw new Error('Missing project id');
      const res = await fetch(`/api/admin/projects/${id}/editor`, {
        method: 'DELETE',
        cache: 'no-store',
      });
      if (!res.ok) await readError(res, 'Could not close the editor session');
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: operatorEditorQueryKey(id) });
    },
  });
}
