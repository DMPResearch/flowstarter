/**
 * Flowstarter's two cost models, as functions from an outcome to the names of
 * the counters it fired. The prices live in config/evaluation.json; this file
 * only says which mistake happened.
 *
 * Kept apart from the gate on purpose: a cost model is an opinion about
 * consequences, and it belongs where a reviewer can argue with it without
 * reading the classifier.
 */

import type { CostModel, ScoredItem } from '@flowstarter/sigma-core';
import type {
  AcceptableUseAction,
  AcceptableUseCategory,
  ScopeAction,
  ScopeCategory,
} from './taxonomy.js';

/**
 * Acceptable use.
 *
 * `prohibited_miss` is the one that is not tradeable: a prohibited business
 * that got `allow` walked into an unattended build. The eval suite gates on
 * zero of these independently of the total, so no amount of being right
 * elsewhere can buy one.
 *
 * Note what is NOT a miss: a prohibited business that got `review`. The
 * classifier abstained and a human is looking at it. That is the system
 * working, and it costs 10 rather than 100.
 */
export const acceptableUseCosts: CostModel<AcceptableUseCategory, AcceptableUseAction> = (
  item,
) => {
  const fired: string[] = [];
  if (item.abstained) fired.push('abstention');

  if (item.expectedAction === 'refuse') {
    if (item.actualAction === 'allow') fired.push('prohibited_miss');
    else if (item.actualAction === 'review') fired.push('review_instead_of_refuse');
  } else if (item.expectedAction === 'allow') {
    if (item.actualAction === 'refuse') fired.push('refuse_clean_business');
    else if (item.actualAction === 'review') fired.push('review_instead_of_allow');
  } else {
    // Expected review: a sensitive business. Refusing one is as wrong as
    // refusing a clean one — a licensed pharmacy is a customer.
    if (item.actualAction === 'refuse') fired.push('refuse_clean_business');
    else if (item.actualAction === 'allow') fired.push('prohibited_miss');
  }

  if (
    !item.abstained &&
    item.actualLabel !== null &&
    item.expectedLabel !== null &&
    item.actualLabel !== item.expectedLabel
  ) {
    fired.push('category_confusion');
  }
  return fired;
};

/**
 * Scope. Asymmetric the other way round from acceptable use: letting custom
 * work into the unattended funnel produces a build that fails and a refund,
 * while sending a brochure site to a discovery call only costs a call.
 */
export const scopeCosts: CostModel<ScopeCategory, ScopeAction> = (item) => {
  const fired: string[] = [];
  if (item.abstained) fired.push('scope_abstention');
  if (item.expectedAction === 'custom' && item.actualAction === 'standard') {
    fired.push('custom_missed_as_standard');
  }
  if (item.expectedAction === 'standard' && item.actualAction === 'custom') {
    fired.push('standard_sent_to_a_call');
  }
  return fired;
};

/** Convenience for the sweep, which sees labels rather than actions. */
export function acceptableUseSweepCost(outcome: {
  expected: string;
  predicted: string | null;
}): readonly string[] {
  if (outcome.predicted === null) return ['abstention'];
  if (outcome.predicted === outcome.expected) return [];
  const expectedClass = classOf(outcome.expected);
  const predictedClass = classOf(outcome.predicted);
  if (expectedClass === 'prohibited' && predictedClass === 'clean') return ['prohibited_miss'];
  if (expectedClass !== 'prohibited' && predictedClass === 'prohibited') {
    return ['refuse_clean_business'];
  }
  if (expectedClass === 'clean' && predictedClass === 'sensitive') {
    return ['review_instead_of_allow', 'category_confusion'];
  }
  return ['category_confusion'];
}

export function scopeSweepCost(outcome: {
  expected: string;
  predicted: string | null;
}): readonly string[] {
  if (outcome.predicted === null) return ['scope_abstention'];
  if (outcome.predicted === outcome.expected) return [];
  if (outcome.expected === 'custom-work' && outcome.predicted === 'standard-site') {
    return ['custom_missed_as_standard'];
  }
  if (outcome.expected === 'standard-site' && outcome.predicted === 'custom-work') {
    return ['standard_sent_to_a_call'];
  }
  return ['scope_abstention'];
}

function classOf(label: string): 'prohibited' | 'sensitive' | 'clean' {
  if (label === 'clean') return 'clean';
  return SENSITIVE.has(label) ? 'sensitive' : 'prohibited';
}

const SENSITIVE = new Set([
  'licensed_pharmacy',
  'legal_cannabis',
  'firearms_training',
  'sexual_health',
  'licensed_betting',
  'adult_adjacent_retail',
]);

export type { ScoredItem };
