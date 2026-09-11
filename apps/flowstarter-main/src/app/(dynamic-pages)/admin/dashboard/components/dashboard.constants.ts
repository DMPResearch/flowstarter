import { useQuery } from '@tanstack/react-query';
import type { TranslationKeys } from '@/lib/i18n';
import type { Tone } from '@flowstarter/flow-design-system';

// ─── Stage display (read-only — kanban owns the writes) ───────────────────

export const STAGE_I18N_KEYS: Partial<Record<string, TranslationKeys>> = {
  intake: 'admin.stage.intake',
  brief: 'admin.stage.brief',
  build: 'admin.stage.build',
  internal_review: 'admin.stage.build',
  client_review: 'admin.stage.review',
  launched: 'admin.stage.live',
  care: 'admin.stage.live',
};

/**
 * The lifecycle in colour: `neutral` before anything has started, `info` once
 * there is a brief, `warn` while it is being built or reviewed internally
 * (there is work an operator owns), `accent` once it is in front of the
 * client, `ok` once it has launched. Anything unrecognised falls back to
 * `neutral` rather than guessing.
 */
export const STAGE_TONE: Record<string, Tone> = {
  intake: 'neutral',
  brief: 'info',
  build: 'warn',
  internal_review: 'warn',
  client_review: 'accent',
  launched: 'ok',
  care: 'ok',
};

export function stageTone(stage: string): Tone {
  return STAGE_TONE[stage] ?? 'neutral';
}

/** Inline style for a small status dot, from the same tone tokens the rest
 * of the system reads its colour from — no per-stage Tailwind palette. */
export function stageDotStyle(stage: string): { backgroundColor: string } {
  return { backgroundColor: `var(--fs-tone-${stageTone(stage)})` };
}

export const TIER_I18N_KEYS: Partial<Record<string, TranslationKeys>> = {
  essential: 'admin.tier.essential',
  pro: 'admin.tier.pro',
  commerce: 'admin.tier.commerce',
  custom: 'admin.tier.custom',
};

// ─── Client types & data hook ─────────────────────────────────────────────

export interface Client {
  key: string;
  name: string;
  email: string;
  phone: string;
  businessName: string;
  projectCount: number;
  totalFee: number;
  stages: string[];
  tiers: string[];
  deployStatuses: string[];
  lastActivity: string;
}

export function useTeamClients() {
  return useQuery({
    queryKey: ['team-clients'],
    queryFn: async (): Promise<Client[]> => {
      const res = await fetch('/api/admin/clients', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load clients');
      const json = (await res.json()) as { clients: Client[] };
      return json.clients ?? [];
    },
    staleTime: 20_000,
    retry: 1,
  });
}
