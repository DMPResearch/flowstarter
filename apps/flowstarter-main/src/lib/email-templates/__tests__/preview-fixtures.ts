/**
 * One fixture per email, shared by the test suite and the preview harness.
 *
 * It lives under `__tests__` because these are invented numbers and invented
 * people, and invented data does not belong in product code. The harness
 * (`scripts/render-email-previews.mjs`) bundles this file with esbuild rather
 * than keeping a second copy, so what a reviewer looks at in the browser is
 * exactly what the assertions below run against.
 *
 * The fixtures are deliberately realistic in length. A template only looks
 * wrong next to copy of the length it will really carry.
 */
import type { RenderedEmail } from '../base';
import {
  balanceInvoiceEmail,
  bookingPageReadyEmail,
  briefIncompleteEmail,
  buildNeedsReviewEmail,
  changeRequestLiveEmail,
  depositReceivedEmail,
  newBookingEmail,
  previewReadyEmail,
  siteLiveEmail,
} from '../client-notices';
import { customWorkOperatorEmail } from '../custom-work';
import { guestDepositWelcomeEmail } from '../guest-deposit-welcome';
import { invitationEmail } from '../invitation';
import { leadNotificationEmail } from '../lead-notification';
import { policyReviewOperatorEmail } from '../policy-review';
import { verificationEmail } from '../verification';
import { welcomeEmail } from '../welcome';
import { persona } from '@/test/fixtures/personas';

export const DASHBOARD = 'https://flowstarter.net/dashboard/projects/ws-demo';
export const SITE = 'https://darius-mihai-popescu-enxxz0.flowstarter.dev';
export const PREVIEW = 'https://p-4f2a9c1d8b3e7a06.preview.flowstarter.net';
export const INVOICE = 'https://invoice.stripe.com/i/acct_1/test_abc123';
export const BRIEF = `${DASHBOARD}/brief`;
/** The self-hosted Cal.com this platform provisions client calendars on. */
export const BOOKING_PAGE =
  'https://cal.flowstarter.dev/lumina-dental/intro-call';
export const CAL_PASSWORD_SETUP =
  'https://cal.flowstarter.dev/auth/forgot-password';
/** The two operator boards. Both are the primary link of their own email. */
export const LEAD_ON_BOARD =
  'https://flowstarter.net/admin/dashboard/pipeline#custom-work-lead-ld-4417';
export const REVIEW_ON_BOARD =
  'https://flowstarter.net/admin/dashboard/projects/ws-demo#policy-review-pr-2081';
export const DISCOVERY_CALL =
  'https://cal.flowstarter.dev/darius/discovery-call';

/**
 * The two operator emails are fixtured against the same six people the rest
 * of the suite uses (`@/test/fixtures/personas`), rather than a second cast
 * invented here, so a name that reads oddly in an email is a name somebody
 * has already seen in a brief. What is written locally is the brief itself,
 * because neither queue exists for the happy path: a persona's own intake
 * answers never trip the scope gate or the policy gate, which is the whole
 * reason those personas pass.
 *
 * Elena runs a real workshop with a real shop, so a wholesale portal her
 * restaurants log into is the shape her custom-work brief would actually
 * take, and she writes in Romanian, which exercises the one locale line the
 * template has. Tom coaches beginners, and a promise to reverse a diagnosis
 * in twelve weeks is exactly the lawful-but-sensitive claim the review queue
 * was built to hold.
 */
const ELENA = persona('elena-ceramica');
const TOM = persona('tom-trainer');

/**
 * Elena's custom-work brief, and the two fragments the classifier lifted out
 * of it. The fragments are substrings of the brief on purpose: an operator
 * reading a quoted phrase has to be able to find it in the paragraph
 * underneath, or the quote is the template's word rather than hers.
 */
const ELENA_BRIEF =
  'Vreau un loc unde restaurantele cu care lucrez isi fac singure comanda. ' +
  'Fiecare restaurant se autentifica, vede seriile disponibile, pune comanda ' +
  'si urmareste arderea. Eu vreau sa vad toate comenzile intr-un singur loc.';
const ELENA_EVIDENCE = [
  'Fiecare restaurant se autentifica',
  'urmareste arderea',
];

/** Tom's brief, held by the policy gate rather than refused by it. */
const TOM_BRIEF =
  'Strength coaching for beginners in Leeds. My twelve week programme ' +
  'reverses type 2 diabetes and gets most people off their blood pressure ' +
  'medication, and I want that on the front page.';

export interface EmailFixture {
  name: string;
  mail: RenderedEmail;
  /** The href the one primary button must carry, or null when it has none. */
  button: string | null;
  /** Facts the plain-text alternative has to carry on its own. */
  textContains: string[];
}

