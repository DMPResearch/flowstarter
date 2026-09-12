/**
 * POST /api/team/projects/[id]/changes/[changeId]/build
 *
 * Queues the agent pass that does a paid change request, on the site the
 * client already has. Valid from HUMAN_QA or LIVE_SUBSCRIPTION, for a request
 * that is `paid`.
 */
export { buildChangeRequestHandler as POST } from '@/lib/flowstarter/change-requests-api';
