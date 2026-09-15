/**
 * POST /api/team/projects/[id]/pipeline/requeue-deploy
 *
 * The team-facing name for the handler the admin tree exposes under the same
 * path. One implementation, two routes — see the header of
 * `@/lib/flowstarter/pipeline/api`.
 */
export { requeueDeployHandler as POST } from '@/lib/flowstarter/pipeline/api';
