import { describe, expect, it } from 'vitest';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import {
  stageTone,
  stageDotStyle,
  PROJECT_STATE_TONE,
  projectStateTone,
} from '../dashboard.constants';
import { isStageStep } from '@/lib/flowstarter/pipeline/job-labels';

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
      'stage-1',
      'stage-2',
      'stage-3',
      'stage-4',
      'warn',
      'ok',
    ]);
  });

  it('steps the four progress states through one hue, in order', () => {
    // The whole point of the table: four columns that are nothing but
    // progress must not each pick a hue of their own, and the steps must not
    // be shuffled, or the ramp stops reading as a ramp.
    const progress = [
      ProjectState.INTAKE,
      ProjectState.PREVIEW_READY,
      ProjectState.DEPOSIT_PAID,
      ProjectState.AGENTS_WORKING,
    ].map(projectStateTone);

    expect(progress).toEqual(['stage-1', 'stage-2', 'stage-3', 'stage-4']);
    for (const tone of progress) expect(isStageStep(tone)).toBe(true);
  });

  it('spends a second hue only on the two states that are not progress', () => {
    expect(projectStateTone(ProjectState.LIVE_SUBSCRIPTION)).toBe('ok');
    expect(projectStateTone(ProjectState.HUMAN_QA)).toBe('warn');

    const semantic = Object.values(PROJECT_STATE_TONE).filter(
      (tone) => !isStageStep(tone)
    );
    expect(semantic).toEqual(['warn', 'ok']);
  });

  it('reads the same table projectStateTone does', () => {
    expect(projectStateTone(ProjectState.INTAKE)).toBe(
      PROJECT_STATE_TONE[ProjectState.INTAKE]
    );
  });
});
