/**
 * Every template, rendered, checked against the rules the whole set shares.
 *
 * The per-template assertions live next door in `client-notices.test.ts`; this
 * file is the sweep. It exists because the expensive email mistakes are the
 * uniform ones: a missing preheader, a second button, a text part that lost a
 * fact the HTML still has, an emoji that slipped into a subject line. Adding a
 * template to `preview-fixtures.ts` puts it under all of these at once, which
 * is the point.
 */
import { describe, expect, it } from 'vitest';
import { emailFixtures, lintEmailHtml } from './preview-fixtures';
import { invitationEmail } from '../invitation';
import { leadNotificationEmail } from '../lead-notification';
import { welcomeEmail } from '../welcome';

const fixtures = emailFixtures();
const named = fixtures.map((f) => [f.name, f] as const);

/**
 * Everything the copy rules call an emoji: the symbol and dingbat blocks, the
 * variation selector that turns a plain glyph into one, and the astral planes,
 * matched through their surrogate pair because the app's tsconfig target
 * predates the `u` flag.
 *
 * Built from a string rather than written as a literal so the source stays
 * readable: Prettier rewrites `\uXXXX` inside a regex literal to the character
 * itself, which would leave an invisible variation selector sitting in a file
 * whose whole job is to notice invisible characters.
 */
const EMOJI = new RegExp(
  '[\\u2600-\\u27BF]|\\uFE0F|[\\uD83C-\\uD83E][\\uDC00-\\uDFFF]'
);

/** Em dash and en dash, the two the house style bans. */
const LONG_DASH = new RegExp('[\\u2014\\u2013]');

describe('every template', () => {
  it('covers every email the product sends', () => {
    expect(fixtures.map((f) => f.name)).toEqual([
      'preview-ready',
      'deposit-paid',
      'brief-incomplete',
      'balance-invoice',
      'site-live',
      'build-needs-review',
      'new-booking',
      'change-delivered',
      'welcome',
      'invitation',
      'verification-link',
      'verification-code',
      'lead-notification',
      'guest-deposit-welcome',
      'guest-deposit-welcome-existing',
    ]);
  });

  it.each(named)('%s has a subject an inbox list can show whole', (_n, f) => {
    expect(f.mail.subject.length).toBeGreaterThan(0);
    expect(f.mail.subject.length).toBeLessThanOrEqual(60);
  });

  it.each(named)('%s has a preheader, and it is in the HTML', (_n, f) => {
    expect(f.mail.preheader.trim().length).toBeGreaterThan(0);
    expect(f.mail.html).toContain(f.mail.preheader);
  });

  it.each(named)(
    '%s carries the wordmark, with no image that could 404',
    (_n, f) => {
      expect(f.mail.html).toContain('class="fs-mark"');
      expect(f.mail.html).toContain('>Flow</span>starter');
      // EMAIL_ASSET_BASE_URL is unset for every fixture, so no template can
      // depend on an asset this deployment cannot prove is reachable.
      expect(f.mail.html).not.toContain('<img');
    }
  );

  it.each(named)('%s has exactly one heading', (_n, f) => {
    expect(f.mail.html.match(/<h1/g) ?? []).toHaveLength(1);
  });

  it.each(named)('%s has at most one primary button', (_n, f) => {
    const buttons = f.mail.html.match(/class="fs-button"/g) ?? [];
    expect(buttons).toHaveLength(f.button ? 1 : 0);
    if (f.button) {
      // Both halves of the bulletproof button point at the same place.
      const vml = f.mail.html.match(/<v:roundrect[^>]*href="([^"]+)"/);
      expect(vml?.[1]).toBe(f.button);
      expect(f.mail.html).toContain(`class="fs-button" href="${f.button}"`);
    }
  });

  it.each(named)('%s keeps its facts in the plain-text part', (_n, f) => {
    for (const fact of f.textContains) expect(f.mail.text).toContain(fact);
    expect(f.mail.text).not.toMatch(/<[a-z/]/i);
    if (f.button) expect(f.mail.text).toContain(f.button);
  });

  it.each(named)('%s uses no em dashes and no emoji', (_n, f) => {
    for (const part of [
      f.mail.subject,
      f.mail.preheader,
      f.mail.html,
      f.mail.text,
    ]) {
      expect(part).not.toMatch(LONG_DASH);
      expect(part).not.toMatch(EMOJI);
    }
  });

  it.each(named)('%s uses only CSS a mail client runs', (_n, f) => {
    expect(lintEmailHtml(f.mail.html)).toEqual([]);
  });

  it.each(named)('%s stays under the Gmail clipping limit', (_n, f) => {
    expect(Buffer.byteLength(f.mail.html, 'utf8')).toBeLessThan(100 * 1024);
  });
});

