/**
 * The seven client notices, rendered.
 *
 * A template test earns its place by pinning the two things that are invisible
 * at the call site and expensive to get wrong in an inbox: the subject line,
 * which is all most people read, and the link, which is the only reason the
 * email exists. Everything else here is house style the reviewer cannot keep
 * in their head across seven templates and a year, so it is asserted instead:
 * no em dashes, no emoji, and a client-supplied name that cannot close the tag
 * it is sitting in.
 */
import { describe, expect, it } from 'vitest';
import {
  balanceInvoiceEmail,
  bookingPageReadyEmail,
  briefIncompleteEmail,
  buildNeedsReviewEmail,
  changeRequestLiveEmail,
  depositReceivedEmail,
  escapeHtml,
  newBookingEmail,
  newEnquiryEmail,
  previewReadyEmail,
  readableDate,
  siteLiveEmail,
  type RenderedEmail,
} from '../client-notices';

const DASHBOARD = 'https://flowstarter.net/dashboard/projects/ws-1';
const BRIEF = `${DASHBOARD}/brief`;

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
  // The variation selector is its own alternative rather than a member of the
  // first class: inside a class it reads as a combining mark on whatever
  // precedes it, which is both wrong and an eslint error.
  '[\\u2190-\\u2BFF]|\\uFE0F|[\\uD83C-\\uD83E][\\uDC00-\\uDFFF]'
);

/** Em dash and en dash, the two the house style bans. */
const LONG_DASH = new RegExp('[\\u2014\\u2013]');

const ALL: Array<[string, RenderedEmail]> = [
  [
    'depositReceived',
    depositReceivedEmail({ dashboardUrl: DASHBOARD, businessName: 'Acme' }),
  ],
  [
    'previewReady',
    previewReadyEmail({
      previewUrl: 'https://p-abc.preview.flowstarter.net',
      businessName: 'Acme',
    }),
  ],
  [
    'balanceInvoice',
    balanceInvoiceEmail({
      hostedInvoiceUrl: 'https://invoice.stripe.com/i/abc',
      amount: '€639.20',
      dashboardUrl: DASHBOARD,
    }),
  ],
  [
    'siteLive',
    siteLiveEmail({
      siteUrl: 'https://acme.example',
      dashboardUrl: DASHBOARD,
      businessName: 'Acme',
    }),
  ],
  [
    'buildNeedsReview',
    buildNeedsReviewEmail({ dashboardUrl: DASHBOARD, businessName: 'Acme' }),
  ],
  [
    'newBooking',
    newBookingEmail({
      bookingsUrl: `${DASHBOARD}/bookings`,
      when: 'Thursday 18 September, 10:30',
      attendeeName: 'Mihai',
      eventName: 'a consultation',
      businessName: 'Acme',
    }),
  ],
  [
    'briefIncomplete',
    briefIncompleteEmail({
      briefUrl: BRIEF,
      missing: ['A sentence or two on what you offer.'],
      businessName: 'Acme',
    }),
  ],
  [
    'bookingPageReady',
    bookingPageReadyEmail({
      bookingUrl: 'https://cal.flowstarter.dev/acme/intro-call',
      passwordSetupUrl: 'https://cal.flowstarter.dev/auth/forgot-password',
      dashboardUrl: DASHBOARD,
      businessName: 'Acme',
    }),
  ],
  [
    'changeRequestLive',
    changeRequestLiveEmail({
      request: 'Put the Saturday hours in the footer.',
      siteUrl: 'https://acme.example',
      dashboardUrl: DASHBOARD,
      version: 4,
      businessName: 'Acme',
    }),
  ],
  [
    'newEnquiry',
    newEnquiryEmail({
      enquiriesUrl: `${DASHBOARD}/enquiries/list`,
      fromName: 'Elena Popescu',
      fromEmail: 'elena@salon.ro',
      message: 'Doresc o programare pentru vineri',
      businessName: 'Acme',
    }),
  ],
];

