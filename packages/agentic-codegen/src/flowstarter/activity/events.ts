/**
 * The event the agent emits while it works, and nothing else.
 *
 * Every step a client or an operator will ever read comes from one of these.
 * A model never writes one: the pipeline emits them at the phase boundaries it
 * already has and at each tool call, deterministic code decides the `kind` and
 * the `subject`, and the app phrases them from its own dictionary. That is the
 * house rule -- rules decide, models phrase -- applied to the one surface most
 * likely to break it, because "show what the agent is thinking" is exactly the
 * feature that tempts you to pipe raw model text to the screen.
 *
 * Three things an event may never carry, enforced by `assertSafeEvent`:
 * a prompt, a secret, or a token. `subject` is a token from a closed set, not
 * a path; `detail` is the operator's extra and is dropped before an event
 * reaches a client (see `projectForClient`).
 */

/** What the agent was doing. One closed set; the UI has a dot for each. */
export const AGENT_ACTIVITY_KINDS = [
  'thinking',
  'reading',
  'editing',
  'searching',
  'checking',
  'repairing',
  'building',
  'publishing',
  'done',
  'failed',
] as const;

export type AgentActivityKind = (typeof AGENT_ACTIVITY_KINDS)[number];

/**
 * The subject tokens the friendly-name rule may produce. They are tokens and
 * not English so the app can say them in the reader's language, and so a
 * rename of a template file cannot change a sentence on a dashboard.
 *
 * `page.*` is a page of the generated site, `section.*` a block within one,
 * and the rest are the site-wide things a build touches. Everything the rule
 * cannot place lands on `file.other`, which is the honest answer: the step
 * still happened, we just will not name it more precisely than we know.
 */
export const ACTIVITY_SUBJECTS = [
  'page.home',
  'page.about',
  'page.services',
  'page.work',
  'page.contact',
  'page.pricing',
  'page.gallery',
  'page.booking',
  'page.blog',
  'page.legal',
  'page.other',
  'section.hero',
  'section.services',
  'section.about',
  'section.work',
  'section.testimonials',
  'section.pricing',
  'section.contact',
  'section.gallery',
  'section.faq',
  'section.booking',
  'section.stats',
  'section.header',
  'section.footer',
  'section.cta',
  'section.other',
  'content.site',
  'style.site',
  'setup.site',
  'image.site',
  'file.other',
  'brief',
  'template.library',
  'site',
  'preview',
  'gate.links',
  'gate.copy',
  'gate.images',
  'gate.markup',
  'gate.brief',
  'gate.build',
  'gate.pages',
  'gate.changes',
  'gate.other',
] as const;

export type ActivitySubject = (typeof ACTIVITY_SUBJECTS)[number];

const SUBJECT_SET: ReadonlySet<string> = new Set(ACTIVITY_SUBJECTS);
const KIND_SET: ReadonlySet<string> = new Set(AGENT_ACTIVITY_KINDS);

/**
 * The structured event. The shape is deliberately small: anything that does
 * not fit in it is something we decided not to show.
 */
export interface AgentActivityEvent {
  /** ISO-8601, set by the emitter from one clock. */
  at: string;
  /** The pipeline phase the step belongs to. Free-form, because phases move. */
  phase: string;
  kind: AgentActivityKind;
  subject: ActivitySubject;
  /**
   * The operator's extra: a file path, a gate verdict, a count. Never shown
   * to a client; `projectForClient` strips it.
   */
  detail?: string;
  /** Searches and library lookups, drawn as chips inside the step. */
  chips?: string[];
}

/**
 * Anything that looks like a secret has no business on a timeline that ends
 * up in a browser. This is a belt over the braces: the emitters only ever
 * pass paths and gate names, but a timeline is exactly the kind of surface a
 * later change starts stuffing context into.
 */
const SECRET_PATTERN =
  /(sk-[A-Za-z0-9]{8,}|pk_(live|test)_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[A-Za-z0-9_-]*(?:api[_-]?key|secret|password|bearer|authorization)\b\s*[:=]\s*\S+)/i;

export class UnsafeActivityEventError extends Error {
  constructor(field: string) {
    super(`Activity event ${field} looks like a credential and was dropped`);
    this.name = 'UnsafeActivityEventError';
  }
}

/** True when the value carries something that must never leave the worker. */
export function looksLikeSecret(value: string): boolean {
  return SECRET_PATTERN.test(value);
}

/**
 * Validates an event on the way out. A malformed one throws rather than being
 * quietly repaired, because a repaired event is an invented step.
 */
export function assertSafeEvent(event: AgentActivityEvent): AgentActivityEvent {
  if (!KIND_SET.has(event.kind)) {
    throw new UnsafeActivityEventError(`kind "${event.kind}"`);
  }
  if (!SUBJECT_SET.has(event.subject)) {
    throw new UnsafeActivityEventError(`subject "${event.subject}"`);
  }
  if (event.detail && looksLikeSecret(event.detail)) {
    throw new UnsafeActivityEventError('detail');
  }
  for (const chip of event.chips ?? []) {
    if (looksLikeSecret(chip)) throw new UnsafeActivityEventError('chip');
  }
  return event;
}

/** A well-formed event from an untrusted source (a row read back, a stream). */
export function isAgentActivityEvent(
  value: unknown,
): value is AgentActivityEvent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AgentActivityEvent>;
  if (typeof candidate.at !== 'string' || candidate.at.length === 0)
    return false;
  if (typeof candidate.phase !== 'string') return false;
  if (typeof candidate.kind !== 'string' || !KIND_SET.has(candidate.kind))
    return false;
  if (
    typeof candidate.subject !== 'string' ||
    !SUBJECT_SET.has(candidate.subject)
  )
    return false;
  if (candidate.detail !== undefined && typeof candidate.detail !== 'string')
    return false;
  if (candidate.chips !== undefined) {
    if (!Array.isArray(candidate.chips)) return false;
    if (candidate.chips.some((chip) => typeof chip !== 'string')) return false;
  }
  return true;
}

/**
 * The client's copy of an event: the same step, without the file path or the
 * gate's raw verdict. Operators see the full one because they are the people
 * who have to fix the thing; a client is told the services section was edited,
 * not which `.astro` file it lives in.
 */
export function projectForClient(
  event: AgentActivityEvent,
): AgentActivityEvent {
  const { detail: _detail, ...rest } = event;
  return rest;
}

/** Parses a list of rows back into events, dropping anything malformed. */
export function parseActivityEvents(value: unknown): AgentActivityEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isAgentActivityEvent);
}
