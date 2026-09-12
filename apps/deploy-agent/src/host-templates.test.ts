import { describe, expect, test } from 'bun:test';
import { hostFromTemplate, slugFromTemplateHost } from './host-templates';

const SITE = '{slug}.flowstarter.net';
const PREVIEW = '{slug}.preview.flowstarter.net';

describe('hostFromTemplate', () => {
  test('builds the final and the preview hostname from the same rule', () => {
    expect(hostFromTemplate(SITE, 'acme')).toBe('acme.flowstarter.net');
    expect(hostFromTemplate(PREVIEW, 'p-0123456789abcdef')).toBe(
      'p-0123456789abcdef.preview.flowstarter.net',
    );
  });

  test('an unset template means this agent adds no such host', () => {
    for (const template of [undefined, null, '', '   ']) {
      expect(hostFromTemplate(template, 'acme')).toBeNull();
    }
  });

  test('a template with no placeholder is a misconfiguration, not a suffix', () => {
    // Silently treating `flowstarter.net` as a suffix would put every site on
    // one hostname, which is worse than having no hostname.
    expect(hostFromTemplate('flowstarter.net', 'acme')).toBeNull();
  });

  test('refuses a slug that is not a slug', () => {
    for (const bad of ['', 'ACME', '-acme', 'acme-', 'acme.com', '../etc']) {
      expect(hostFromTemplate(SITE, bad)).toBeNull();
    }
  });
});

describe('slugFromTemplateHost — what /tls-ask decides on', () => {
  test('recovers the slug from a host the template would have produced', () => {
    expect(slugFromTemplateHost(SITE, 'acme.flowstarter.net')).toBe('acme');
    expect(
      slugFromTemplateHost(
        PREVIEW,
        'p-0123456789abcdef.preview.flowstarter.net',
      ),
    ).toBe('p-0123456789abcdef');
  });

  test('is case-insensitive about the hostname Caddy hands it', () => {
    expect(slugFromTemplateHost(SITE, 'ACME.FlowStarter.NET')).toBe('acme');
  });

  test('refuses a host from a zone this agent does not serve', () => {
    expect(slugFromTemplateHost(SITE, 'acme.example.com')).toBeNull();
    expect(slugFromTemplateHost(SITE, 'acme.flowstarter.dev')).toBeNull();
  });

  test('a preview host is not a final host, and the reverse', () => {
    // Two families. Answering for the wrong one is how a preview name gets a
    // certificate from the agent that serves paying customers.
    expect(
      slugFromTemplateHost(SITE, 'p-0123456789abcdef.preview.flowstarter.net'),
    ).toBeNull();
    expect(slugFromTemplateHost(PREVIEW, 'acme.flowstarter.net')).toBeNull();
  });

  test('refuses the bare zone, with nothing where the slug should be', () => {
    expect(slugFromTemplateHost(SITE, 'flowstarter.net')).toBeNull();
    expect(slugFromTemplateHost(SITE, '.flowstarter.net')).toBeNull();
  });

  test('refuses a wildcard, which is never one site', () => {
    expect(slugFromTemplateHost(SITE, '*.flowstarter.net')).toBeNull();
  });

  test('an unset or ambiguous template answers for nothing', () => {
    expect(slugFromTemplateHost(undefined, 'acme.flowstarter.net')).toBeNull();
    expect(
      slugFromTemplateHost(
        '{slug}.{slug}.flowstarter.net',
        'a.b.flowstarter.net',
      ),
    ).toBeNull();
  });
});
