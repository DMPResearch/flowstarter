/**
 * Prove the address is real.
 *
 * Two shapes, because the auth provider sends one of two things: a link, or a
 * six-character code the person types back into the tab they already have
 * open. The code variant is the only email in the whole system with no button,
 * because there is nowhere for it to go.
 */
import { renderEmail, type RenderedEmail } from './base';

interface VerificationEmailProps {
  verificationUrl?: string;
  verificationCode?: string;
}

export function verificationEmail({
  verificationUrl,
  verificationCode,
}: VerificationEmailProps): RenderedEmail {
  const ignore =
    'If you did not create a Flowstarter account, you can ignore this email ' +
    'and nothing will happen.';

  if (verificationCode) {
    return renderEmail({
      subject: 'Verify your email for Flowstarter',
      preheader: `Your verification code is ${verificationCode}.`,
      blocks: [
        { kind: 'heading', text: 'Verify your email' },
        {
          kind: 'paragraph',
          content:
            'Enter this code in the tab you started from to finish signing up.',
        },
        {
          kind: 'panel',
          rows: [{ label: 'Verification code', value: verificationCode }],
        },
        { kind: 'note', content: ignore },
      ],
    });
  }

  return renderEmail({
    subject: 'Verify your email for Flowstarter',
    preheader: 'One link finishes your Flowstarter sign-up.',
    blocks: [
      { kind: 'heading', text: 'Verify your email' },
      {
        kind: 'paragraph',
        content:
          'Confirm this is your address and your Flowstarter account is ready.',
      },
      { kind: 'button', label: 'Verify email', href: verificationUrl ?? '#' },
      { kind: 'note', content: ignore },
    ],
  });
}
