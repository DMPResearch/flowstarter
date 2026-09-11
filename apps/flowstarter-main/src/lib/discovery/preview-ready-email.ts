/**
 * "Your preview is ready", to the visitor who asked for it.
 *
 * The intake asks, in these words, "Where should I send your preview once it's
 * ready?" and then stores the answer and sends nothing. This closes that. It
 * is the one email in this set that goes out before there is a workspace, an
 * account or a payment, so it cannot use `project_events` as its ledger
 * (`workspace_id` is NOT NULL there). The live job is the record of this
 * preview and the ready transition happens once, in one process, in the
 * detached generator that owns the job, so a flag on the job is both the
 * natural and the sufficient guard.
 */
import { sendEmail } from '@/lib/email';
import { previewReadyEmail } from '@/lib/email-templates/client-notices';
import { getJob, updateJob } from './live-jobs';
import { previewUrlForClient } from './local-preview-frame';

/**
 * Deliberately loose. The wizard already validates the address it collects;
 * this is the last line of defence against mailing something that is plainly
 * not an address, not a second opinion on RFC 5322.
 */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type PreviewReadyOutcome =
  | 'sent'
  | 'already_sent'
  | 'no_email'
  | 'no_link'
  | 'unknown_job'
  | 'send_failed';

/**
 * The origin an emailed link has to be absolute against.
 *
 * Returns null rather than guessing a hostname: a link to somebody else's site
 * is worse than a preview the visitor reaches from the tab they already have
 * open.
 */
function publicOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The link to put in the email.
 *
 * Prefers the durable hosted copy on the previews host when it exists, because
 * that one outlives the sandbox. Otherwise it reuses exactly what the wizard
 * shows, `previewUrlForClient`, which is a same-origin frame path for a local
 * `astro dev` preview and the sandbox URL for a remote one. A frame path is
 * relative, so it is only usable in an email once an origin can be put in
 * front of it.
 */
export function emailablePreviewUrl(
  demoId: string,
  job: { previewUrl?: string; hostedPreviewUrl?: string }
): string | null {
  if (job.hostedPreviewUrl) return job.hostedPreviewUrl;
  const forClient = previewUrlForClient(demoId, job.previewUrl);
  if (!forClient) return null;
  if (/^https?:\/\//i.test(forClient)) return forClient;
  const origin = publicOrigin();
  return origin ? `${origin}${forClient}` : null;
}

/**
 * Best effort, never throws. The caller is the generator's happy path, and a
 * preview that generated perfectly must not be reported as failed because
 * Resend was unreachable.
 */
export async function sendPreviewReadyEmail(
  demoId: string
): Promise<PreviewReadyOutcome> {
  try {
    const job = getJob(demoId);
    if (!job) return 'unknown_job';
    if (job.readyEmailAt) return 'already_sent';

    const to = job.leadEmail?.trim();
    if (!to || !LOOKS_LIKE_EMAIL.test(to)) return 'no_email';

    const previewUrl = emailablePreviewUrl(demoId, job);
    if (!previewUrl) {
      console.warn(
        `[preview-email] preview ${demoId} is ready but has no link that works ` +
          'outside the browser tab, so nothing was emailed'
      );
      return 'no_link';
    }

    // Claimed before the send, not after: the point of the flag is that a
    // second caller finds it, and a send that takes seconds is exactly the
    // window in which a second caller could arrive.
    updateJob(demoId, { readyEmailAt: Date.now() });

    const { subject, html } = previewReadyEmail({
      previewUrl,
      ...(job.businessName ? { businessName: job.businessName } : {}),
      ...(job.leadName ? { clientName: job.leadName } : {}),
    });
    const result = await sendEmail({ to, subject, html });
    if (!result.success) {
      console.error(
        `[preview-email] preview ${demoId} ready email failed: ` +
          (result.error ?? 'unknown error')
      );
      return 'send_failed';
    }
    return 'sent';
  } catch (error) {
    console.error(
      `[preview-email] preview ${demoId} ready email threw: ` +
        (error instanceof Error ? error.message : 'unknown error')
    );
    return 'send_failed';
  }
}
