/**
 * POST /api/admin/projects/[id]/pipeline/requeue-deploy
 *
 * Re-queues a build that is finished and stuck: the site passed every gate and
 * was packaged, and only the deploy failed. Keeps the recorded artifact, grants
 * one deploy attempt, and refuses outright when no artifact was recorded —
 * with none there is nothing to deploy and a re-dispatch is the honest answer.
 * See `requeueDeployHandler`.
 */
export { requeueDeployHandler as POST } from '@/lib/flowstarter/pipeline/api';
