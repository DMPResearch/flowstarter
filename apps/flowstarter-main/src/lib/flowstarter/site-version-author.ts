/**
 * Who made a version of the site, in words a client already understands.
 *
 * `site_versions.created_by` holds one of four things, and until now the
 * client's history panel printed none of them:
 *
 *   - a Clerk user id, for an edit somebody made in the editor
 *   - `system`, for the baseline row written when the site was delivered
 *   - `system:change_request_build:<jobId>`, for a paid change request
 *   - `system:operator_edit_build:<jobId>`, for work one of us did in the
 *     Flowstarter editor
 *
 * The last of those is the reason this file exists. A client whose site
 * changes overnight because we built them the page they asked for should be
 * told that, in one line, on the screen they already look at. Reading a raw
 * `created_by` would show them a job UUID; showing nothing at all is how a
 * client ends up asking whether their site was hacked.
 *
 * Deliberately a rule and not a sentence assembled in a component: the same
 * words appear in the editor's history panel and in anything that later prints
 * a version, and a label that says "you" in one place and a Clerk id in
 * another is worse than no label.
 *
 * It also names no individual. A client bought a service, not a person, and
 * which of us was on shift is not theirs to have — the operator's own id is on
 * the session row, where an operator can see it.
 *
 * Pure, no imports, safe on both sides of the wire.
 */

export type SiteVersionAuthorKind =
  | 'you'
  | 'your-team'
  | 'flowstarter-team'
  | 'delivered'
  | 'unknown';

export interface SiteVersionAuthor {
  kind: SiteVersionAuthorKind;
  /** What the client reads, or null when there is nothing honest to say. */
  label: string | null;
}

/** The `system:<what>:<jobId>` prefix the build worker writes for our work. */
const OPERATOR_EDIT_PREFIX = 'system:operator_edit_build:';
/** The same shape for a paid change request. */
const CHANGE_REQUEST_PREFIX = 'system:change_request_build:';

/**
 * @param createdBy `site_versions.created_by`, verbatim.
 * @param viewerId the Clerk id of whoever is looking, or null when unknown.
 */
export function siteVersionAuthor(
  createdBy: string | null | undefined,
  viewerId: string | null = null
): SiteVersionAuthor {
  const value = (createdBy ?? '').trim();
  if (value.length === 0) return { kind: 'unknown', label: null };

  if (
    value.startsWith(OPERATOR_EDIT_PREFIX) ||
    value.startsWith(CHANGE_REQUEST_PREFIX)
  ) {
    // One label for both. From a client's seat they are the same event -- we
    // changed their site -- and the difference between "we did this because
    // you paid for it" and "we did this" is already on their change request
    // card, in the words they wrote themselves.
    return { kind: 'flowstarter-team', label: 'Built by the Flowstarter team' };
  }
  if (value === 'system' || value.startsWith('system:')) {
    return { kind: 'delivered', label: 'The site as it was delivered' };
  }
  if (viewerId && value === viewerId) return { kind: 'you', label: 'You' };
  // Another member of the client's own workspace. Named as their team rather
  // than by id: we are not the right place for a client's org chart.
  return { kind: 'your-team', label: 'Someone on your team' };
}

/**
 * The same answer for a version row the client's editor already holds.
 * A convenience so callers do not have to remember the field name.
 */
export function siteVersionAuthorLabel(
  version: { createdBy?: string | null },
  viewerId: string | null = null
): string | null {
  return siteVersionAuthor(version.createdBy ?? null, viewerId).label;
}
