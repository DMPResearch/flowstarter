/**
 * Telling a client the booking page we made them is live.
 *
 * `cal-provisioning.ts` creates a whole calendar account on the client's
 * behalf: a user, weekday hours, an "Intro call" event type, and the link that
 * goes onto their site. All of that happens without them, which is the point,
 * and it leaves exactly one thing they have to do themselves. Nobody can set a
 * password for them, so an account with no password is an account they can
 * never open to change their own hours. This email is the only prompt they
 * ever get to do it.
 *
 * The dedupe key is NOTHING, deliberately: a workspace gets one booking page,
 * once, forever. The retry button on the dashboard and a re-claimed preview
 * both re-run provisioning, and both find the page already there;
 * `provisionWorkspaceCalendar` only calls this on the run that actually
 * created it, and `notifyClientOnce`'s ledger catches whatever slips past
 * that. A second copy would read as a second booking page.
 *
 * Never throws, by `notifyClientOnce`'s contract, so the claim path can await
 * it without a guard and a mailer outage cannot cost a client their project.
 */
import { bookingPageReadyEmail } from '@/lib/email-templates/client-notices';
import type { CalProvisionedNotice } from './cal-provisioning';
import {
  notifyClientOnce,
  type ClientNotifyResult,
} from './client-notifications';

export async function notifyClientBookingPageReady(
  input: CalProvisionedNotice
): Promise<ClientNotifyResult> {
  return notifyClientOnce({
    supabase: input.supabase,
    workspaceId: input.workspaceId,
    notification: 'cal_provisioned',
    // The operator reading the ledger wants to know which page was made and
    // where the client was sent to unlock it. Neither is a secret: the booking
    // URL is on the client's own public site, and the password-setup URL is
    // the instance's own forgot-password page. The account's credentials are
    // never written here because none are ever minted.
    detail: {
      bookingUrl: input.bookingUrl,
      passwordSetupUrl: input.passwordSetupUrl,
    },
    render: (recipient) =>
      bookingPageReadyEmail({
        bookingUrl: input.bookingUrl,
        passwordSetupUrl: input.passwordSetupUrl,
        dashboardUrl: recipient.dashboardUrl,
        clientName: recipient.clientName,
        businessName: recipient.businessName,
      }),
  });
}