export function emailFixtures(): EmailFixture[] {
  return [
    {
      name: 'preview-ready',
      mail: previewReadyEmail({
        previewUrl: PREVIEW,
        businessName: 'Lumina Dental',
        clientName: 'Ana',
        expiresAt: '2026-09-26T09:00:00.000Z',
      }),
      button: PREVIEW,
      textContains: [PREVIEW, '26 September 2026', 'What happens next'],
    },
    {
      name: 'deposit-paid',
      mail: depositReceivedEmail({
        dashboardUrl: DASHBOARD,
        briefUrl: BRIEF,
        clientName: 'Ana',
        businessName: 'Lumina Dental',
        amount: '€159.80',
      }),
      button: BRIEF,
      textContains: ['€159.80', 'What starts now', DASHBOARD],
    },
    {
      name: 'brief-incomplete',
      mail: briefIncompleteEmail({
        briefUrl: BRIEF,
        missing: [
          'A sentence or two on what you offer.',
          'Your opening hours, or that you work by appointment.',
          'Your products or projects, with a screenshot each.',
        ],
        clientName: 'Ana',
        businessName: 'Lumina Dental',
      }),
      button: BRIEF,
      textContains: [
        '- A sentence or two on what you offer.',
        '- Your products or projects, with a screenshot each.',
        BRIEF,
      ],
    },
    {
      name: 'balance-invoice',
      mail: balanceInvoiceEmail({
        hostedInvoiceUrl: INVOICE,
        amount: '€639.20',
        dashboardUrl: DASHBOARD,
        clientName: 'Ana',
        dueInDays: 14,
      }),
      button: INVOICE,
      textContains: ['€639.20', INVOICE, 'due in 14 days'],
    },
    {
      name: 'site-live',
      mail: siteLiveEmail({
        siteUrl: SITE,
        dashboardUrl: DASHBOARD,
        clientName: 'Ana',
        businessName: 'Lumina Dental',
      }),
      button: SITE,
      textContains: [SITE, DASHBOARD, 'care plan'],
    },
    {
      name: 'build-needs-review',
      mail: buildNeedsReviewEmail({
        dashboardUrl: DASHBOARD,
        clientName: 'Ana',
        businessName: 'Lumina Dental',
      }),
      button: DASHBOARD,
      textContains: [
        'Nothing is needed from you',
        'one of us is going through it',
      ],
    },
    {
      name: 'new-booking',
      mail: newBookingEmail({
        bookingsUrl: `${DASHBOARD}/bookings`,
        when: 'Thursday 18 September, 10:30 (Europe/Bucharest)',
        attendeeName: 'Mihai Ionescu',
        eventName: 'a 30 minute consultation',
        businessName: 'Lumina Dental',
        clientName: 'Ana',
      }),
      button: `${DASHBOARD}/bookings`,
      textContains: [
        'Mihai Ionescu',
        'a 30 minute consultation',
        'Thursday 18 September, 10:30',
      ],
    },
    {
      name: 'booking-page-ready',
      mail: bookingPageReadyEmail({
        bookingUrl: BOOKING_PAGE,
        passwordSetupUrl: CAL_PASSWORD_SETUP,
        dashboardUrl: DASHBOARD,
        clientName: 'Ana',
        businessName: 'Lumina Dental',
      }),
      // The password, not the booking link: the link already works.
      button: CAL_PASSWORD_SETUP,
      textContains: [BOOKING_PAGE, DASHBOARD, 'To change your times'],
    },
    {
      name: 'change-delivered',
      mail: changeRequestLiveEmail({
        request:
          'Please add the new whitening price to the services page and put ' +
          'the Saturday hours in the footer.',
        siteUrl: SITE,
        dashboardUrl: DASHBOARD,
        version: 4,
        clientName: 'Ana',
        businessName: 'Lumina Dental',
      }),
      button: SITE,
      textContains: ['whitening price', 'version 4', SITE],
    },
    {
      name: 'welcome',
      mail: welcomeEmail({ userName: 'Ana', dashboardUrl: DASHBOARD }),
      button: DASHBOARD,
      textContains: ['Ana', DASHBOARD],
    },
    {
      name: 'invitation',
      mail: invitationEmail({
        inviterName: 'Darius Popescu',
        inviterEmail: 'darius@flowstarter.net',
        invitationUrl: 'https://flowstarter.net/invite/9f2c1b',
        expiresInDays: 30,
      }),
      button: 'https://flowstarter.net/invite/9f2c1b',
      textContains: ['Darius Popescu', 'expires in 30 days'],
    },
    {
      name: 'verification-link',
      mail: verificationEmail({
        verificationUrl: 'https://flowstarter.net/verify/9f2c1b',
      }),
      button: 'https://flowstarter.net/verify/9f2c1b',
      textContains: ['https://flowstarter.net/verify/9f2c1b'],
    },
    {
      name: 'verification-code',
      mail: verificationEmail({ verificationCode: '418209' }),
      // The one email with nowhere to go: the code is typed back into the tab
      // the person already has open.
      button: null,
      textContains: ['418209'],
    },
    {
      name: 'lead-notification',
      mail: leadNotificationEmail({
        recipientName: 'Ana',
        projectName: 'Lumina Dental',
        leadName: 'Mihai Ionescu',
        leadEmail: 'mihai@example.com',
        leadPhone: '+40 722 000 111',
        leadMessage:
          'Hello, I broke a filling on Sunday and it is sore. Do you have ' +
          'anything this week, preferably in the morning?',
        source: 'contact_form',
        inboxUrl: `${DASHBOARD}/enquiries`,
        receivedAt: '2026-09-12T14:20:00.000Z',
      }),
      button: `${DASHBOARD}/enquiries`,
      textContains: [
        'Mihai Ionescu',
        'mihai@example.com',
        'I broke a filling on Sunday',
        '12 September 2026 at 14:20 UTC',
      ],
    },
    {
      name: 'guest-deposit-welcome',
      mail: guestDepositWelcomeEmail({
        email: 'ana@luminadental.ro',
        tempPassword: 'cedar-lantern-8142',
        signInUrl: 'https://flowstarter.net/login',
        businessName: 'Lumina Dental',
      }),
      button: 'https://flowstarter.net/login',
      textContains: ['ana@luminadental.ro', 'cedar-lantern-8142'],
    },
    {
      name: 'guest-deposit-welcome-existing',
      mail: guestDepositWelcomeEmail({
        email: 'ana@luminadental.ro',
        signInUrl: 'https://flowstarter.net/login',
        businessName: 'Lumina Dental',
      }),
      button: 'https://flowstarter.net/login',
      textContains: ['ana@luminadental.ro', 'We did not change your password'],
    },
    {
      name: 'custom-work-lead',
      mail: customWorkOperatorEmail({
        visitorName: ELENA.discovery.fullName,
        visitorEmail: ELENA.discovery.email,
        description: ELENA_BRIEF,
        linkUrl: ELENA.discovery.websiteUrl,
        linkLabel: 'Their site',
        routeRule: 'customAboveThreshold',
        evidence: ELENA_EVIDENCE,
        locale: ELENA.locale,
        bookingUrl: DISCOVERY_CALL,
        leadUrl: LEAD_ON_BOARD,
      }),
      button: LEAD_ON_BOARD,
      textContains: [
        ELENA.discovery.email,
        ELENA.discovery.websiteUrl,
        'The brief is written in Romanian',
        'Custom work lane',
        LEAD_ON_BOARD,
      ],
    },
    {
      name: 'policy-review',
      mail: policyReviewOperatorEmail({
        rule: 'sensitive_lawful',
        categoryId: 'unlicensed_claims',
        categoryLabel: 'Unlicensed medical or financial claims',
        briefText: TOM_BRIEF,
        contactName: TOM.discovery.fullName,
        contactEmail: TOM.discovery.email,
        reviewUrl: REVIEW_ON_BOARD,
      }),
      button: REVIEW_ON_BOARD,
      textContains: [
        TOM.discovery.email,
        'unlicensed medical or financial claims',
        'It stays open until an operator approves or refuses it.',
        REVIEW_ON_BOARD,
      ],
    },
  ];
}

