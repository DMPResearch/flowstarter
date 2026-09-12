import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { authMock, getUserMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  getUserMock: vi.fn(),
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: () => authMock(),
  clerkClient: async () => ({ users: { getUser: getUserMock } }),
  currentUser: vi.fn(),
}));

function clerkUser({
  role,
  email,
  verified,
}: {
  role?: string;
  email?: string;
  verified?: boolean;
}) {
  return {
    publicMetadata: role ? { role } : {},
    primaryEmailAddressId: email ? 'email_1' : null,
    emailAddresses: email
      ? [
          {
            id: 'email_1',
            emailAddress: email,
            verification: { status: verified ? 'verified' : 'unverified' },
          },
        ]
      : [],
  };
}

describe('resolveUserRole — domain-based operator elevation', () => {
  beforeEach(() => {
    authMock.mockReset();
    getUserMock.mockReset();
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('elevates to admin when the primary email is on a team domain AND verified', async () => {
    authMock.mockResolvedValue({ sessionClaims: undefined });
    getUserMock.mockResolvedValue(
      clerkUser({ email: 'new-hire@flowstarter.dev', verified: true })
    );
    const { resolveUserRole } = await import('../api-auth');
    const role = await resolveUserRole('user_1');
    expect(role).toBe('admin');
  });

  it('does NOT elevate an unverified primary email on a team domain, and logs the refusal', async () => {
    authMock.mockResolvedValue({ sessionClaims: undefined });
    getUserMock.mockResolvedValue(
      clerkUser({ email: 'attacker@flowstarter.dev', verified: false })
    );
    const warnSpy = vi.spyOn(console, 'warn');
    const { resolveUserRole } = await import('../api-auth');
    const role = await resolveUserRole('user_2');
    expect(role).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Refused domain-based admin elevation'),
      expect.objectContaining({ domain: 'flowstarter.dev' })
    );
  });

  it('does not elevate a verified email on a non-team domain', async () => {
    authMock.mockResolvedValue({ sessionClaims: undefined });
    getUserMock.mockResolvedValue(
      clerkUser({ email: 'someone@gmail.com', verified: true })
    );
    const { resolveUserRole } = await import('../api-auth');
    const role = await resolveUserRole('user_3');
    expect(role).toBeUndefined();
  });

  it('lets explicit publicMetadata.role win over an unverified team-domain email', async () => {
    authMock.mockResolvedValue({ sessionClaims: undefined });
    getUserMock.mockResolvedValue(
      clerkUser({
        role: 'client',
        email: 'attacker@flowstarter.dev',
        verified: false,
      })
    );
    const { resolveUserRole } = await import('../api-auth');
    const role = await resolveUserRole('user_4');
    expect(role).toBe('client');
  });

  it('lets explicit publicMetadata.role win even over a verified team-domain email', async () => {
    authMock.mockResolvedValue({ sessionClaims: undefined });
    getUserMock.mockResolvedValue(
      clerkUser({
        role: 'client',
        email: 'staff@flowstarter.dev',
        verified: true,
      })
    );
    const { resolveUserRole } = await import('../api-auth');
    const role = await resolveUserRole('user_5');
    expect(role).toBe('client');
  });

  it('session-claim metadata role short-circuits before any Clerk user lookup', async () => {
    authMock.mockResolvedValue({
      sessionClaims: { metadata: { role: 'admin' } },
    });
    const { resolveUserRole } = await import('../api-auth');
    const role = await resolveUserRole('user_6');
    expect(role).toBe('admin');
    expect(getUserMock).not.toHaveBeenCalled();
  });
});
