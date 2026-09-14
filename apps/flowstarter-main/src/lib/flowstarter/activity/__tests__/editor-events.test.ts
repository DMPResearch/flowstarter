/**
 * The editor timeline is only worth showing if every line on it happened.
 *
 * These tests pin the two properties the rule exists for: it is cumulative,
 * so the timeline grows rather than flickering, and it never emits a stage
 * the editor did not enter -- including the failure case, where the stage it
 * stopped at decides how much of the ladder is true.
 */
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_SUBJECTS,
  AGENT_ACTIVITY_KINDS,
  isAgentActivityEvent,
} from '@flowstarter/agentic-codegen/src/flowstarter/activity';
import {
  editorActivityEvents,
  type EditorActivityStage,
} from '../editor-events';

/** A clock that counts, so the order of the events is readable in a failure. */
function clock() {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 8, 14, 10, 0, tick)).toISOString();
  };
}

function shape(
  stage: EditorActivityStage,
  reached?: 'idle' | 'reading' | 'writing' | 'checking' | 'saving' | 'saved'
) {
  return editorActivityEvents(stage, clock(), reached).map(
    (event) => `${event.kind}:${event.subject}`
  );
}

describe('editorActivityEvents', () => {
  it('draws nothing before a change has been asked for', () => {
    expect(editorActivityEvents('idle', clock())).toEqual([]);
  });

  it('reads the preview while the proposal is in flight', () => {
    expect(shape('reading')).toEqual(['reading:preview']);
  });

  it('adds the write once the proposal has come back', () => {
    expect(shape('writing')).toEqual([
      'reading:preview',
      'editing:content.site',
    ]);
  });

  it('adds the markup check once the client has pressed save', () => {
    expect(shape('checking')).toEqual([
      'reading:preview',
      'editing:content.site',
      'checking:gate.markup',
    ]);
  });

  it('adds the publish once the save has returned', () => {
    expect(shape('saving')).toEqual([
      'reading:preview',
      'editing:content.site',
      'checking:gate.markup',
      'publishing:site',
    ]);
  });

  it('ends on a done event once the editor has re-read its state', () => {
    expect(shape('saved')).toEqual([
      'reading:preview',
      'editing:content.site',
      'checking:gate.markup',
      'publishing:site',
      'done:site',
    ]);
  });

  it('stops where the run stopped: a refused proposal never checked anything', () => {
    expect(shape('failed', 'reading')).toEqual([
      'reading:preview',
      'failed:gate.other',
    ]);
  });

  it('keeps the stages a refused save did reach', () => {
    expect(shape('failed', 'checking')).toEqual([
      'reading:preview',
      'editing:content.site',
      'checking:gate.markup',
      'failed:gate.other',
    ]);
  });

  it('draws a single line for a run that refused before it read anything', () => {
    expect(shape('failed')).toEqual(['failed:gate.other']);
  });

  it('is cumulative: each stage is the previous one plus one line', () => {
    const ladder: EditorActivityStage[] = [
      'idle',
      'reading',
      'writing',
      'checking',
      'saving',
      'saved',
    ];
    let previous: string[] = [];
    for (const stage of ladder) {
      const current = shape(stage);
      expect(current.slice(0, previous.length)).toEqual(previous);
      expect(current.length).toBe(previous.length + (stage === 'idle' ? 0 : 1));
      previous = current;
    }
  });

  it('stamps every event from the clock it was given, oldest first', () => {
    const events = editorActivityEvents('saved', clock());
    const stamps = events.map((event) => event.at);
    expect(stamps).toEqual([...stamps].sort());
    expect(new Set(stamps).size).toBe(events.length);
    expect(events.every((event) => event.phase === 'editor')).toBe(true);
  });

  it('only ever emits tokens the closed sets in the pipeline already know', () => {
    const stages: EditorActivityStage[] = [
      'idle',
      'reading',
      'writing',
      'checking',
      'saving',
      'saved',
      'failed',
    ];
    for (const stage of stages) {
      for (const event of editorActivityEvents(stage, clock(), 'saving')) {
        expect(isAgentActivityEvent(event)).toBe(true);
        expect(AGENT_ACTIVITY_KINDS).toContain(event.kind);
        expect(ACTIVITY_SUBJECTS).toContain(event.subject);
        expect(event.detail).toBeUndefined();
      }
    }
  });

  it('carries no reached stage on a run that is still going', () => {
    // `reached` is read only on a failure: a live run at `writing` is at
    // `writing`, whatever the caller left in the third argument.
    expect(shape('writing', 'saved')).toEqual([
      'reading:preview',
      'editing:content.site',
    ]);
  });
});
