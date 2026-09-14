/**
 * Who is allowed to tell this agent to do anything.
 *
 * One shared secret, held by `flowstarter-main` and by the host, compared in
 * constant time. Pulled out of `index.ts` into a pure function for one
 * specific reason: the interesting case cannot be tested where the rule lives.
 * `index.ts` reads the secret once, at module load, so a suite running in a
 * process that has one configured can never exercise the process that does
 * not - and "what happens when the secret is missing" is the case that was
 * wrong.
 *
 * IT WAS WRONG LIKE THIS. `SHARED_SECRET` defaults to `''`. The digest of `''`
 * is a perfectly good SHA-256. A request carrying `Authorization: Bearer `
 * - the word, a space, and nothing after it - produced that same digest and
 * passed `timingSafeEqual`. So an agent started from an env file with the
 * variable misspelled did not fail to start: it accepted deploys from anybody
 * who could reach the port, on a box holding every client site it serves.
 *
 * An unconfigured agent now refuses everything. That is a host that visibly
 * does not work, which is the failure a misconfiguration should have.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * True when `header` presents exactly `secret` as a bearer token.
 *
 * SHA-256 digests are compared rather than the tokens themselves, so two
 * inputs of different lengths still produce two buffers of the same length -
 * there is no early return on a length mismatch for a caller to time the
 * secret's length out of, and `timingSafeEqual` handles the rest.
 */
export function bearerAuthorized(
  header: string | null | undefined,
  secret: string,
): boolean {
  // Before anything is hashed. An agent with no secret has no caller it can
  // recognise, and the digest of the empty string is a valid digest that an
  // empty bearer token would match.
  if (!secret) return false;

  const offered = header ?? '';
  if (!offered.startsWith('Bearer ')) return false;

  const token = offered.slice('Bearer '.length).trim();
  const digest = createHash('sha256').update(token).digest();
  const expected = createHash('sha256').update(secret).digest();
  return timingSafeEqual(digest, expected);
}
