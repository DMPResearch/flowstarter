import 'server-only';
/**
 * Email Service
 *
 * Uses Resend for transactional emails.
 * Set RESEND_API_KEY in environment variables.
 *
 * @see https://resend.com/docs
 */

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  /**
   * The text/plain alternative. Every template renders one, and Resend only
   * sends a multipart message when it is given one: without it a reader that
   * shows text gets whatever the client can salvage from the markup, and spam
   * filters score an HTML-only message worse.
   */
  text?: string;
  from?: string;
  replyTo?: string;
}

interface SendEmailResult {
  success: boolean;
  id?: string;
  error?: string;
}

const DEFAULT_FROM = 'Flowstarter <hello@flowstarter.net>';
const RESEND_API_URL = 'https://api.resend.com/emails';

export async function sendEmail({
  to,
  subject,
  html,
  text,
  from = DEFAULT_FROM,
  replyTo = 'hello@flowstarter.net',
}: SendEmailOptions): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.error('[Email] RESEND_API_KEY is not configured');
    return { success: false, error: 'Email service not configured' };
  }

  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        ...(text ? { text } : {}),
        reply_to: replyTo,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const errorMsg = data.message || data.error || JSON.stringify(data);
      console.error('[Email] Failed to send:', {
        status: response.status,
        error: errorMsg,
        to,
        subject,
      });
      return { success: false, error: errorMsg };
    }

    console.info(`[Email] Sent to ${to}: ${subject}`);
    return { success: true, id: data.id };
  } catch (error) {
    console.error('[Email] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Send team invitation email
 */
export async function sendTeamInvitation(
  email: string,
  inviterName: string,
  inviterEmail: string,
  invitationUrl: string
): Promise<SendEmailResult> {
  const { invitationEmail } = await import('./email-templates/invitation');
  const { subject, html, text } = invitationEmail({
    inviterName,
    inviterEmail,
    invitationUrl,
  });

  return sendEmail({ to: email, subject, html, text });
}

/**
 * Send welcome email
 */
export async function sendWelcomeEmail(
  email: string,
  userName?: string
): Promise<SendEmailResult> {
  const { welcomeEmail } = await import('./email-templates/welcome');
  const { subject, html, text } = welcomeEmail({
    userName,
    dashboardUrl: 'https://flowstarter.dev/dashboard',
  });

  return sendEmail({ to: email, subject, html, text });
}
