/**
 * Where an operator is sent when they open a client's site in the editor.
 *
 * This rule and `decideAuthTransferDestination` deliberately disagree about
 * the same hostname, and the tests below pin both halves of that disagreement,
 * because getting either one wrong is a live hole:
 *
 *   - the shared allow-list must keep refusing `{slug}.{domain}`. A page on a
 *     client's tenant-authored site asking for a sign-in ticket is the attack
 *     PR #133 exists for.
 *   - this function must still produce that URL, because it is not answering a
 *     browser. The slug is a column the server read and the path is a
 *     constant, so nothing a browser sends reaches it.
 */
import { describe, expect, it } from 'vitest';

import {
  decideAuthTransferDestination,
  decideOperatorEditorDestination,
  type AuthTransferEnvInput,
} from '../src/auth-transfer-policy';

const PRODUCTION: AuthTransferEnvInput = {
  flowstarterEnv: 'production',
  nodeEnv: 'production',
  platformDomain: 'flowstarter.net',
};

const DEVELOPMENT: AuthTransferEnvInput = {
  flowstarterEnv: 'development',
  nodeEnv: 'development',
  platformDomain: 'flowstarter.dev',
};

describe('decideOperatorEditorDestination', () => {
  it('sends the operator to the workspace host, where the editor actually is', () => {
    const decision = decideOperatorEditorDestination('acme', PRODUCTION);
    expect(decision).toEqual({
      allowed: true,
      url: 'https://acme.flowstarter.net/editor/',
      origin: 'https://acme.flowstarter.net',
      surface: 'editor',
    });
  });

  it('is exactly the URL the shared allow-list refuses, and that is the point', () => {
    const slug = 'acme';
    const operator = decideOperatorEditorDestination(slug, PRODUCTION);
    expect(operator.allowed).toBe(true);

    // The same string, offered by a browser, is still refused. If this ever
    // starts passing, the tenant-site hole is open again for every caller.
    const proposed = decideAuthTransferDestination(
      operator.allowed ? operator.url : '',
      PRODUCTION
    );
    expect(proposed.allowed).toBe(false);
    expect(proposed.allowed === false && proposed.reason).toBe(
      'untrusted-origin'
    );
  });

  it('normalises case and whitespace, because a slug column is not a URL', () => {
    expect(decideOperatorEditorDestination('  ACME  ', PRODUCTION)).toMatchObject(
      { url: 'https://acme.flowstarter.net/editor/' }
    );
  });

  it('refuses anything that is not a workspace slug', () => {
    for (const slug of [
      null,
      undefined,
      42,
      '',
      '   ',
      'not a slug',
      '../etc',
      'a.b',
      '-leading',
      'trailing-',
      'x'.repeat(70),
      'https://evil.example',
    ]) {
      const decision = decideOperatorEditorDestination(slug, PRODUCTION);
      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false && decision.reason).toBe('malformed');
    }
  });

  it('refuses a slug that would land on a preview or a PR slot', () => {
    // `isNeverOperatorOwned`, asked for the same reason the policy asks it:
    // we do not control the contents of those hosts, whatever the workspaces
    // table says.
    for (const slug of ['preview', 'pr-7']) {
      const decision = decideOperatorEditorDestination(slug, PRODUCTION);
      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false && decision.reason).toBe(
        'untrusted-origin'
      );
    }
  });

  it('allows http only in development, where there is no certificate', () => {
    expect(decideOperatorEditorDestination('acme', DEVELOPMENT)).toMatchObject({
      url: 'http://acme.flowstarter.dev/editor/',
    });
    expect(
      decideOperatorEditorDestination('acme', {
        flowstarterEnv: 'staging',
        nodeEnv: 'production',
        platformDomain: 'flowstarter.dev',
      })
    ).toMatchObject({ url: 'https://acme.flowstarter.dev/editor/' });
  });

  it('never points at an API path, whatever the slug is', () => {
    const decision = decideOperatorEditorDestination('acme', PRODUCTION);
    expect(decision.allowed && decision.url).toContain('/editor/');
    expect(decision.allowed && decision.url).not.toContain('/api');
  });
});
