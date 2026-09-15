/**
 * The rule that decides a classifier is down rather than unlucky.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CLASSIFIER_FAILURE_ALERT_THRESHOLD,
  CLASSIFIER_FAILURE_ALERT_THRESHOLD_ENV,
  classifierFailureAlertThreshold,
  classifierFailureRun,
  noteClassifierFailure,
  noteClassifierSuccess,
  resetClassifierHealth,
  shouldRaiseClassifierAlert,
} from '../classifier-health';

beforeEach(() => resetClassifierHealth());
afterEach(() => resetClassifierHealth());

describe('shouldRaiseClassifierAlert', () => {
  it('stays quiet below the threshold and speaks at it', () => {
    for (let n = 0; n < CLASSIFIER_FAILURE_ALERT_THRESHOLD; n += 1) {
      expect(shouldRaiseClassifierAlert(n, {})).toBe(false);
    }
    expect(
      shouldRaiseClassifierAlert(CLASSIFIER_FAILURE_ALERT_THRESHOLD, {})
    ).toBe(true);
  });

  it('keeps saying so while the outage lasts', () => {
    // Deliberately not "only on the crossing". How often a continuing outage
    // is worth another email is the alert module's decision, made from the
    // last send time, not this rule's.
    expect(
      shouldRaiseClassifierAlert(CLASSIFIER_FAILURE_ALERT_THRESHOLD * 10, {})
    ).toBe(true);
  });
});

describe('classifierFailureAlertThreshold', () => {
  it('is retunable without a deploy', () => {
    expect(
      classifierFailureAlertThreshold({
        [CLASSIFIER_FAILURE_ALERT_THRESHOLD_ENV]: '10',
      })
    ).toBe(10);
  });

  it('ignores a value that is not a count', () => {
    for (const bad of ['0', '-1', 'soon', '']) {
      expect(
        classifierFailureAlertThreshold({
          [CLASSIFIER_FAILURE_ALERT_THRESHOLD_ENV]: bad,
        })
      ).toBe(CLASSIFIER_FAILURE_ALERT_THRESHOLD);
    }
  });
});

describe('the counter', () => {
  it('counts a run and resets it on a success', () => {
    expect(noteClassifierFailure('scope', {}).consecutiveFailures).toBe(1);
    expect(noteClassifierFailure('scope', {}).consecutiveFailures).toBe(2);
    noteClassifierSuccess('scope');
    expect(classifierFailureRun('scope')).toBe(0);
    expect(noteClassifierFailure('scope', {}).consecutiveFailures).toBe(1);
  });

  it('counts each classifier on its own', () => {
    // One head going down must not reset or mask another head's run.
    noteClassifierFailure('scope', {});
    noteClassifierFailure('scope', {});
    noteClassifierFailure('acceptable_use', {});
    expect(classifierFailureRun('scope')).toBe(2);
    expect(classifierFailureRun('acceptable_use')).toBe(1);
    noteClassifierSuccess('acceptable_use');
    expect(classifierFailureRun('scope')).toBe(2);
  });

  it('reports the alert decision alongside the count', () => {
    let last = { consecutiveFailures: 0, shouldAlert: false };
    for (let n = 0; n < CLASSIFIER_FAILURE_ALERT_THRESHOLD; n += 1) {
      last = noteClassifierFailure('scope', {});
    }
    expect(last).toEqual({
      consecutiveFailures: CLASSIFIER_FAILURE_ALERT_THRESHOLD,
      shouldAlert: true,
    });
  });
});