describe('client notice house style', () => {
  it.each(ALL)('%s renders a full document with a subject', (_name, mail) => {
    expect(mail.subject.length).toBeGreaterThan(0);
    // Short enough to survive an inbox list without being truncated.
    expect(mail.subject.length).toBeLessThanOrEqual(60);
    expect(mail.html).toContain('<!DOCTYPE html>');
    expect(mail.html).toContain('Flowstarter');
  });

  it.each(ALL)('%s uses no em dashes and no emoji', (_name, mail) => {
    expect(mail.subject).not.toMatch(LONG_DASH);
    expect(mail.html).not.toMatch(LONG_DASH);
    expect(mail.subject).not.toMatch(EMOJI);
    expect(mail.html).not.toMatch(EMOJI);
  });

  it.each(ALL)('%s inherits the brand tokens from base.ts', (_name, mail) => {
    // Updated with the layout rewrite: the old assertion pinned `#7B6AD8` and
    // `class="button"`, both of which belonged to the gradient button the
    // design rulings removed. The tokens a client now recognises across the
    // set are the cream page, the ink, and the one indigo on the button.
    expect(mail.html).toContain('#fbf7ef');
    expect(mail.html).toContain('#120a22');
    expect(mail.html).toContain('#2d40d2');
    expect(mail.html).toContain('class="fs-button"');
  });

  it.each(ALL)(
    '%s ships a text alternative with the link in it',
    (_n, mail) => {
      expect(mail.text.length).toBeGreaterThan(0);
      expect(mail.text).not.toMatch(/<[a-z/]/i);
      expect(mail.preheader.length).toBeGreaterThan(0);
    }
  );
});

describe('depositReceivedEmail', () => {
  it('names the moment and links only to the dashboard', () => {
    const mail = depositReceivedEmail({
      dashboardUrl: DASHBOARD,
      clientName: 'Darius',
      businessName: 'Acme Dental',
    });
    expect(mail.subject).toBe('Your deposit is in and your build has started');
    expect(mail.html).toContain('Hi Darius,');
    expect(mail.html).toContain('Acme Dental');
    expect(mail.html).toContain(`href="${DASHBOARD}"`);
    expect(mail.html).toContain('Open your dashboard');
  });

  it('says "your site" rather than an empty name', () => {
    const mail = depositReceivedEmail({
      dashboardUrl: DASHBOARD,
      businessName: '   ',
    });
    expect(mail.html).toContain('your site');
    expect(mail.html).toContain('Hi there,');
  });
});

describe('previewReadyEmail', () => {
  it('leads with the preview link and says what happens next', () => {
    const mail = previewReadyEmail({
      previewUrl: 'https://p-abc.preview.flowstarter.net',
      businessName: 'Acme',
      clientName: 'Darius',
    });
    expect(mail.subject).toBe('Your preview is ready');
    expect(mail.html).toContain('href="https://p-abc.preview.flowstarter.net"');
    expect(mail.html).toContain('See your preview');
    expect(mail.html).toContain('What happens next');
    expect(mail.html).toContain('deposit');
  });
});

describe('balanceInvoiceEmail', () => {
  it('states the amount and points at the hosted Stripe page', () => {
    const mail = balanceInvoiceEmail({
      hostedInvoiceUrl: 'https://invoice.stripe.com/i/abc',
      amount: '€639.20',
      dashboardUrl: DASHBOARD,
      clientName: 'Darius',
      dueInDays: 14,
    });
    expect(mail.subject).toBe('Your balance invoice is ready');
    expect(mail.html).toContain('€639.20');
    expect(mail.html).toContain('href="https://invoice.stripe.com/i/abc"');
    expect(mail.html).toContain('View and pay');
    expect(mail.html).toContain('due in 14 days');
    expect(mail.html).toContain(DASHBOARD);
  });

  it('singularises a one-day due window and omits it when unknown', () => {
    expect(
      balanceInvoiceEmail({
        hostedInvoiceUrl: 'https://x',
        amount: '€1.00',
        dashboardUrl: DASHBOARD,
        dueInDays: 1,
      }).html
    ).toContain('due in 1 day.');
    const noDue = balanceInvoiceEmail({
      hostedInvoiceUrl: 'https://x',
      amount: '€1.00',
      dashboardUrl: DASHBOARD,
    }).html;
    expect(noDue).not.toContain('It is due in');
  });
});

