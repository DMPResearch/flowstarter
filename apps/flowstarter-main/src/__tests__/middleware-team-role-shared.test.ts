/**
 * Security audit 2026-09-13 (Claude, M1; Codex, F17): `middleware.ts` kept
 * a private copy of the flowstarter-domain admin-elevation rule that never
 * checked Clerk's email verification status, despite a comment on it
 * reading "Mirrors `resolveUserRole` in src/lib/api-auth.ts — keep them in
 * sync." PR #121 patched only `api-auth.ts`; the middleware copy shipped
 * unpatched. This test reads `middleware.ts` from disk (its Clerk/Edge
 * dependencies make it unimportable in this unit suite, same reasoning as
 * `lead-capture-middleware.test.ts`) and fails if the private copy — or any
 * other locally-defined admin-elevation rule — ever comes back.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const MIDDLEWARE = readFileSync(
  path.resolve(__dirname, '..', 'middleware.ts'),
  'utf8'
);

describe('middleware.ts imports the shared team-role rule instead of defining its own', () => {
  it('does not define a local TEAM_EMAIL_DOMAINS set', () => {
    expect(MIDDLEWARE).not.toMatch(/const\s+TEAM_EMAIL_DOMAINS\s*=/);
  });

  it('does not define a local emailDomainRole function', () => {
    expect(MIDDLEWARE).not.toMatch(/function\s+emailDomainRole\s*\(/);
  });

  it('imports teamRoleForEmail from the shared module', () => {
    expect(MIDDLEWARE).toMatch(
      /import\s*\{\s*teamRoleForEmail\s*\}\s*from\s*['"]@\/lib\/auth\/team-role['"]/
    );
  });

  it('calls teamRoleForEmail rather than a private helper when resolving the role', () => {
    expect(MIDDLEWARE).toMatch(/teamRoleForEmail\(/);
  });

  it('passes a verified flag through rather than a bare email string', () => {
    // The bug this regresses: the old copy took `email: string | undefined`
    // and never looked at Clerk's verification status at all. Any call
    // shaped like the fixed one must carry a `verified:` field.
    expect(MIDDLEWARE).toMatch(/verified:\s*primaryEmail\.verification/);
  });
});