/**
 * The CSS an email client will not run.
 *
 * There is no email linter in this repo, so the rules are the ones that
 * actually break: layout properties Outlook's Word engine has never
 * implemented, remote assets that cost a request or leak a read, and anything
 * that needs a cascade the client has already thrown away. Checked against the
 * rendered HTML, because the source is not what gets delivered.
 */
export function lintEmailHtml(html: string): string[] {
  const problems: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/display\s*:\s*flex/i, 'flexbox is not supported in Outlook or Gmail'],
    [/display\s*:\s*(inline-)?grid/i, 'CSS grid is not supported in email'],
    [/@import|fonts\.googleapis|fonts\.gstatic/i, 'external font request'],
    // The system's one `@font-face` resolves against faces the reader
    // already has (`local()` only, see `emailFontFace` in `../design`). A
    // `url()` in it would be a request per open and a read receipt for
    // whoever serves the file.
    [/@font-face[^}]*url\s*\(/i, 'webfont fetched over the network'],
    [/background-image\s*:|url\(\s*['"]?https?:/i, 'background image'],
    [/position\s*:\s*(absolute|fixed|sticky)/i, 'positioned element'],
    [/<script/i, 'script tag'],
    [/linear-gradient|radial-gradient/i, 'gradient'],
    [/\bvar\(--/, 'CSS custom property'],
    [/:\s*-?\d+(\.\d+)?rem\b/, 'rem unit (Outlook ignores it)'],
  ];
  for (const [re, why] of rules) {
    if (re.test(html)) problems.push(why);
  }
  // An image has to be reachable from outside our network and carry an alt, or
  // a blocked-images inbox shows a broken box with nothing in it.
  for (const img of html.match(/<img[^>]*>/gi) ?? []) {
    if (!/\balt\s*=/.test(img)) problems.push('img without alt');
    if (!/src="(https?:|file:)/.test(img)) {
      problems.push('img with no absolute src');
    }
  }
  return problems;
}