describe('siteLiveEmail', () => {
  it('gives the address in the button and again as readable text', () => {
    const mail = siteLiveEmail({
      siteUrl: 'http://127.0.0.1:8842/acme/',
      dashboardUrl: DASHBOARD,
      businessName: 'Acme',
    });
    expect(mail.subject).toBe('Your site is live');
    expect(mail.html).toContain('href="http://127.0.0.1:8842/acme/"');
    expect(mail.html).toContain('Open your site');
    // The client should be able to read the address, not only click it.
    expect(mail.html).toContain('>http://127.0.0.1:8842/acme/<');
    expect(mail.html).toContain(DASHBOARD);
  });
});

describe('escapeHtml', () => {
  it('neutralises a business name that is trying to be markup', () => {
    expect(escapeHtml('<script>&"\'')).toBe('&lt;script&gt;&amp;&quot;&#39;');
  });

  it('is applied to every client-supplied name a template prints', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    for (const html of [
      depositReceivedEmail({ dashboardUrl: DASHBOARD, businessName: hostile })
        .html,
      depositReceivedEmail({ dashboardUrl: DASHBOARD, clientName: hostile })
        .html,
      previewReadyEmail({ previewUrl: 'https://x', businessName: hostile })
        .html,
      siteLiveEmail({
        siteUrl: 'https://x',
        dashboardUrl: DASHBOARD,
        businessName: hostile,
      }).html,
      balanceInvoiceEmail({
        hostedInvoiceUrl: 'https://x',
        amount: hostile,
        dashboardUrl: DASHBOARD,
      }).html,
    ]) {
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;img src=x');
    }
  });
});

describe('readableDate', () => {
  it('turns the stored instant into a date a client can read', () => {
    expect(readableDate('2026-09-26T09:00:00.000Z')).toBe('26 September 2026');
  });

  it('returns null rather than printing "Invalid Date" at a client', () => {
    expect(readableDate('not a date')).toBeNull();
    expect(readableDate(null)).toBeNull();
    expect(readableDate(undefined)).toBeNull();
  });
});

describe('previewReadyEmail expiry', () => {
  it('names the day the link stops working when the preview has one', () => {
    const mail = previewReadyEmail({
      previewUrl: 'https://p-abc.preview.flowstarter.net',
      expiresAt: '2026-09-26T09:00:00.000Z',
    });
    expect(mail.html).toContain('stops being served on 26 September 2026');
  });

  it('falls back to "temporary" when there is no expiry to give', () => {
    const mail = previewReadyEmail({
      previewUrl: 'https://p-abc.preview.flowstarter.net',
    });
    expect(mail.html).toContain('This preview is temporary.');
    expect(mail.html).not.toContain('stops being served');
  });
});

describe('depositReceivedEmail amount', () => {
  it('states what was charged when the caller knows it', () => {
    const mail = depositReceivedEmail({
      dashboardUrl: DASHBOARD,
      amount: '\u20ac159.80',
    });
    expect(mail.html).toContain('\u20ac159.80');
    expect(mail.text).toContain('Your deposit of \u20ac159.80 went through');
  });

  it('says it went through without inventing a number', () => {
    const mail = depositReceivedEmail({ dashboardUrl: DASHBOARD });
    expect(mail.text).toContain('Your deposit went through');
  });
});

/**
 * The sentence this email is no longer allowed to say.
 *
 * The in-depth brief moved to the client's dashboard and the build now waits
 * on it, so "Nothing else is needed from you right now" went from reassuring
 * to false in one commit. A client who reads it waits for a build that is
 * waiting for them.
 */
