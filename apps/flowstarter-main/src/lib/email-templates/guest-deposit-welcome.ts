/**
 * The one email a guest-checkout client gets between paying and signing in.
 *
 * It is the only place the temporary password ever appears, so it has to be
 * unambiguous: the address they sign in with, the password we chose, where to
 * go, and the fact that the password is about to be replaced. Everything else
 * is noise in the message that decides whether a paying client can get into
 * the product at all.
 *
 * Two variants, because there are two truths. Someone who has never had an
 * account needs credentials. Someone who already has one must NOT be told we
 * made them a password, because we did not touch it.
 */
import { renderEmail, type RenderedEmail } from './base';

interface GuestDepositWelcomeProps {
  /** The address Stripe charged, which is also the sign-in identifier. */
  email: string;
  /** Omitted for a client who already had an account. */
  tempPassword?: string;
  signInUrl: string;
  businessName?: string | null;
}

export function guestDepositWelcomeEmail({
  email,
  tempPassword,
  signInUrl,
  businessName,
}: GuestDepositWelcomeProps): RenderedEmail {
  const project = businessName?.trim() || 'your site';
  const wrongPayer =
    'If you did not pay this deposit, reply to this email and we will sort ' +
    'it out.';

  if (!tempPassword) {
    return renderEmail({
      subject: 'Your deposit is in and your build has started',
      preheader: `We have started building ${project}. Sign in the way you normally do.`,
      blocks: [
        { kind: 'heading', text: 'Your build has started' },
        {
          kind: 'paragraph',
          content: `Your deposit went through. We have started building ${project}, and the project is already in your dashboard.`,
        },
        {
          kind: 'paragraph',
          content:
            'You already have a Flowstarter account at this address, so ' +
            'nothing changes for you. Sign in the way you normally do.',
        },
        { kind: 'panel', rows: [{ label: 'Sign in with', value: email }] },
        { kind: 'button', label: 'Sign in', href: signInUrl },
        {
          kind: 'note',
          content:
            'We did not change your password. Use the one you already set.',
        },
        { kind: 'note', content: wrongPayer },
      ],
    });
  }

  return renderEmail({
    subject: 'Your Flowstarter account and your build',
    preheader: `We have started building ${project}, and your sign-in details are inside.`,
    blocks: [
      { kind: 'heading', text: 'Your build has started' },
      {
        kind: 'paragraph',
        content: `Your deposit went through. We have started building ${project}, and we made you an account so you can follow it.`,
      },
      {
        kind: 'panel',
        rows: [
          { label: 'Sign in with', value: email },
          { label: 'Temporary password', value: tempPassword },
        ],
      },
      { kind: 'button', label: 'Sign in', href: signInUrl },
      {
        kind: 'paragraph',
        content:
          'The first time you sign in we will ask you to choose your own ' +
          'password. The temporary one above stops working as soon as you do.',
      },
      { kind: 'note', content: wrongPayer },
    ],
  });
}
