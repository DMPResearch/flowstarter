/**
 * The emails a paying client gets while their site is being made.
 *
 * Until PR #94 the product sent the client nothing between "your deposit went
 * through" on a guest checkout and an operator typing them a message by hand.
 * These are the seven moments that answer that: the deposit landing, the
 * preview being ready, the balance invoice going out, the site going live, a
 * build that stopped and has to be looked at, a booking arriving through the
 * client's own calendar, and a paid change reaching the site. Since the
 * in-depth brief moved to the dashboard there is one more: the build that
 * cannot start because we are waiting on the client. And since the platform
 * started hosting its clients' calendars itself, one more again: the booking
 * page it makes for them, which is the only moment that asks a client to sign
 * in somewhere they have never been.
 *
 * House style, and the reason these live in one file: each is six lines of
 * prose and a button. Splitting them across seven modules would make the
 * differences harder to see than the similarities, and what matters most about
 * a set of transactional emails is that they sound like one voice. Plain
 * sentences, no em dashes, no emoji, one button each, and a subject line that
 * is true when read alone in an inbox list.
 *
 * They describe themselves as blocks and `renderEmail` draws them. No template
 * in here writes HTML, escapes anything, or writes its own plain-text copy:
 * all three are the base layout's job, and were the three things the old
 * hand-written markup got wrong.
 */
import { renderEmail, type Block, type RenderedEmail } from './base';

export { escapeHtml } from './base';
export type { RenderedEmail } from './base';

/**
 * "your site" is the honest fallback. A sentence built around an empty string
 * reads worse than one with no name in it at all.
 */
function projectPhrase(businessName?: string | null): string {
  return businessName?.trim() || 'your site';
}

function greeting(clientName?: string | null): Block {
  const trimmed = clientName?.trim();
  return {
    kind: 'paragraph',
    content: trimmed ? `Hi ${trimmed},` : 'Hi there,',
  };
}

/**
 * A date a person can read, in the one format that is unambiguous on both
 * sides of the Atlantic. Returns null for anything unparseable rather than
 * printing "Invalid Date" at a client.
 */