describe('depositReceivedEmail and the brief', () => {
  it('asks for the brief and links to it when there is one', () => {
    const mail = depositReceivedEmail({
      dashboardUrl: DASHBOARD,
      briefUrl: BRIEF,
      clientName: 'Darius',
      businessName: 'Acme Dental',
    });
    expect(mail.html).not.toContain('Nothing else is needed from you');
    expect(mail.html).toContain(
      'There is one thing we need from you: the detail of what you want on the'
    );
    expect(mail.html).toContain(`href="${BRIEF}"`);
    expect(mail.html).toContain('Fill in your brief');
    // The dashboard link survives alongside it, as a link rather than a second
    // button: the brief is the ask, the dashboard is still where the work
    // becomes visible.
    expect(mail.html).toContain(`href="${DASHBOARD}"`);
    expect(mail.html).toContain('Open your dashboard');
    expect(mail.html.match(/class="fs-button"/g)).toHaveLength(1);
  });

  it('keeps the old wording exactly when no brief url is given', () => {
    // Every caller that predates the brief must keep meaning what it meant.
    const mail = depositReceivedEmail({
      dashboardUrl: DASHBOARD,
      businessName: 'Acme',
    });
    expect(mail.html).toContain('Nothing else is needed from you right now.');
    expect(mail.html).not.toContain('Fill in your brief');
    expect(mail.html).not.toContain('/brief"');
  });
});

/**
 * The ask, which is the one email here that is not a report.
 *
 * What has to be true of it: the subject reads correctly alone in an inbox
 * list (it is about their site, not about a form), every ask is listed rather
 * than summarised, and a list item cannot close the tag it sits in. The list
 * comes from `brief-readiness.ts` and its text is ours, but the same escape is
 * applied anyway: the day one of those strings interpolates a project name,
 * the escaping has to already be there.
 */
describe('briefIncompleteEmail', () => {
  it('lists every ask and points at one page', () => {
    const mail = briefIncompleteEmail({
      briefUrl: BRIEF,
      missing: [
        'A sentence or two on what you offer.',
        'Your products or projects, with a screenshot each.',
      ],
      clientName: 'Darius',
      businessName: 'Acme Dental',
    });

    expect(mail.subject).toBe('We are waiting on a few things for your site');
    expect(mail.html).toContain('Hi Darius,');
    expect(mail.html).toContain('Acme Dental');
    expect(mail.html).toContain('<li');
    expect(mail.html).toContain('A sentence or two on what you offer.');
    expect(mail.html).toContain(
      'Your products or projects, with a screenshot each.'
    );
    // One link, one button. A second destination is a second decision.
    expect(mail.html).toContain(`href="${BRIEF}"`);
    expect(mail.html).toContain('Fill in your brief');
    expect(mail.html.match(/class="fs-button"/g)).toHaveLength(1);
    // The text part keeps the list as a list.
    expect(mail.text).toContain('- A sentence or two on what you offer.');
  });

  it('renders with an empty list rather than an empty tag soup', () => {
    // Never sent in this state, but a template that throws on an edge case is
    // a template that takes a caller down with it.
    const mail = briefIncompleteEmail({ briefUrl: BRIEF, missing: [] });
    expect(mail.html).toContain('Hi there,');
    expect(mail.html).toContain('your site');
    expect(mail.html).not.toContain('<li');
  });

  it('escapes a missing-item string and a business name', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const mail = briefIncompleteEmail({
      briefUrl: BRIEF,
      missing: [hostile],
      businessName: hostile,
    });
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.html).toContain('&lt;img src=x');
  });
});

/**
 * The one email a visitor's own words end up in.
 *
 * `newEnquiryEmail` uses the shared block renderer rather than hand-rolled
 * HTML, so the message goes through the `quote` block like every other
 * quoted value in this file (see `changeRequestLiveEmail`): escaped, and
 * preserved as separate lines in the text alternative rather than promised a
 * literal `<br />` the block renderer does not produce.
 */
