/**
 * GET /api/admin/projects/[id]/policy
 *
 * Every acceptable-use hold and refusal on this project, newest first, with
 * the category and the classifier's one sentence of evidence. The submission
 * itself is never stored, so it is never returned.
 */
export { listPolicyReviewsHandler as GET } from '@/lib/policy/review-api';
