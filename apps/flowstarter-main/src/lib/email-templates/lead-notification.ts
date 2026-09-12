/**
 * Somebody filled in the contact form on a client's own site.
 *
 * The only email in the system whose reader is trying to do one thing with it:
 * reply. So the enquirer's own words come before anything of ours, the reply
 * address is theirs (the capture route sets `replyTo`), and the facts sit in a
 * table the eye can skip.
 *
 * The subject was `New lead on <site>: <name>`, which put a stranger's name in
 * a client's inbox list and called their customer a lead. It is now the same
 * sentence for every enquiry, which is what an inbox rule can be written
 * against.
 */
import { renderEmail, type Block, type RenderedEmail } from './base';

interface LeadNotificationProps {
  /** Display name for the recipient (the client or team member). */
  recipientName?: string | null;
  /** Project name (the site that received the enquiry). */
  projectName?: string | null;
  /** Enquirer fields */
  leadName?: string | null;
  leadEmail?: string | null;
  leadPhone?: string | null;
  leadMessage?: string | null;
  /** Source channel, e.g. "contact_form", "newsletter". */
  source?: string | null;
  /** Optional URL to view enquiries in the dashboard. */
  inboxUrl?: string | null;
  /** Local timestamp string for the arrival. */
  receivedAt?: string;
}

/**
 * The capture route hands this an ISO instant, which is correct to store and
 * unreadable in an inbox. Anything that does not parse is printed as given,
 * because an operator-supplied string is more likely to be right than a
 * fallback we invent.
 */
export function readableReceived(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const day = at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const time = at.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return `${day} at ${time} UTC`;
}

export function leadNotificationEmail(
  props: LeadNotificationProps
): RenderedEmail {
  const projectName = props.projectName?.trim() || 'your website';
  const who = props.leadName?.trim();
  const message = props.leadMessage?.trim();

  const blocks: Block[] = [
    { kind: 'heading', text: 'New enquiry from your site' },
    {
      kind: 'paragraph',
      content: props.recipientName?.trim()
        ? `Hi ${props.recipientName.trim()},`
        : 'Hi there,',
    },
    {
      kind: 'paragraph',
      content: who
        ? `${who} just got in touch through the contact form on ${projectName}.`
        : `Someone just got in touch through the contact form on ${projectName}.`,
    },
  ];

  if (message) blocks.push({ kind: 'quote', text: message });

  blocks.push({
    kind: 'facts',
    rows: [
      { label: 'Name', value: who ?? '' },
      { label: 'Email', value: props.leadEmail?.trim() ?? '' },
      { label: 'Phone', value: props.leadPhone?.trim() ?? '' },
      { label: 'Source', value: props.source?.trim() ?? '' },
      {
        label: 'Received',
        value: readableReceived(props.receivedAt ?? new Date().toISOString()),
      },
    ],
  });

  if (props.inboxUrl) {
    blocks.push({
      kind: 'button',
      label: 'Open your enquiries',
      href: props.inboxUrl,
    });
  }

  blocks.push({
    kind: 'note',
    content:
      'Reply to this email and it goes straight to them, not to us. Their ' +
      'address is above if you would rather start a new message.',
  });

  return renderEmail({
    subject: 'New enquiry from your site',
    preheader: message
      ? `${who ?? 'Someone'}: ${message.slice(0, 90)}`
      : `${who ?? 'Someone'} got in touch through ${projectName}.`,
    blocks,
  });
}
