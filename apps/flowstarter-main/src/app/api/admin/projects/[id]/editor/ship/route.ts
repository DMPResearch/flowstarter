/**
 * Ship the open editor session: commit the worktree with the build commit
 * policy, store what it held, and queue the OPERATOR_EDIT_BUILD that runs
 * every gate before any of it reaches the client.
 */
export { shipOperatorEditorHandler as POST } from '@/lib/flowstarter/operator-editor-api';
