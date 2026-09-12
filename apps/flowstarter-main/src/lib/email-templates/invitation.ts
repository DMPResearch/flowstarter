/**
 * Somebody on the team invited somebody else into it.
 *
 * The one template in this set whose recipient may never have heard of
 * Flowstarter, so it names the person who invited them before it names us.
 */
import { renderEmail, type RenderedEmail } from './base';

interface InvitationEmailProps {
  inviterName: string;
  inviterEmail: string;
  invitationUrl: string;
  expiresInDays?: number;
}

export function invitationEmail({
  inviterName,
  inviterEmail,
  invitationUrl,
  expiresInDays = 30,
}: InvitationEmailProps): RenderedEmail {
  return renderEmail({
    subject: `You're invited to join Flowstarter`,
    preheader: `${inviterName} invited you to the Flowstarter team.`,
    blocks: [
      { kind: 'heading', text: "You're invited to join Flowstarter" },
      {
        kind: 'paragraph',
        content: [
          { strong: inviterName },
          ` (${inviterEmail}) invited you to join their team on Flowstarter.`,
        ],
      },
      {
        kind: 'paragraph',
        content:
          'The link below creates your account and puts you straight in the ' +
          'team. It works once.',
      },
      { kind: 'button', label: 'Accept invitation', href: invitationUrl },
      {
        kind: 'note',
        content: `This invitation expires in ${expiresInDays} day${
          expiresInDays === 1 ? '' : 's'
        }. If you were not expecting it, you can ignore this email.`,
      },
    ],
  });
}
