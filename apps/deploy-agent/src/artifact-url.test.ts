/**
 * Where this agent will and will not go to fetch a tarball.
 *
 * The sha256 check proves the bytes are the bytes the caller committed to. It
 * says nothing about the request being made, and the request is made from
 * inside a host's network. So these cases are about the address, not the
 * payload: a URL that would have this process read the host's own disk, ask
 * the cloud for the machine's credentials, or fetch from a tenant it has no
 * business fetching from.
 */
import { describe, expect, test } from 'bun:test';
import {
  ARTIFACT_HOSTS_ENV_VAR,
  artifactUrlPolicy,
  checkArtifactUrl,
} from './artifact-url';

/** What an un-upgraded host has: no allow list, rule one only. */
const OPEN = { allowedHosts: [] as string[] };
const PINNED = { allowedHosts: ['artifacts.flowstarter.net', '127.0.0.1:9999'] };

const refusal = (raw: string, policy = OPEN) => {
  const verdict = checkArtifactUrl(raw, policy);
  expect(verdict.ok).toBe(false);
  return verdict.ok ? '' : verdict.reason;
};

describe('rules that apply in every configuration', () => {
  test('refuses a scheme that is not http or https', () => {
    for (const raw of [
      'file:///etc/shadow',
      'file:///var/www/sites/other-client/index.html',
      'ftp://artifacts.flowstarter.net/site.tar.gz',
      'gopher://artifacts.flowstarter.net/1',
      'data:application/gzip;base64,H4sIAAAAAAAAA',
    ]) {
      expect(refusal(raw)).toContain('http or https');
    }
  });

  test('refuses credentials smuggled into the URL', () => {
    expect(refusal('https://user:pass@artifacts.flowstarter.net/x.tar.gz')).toContain(
      'credentials',
    );
    expect(refusal('https://user@artifacts.flowstarter.net/x.tar.gz')).toContain(
      'credentials',
    );
  });

  test('refuses the cloud metadata address, by address and by name', () => {
    for (const raw of [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://169.254.170.2/v2/credentials',
      'http://[fe80::1]/x.tar.gz',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://metadata/computeMetadata/v1/',
    ]) {
      expect(refusal(raw)).toContain('link-local or metadata');
    }
  });

  test('refuses something that is not a URL at all', () => {
    for (const raw of ['', 'not a url', '/var/www/sites/x.tar.gz', '//host/x']) {
      expect(refusal(raw)).toContain('not a URL');
    }
  });

  test('allows an ordinary origin when nothing is pinned', () => {
    // Deliberate: an agent upgraded without new configuration keeps working.
    // The allow list is the stronger rule and it is opt-in.
    const verdict = checkArtifactUrl(
      'https://artifacts.example.test/sites/acme.tar.gz',
      OPEN,
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('a pinned agent', () => {
  test('fetches from the hosts it was given', () => {
    expect(
      checkArtifactUrl('https://artifacts.flowstarter.net/x.tar.gz', PINNED).ok,
    ).toBe(true);
    expect(checkArtifactUrl('http://127.0.0.1:9999/x.tar.gz', PINNED).ok).toBe(
      true,
    );
  });

  test('refuses a foreign host, however plausible it looks', () => {
    for (const raw of [
      'https://artifacts.flowstarter.net.evil.example/x.tar.gz',
      'https://evil.example/artifacts.flowstarter.net/x.tar.gz',
      'https://artifacts.flowstarter.example/x.tar.gz',
      'https://other-tenant.flowstarter.net/x.tar.gz',
    ]) {
      expect(refusal(raw, PINNED)).toContain('not one this agent fetches from');
    }
  });

  test('refuses the right host on a port it was not given', () => {
    expect(refusal('http://127.0.0.1:9998/x.tar.gz', PINNED)).toContain(
      'not one this agent fetches from',
    );
  });

  test('allows an entry written without a port on any port', () => {
    // `artifacts.flowstarter.net` was pinned as a bare hostname, so the
    // operator did not say anything about ports and neither does the rule.
    expect(
      checkArtifactUrl('https://artifacts.flowstarter.net:8443/x.tar.gz', PINNED)
        .ok,
    ).toBe(true);
  });

  test('still refuses metadata even if somebody pins it', () => {
    const silly = { allowedHosts: ['169.254.169.254'] };
    expect(refusal('http://169.254.169.254/latest/', silly)).toContain(
      'link-local or metadata',
    );
  });
});

describe('the policy itself', () => {
  test('is empty on an empty environment', () => {
    expect(artifactUrlPolicy({})).toEqual({ allowedHosts: [] });
  });

  test('is the list an operator wrote, trimmed and lowercased', () => {
    expect(
      artifactUrlPolicy({
        [ARTIFACT_HOSTS_ENV_VAR]: ' Artifacts.Flowstarter.NET , ,127.0.0.1:9999 ',
      }),
    ).toEqual({ allowedHosts: ['artifacts.flowstarter.net', '127.0.0.1:9999'] });
  });
});
