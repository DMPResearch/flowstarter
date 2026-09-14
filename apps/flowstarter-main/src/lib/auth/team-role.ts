/**
 * The single rule for "does this email earn the automatic flowstarter-domain
 * admin role", shared by `middleware.ts` (the Edge page gate) and
 * `src/lib/api-auth.ts` (`resolveUserRole`, every `/api/admin/*` route).
 *
 * Security audit 2026-09-13 (Claude, M1; Codex, F17) — PR #121 fixed the
 * verification check in `api-auth.ts` and left a byte-identical copy in
 * `middleware.ts` unpatched, despite a comment on the middleware copy
 * reading "Mirrors resolveUserRole in src/lib/api-auth.ts — keep them in
 * sync." Two copies kept in sync by a comment is the defect a reader cannot
 * see failed; one function two callers import cannot drift, because there
 * is nothing left to keep in sync.
 *
 * Rule: the domain must be one of the internal team domains AND Clerk must
 * have verified that address. An unverified address on a team domain does
 * NOT elevate — anyone can type `you@flowstarter.dev` into a sign-up form;
 * only Clerk's verification proves the person actually controls that
 * mailbox. `publicMetadata.role` (checked before this ever runs, by both
 * callers) always stays authoritative over this fallback.
 */

/**
 * @flowstarter.* primary emails auto-resolve to admin so internal hires
 * don't need a manual Clerk metadata edit before they can use /admin/*.
 */
export const TEAM_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'flowstarter.net',
  'flowstarter.app',
  'flowstarter.dev',
  'flowstarter.com',
]);

/**
 * The minimal shape either caller needs from a Clerk email address: enough
 * to unit test with a plain object, without importing Clerk's full type.
 */
export interface TeamEmailAddress {
  address: string;
  /** Clerk's `verification.status === 'verified'` for this address. */
  verified: boolean;
}

/**
 * Whether a primary email address earns the automatic flowstarter-domain
 * operator role. Returns `'admin'` or `undefined` — never throws, never
 * elevates on anything short of a verified team-domain address.
 */
export function teamRoleForEmail(
  email: TeamEmailAddress | undefined
): string | undefined {
  if (!email?.address) return undefined;
  const domain = email.address.split('@')[1]?.toLowerCase();
  if (!domain || !TEAM_EMAIL_DOMAINS.has(domain)) return undefined;

  if (!email.verified) {
    console.warn(
      '[team-role] Refused domain-based admin elevation: primary email on a team domain is not verified',
      { domain }
    );
    return undefined;
  }

  return 'admin';
}