describe('newEnquiryEmail', () => {
  const mail = newEnquiryEmail({
    enquiriesUrl: `${DASHBOARD}/enquiries/list`,
    fromName: 'Elena Popescu',
    fromEmail: 'elena@salon.ro',
    message: 'Line one\nLine two',
    phone: '+40712345678',
    page: '/contact',
    businessName: 'Acme',
    clientName: 'Dorin',
  });

  it('carries the message itself, so the client can act without opening a tab', () => {
    expect(mail.subject).toBe('New enquiry from your site');
    expect(mail.html).toContain('Line one');
    expect(mail.html).toContain('Line two');
    // The plain-text alternative keeps the message readable as two lines.
    expect(mail.text).toContain('Line one');
    expect(mail.text).toContain('Line two');
  });

  it('says who it is from, and where on the site it came from', () => {
    expect(mail.html).toContain('Elena Popescu');
    expect(mail.html).toContain('elena@salon.ro');
    expect(mail.html).toContain('+40712345678');
    expect(mail.html).toContain('/contact');
  });

  it('links to the client own enquiries list', () => {
    expect(mail.html).toContain(`${DASHBOARD}/enquiries/list`);
  });

  it('lets a visitor-supplied name close no tag', () => {
    const hostile = newEnquiryEmail({
      enquiriesUrl: DASHBOARD,
      fromName: '<img src=x onerror=alert(1)>',
      fromEmail: 'x@example.com',
      message: '<script>alert(1)</script>',
    });
    expect(hostile.html).not.toContain('<img src=x');
    expect(hostile.html).not.toContain('<script>alert(1)</script>');
    expect(hostile.html).toContain('&lt;img src=x');
  });

  it('leaves the phone and page lines out when there are none', () => {
    const plain = newEnquiryEmail({
      enquiriesUrl: DASHBOARD,
      fromName: 'Elena',
      fromEmail: 'elena@salon.ro',
      message: 'Hello',
    });
    expect(plain.html).not.toContain('+4');
    expect(plain.text).not.toContain('Phone:');
    expect(plain.html).not.toContain('/contact');
  });
});


/**
 * The notice that hands a client an account they did not ask for.
 *
 * Two things have to be true of it and of nothing else in this file. The one
 * button is the password, not the booking link: the link already works, and a
 * client who clicks the wrong one of two buttons ends up on their own public
 * page thinking they have done the setup. And the booking address survives
 * into the plain-text part, because that is the line they forward to someone
 * else and the part an HTML-stripping client shows them.
 */
describe('bookingPageReadyEmail', () => {
  const BOOKING = 'https://cal.flowstarter.dev/acme-dental/intro-call';
  const PASSWORD = 'https://cal.flowstarter.dev/auth/forgot-password';

  function mail(overrides: Record<string, unknown> = {}) {
    return bookingPageReadyEmail({
      bookingUrl: BOOKING,
      passwordSetupUrl: PASSWORD,
      dashboardUrl: DASHBOARD,
      clientName: 'Darius',
      businessName: 'Acme Dental',
      ...overrides,
    });
  }

  it('leads with the page being live and makes the password the one action', () => {
    const rendered = mail();

    expect(rendered.subject).toBe('Your booking page is ready');
    expect(rendered.html).toContain('Hi Darius,');
    expect(rendered.html).toContain('Acme Dental');
    expect(rendered.html).toContain(BOOKING);
    // Exactly one button, and it is the password rather than the link the
    // client already has on their own site.
    expect(rendered.html.match(/class="fs-button"/g)).toHaveLength(1);
    expect(rendered.html).toContain(`class="fs-button" href="${PASSWORD}"`);
    expect(rendered.html).toContain('Set your password');
  });

  it('says what the account is for, in the client’s own terms', () => {
    const rendered = mail();
    expect(rendered.html).toContain('To change your times');
    expect(rendered.html).toContain('see who has booked');
    // Never the vendor, the username or the event type: none of those is a
    // fact about the client's business.
    expect(rendered.html).not.toContain('Cal.com');
    expect(rendered.html).not.toContain('event type');
  });

  it('keeps the booking address and the dashboard in the text alternative', () => {
    const rendered = mail();
    expect(rendered.text).toContain(BOOKING);
    expect(rendered.text).toContain(PASSWORD);
    expect(rendered.text).toContain(DASHBOARD);
    expect(rendered.text).not.toMatch(/<[a-z/]/i);
  });

  it('falls back to "your site" with no business name and no client name', () => {
    const rendered = mail({ businessName: null, clientName: null });
    expect(rendered.html).toContain('Hi there,');
    expect(rendered.preheader).toContain('your site');
  });

  it('escapes a business name that is trying to close the tag it sits in', () => {
    const rendered = mail({ businessName: '<img src=x onerror=alert(1)>' });
    expect(rendered.html).not.toContain('<img src=x');
    expect(rendered.html).toContain('&lt;img src=x');
  });
});
