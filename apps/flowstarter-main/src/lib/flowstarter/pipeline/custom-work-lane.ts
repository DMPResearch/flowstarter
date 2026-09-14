/**
 * The "Custom work" lane on the operator's pipeline board.
 *
 * The rest of the board is projects: rows in `workspaces`, one column per
 * lifecycle state, and a card is stuck or it is not. This lane is the opposite
 * shape. Its rows are people who will never have a workspace, because the whole
 * reason they are here is that the generator was not run for them, and the
 * question an operator asks of them is not "is it stuck" but "has anybody
 * replied yet".
 *
 * So it is its own lane with its own card, built by its own pure function, and
 * bolted onto the board rather than folded into `PROJECT_STATE_ORDER`. Folding
 * it in would have meant inventing a seventh `ProjectState` that no project can
 * ever be in, which is the kind of shortcut that costs a day six months later
 * when somebody transitions a workspace into it.
 *
 * Pure, like `./board`: rows in, cards out, `now` passed rather than read.
 */
import type { CustomWorkLeadRow } from '@/lib/flowstarter/custom-work-leads';
import { formatDuration } from './board';

export interface CustomWorkCard {
  id: string;
  name: string;
  email: string;
  /** The visitor's own words, trimmed to a card's worth. */
  description: string;
  linkUrl: string | null;
  /** What the classifier said, and what it quoted to say it. */
  scope: string;
  confidence: number;
  evidence: string[];
  classifier: string;
  /** The deterministic route and the rule that produced it. */
  route: string;
  routeRule: string;
  source: string;
  bookingStatus: string;
  /** True once an operator has pressed "Mark contacted". */
  contacted: boolean;
  contactedAt: string | null;
  contactedBy: string | null;
  /** Null when the branded confirmation never reached them. */
  confirmationSentAt: string | null;
  createdAt: string;
  /** How long this lead has been waiting, in the board's own words. */
  waitingFor: string;
  /** True when nobody has replied and it has been long enough to matter. */
  needsAttention: boolean;
}

export interface CustomWorkLane {
  cards: CustomWorkCard[];
  total: number;
  /** How many nobody has replied to yet. The number to drive to zero. */
  waitingCount: number;
}

/** As much of a brief as fits on a card before an operator opens the row. */
const MAX_DESCRIPTION_CHARS = 280;

const HOUR = 60 * 60_000;

/**
 * How long a custom work lead may sit before the board says so.
 *
 * One working day. These are the leads worth the most per head in the whole
 * product and they arrive from a person who has just been told, politely, that
 * the self-serve thing they came for is not for them. The window in which a
 * reply still feels like a reply is short.
 */
export const CUSTOM_WORK_REPLY_WINDOW_MS = 24 * HOUR;

/** Statuses that mean somebody has already dealt with it. */
const ANSWERED = new Set(['contacted', 'booked', 'closed']);

function evidenceOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3);
}

export function toCustomWorkCard(
  row: CustomWorkLeadRow,
  now: number
): CustomWorkCard {
  const answered = ANSWERED.has(row.booking_status);
  const waitingMs = Math.max(0, now - Date.parse(row.created_at));
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    description: row.description.trim().slice(0, MAX_DESCRIPTION_CHARS),
    linkUrl: row.link_url,
    scope: row.scope,
    confidence: Number(row.scope_confidence) || 0,
    evidence: evidenceOf(row.scope_evidence),
    classifier: row.classifier,
    route: row.route,
    routeRule: row.route_rule,
    source: row.source,
    bookingStatus: row.booking_status,
    contacted: row.contacted_at !== null,
    contactedAt: row.contacted_at,
    contactedBy: row.contacted_by,
    confirmationSentAt: row.confirmation_sent_at,
    createdAt: row.created_at,
    waitingFor: formatDuration(waitingMs),
    needsAttention: !answered && waitingMs > CUSTOM_WORK_REPLY_WINDOW_MS,
  };
}

/**
 * The lane, newest first.
 *
 * Everything is kept, including the leads already contacted: an operator who
 * replied last week still wants to see that nobody ever booked, and a lane that
 * emptied itself on the first reply would hide exactly that.
 */
export function buildCustomWorkLane(input: {
  leads: readonly CustomWorkLeadRow[];
  now?: number;
}): CustomWorkLane {
  const now = input.now ?? Date.now();
  const cards = input.leads
    .map((row) => toCustomWorkCard(row, now))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    cards,
    total: cards.length,
    waitingCount: cards.filter((card) => !card.contacted).length,
  };
}
