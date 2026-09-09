/**
 * The two refusals every operator route owes, run over a list of real
 * handlers.
 *
 * `/api/admin/projects/[id]` and `/api/team/projects/[id]` are cross-tenant by
 * design: `requireTeamAuth` lets a `team` or `admin` role reach any workspace,
 * because that is what the operator dashboards are for. Which makes the
 * boundary a different one from the client editor's, and easy to state:
 * holding a workspace is not the same as operating it. A signed-in client, a
 * member of the very workspace named in the URL, must still be refused, and
 * refused before the service-role client is asked for anything.
 *
 * Shared rather than copied because the admin tree and the team tree are twins
 * and the checks must not drift between them. The handler imports stay in each
 * test file, so a route with no case here is visible as an absent import.
 *
 * Not a `.test.ts` file, so vitest does not collect it as a suite.
 */
import { expect } from 'vitest';
import type { RecordingDb } from './recording-supabase';

/** A named way to call one exported handler. Thunks, not promises: each call
 * has to start after the query log is cleared. */
export type RouteCase = [name: string, call: () => Promise<Response>];

export interface OperatorAuthState {
  userId: string | null;
  role: string | undefined;
}

/**
 * A signed-in caller who is not an operator gets 403 from every handler, and
 * no handler reads a row on the way to saying so.
 */
export async function expectRejectsForeignWorkspace(
  cases: RouteCase[],
  db: RecordingDb,
  authState: OperatorAuthState
): Promise<void> {
  authState.userId = 'user_client_a';
  authState.role = undefined;

  for (const [name, call] of cases) {
    db.reset();
    const response = await call();
    expect(response.status, name).toBe(403);
    expect(await response.clone().json(), name).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.tables, name).toEqual([]);
  }
}

/** A signed-out caller gets 401, and reads nothing either. */
export async function expectRejectsSignedOut(
  cases: RouteCase[],
  db: RecordingDb,
  authState: OperatorAuthState
): Promise<void> {
  authState.userId = null;
  authState.role = undefined;

  for (const [name, call] of cases) {
    db.reset();
    const response = await call();
    expect(response.status, name).toBe(401);
    expect(db.tables, name).toEqual([]);
  }
}