export function readableDate(iso?: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The deposit has landed on the concierge path and the build is queued.
 *
 * Deliberately not the guest-checkout welcome: this client already has an
 * account and is already signed in, so credentials would be noise. What they
 * need is confirmation that the money arrived, what it started, and one link
 * to where the work is now visible.
 */
export function depositReceivedEmail(input: {
  dashboardUrl: string;
  /**
   * The brief page, when there is one to point at.
   *
   * This email used to end "Nothing else is needed from you right now", and
   * that sentence stopped being true the day the in-depth brief moved from the
   * intake to the dashboard: the build is queued and will sit there until the
   * client writes down what they sell and what they have made. A behaviour
   * change that leaves the old promise in the outbox is the worst of both,
   * because the client believes it and then waits.
   *
   * Optional, and absent means the old wording verbatim, so no existing caller
   * quietly starts saying something different.
   */
  briefUrl?: string;
  clientName?: string | null;
  businessName?: string | null;
  /** Formatted for display, e.g. "EUR 159.80". Omitted when not known. */
  amount?: string | null;
}): RenderedEmail {
  const amount = input.amount?.trim();
  const started = `we have started building ${projectPhrase(
    input.businessName
  )}.${input.briefUrl ? '' : ' Nothing else is needed from you right now.'}`;

  // With a brief to fill in, that is the one action, and the dashboard stays a
  // link rather than a second button: two buttons is two decisions, and only
  // one of them unblocks the build.
  const next: Block[] = input.briefUrl
    ? [
        {
          kind: 'callout',
          title: 'What starts now',
          content:
            'There is one thing we need from you: the detail of what you ' +
            'want on the site. It takes about ten minutes, and the build ' +
            'starts by itself the moment it is done.',
        },
        { kind: 'button', label: 'Fill in your brief', href: input.briefUrl },
        {
          kind: 'paragraph',
          content: [
            {
              link: {
                href: input.dashboardUrl,
                label: 'Open your dashboard',
              },
            },
            ' to follow the build. We will email you again the moment there ' +
              'is something to look at.',
          ],
        },
      ]
    : [
        {
          kind: 'callout',
          title: 'What starts now',
          content:
            'We build the full site from your brief, then check it by hand ' +
            'before you see it. You can follow it from your dashboard, and ' +
            'we will email you the moment there is something to look at.',
        },
        {
          kind: 'button',
          label: 'Open your dashboard',
          href: input.dashboardUrl,
        },
      ];

  return renderEmail({
    subject: 'Your deposit is in and your build has started',
    preheader: `We have started building ${projectPhrase(
      input.businessName
    )}. ${
      input.briefUrl
        ? 'One thing is needed from you.'
        : 'Nothing is needed from you.'
    }`,
    blocks: [
      { kind: 'heading', text: 'Your build has started' },
      greeting(input.clientName),
      {
        kind: 'paragraph',
        content: amount
          ? [
              'Your deposit of ',
              { strong: amount },
              ` went through and ${started}`,
            ]
          : `Your deposit went through and ${started}`,
      },
      ...next,
      {
        kind: 'note',
        content:
          'If you did not pay this deposit, reply to this email and we will ' +
          'sort it out.',
      },
    ],
  });
}

/**
 * The build is queued and we are waiting on the client.
 *
 * The one email in this file that asks for something. Everything else here
 * reports; this one is the reason a site is not being built yet, so it has to
 * be specific about what is missing without reading as a form rejection. The
 * list comes from `brief-readiness.ts`, which produces one concrete ask per
 * missing thing ("a name, one line, a link, a screenshot") rather than "some
 * more information", because a client who reads the vague version sends the
 * vague answer and we are back here a week later.
 *
 * Deliberately not apologetic and deliberately not a deadline. Nobody is late:
 * the deposit bought a site and the site needs their words, which is the whole
 * message.
 */
export function briefIncompleteEmail(input: {
  briefUrl: string;
  /** The blocking asks, already written as sentences by the readiness rule. */
  missing: string[];
  clientName?: string | null;
  businessName?: string | null;
}): RenderedEmail {
  return renderEmail({
    subject: 'We are waiting on a few things for your site',
    preheader: `The build of ${projectPhrase(
      input.businessName
    )} is queued and needs a few things only you can write.`,
    blocks: [
      { kind: 'heading', text: 'We are waiting on a few things' },
      greeting(input.clientName),
      {
        kind: 'paragraph',
        content: `Your deposit is in and the build of ${projectPhrase(
          input.businessName
        )} is queued. Before it can start we need a short list of things from you, because they are the parts of the site only you can write.`,
      },
      { kind: 'list', items: input.missing },
      {
        kind: 'paragraph',
        content:
          'It all goes on one page and takes about ten minutes. The build ' +
          'starts by itself as soon as it is done, so there is nothing to ' +
          'tell us afterwards.',
      },
      { kind: 'button', label: 'Fill in your brief', href: input.briefUrl },
      {
        kind: 'note',
        content:
          'If something on that list is not going to happen, reply to this ' +
          'email and we will work around it.',
      },
    ],
  });
}

/**
 * The funnel preview finished generating.
 *
 * Sent to the address the intake asked for with the words "Where should I send
 * your preview once it's ready?", which until PR #94 was collected and then
 * never used for that. The expiry is in the email because the preview is
 * temporary by rule, and a link that stops working without warning is worse
 * than one that never existed.
 */
export function previewReadyEmail(input: {
  previewUrl: string;
  businessName?: string | null;
  clientName?: string | null;
  /** ISO instant the hosted preview stops being served. */
  expiresAt?: string | null;
}): RenderedEmail {
  const expires = readableDate(input.expiresAt);
  return renderEmail({
    subject: 'Your preview is ready',
    preheader: `A first version of ${projectPhrase(
      input.businessName
    )} is built and you can open it now.`,
    blocks: [
      { kind: 'heading', text: 'Your preview is ready' },
      greeting(input.clientName),
      {
        kind: 'paragraph',
        content: `We finished a first version of ${projectPhrase(
          input.businessName
        )}. It is a real site, not a mockup, and you can open it now.`,
      },
      { kind: 'button', label: 'See your preview', href: input.previewUrl },
      {
        kind: 'callout',
        title: 'What happens next',
        content:
          'Look it over and tell us what you want changed. When you are happy ' +
          'with it, a deposit starts the full build and the rest of the pages.',
      },
      {
        kind: 'note',
        content: expires
          ? `This preview is temporary and stops being served on ${expires}. Claim it before then if you want to keep it.`
          : 'This preview is temporary. Claim it from the link above if you want to keep it.',
      },
    ],
  });
}

/**
 * The balance invoice exists and Stripe has it.
 *
 * Stripe sends its own hosted invoice email, but only when the account is
 * configured to and only for invoices it was asked to send. This one is ours,
 * so the client hears about the balance whatever Stripe decides to do.
 */
export function balanceInvoiceEmail(input: {
  hostedInvoiceUrl: string;
  amount: string;
  dashboardUrl: string;
  clientName?: string | null;
  dueInDays?: number;
}): RenderedEmail {
  const due =
    typeof input.dueInDays === 'number' && input.dueInDays > 0
      ? ` It is due in ${input.dueInDays} day${
          input.dueInDays === 1 ? '' : 's'
        }.`
      : '';
  return renderEmail({
    subject: 'Your balance invoice is ready',
    preheader: `The remaining balance of ${input.amount} is invoiced and payable by card.`,
    blocks: [
      { kind: 'heading', text: 'Your balance invoice is ready' },
      greeting(input.clientName),
      {
        kind: 'paragraph',
        content: [
          'Your site is approved, so the remaining balance of ',
          { strong: input.amount },
          ` is now invoiced.${due}`,
        ],
      },
      {
        kind: 'paragraph',
        content:
          'You can pay it by card on the secure Stripe page below. There is ' +
          'nothing to install and no account to make.',
      },
      { kind: 'button', label: 'View and pay', href: input.hostedInvoiceUrl },
      {
        kind: 'note',
        content: [
          'The same link is on your dashboard at ',
          { link: { href: input.dashboardUrl } },
          '.',
        ],
      },
    ],
  });
}

/**
 * Somebody booked time through the calendar on the client's own site.
 *
 * Cal.com sends its own confirmation to both people, so this is deliberately
 * not a second copy of that. It says one booking landed, who and when, and
 * points at the list. Nothing about the attendee beyond their name: the
 * details are on a page behind a login, and an inbox is not.
 */
export function newBookingEmail(input: {
  bookingsUrl: string;
  when: string;
  attendeeName?: string | null;
  eventName?: string | null;
  businessName?: string | null;
  clientName?: string | null;
}): RenderedEmail {
  const who = input.attendeeName?.trim() || 'Someone';
  const what = input.eventName?.trim() || 'time with you';
  return renderEmail({
    subject: 'New booking on your site',
    preheader: `${who} booked ${what} for ${input.when}.`,
    blocks: [
      { kind: 'heading', text: 'New booking on your site' },
      greeting(input.clientName),
      {
        kind: 'paragraph',
        content: `${who} booked time through the calendar on ${projectPhrase(
          input.businessName
        )}.`,
      },
      {
        kind: 'facts',
        rows: [
          { label: 'Who', value: who },
          { label: 'What', value: what },
          { label: 'When', value: input.when },
        ],
      },
      {
        kind: 'paragraph',
        content:
          'It is already in your Cal.com calendar, so there is nothing to ' +
          'accept. Your dashboard keeps the full list, including anything ' +
          'that gets moved or cancelled later.',
      },
      { kind: 'button', label: 'See your bookings', href: input.bookingsUrl },
    ],
  });
}

/**
 * Somebody filled in the contact form on the client's own site.
 *
 * The message is in the email on purpose. An enquiry is worth answering in the
 * minutes after it arrives, and a notice that says only "you have an enquiry"
 * makes the client open a dashboard to find out whether it was worth opening a
 * dashboard for. The reply-to is set to the sender by the caller, so hitting
 * reply works.
 *
 * Spam is never sent. The classifier decides, and a client told forty times a
 * week that a casino wants to talk to them stops reading these.
 */
export function newEnquiryEmail(input: {
  enquiriesUrl: string;
  fromName: string;
  fromEmail: string;
  message: string;
  phone?: string | null;
  page?: string | null;
  businessName?: string | null;
  clientName?: string | null;
}): RenderedEmail {
  const where = input.page?.trim() ? ` from ${input.page.trim()}` : '';
  return renderEmail({
    subject: 'New enquiry from your site',
    preheader: `${input.fromName} sent a message through ${projectPhrase(
      input.businessName
    )}.`,
    blocks: [
      { kind: 'heading', text: 'New enquiry from your site' },
      greeting(input.clientName),
      {
        kind: 'paragraph',
        content: `${
          input.fromName
        } sent this through the contact form on ${projectPhrase(
          input.businessName
        )}${where}.`,
      },
      { kind: 'quote', text: input.message },
      {
        kind: 'facts',
        rows: [
          { label: 'Email', value: input.fromEmail },
          { label: 'Phone', value: input.phone?.trim() ?? '' },
        ],
      },
      {
        kind: 'note',
        content:
          'Replying to this email goes straight back to them. Your dashboard ' +
          'keeps every enquiry, so nothing depends on this message surviving ' +
          'your inbox.',
      },
      { kind: 'button', label: 'See your enquiries', href: input.enquiriesUrl },
    ],
  });
}

/**
 * The deploy finished and the site is being served.
 *
 * The address is the hero of this one, large and linked, because it is the
 * thing the client has been waiting weeks for and the thing they will forward
 * to someone else within the hour.
 */
export function siteLiveEmail(input: {
  siteUrl: string;
  dashboardUrl: string;
  clientName?: string | null;
  businessName?: string | null;
}): RenderedEmail {
  return renderEmail({
    subject: 'Your site is live',
    preheader: `${projectPhrase(input.businessName)} is published at ${
      input.siteUrl
    }.`,
    blocks: [
      { kind: 'heading', text: 'Your site is live' },
      greeting(input.clientName),
      {
        kind: 'paragraph',
        content: `${projectPhrase(
          input.businessName
        )} is published and anyone can reach it now.`,
      },
      { kind: 'hero', href: input.siteUrl },
      { kind: 'button', label: 'Open your site', href: input.siteUrl },
      {
        kind: 'paragraph',
        content: [
          'Your dashboard is at ',
          { link: { href: input.dashboardUrl } },
          '. Changes you make in the editor go live the same way, so you ' +
            'never have to wait on us for a wording fix.',
        ],
      },
      {
        kind: 'note',
        content:
          'Your care plan covers the hosting, the domain renewal, ' +
          'maintenance, support and your editor allowance, so the site stays ' +
          'up and current without you doing anything.',
      },
    ],
  });
}

/**
 * The build stopped and a person has to look at it.
 *
 * Written after a client paid in full on 2026-09-12, had their build failed by
 * a gate, and was told by their dashboard for the rest of the day that it was
 * "about to start". Silence is the worst of the available answers, so this one
 * exists even though it carries no good news.
 *
 * Deliberately vague about the cause and specific about the ownership. The
 * client does not want to read an error code; they want to know a person has
 * it, that they are not expected to do anything, and that their money is not
 * gone. It promises a follow-up rather than a time, because the time is not
 * known when this is sent.
 */
export function buildNeedsReviewEmail(input: {
  dashboardUrl: string;
  clientName?: string | null;
  businessName?: string | null;
}): RenderedEmail {
  return renderEmail({
    subject: 'Your build needs a second look',
    preheader: 'One of us is going through it now. Nothing is needed from you.',
    blocks: [
      { kind: 'heading', text: 'Your build needs a second look' },
      greeting(input.clientName),
      {
        kind: 'paragraph',
        content: `The build of ${projectPhrase(
          input.businessName
        )} stopped before it was finished, so one of us is going through it now.`,
      },
      {
        kind: 'callout',
        title: 'Nothing is needed from you',
        content:
          'Nothing you have paid is affected. We will email you again as soon ' +
          'as it is moving, and your dashboard shows where it has got to in ' +
          'the meantime.',
      },
      {
        kind: 'button',
        label: 'Open your dashboard',
        href: input.dashboardUrl,
      },
      {
        kind: 'note',
        content:
          'If you would rather talk to a person about it, reply to this email.',
      },
    ],
  });
}

/**
 * A paid change request is on the site.
 *
 * It quotes the client's own request back to them rather than describing the
 * change in our words. They wrote that sentence, they paid against it, and
 * reading it back is the shortest honest way to say "this, the thing you asked
 * for, is the thing that is now live".
 */
export function changeRequestLiveEmail(input: {
  request: string;
  siteUrl: string;
  dashboardUrl: string;
  version: number;
  clientName?: string | null;
  businessName?: string | null;
}): RenderedEmail {
  return renderEmail({
    subject: 'Your change is live',
    preheader: `The change you asked for on ${projectPhrase(
      input.businessName
    )} is published as version ${input.version}.`,
    blocks: [
      { kind: 'heading', text: 'Your change is live' },
      greeting(input.clientName),
      {
        kind: 'paragraph',
        content: `The change you asked for on ${projectPhrase(
          input.businessName
        )} is done and published. This is what you asked for, in your words:`,
      },
      { kind: 'quote', text: input.request },
      {
        kind: 'paragraph',
        content: `It is version ${input.version} of your site, and your editor can still change any of the wording on it yourself.`,
      },
      { kind: 'button', label: 'See it on your site', href: input.siteUrl },
      {
        kind: 'note',
        content: [
          'Your dashboard is at ',
          { link: { href: input.dashboardUrl } },
          '.',
        ],
      },
    ],
  });
}

/**
 * The client has a booking page of their own, on the calendar we host.
 *
 * Sent once per workspace by `lib/flowstarter/cal-provisioned-notice.ts`, on
 * the run that actually created the page. It is the only prompt a client gets
 * to set a password on an account they never asked for, which is why that, and
 * not the booking link, is the one button: the link is already on their site
 * and already working, and the password is the thing still undone.
 *
 * Deliberately says nothing about Cal.com by name, or usernames, or event
 * types. From the client's side the fact is "the booking page on my site takes
 * bookings now"; the account behind it matters to them only because it is
 * where their times live.
 */
export function bookingPageReadyEmail(input: {
  /** The public page visitors book on. Already live on the built site. */
  bookingUrl: string;
  /** Where the client sets the first password on the account we made them. */
  passwordSetupUrl: string;
  dashboardUrl: string;
  clientName?: string | null;
  businessName?: string | null;
}): RenderedEmail {
  return renderEmail({
    subject: 'Your booking page is ready',
    preheader: `People can book time with you on ${projectPhrase(
      input.businessName
    )} now.`,
    blocks: [
      { kind: 'heading', text: 'Your booking page is ready' },
      greeting(input.clientName),
      {
        kind: 'paragraph',
        content: `The booking page on ${projectPhrase(
          input.businessName
        )} is live. Anyone can pick a time with you on it now, and it takes bookings on weekdays until you say otherwise.`,
      },
      // Shown as an address rather than only linked, for the same reason as
      // `siteLiveEmail`: this is the line the client forwards to someone else,
      // and a link they can read and copy is more use than a button.
      { kind: 'hero', href: input.bookingUrl },
      {
        kind: 'callout',
        title: 'To change your times',
        content:
          'We made you an account on our booking system to hold your ' +
          'calendar. Set a password on it and you can change the hours you ' +
          'are free, see who has booked, and move or cancel anything.',
      },
      {
        kind: 'button',
        label: 'Set your password',
        href: input.passwordSetupUrl,
      },
      {
        kind: 'note',
        content: [
          'Your bookings also show on your dashboard at ',
          { link: { href: input.dashboardUrl } },
          ', so you can see what is coming up without signing in anywhere else.',
        ],
      },
    ],
  });
}
