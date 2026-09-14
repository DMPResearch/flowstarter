/**
 * How long we keep things, separated into what a job enforces and what a
 * person does.
 *
 * The privacy page used to publish five retention periods as if they were
 * enforced: account data deleted 30 days after closure, analytics events kept
 * 12 months, billing kept 7 years, email logs kept 30 days, uploaded assets
 * deleted 30 days after closure. None of that is true. There is no deletion
 * job for account data, no analytics events table at all, no pruning of the
 * billing tables, and no email log table anywhere in the app. Two of the five
 * described data the product does not even hold.
 *
 * Two things exist and are real, and both come from the funnel:
 *
 *   `reapExpiredPreviews` in `src/lib/hosting/preview-reaper.ts` unpublishes
 *   the hosted preview, deletes the site artifact, and deletes the pictures a
 *   visitor uploaded during the intake, for every preview past `expires_at`
 *   that nobody claimed. The window is `FLOWSTARTER_PREVIEW_TTL_DAYS`,
 *   defaulting to 14 days.
 *
 *   `reapExpiredFunnelUploadSessions` in
 *   `src/lib/flowstarter/funnel-assets.ts` deletes the upload session behind
 *   the intake's picture cap, and, when the preview it belonged to was never
 *   created, the orphaned pictures too. The window is
 *   `FLOWSTARTER_FUNNEL_UPLOAD_SESSION_TTL_HOURS`, defaulting to 24 hours.
 *
 * So this module splits the page's retention section in two. `ENFORCED` is
 * what a job does, with the same env vars and the same defaults the jobs read,
 * so a change to a window changes the published page. `ON_REQUEST` is
 * everything else, and it says "until you ask us to delete it" rather than a
 * number, because a number nothing enforces is a promise nothing keeps.
 *
 * The windows are read from the same two environment variables the jobs read,
 * with the same defaults, and NOT by importing the jobs: both of those
 * modules are `server-only` and pull the service-role Supabase client in with
 * them, which is not something a marketing page should have to load in order
 * to print a number. `__tests__/retention.test.ts` imports both sides and
 * fails if the two ever disagree, so the duplication is checked rather than
 * trusted. That test is what stops this file from becoming the sixth
 * unenforced promise.
 */

/** Mirrors DEFAULT_PREVIEW_TTL_DAYS in src/lib/hosting/funnel-previews.ts. */
const DEFAULT_PREVIEW_TTL_DAYS = 14;
/**
 * Mirrors DEFAULT_FUNNEL_UPLOAD_SESSION_TTL_HOURS in
 * src/lib/flowstarter/funnel-assets.ts.
 */
const DEFAULT_UPLOAD_SESSION_TTL_HOURS = 24;

type EnvLike = Record<string, string | undefined>;

function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw?.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export interface EnforcedRetention {
  /** What is deleted, in the words a client would use for it. */
  subject: string;
  /** The window, rendered. */
  window: string;
  /** The job that does it, for anyone checking this against the code. */
  enforcedBy: string;
}

export interface OnRequestRetention {
  subject: string;
  /** Why we hold it while we hold it. */
  reason: string;
}

/** The two windows a job actually enforces, read from the jobs' own config. */
export function enforcedRetention(
  env: EnvLike = process.env as EnvLike
): EnforcedRetention[] {
  const previewDays = positiveNumber(
    env['FLOWSTARTER_PREVIEW_TTL_DAYS'],
    DEFAULT_PREVIEW_TTL_DAYS
  );
  const uploadHours = positiveNumber(
    env['FLOWSTARTER_FUNNEL_UPLOAD_SESSION_TTL_HOURS'],
    DEFAULT_UPLOAD_SESSION_TTL_HOURS
  );
  return [
    {
      subject:
        'The preview site we generate during the intake, and any picture you upload while answering',
      window: `${previewDays} day${previewDays === 1 ? '' : 's'}`,
      enforcedBy: 'the preview reaper',
    },
    {
      subject:
        'The upload session behind the intake, when the preview it belonged to was never finished',
      window: `${uploadHours} hour${uploadHours === 1 ? '' : 's'}`,
      enforcedBy: 'the same job',
    },
  ];
}

/**
 * Everything with no job behind it.
 *
 * Each entry says why we hold it, which is the part that makes "until you ask"
 * an answer rather than an evasion. Billing is the one with a floor rather
 * than a ceiling: tax law requires us to keep invoices whether or not anybody
 * asks us to delete them, and saying so is more useful than printing a number
 * of years nothing in the product counts.
 */
export const ON_REQUEST_RETENTION: readonly OnRequestRetention[] = [
  {
    subject: 'Your account and the people on your team',
    reason:
      'We hold it while the account exists, and delete it when you close the account or ask us to.',
  },
  {
    subject: 'Your project, its brief, and the files you uploaded to it',
    reason:
      'We hold it so we can keep building and supporting your site, and delete it when you ask.',
  },
  {
    subject: 'Invoices and payment records',
    reason:
      'Tax law requires us to keep these even after you ask us to delete everything else, so these are the one thing an erasure request does not reach.',
  },
  {
    subject: 'Support messages and anything you sent through the contact form',
    reason: 'We hold these while they are useful, and delete them on request.',
  },
];

/**
 * Days we commit to answering a data-protection request in.
 *
 * GDPR Article 12(3) gives a controller one month, so 30 is not a number this
 * product invented and not one it can quietly lengthen. It is here rather
 * than in the page so the privacy page, the contact page and any future
 * request form all print the same figure.
 */
export const DATA_REQUEST_RESPONSE_DAYS = 30;

/** Where a data-protection request goes. There is one route, and it is real. */
export const DATA_REQUEST_ROUTE = '/contact';

/**
 * The sentence closing the GDPR rights section.
 *
 * The old one said "email privacy@flowstarter.net. We verify the request and
 * respond within 30 days" for an address with no inbox behind it in the
 * product. The contact form has a route, a rate limit and a mailer, so it is
 * the thing to point at.
 */
export function dataRequestSentence(): string {
  return (
    'To exercise any of these rights, send the request through the contact ' +
    `page. We check that the request is really yours and answer within ` +
    `${DATA_REQUEST_RESPONSE_DAYS} days, which is the limit the GDPR sets. ` +
    'If the answer is going to take the whole window, we say so before it ' +
    'runs out rather than at the end of it.'
  );
}
