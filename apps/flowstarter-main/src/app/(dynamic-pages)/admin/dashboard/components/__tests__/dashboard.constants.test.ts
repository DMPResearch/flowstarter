import { describe, expect, it } from 'vitest';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import {
  stageTone,
  stageDotStyle,
  PROJECT_STATE_TONE,
  projectStateTone,
} from '../dashboard.constants';

describe('stageTone', () => {
  it('reads intake as neutral, before anything has started', () => {
    expect(stageTone('intake')).toBe('neutral');
  });

  it('reads build and internal_review as warn — work an operator owns', () => {
    expect(stageTone('build')).toBe('warn');
    expect(stageTone('internal_review')).toBe('warn');
  });

  it('reads client_review as accent — in front of the client', () => {
    expect(stageTone('client_review')).toBe('accent');
  });

  it('reads launched and care as ok', () => {
    expect(stageTone('launched')).toBe('ok');
    expect(stageTone('care')).toBe('ok');
  });

  it('falls back to neutral for an unrecognised stage', () => {
    expect(stageTone('something_new')).toBe('neutral');
  });
});

describe('stageDotStyle', () => {
  it('reads its colour from the tone token, not a hardcoded palette', () => {
    expect(stageDotStyle('launched')).toEqual({
      backgroundColor: 'var(--fs-tone-ok)',
    });
    expect(stageDotStyle('build')).toEqual({
      backgroundColor: 'var(--fs-tone-warn)',
    });
  });
});

describe('PROJECT_STATE_TONE', () => {
  it('gives every ProjectState a tone', () => {
    for (const state of Object.values(ProjectState)) {
      expect(PROJECT_STATE_TONE[state]).toBeDefined();
    }
  });

  it('reads as progress, in the order the state machine allows', () => {
    // Object.keys on string-keyed object preserves insertion order, so this
    // also pins the table to stay written in state-machine order rather than
    // being reshuffled alphabetically or by tone.
    expect(Object.keys(PROJECT_STATE_TONE)).toEqual([
      ProjectState.INTAKE,
      ProjectState.PREVIEW_READY,
      ProjectState.DEPOSIT_PAID,
      ProjectState.AGENTS_WORKING,
      ProjectState.HUMAN_QA,
      ProjectState.LIVE_SUBSCRIPTION,
    ]);
    expect(Object.values(PROJECT_STATE_TONE)).toEqual([
      'accent',
      'info',
      'violet',
      'teal',
      'warn',
      'ok',
    ]);
  });

  it('reserves ok for live and warn for the state an operator has to act on', () => {
    expect(projectStateTone(ProjectState.LIVE_SUBSCRIPTION)).toBe('ok');
    expect(projectStateTone(ProjectState.HUMAN_QA)).toBe('warn');
  });

  it('reads the same table projectStateTone does', () => {
    expect(projectStateTone(ProjectState.INTAKE)).toBe(
      PROJECT_STATE_TONE[ProjectState.INTAKE]
    );
  });
});
