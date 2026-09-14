/**
 * The operator editor on one project: read the session, open one, close one.
 * The handlers live in `@/lib/flowstarter/operator-editor-api` so the `/admin`
 * and `/team` trees cannot drift apart.
 */
export {
  operatorEditorStateHandler as GET,
  openOperatorEditorHandler as POST,
  closeOperatorEditorHandler as DELETE,
} from '@/lib/flowstarter/operator-editor-api';
