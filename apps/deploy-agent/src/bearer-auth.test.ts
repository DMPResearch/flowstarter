/**
 * The one credential that stands between a caller and every site on a host.
 *
 * The case that matters most here is the one `server-routes.test.ts` cannot
 * reach: a process with no secret configured. `index.ts` reads the secret once
 * at module load, so a suite running with one set can never exercise the
 * agent that has none — and that was the agent that was wrong.
 */
import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { bearerAuthorized } from './bearer-auth';

/**
 * Minted per process rather than written down.
 *
 * A quoted string assigned to something called `SECRET` is, to a credential
 * scanner, indistinguishable from a real one that got committed — and the
 * scanner is right to read it that way, because the difference is a promise in
 * a comment. Generating it here means there is no literal in the repository to
 * be wrong about, and every case below is about the *shape* of the comparison
 * rather than about any particular value.
 */
const SECRET = `test-${randomBytes(16).toString('hex')}`;

describe('an agent with no secret configured', () => {
  test('refuses an empty bearer token instead of matching it', () => {
    // The bug, stated as a test. `Authorization: Bearer ` with nothing after
    // it hashes to the SHA-256 of the empty string, which is exactly what an
    // empty `DEPLOY_AGENT_SHARED_SECRET` hashed to. It passed.
    expect(bearerAuthorized('Bearer ', '')).toBe(false);
    expect(bearerAuthorized('Bearer', '')).toBe(false);
    expect(bearerAuthorized('Bearer  ', '')).toBe(false);
  });

  test('refuses every other caller too, rather than working for one', () => {
    for (const header of [null, undefined, '', `Bearer ${SECRET}`, 'Bearer x']) {
      expect(bearerAuthorized(header, '')).toBe(false);
    }
  });
});

describe('an agent with a secret', () => {
  test('accepts exactly that secret', () => {
    expect(bearerAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  test('accepts it with the surrounding whitespace a client may add', () => {
    expect(bearerAuthorized(`Bearer  ${SECRET} `, SECRET)).toBe(true);
  });

  test('refuses a secret with one byte changed', () => {
    const almost = `${SECRET.slice(0, -1)}${SECRET.endsWith('e') ? 'f' : 'e'}`;
    expect(almost).not.toBe(SECRET);
    expect(almost.length).toBe(SECRET.length);
    expect(bearerAuthorized(`Bearer ${almost}`, SECRET)).toBe(false);
  });

  test('refuses a prefix of the secret, which is what a guess looks like', () => {
    for (let i = 1; i < SECRET.length; i += 5) {
      expect(bearerAuthorized(`Bearer ${SECRET.slice(0, i)}`, SECRET)).toBe(
        false,
      );
    }
  });

  test('refuses the secret with anything appended', () => {
    expect(bearerAuthorized(`Bearer ${SECRET}x`, SECRET)).toBe(false);
  });

  test('refuses a missing header', () => {
    expect(bearerAuthorized(null, SECRET)).toBe(false);
    expect(bearerAuthorized(undefined, SECRET)).toBe(false);
  });

  test('refuses a scheme that is not Bearer, even carrying the secret', () => {
    expect(bearerAuthorized(`Basic ${SECRET}`, SECRET)).toBe(false);
    expect(bearerAuthorized(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(bearerAuthorized(SECRET, SECRET)).toBe(false);
  });
});
