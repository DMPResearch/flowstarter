import { describe, expect, it, vi } from 'vitest';

const updateUserMetadata = vi.fn(async () => undefined);
vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: async () => ({ users: { updateUserMetadata } }),
}));

import {
  clearMustChangePassword,
  findOrCreateGuestUser,
  guestNameParts,
} from '../guest-credentials';

describe('the name a paid guest account is created with', () => {
  it('splits the intake name into first and last', () => {
    expect(guestNameParts('Maria Ionescu', 'm@example.com')).toEqual({
      firstName: 'Maria',
      lastName: 'Ionescu',
    });
    expect(guestNameParts('  Ana  Maria Radu ', 'a@example.com')).toEqual({
      firstName: 'Ana',
      lastName: 'Maria Radu',
    });
  });

  it('never leaves a required field empty: a single word or no name still creates the account', () => {
    expect(guestNameParts('Maria', 'm@example.com')).toEqual({
      firstName: 'Maria',
      lastName: 'Client',
    });
    expect(guestNameParts('', 'bogdan+clerk_test@example.com')).toEqual({
      firstName: 'Bogdan',
      lastName: 'Client',
    });
    expect(guestNameParts(null, '@example.com').firstName).toBe('Client');
  });
});

describe('a guest account with nothing to create it against', () => {
  it('refuses an email that is only whitespace', async () => {
    await expect(findOrCreateGuestUser('   ')).rejects.toThrow(
      /needs an email address/
    );
  });
});

describe('letting go of the password we chose', () => {
  it('turns the flag off rather than deleting it, and merges the rest', async () => {
    await clearMustChangePassword('user_guest_1');

    // `updateUserMetadata` deep-merges, so a role already on the user lives.
    expect(updateUserMetadata).toHaveBeenCalledWith('user_guest_1', {
      publicMetadata: { mustChangePassword: false },
    });
  });
});
