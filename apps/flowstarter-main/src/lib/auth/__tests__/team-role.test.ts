/**
 * Security audit 2026-09-13 (Claude, M1; Codex, F17): `middleware.ts` had
 * its own private copy of this rule that discarded Clerk's verification
 * status entirely, elevating ANY primary email on a team domain — verified
 * or not — to admin. This is the regression suite for the single shared
 * rule both `middleware.ts` and `src/lib/api-auth.ts` now import.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { TEAM_EMAIL_DOMAINS, teamRoleForEmail } from '../team-role';

describe('teamRoleForEmail', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('elevates a verified primary email on a team domain', () => {
    expect(
      teamRoleForEmail({ address: 'new-hire@flowstarter.dev', verified: true })
    ).toBe('admin');
  });

  it('does NOT elevate an unverified primary email on a team domain', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      teamRoleForEmail({ address: 'attacker@flowstarter.dev', verified: false })
    ).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Refused domain-based admin elevation'),
      expect.objectContaining({ domain: 'flowstarter.dev' })
    );
  });

  it('does not elevate a verified email on a non-team domain', () => {
    expect(
      teamRoleForEmail({ address: 'someone@gmail.com', verified: true })
    ).toBeUndefined();
  });

  it('treats missing/undefined as no role, never throwing', () => {
    expect(teamRoleForEmail(undefined)).toBeUndefined();
    expect(teamRoleForEmail({ address: '', verified: true })).toBeUndefined();
  });

  it('is case-insensitive on the domain', () => {
    expect(
      teamRoleForEmail({ address: 'Ops@FLOWSTARTER.DEV', verified: true })
    ).toBe('admin');
  });

  it('every configured team domain elevates when verified', () => {
    Array.from(TEAM_EMAIL_DOMAINS).forEach((domain) => {
      expect(
        teamRoleForEmail({ address: `person@${domain}`, verified: true })
      ).toBe('admin');
    });
  });
});
