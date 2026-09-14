/**
 * Throwaway provider credentials for the portrait suites, minted at run time.
 *
 * The suites used to set the provider secret keys to short made-up strings.
 * They were never real, and that is not the point: a secret scanner reads a
 * repository, not a programmer's intentions, and a string literal assigned to a
 * key named `*_SECRET` is exactly the shape it is built to find. Every one of
 * those is an alert somebody has to triage, and a scanner that cries wolf on
 * committed fixtures is a scanner people learn to wave through, which is how a
 * real leak gets waved through with it.
 *
 * So nothing here is committed. `randomBytes` mints a fresh value per process,
 * prefixed `test-` and named after what it stands in for, so a value that ever
 * did escape into a log is self-evidently a fixture. Within one run it is
 * stable, which is all a test needs: the suites sign a state with it and verify
 * the signature with it in the same process.
 *
 * The rule this exists to make easy: no `*_SECRET` key is assigned a string
 * literal anywhere in committed code, not even in a test.
 */
import { randomBytes } from 'node:crypto';

/** How many random bytes stand behind one fixture. Long enough to be unguessable. */
const CREDENTIAL_BYTES = 16;

/**
 * A credential that is obviously not one, minted fresh.
 *
 * `label` only names what the value stands for, so a failing assertion reads
 * as "the LinkedIn secret" rather than as forty hex characters.
 */
export function testCredential(label: string): string {
  return `test-${label}-${randomBytes(CREDENTIAL_BYTES).toString('hex')}`;
}

/**
 * The four provider credentials, as one environment.
 *
 * A type alias rather than an interface, deliberately: the suites pass this
 * straight into functions typed `EnvLike`, which is an index signature, and
 * TypeScript gives an implicit one to an alias and not to an interface.
 */
export type PortraitTestCredentials = {
  LINKEDIN_CLIENT_ID: string;
  LINKEDIN_CLIENT_SECRET: string;
  INSTAGRAM_APP_ID: string;
  INSTAGRAM_APP_SECRET: string;
};

/**
 * A deployment with both providers wired up.
 *
 * Called once per suite, at module scope, so every test in a file sees the
 * same four values and a state signed in one test verifies in another.
 */
export function portraitTestCredentials(): PortraitTestCredentials {
  return {
    LINKEDIN_CLIENT_ID: testCredential('linkedin-client-id'),
    LINKEDIN_CLIENT_SECRET: testCredential('linkedin-client'),
    INSTAGRAM_APP_ID: testCredential('instagram-app-id'),
    INSTAGRAM_APP_SECRET: testCredential('instagram-app'),
  };
}

/**
 * Values that are present but say nothing, for the cases that prove a
 * half-finished `.env` counts as absent rather than as a credential.
 *
 * Named constants rather than literals at the assignment, so no line in any
 * suite sets a secret-shaped key to a quoted string, even one made of spaces.
 * Two of them, because the suites pin that spaces and a newline are treated
 * alike and a single constant would quietly collapse that pair into one case.
 */
export const BLANK_CREDENTIAL = '   ';
export const WHITESPACE_ONLY_CREDENTIAL = '\n ';

/** The same credential with whitespace around it, for the trimming cases. */
export function padded(value: string): string {
  return ` ${value} `;
}