describe('subjects', () => {
  it('are the ones the product promises, and none of them shout', () => {
    expect(
      Object.fromEntries(fixtures.map((f) => [f.name, f.mail.subject]))
    ).toEqual({
      'preview-ready': 'Your preview is ready',
      'deposit-paid': 'Your deposit is in and your build has started',
      'brief-incomplete': 'We are waiting on a few things for your site',
      'balance-invoice': 'Your balance invoice is ready',
      'site-live': 'Your site is live',
      'build-needs-review': 'Your build needs a second look',
      'new-booking': 'New booking on your site',
      'change-delivered': 'Your change is live',
      // Was "Welcome to Flowstarter! 🎉". The emoji broke the house style the
      // rest of the set is held to, and an exclamation mark in an inbox list
      // reads as marketing.
      welcome: 'Welcome to Flowstarter',
      invitation: "You're invited to join Flowstarter",
      'verification-link': 'Verify your email for Flowstarter',
      'verification-code': 'Verify your email for Flowstarter',
      // Was "New lead on <site>: <name>", which put a stranger's name in the
      // client's inbox list and called their customer a lead. One sentence per
      // enquiry is also something an inbox rule can be written against.
      'lead-notification': 'New enquiry from your site',
      'guest-deposit-welcome': 'Your Flowstarter account and your build',
      'guest-deposit-welcome-existing':
        'Your deposit is in and your build has started',
    });
  });
});

/**
 * The sparse cases, which are the ones that reach a real inbox looking wrong.
 * A contact form with three optional fields produces an enquiry with three
 * blanks more often than it produces a complete one.
 */
describe('what a template does with what it was not given', () => {
  it('omits the rows an enquiry has no value for', () => {
    const mail = leadNotificationEmail({
      leadEmail: 'someone@example.com',
      receivedAt: 'just now',
    });
    expect(mail.html).toContain('Hi there,');
    expect(mail.html).toContain('Someone just got in touch');
    expect(mail.html).toContain('your website');
    expect(mail.html).toContain('someone@example.com');
    // No name, no phone, no source, no message, and no empty rows for them.
    expect(mail.html).not.toContain('Phone');
    expect(mail.html).not.toContain('Source');
    expect(mail.html).not.toContain('Name');
    // Nowhere to send them without an inbox URL, so no button at all.
    expect(mail.html).not.toContain('class="fs-button"');
    expect(mail.html).toContain('Received');
    expect(mail.text).toContain('Received: just now');
  });

  it('quotes the enquiry in the preheader when there is one', () => {
    const withMessage = leadNotificationEmail({
      leadName: 'Mihai',
      leadMessage: 'Are you open on Saturday?',
    });
    expect(withMessage.preheader).toBe('Mihai: Are you open on Saturday?');
    const without = leadNotificationEmail({ projectName: 'Acme' });
    expect(without.preheader).toBe('Someone got in touch through Acme.');
  });

  it('greets a new account that gave no name', () => {
    const mail = welcomeEmail({ dashboardUrl: 'https://x.example' });
    expect(mail.html).toContain('Hi there,');
    expect(
      welcomeEmail({ userName: '  ', dashboardUrl: 'https://x.example' }).html
    ).toContain('Hi there,');
  });

  it('singularises a one-day invitation window', () => {
    expect(
      invitationEmail({
        inviterName: 'Darius',
        inviterEmail: 'd@x.example',
        invitationUrl: 'https://x.example/i',
        expiresInDays: 1,
      }).text
    ).toContain('expires in 1 day.');
  });
});
