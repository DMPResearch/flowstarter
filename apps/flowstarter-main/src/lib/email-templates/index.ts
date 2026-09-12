/**
 * Flowstarter Email Templates
 *
 * Every transactional email the product sends, rendered from one layout.
 * See `base.ts` for the block vocabulary and `docs/email-templates.md` for how
 * to add one.
 */

export {
  renderEmail,
  escapeHtml,
  safeHref,
  emailAssetBase,
  EMAIL_COLORS,
  type Block,
  type Inline,
  type RenderedEmail,
} from './base';
export { invitationEmail } from './invitation';
export { welcomeEmail } from './welcome';
export { verificationEmail } from './verification';
export { leadNotificationEmail } from './lead-notification';
export {
  balanceInvoiceEmail,
  briefIncompleteEmail,
  buildNeedsReviewEmail,
  changeRequestLiveEmail,
  depositReceivedEmail,
  newBookingEmail,
  previewReadyEmail,
  readableDate,
  siteLiveEmail,
} from './client-notices';
export { guestDepositWelcomeEmail } from './guest-deposit-welcome';
