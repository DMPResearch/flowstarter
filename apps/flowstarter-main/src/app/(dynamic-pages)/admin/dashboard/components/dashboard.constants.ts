import { useQuery } from '@tanstack/react-query';
import type { TranslationKeys } from '@/lib/i18n';
import type { Tone } from '@flowstarter/flow-design-system';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import type { ColumnTone } from '@/lib/flowstarter/pipeline/job-labels';

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

/**
 * The cross-project pipeline board's lifecycle states in colour — the state
 * machine's own six `ProjectState` values, not the client-facing `stage`
 * strings `STAGE_TONE` reads above. Kept as a separate table because the two
 * vocabularies do not line up one-to-one (`internal_review` and `client_review`
 * are both, for instance, states a `ProjectState` column never names), but the
 * two boards that share this table — the pipeline board and, for its build
 * columns, `BOARD_COLUMN_TONE` in `job-labels.ts` — read their tone from here
 * so a state is never coloured two different ways in two places.
 *
 * In the order the state machine allows, and that order is the point. The
 * first four states are a project moving forward and nothing else, so they
 * take the four steps of the one accent ladder (`--fs-stage-1` to
 * `--fs-stage-4` in brand.css) in sequence: same hue, deepening left to
 * right, so the board reads as a ramp. Only the last two are a different kind
 * of thing — `HUMAN_QA` will not move without an operator, so it is `warn`,
 * and `LIVE_SUBSCRIPTION` is the finished state, so it is `ok`.
 *
 * The previous table gave each of the six a hue of its own (accent, info,
 * violet, teal, warn, ok). Every column then said "I am a different colour
 * from my neighbour", which is the one thing position on a board already
 * says, and six hues across a board is a rainbow rather than a pipeline.
 */
export const PROJECT_STATE_TONE: Record<ProjectState, ColumnTone> = {
  [ProjectState.INTAKE]: 'stage-1',
  [ProjectState.PREVIEW_READY]: 'stage-2',
  [ProjectState.DEPOSIT_PAID]: 'stage-3',
  [ProjectState.AGENTS_WORKING]: 'stage-4',
  [ProjectState.HUMAN_QA]: 'warn',
  [ProjectState.LIVE_SUBSCRIPTION]: 'ok',
};

export function projectStateTone(state: ProjectState): ColumnTone {
  return PROJECT_STATE_TONE[state] ?? 'stage-1';
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
