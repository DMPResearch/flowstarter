/**
 * POST /api/team/projects/[id]/policy/decision
 *
 * An operator approving or refusing one held review. Approving lifts the hold
 * and, on a brief hold, starts the build the save did not start.
 */
export { resolvePolicyReviewHandler as POST } from '@/lib/policy/review-api';
