/**
 * The client editor's event source is its own request lifecycle.
 *
 * `/edit` and `/apply` answer once and do not stream, so there is no feed of
 * agent events to read here the way the build worker has one. What there is
 * instead is a lifecycle the component genuinely passes through -- the
 * proposal was asked for, the proposal came back, the client pressed save,
 * the save returned, the editor re-read its state -- and every one of those
 * transitions is an observed fact, not a guess. This module maps those facts
 * onto the same `AgentActivityEvent` shape the pipeline emits, so the editor
 * draws its progress with the one timeline component and not a second one.
 *
 * Two rules keep it honest.
 *
 * It will not invent a stage. Each stage emits exactly one event, and a stage
 * the component never entered emits nothing: there is no "checking" line
 * until the client actually pressed save, and no "saved" line until the save
 * came back. That is why the failure case carries the stage it got to rather
 * than assuming a full run -- a `/edit` that 402s stopped after reading, and
 * saying it checked anything would be a lie told in a nice font.
 *
 * It is pure. The clock is a parameter, so the whole rule is a table lookup a
 * unit test can walk end to end.
 */
// Deep import, not the package root: the root re-exports the Pi SDK and the
// whole generation pipeline, neither of which belongs in a client bundle.
import type { AgentActivityEvent } from '@flowstarter/agentic-codegen/src/flowstarter/activity';

/**
 * Where the editor is in one change.
 *
 * - `idle` -- nothing asked for yet, so the timeline draws nothing.
 * - `reading` -- `/edit` is in flight; the agent is reading the block.
 * - `writing` -- the proposal came back; the change is written and on screen.
 * - `checking` -- `/apply` is in flight; the server is checking the markup.
 * - `saving` -- the save returned; the new version is going out to the preview.
 * - `saved` -- the editor has re-read its state and the change is live.
 * - `failed` -- one of the two requests refused. Pairs with `reached`.
 */
export type EditorActivityStage =
  | 'idle'
  | 'reading'
  | 'writing'
  | 'checking'
  | 'saving'
  | 'saved'
  | 'failed';

/** A stage the editor can have got to. Every stage but the failure itself. */
export type EditorActivityReached = Exclude<EditorActivityStage, 'failed'>;

/** The pipeline phase these events belong to. Part of each step's id. */
const EDITOR_PHASE = 'editor';

/** The ladder, in the order the editor climbs it. `idle` is below the first rung. */
const LADDER = [
  'reading',
  'writing',
  'checking',
  'saving',
  'saved',
] as const satisfies readonly EditorActivityReached[];

type LadderStage = (typeof LADDER)[number];

/**
 * The one event entering each stage emits. `kind` and `subject` are tokens
 * from the closed sets in `@flowstarter/agentic-codegen`, so the app phrases
 * them from its own dictionary and nothing here writes a sentence.
 */
const STAGE_EVENT: Record<
  LadderStage,
  Pick<AgentActivityEvent, 'kind' | 'subject'>
> = {
  reading: { kind: 'reading', subject: 'preview' },
  writing: { kind: 'editing', subject: 'content.site' },
  checking: { kind: 'checking', subject: 'gate.markup' },
  saving: { kind: 'publishing', subject: 'site' },
  saved: { kind: 'done', subject: 'site' },
};

/**
 * What a refusal is attributed to. The client end of `/edit` and `/apply`
 * learns that the request was refused, never which rule refused it, so this
 * is the closed set's honest catch-all rather than a gate named on a guess.
 */
const FAILURE_EVENT: Pick<AgentActivityEvent, 'kind' | 'subject'> = {
  kind: 'failed',
  subject: 'gate.other',
};

/** How far up the ladder a stage is. `-1` for `idle`, which emits nothing. */
function rung(stage: EditorActivityReached): number {
  return LADDER.indexOf(stage as LadderStage);
}

/**
 * Every event the run has earned so far, oldest first.
 *
 * Cumulative on purpose: the timeline grows a line per stage rather than
 * replacing itself, which is the whole point of a timeline.
 *
 * @param stage the stage the editor is in now.
 * @param now the clock, called once per event.
 * @param reached the last stage that completed, read only when `stage` is
 *   `failed`. A failure that carries no reached stage is a run that refused
 *   before it read anything, and draws one line.
 */
export function editorActivityEvents(
  stage: EditorActivityStage,
  now: () => string,
  reached: EditorActivityReached = 'idle'
): AgentActivityEvent[] {
  const furthest: EditorActivityReached = stage === 'failed' ? reached : stage;
  const events: AgentActivityEvent[] = [];

  // `rung('idle')` is -1, so an idle run slices nothing and draws nothing.
  for (const name of LADDER.slice(0, rung(furthest) + 1)) {
    events.push({ at: now(), phase: EDITOR_PHASE, ...STAGE_EVENT[name] });
  }

  if (stage === 'failed') {
    events.push({ at: now(), phase: EDITOR_PHASE, ...FAILURE_EVENT });
  }

  return events;
}
