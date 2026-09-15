/**
 * One `PolicyVerdict`, narrowed onto the four values the funnel's routing
 * table reads.
 *
 * This lived inside `./scope-gate.ts` until the intake needed it too.
 * `scope-gate` reaches Supabase, Resend and a classifier the moment it is
 * imported, and the intake route has no business loading any of that to ask a
 * three-line question about a verdict it already holds. So the narrowing moved
 * here, where it is pure: it imports two predicates from the policy's own rule
 * layer and a type from the routing table, and nothing else.
 *
 * `scope-gate` re-exports `acceptableUseFrom` so the outcome-table test and
 * every existing caller keep their import path. There is still exactly one
 * implementation, which is the whole point -- the 2026-09-15 defect that
 * `PolicyVerdict` -> `AcceptableUse` exists to prevent was `review` collapsing
 * three unrelated facts into one word, and a second copy of this function is
 * how that comes back.
 */
import {
  classifierUnavailable,
  reviewNamesCategory,
  type PolicyVerdict,
} from '@/lib/policy/acceptable-use';
import type { AcceptableUse } from './scope-route';

/**
 * The one place the policy's vocabulary and the funnel's meet.
 *
 * The narrowing is where the 2026-09-15 defect lived: `review` collapsed
 * three unrelated facts into one value, and the route table could only act on
 * the word.
 */
export function acceptableUseFrom(verdict: PolicyVerdict): AcceptableUse {
  if (verdict.decision === 'refuse') return 'blocked';
  if (verdict.decision !== 'review') return 'allowed';
  // Order matters: a classifier that never answered has no category either,
  // so the unavailable check has to come first or every hold would be read as
  // a merely-unsure review and fall through to the scope rules.
  if (classifierUnavailable(verdict)) return 'hold';
  return reviewNamesCategory(verdict) ? 'review' : 'unsettled';
}
