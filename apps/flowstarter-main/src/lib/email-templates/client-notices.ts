/**
 * The four emails a paying client gets while their site is being made.
 *
 * Until now the product sent the client nothing between "your deposit went
 * through" on a guest checkout and an operator typing them a message by hand.
 * A real run of the whole funnel produced zero emails, and the person who paid
 * asked, reasonably, whether he would ever receive one. These are the four
 * moments that answer that: the deposit landing, the preview being ready, the
 * balance invoice going out, and the site going live.
 *
 * House style, and the reason these live in one file: each is six lines of
 * prose and a button. Splitting them across four modules would make the
 * differences harder to see than the similarities, and what matters most about
 * a set of transactional emails is that they sound like one voice. Plain
 * sentences, no em dashes, no emoji, one link each, and a subject line that is
 * true when read alone in an inbox list.
 */
import { baseEmailTemplate } from './base';

export interface RenderedEmail {
  subject: string;
  html: string;
}

/** Keeps a client-supplied name out of the HTML as anything but text. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * "your site" is the honest fallback. A sentence built around an empty string
 * reads worse than one with no name in it at all.
 */
function projectPhrase(businessName?: string | null): string {
  const trimmed = businessName?.trim();
  return trimmed ? escapeHtml(trimmed) : 'your site';
}

function greeting(clientName?: string | null): string {
  const trimmed = clientName?.trim();
  return trimmed ? `Hi ${escapeHtml(trimmed)},` : 'Hi there,';
}

/**
 * The deposit has landed on the concierge path and the build is queued.
 *
 * Deliberately not the guest-checkout welcome: this client already has an
 * account and is already signed in, so credentials would be noise. What they
 * need is confirmation that the money arrived and one link to where the work
 * is now visible.
 */
export function depositReceivedEmail(input: {
  dashboardUrl: string;
  clientName?: string | null;
  businessName?: string | null;
}): RenderedEmail {
  return {
    subject: 'Your deposit is in and your build has started',
    html: baseEmailTemplate(`
    <h1>Your build has started</h1>
    <p>${greeting(input.clientName)}</p>
    <p>
      Your deposit went through and we have started building
      ${projectPhrase(input.businessName)}. Nothing else is needed from you
      right now.
    </p>
    <p>
      You can follow the build from your dashboard. We will email you again the
      moment there is something to look at.
    </p>
    <div style="text-align: center;">
      <a href="${input.dashboardUrl}" class="button">Open your dashboard</a>
    </div>
    <p class="muted" style="margin-top: 24px;">
      If you did not pay this deposit, reply to this email and we will sort it
      out.
    </p>
  `),
  };
}

/**
 * The funnel preview finished generating.
 *
 * Sent to the address the intake asked for with the words "Where should I send
 * your preview once it's ready?", which until now was collected and then never
 * used for that.
 */
export function previewReadyEmail(input: {
  previewUrl: string;
  businessName?: string | null;
  clientName?: string | null;
}): RenderedEmail {
  return {
    subject: 'Your preview is ready',
    html: baseEmailTemplate(`
    <h1>Your preview is ready</h1>
    <p>${greeting(input.clientName)}</p>
    <p>
      We finished a first version of ${projectPhrase(input.businessName)}. It is
      a real site, not a mockup, and you can open it now.
    </p>
    <div style="text-align: center;">
      <a href="${input.previewUrl}" class="button">See your preview</a>
    </div>
    <p style="margin-top: 24px;">
      <strong>What happens next.</strong> Look it over and tell us what you want
      changed. When you are happy with it, a deposit starts the full build and
      the rest of the pages.
    </p>
    <p class="muted">
      This preview is temporary. Claim it from the link above if you want to
      keep it.
    </p>
  `),
  };
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
  return {
    subject: 'Your balance invoice is ready',
    html: baseEmailTemplate(`
    <h1>Your balance invoice is ready</h1>
    <p>${greeting(input.clientName)}</p>
    <p>
      Your site is approved, so the remaining balance of
      <strong>${escapeHtml(input.amount)}</strong> is now invoiced.${due}
    </p>
    <p>
      You can pay it by card on the secure Stripe page below. There is nothing
      to install and no account to make.
    </p>
    <div style="text-align: center;">
      <a href="${input.hostedInvoiceUrl}" class="button">View and pay</a>
    </div>
    <p class="muted" style="margin-top: 24px;">
      The same link is on your dashboard at
      <a href="${input.dashboardUrl}">${input.dashboardUrl}</a>.
    </p>
  `),
  };
}

/**
 * Somebody booked time through the calendar on the client's own site.
 *
 * The one email in this file that is not about the build. It is here for the
 * same reason the others are: the moment happens inside a webhook, where an
 * email is easy to forget and dangerous to add, and `notifyClientOnce` is the
 * only safe way to send one from there. Cal.com sends its own confirmation to
 * both people, so this is deliberately not a second copy of that. It says one
 * booking landed and points at the list, and it says nothing about the
 * attendee beyond their name, because the details are on a page behind a login
 * and an inbox is not.
 */
export function newBookingEmail(input: {
  bookingsUrl: string;
  when: string;
  attendeeName?: string | null;
  eventName?: string | null;
  businessName?: string | null;
  clientName?: string | null;
}): RenderedEmail {
  const who = input.attendeeName?.trim()
    ? escapeHtml(input.attendeeName.trim())
    : 'Someone';
  const what = input.eventName?.trim()
    ? escapeHtml(input.eventName.trim())
    : 'time with you';
  return {
    subject: 'New booking on your site',
    html: baseEmailTemplate(`
    <h1>New booking on your site</h1>
    <p>${greeting(input.clientName)}</p>
    <p>
      ${who} booked ${what} through the calendar on
      ${projectPhrase(input.businessName)}.
    </p>
    <p><strong>${escapeHtml(input.when)}</strong></p>
    <p>
      It is already in your Cal.com calendar, so there is nothing to accept.
      Your dashboard keeps the full list, including anything that gets moved or
      cancelled later.
    </p>
    <div style="text-align: center;">
      <a href="${input.bookingsUrl}" class="button">See your bookings</a>
    </div>
  `),
  };
}

/** The deploy finished and the site is being served. */
export function siteLiveEmail(input: {
  siteUrl: string;
  dashboardUrl: string;
  clientName?: string | null;
  businessName?: string | null;
}): RenderedEmail {
  return {
    subject: 'Your site is live',
    html: baseEmailTemplate(`
    <h1>Your site is live</h1>
    <p>${greeting(input.clientName)}</p>
    <p>
      ${projectPhrase(input.businessName)} is published and anyone can reach it
      now.
    </p>
    <div style="text-align: center;">
      <a href="${input.siteUrl}" class="button">Open your site</a>
    </div>
    <p style="margin-top: 24px;">
      The address is
      <a href="${input.siteUrl}">${escapeHtml(input.siteUrl)}</a>. Changes you
      make in the editor go live the same way, so you never have to wait on us
      for a wording fix.
    </p>
    <p class="muted">
      Your dashboard is at
      <a href="${input.dashboardUrl}">${input.dashboardUrl}</a>.
    </p>
  `),
  };
}
