/**
 * What counts as a Cal.com booking link.
 *
 * The cases that matter are the ones where "close enough" is a real problem.
 * The stored value ends up as an iframe on a site we host under the client's
 * own domain, so a host that merely contains `cal.com` is not a near miss, it
 * is a stranger's page rendered inside our customer's business.
 */
import { describe, expect, it } from 'vitest';
import {
  calEmbedSrc,
  calLinkRejectionMessage,
  isCalLink,
  parseCalLink,
  type CalLinkRejection,
} from '../cal-link';

function link(raw: string) {
  const result = parseCalLink(raw);
  if (!result.ok)
    throw new Error(`expected ${raw} to parse, got ${result.reason}`);
  return result.link;
}

function rejection(raw: string): CalLinkRejection {
  const result = parseCalLink(raw);
  if (result.ok) throw new Error(`expected ${raw} to be refused`);
  return result.reason;
}

describe('the links a client may save', () => {
  it('takes the three Cal.com hosts and canonicalises all of them to cal.com', () => {
    for (const raw of [
      'https://cal.com/halden-roe/intro',
      'https://www.cal.com/halden-roe/intro',
      'https://app.cal.com/halden-roe/intro',
    ]) {
      expect(link(raw).url).toBe('https://cal.com/halden-roe/intro');
    }
  });

  it('takes a link with no scheme, and a bare handle on its own', () => {
    expect(link('cal.com/halden-roe/intro').url).toBe(
      'https://cal.com/halden-roe/intro'
    );
    expect(link('halden-roe/intro').url).toBe(
      'https://cal.com/halden-roe/intro'
    );
    expect(link('halden-roe').url).toBe('https://cal.com/halden-roe');
  });

  it('takes a team or user page with no event on it', () => {
    expect(link('https://cal.com/halden-roe')).toMatchObject({
      handle: 'halden-roe',
      eventSlug: null,
      path: 'halden-roe',
    });
  });

  it('drops the query string and the fragment people copy out of the bar', () => {
    expect(
      link('https://cal.com/halden-roe/intro?month=2026-09#slot').url
    ).toBe('https://cal.com/halden-roe/intro');
  });

  it('takes underscores, digits and hyphens, which Cal.com allows', () => {
    expect(link('halden_roe2/30min').url).toBe(
      'https://cal.com/halden_roe2/30min'
    );
  });

  it('ignores surrounding whitespace and a leading slash', () => {
    expect(link('  /halden-roe/intro  ').url).toBe(
      'https://cal.com/halden-roe/intro'
    );
  });
});

describe('the links a client may not save', () => {
  // The whole reason the host is parsed rather than matched as a substring.
  it('refuses a host that merely contains cal.com', () => {
    expect(rejection('https://cal.com.attacker.example/halden-roe')).toBe(
      'host'
    );
    expect(rejection('https://notcal.com/halden-roe')).toBe('host');
    expect(rejection('https://evil.app.cal.com.example/x')).toBe('host');
  });

  it('refuses another vendor entirely', () => {
    expect(rejection('https://calendly.com/halden-roe/intro')).toBe('host');
  });

  it('refuses http, because the embed runs inside an https document', () => {
    expect(rejection('http://cal.com/halden-roe/intro')).toBe('scheme');
    expect(rejection('javascript:alert(1)')).toBe('scheme');
  });

  it('refuses a path that is not a booking page', () => {
    expect(rejection('https://cal.com')).toBe('path');
    expect(rejection('https://cal.com/')).toBe('path');
    expect(rejection('https://cal.com/a/b/c')).toBe('path');
  });

  it('refuses Cal.com’s own product pages, which no visitor can book', () => {
    expect(rejection('https://cal.com/bookings/upcoming')).toBe('reserved');
    expect(rejection('https://cal.com/settings')).toBe('reserved');
    expect(rejection('https://cal.com/event-types')).toBe('reserved');
    // Case does not get you past it.
    expect(rejection('https://cal.com/Settings')).toBe('reserved');
  });

  it('refuses a segment carrying anything but slug characters', () => {
    expect(rejection('https://cal.com/halden roe/intro')).toBe('path');
    expect(rejection('https://cal.com/-leading/intro')).toBe('path');
    expect(rejection('https://cal.com/halden%2Froe')).toBe('path');
    expect(rejection(`https://cal.com/${'x'.repeat(65)}`)).toBe('path');
  });

  it('refuses an empty paste and a paste that is an essay', () => {
    expect(rejection('')).toBe('empty');
    expect(rejection('   ')).toBe('empty');
    expect(rejection('x'.repeat(401))).toBe('too_long');
  });

  it('refuses something that is not a url at all', () => {
    expect(rejection('https://')).toBe('malformed');
  });
});

describe('what the client is told when a paste is refused', () => {
  it('has a sentence for every reason, and none of them says "error"', () => {
    const reasons: CalLinkRejection[] = [
      'empty',
      'too_long',
      'malformed',
      'scheme',
      'host',
      'path',
      'reserved',
    ];
    for (const reason of reasons) {
      const message = calLinkRejectionMessage(reason);
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toMatch(/error|invalid input|failed/i);
      // House style: no em dashes anywhere a client can read.
      expect(message).not.toContain('—');
    }
  });

  it('names the actual problem rather than giving one generic line', () => {
    expect(calLinkRejectionMessage('host')).toMatch(/Only cal.com links/);
    expect(calLinkRejectionMessage('scheme')).toMatch(/https/);
    expect(calLinkRejectionMessage('reserved')).toMatch(/settings page/);
  });
});

describe('isCalLink and calEmbedSrc', () => {
  it('agrees with the parser', () => {
    expect(isCalLink('halden-roe/intro')).toBe(true);
    expect(isCalLink('')).toBe(false);
    expect(isCalLink('https://calendly.com/x')).toBe(false);
  });

  it('builds the documented no-JS embed route', () => {
    expect(calEmbedSrc(link('halden-roe/intro'))).toBe(
      'https://cal.com/halden-roe/intro/embed?layout=month_view&theme=light'
    );
  });
});
