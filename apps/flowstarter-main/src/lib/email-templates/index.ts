/**
 * Flowstarter Email Templates
 *
 * Custom email templates for Clerk events.
 * To use these, set up Clerk webhooks and send emails via Resend/SendGrid.
 *
 * Setup:
 * 1. In Clerk Dashboard → Settings → Email, disable built-in emails
 * 2. Set up webhooks for: user.created, email.created, etc.
 * 3. Use these templates with your email service (Resend recommended)
 */

export { baseEmailTemplate, EMAIL_STYLES } from './base';
export { invitationEmail } from './invitation';
export { welcomeEmail } from './welcome';
export { verificationEmail } from './verification';
export { leadNotificationEmail } from './lead-notification';
export {
  balanceInvoiceEmail,
  depositReceivedEmail,
  previewReadyEmail,
  siteLiveEmail,
  type RenderedEmail,
} from './client-notices';
export { guestDepositWelcomeEmail } from './guest-deposit-welcome';
