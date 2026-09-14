/**
 * The two emails a visitor gets when the intake routes them to custom work.
 *
 * They are the first thing anybody has ever sent this person, and they carry
 * an awkward message: the thing they asked for is not the thing this site
 * builds by itself. So the copy does the one thing that makes that land well,
 * which is to say it plainly and immediately, name who does do it, and give
 * them the next step in the same breath. No apology, no "unfortunately", and
 * no pretending a discovery call is a prize.
 *
 * Two templates rather than one with a branch: whether there is a calendar to
 * book is a fact about our configuration, not about them, and an email that
 * says "book a time" with no link is worse than one that says "Darius will
 * write to you". The caller picks by whether `discoveryCallBookingUrl` returned
 * a URL.
 */
import { renderEmail, type RenderedEmail } from './base';

/** The studio that contracts the custom work. Named, not implied. */
const STUDIO = 'DMPResearch';

function greeting(name?: string | null) {
  const trimmed = (name ?? '').trim();
  return {
    kind: 'paragraph' as const,
    content: trimmed ? `Hi ${trimmed},` : 'Hi,',
  };
}

/**
 * What we understood, quoted back.
 *
 * The visitor's own sentence, not a summary of it. Somebody being told their
 * project needs a different process wants to see that the thing was read, and
 * a paraphrase invites an argument about the paraphrase.
 */
function whatTheyAsked(description: string) {
  const trimmed = description.trim();
  return trimmed ? [{ kind: 'quote' as const, text: trimmed }] : [];
}

export function discoveryCallBookedOfferEmail(input: {
  /** Already prefilled with their name and address. */
  bookingUrl: string;
  visitorName?: string | null;
  description: string;
}): RenderedEmail {
  return renderEmail({
    subject: `Your project needs a call with ${STUDIO}`,
    preheader: 'Pick a time and we will scope it properly.',
    blocks: [
      { kind: 'heading', text: 'This one is custom work' },
      greeting(input.visitorName),
      {
        kind: 'paragraph',
        content:
          'Thank you for telling us about your project. Reading it back, what ' +
          'you need is not a site that presents your business, it is software ' +
          `built for it. That is real work and we do not start it from a form.`,
      },
      ...whatTheyAsked(input.description),
      {
        kind: 'paragraph',
        content:
          `Work like this is handled by ${STUDIO}, Darius's studio, and it is ` +
          'contracted after a call rather than bought off a page. The call is ' +
          'thirty minutes, there is nothing to prepare, and you leave it ' +
          'knowing what the work involves and what it costs, whether or not ' +
          'you go ahead with us.',
      },
      { kind: 'button', label: 'Pick a time', href: input.bookingUrl },
      {
        kind: 'note',
        content:
          'Your name and address are already filled in on that page. If none ' +
          'of the times suit you, reply to this email and we will find one.',
      },
    ],
  });
}

export function customWorkEnquiryEmail(input: {
  visitorName?: string | null;
  description: string;
}): RenderedEmail {
  return renderEmail({
    subject: `Your project is with ${STUDIO}`,
    preheader: 'We have it, and Darius will write to you.',
    blocks: [
      { kind: 'heading', text: 'This one is custom work' },
      greeting(input.visitorName),
      {
        kind: 'paragraph',
        content:
          'Thank you for telling us about your project. Reading it back, what ' +
          'you need is not a site that presents your business, it is software ' +
          'built for it. That is real work and we do not start it from a form.',
      },
      ...whatTheyAsked(input.description),
      {
        kind: 'paragraph',
        content:
          `Work like this is handled by ${STUDIO}, Darius's studio. We have ` +
          'your enquiry and Darius will write to you himself to arrange a ' +
          'call. There is nothing for you to do in the meantime.',
      },
      {
        kind: 'note',
        content:
          'If anything has changed, or you want to add something you left ' +
          'out, just reply to this email.',
      },
    ],
  });
}

/**
 * What Darius reads.
 *
 * Separate from the two above because an operator's email is facts and a
 * client's email is a sentence. This one is the brief, the classifier's own
 * evidence and the route, so the decision can be judged from the inbox without
 * opening the board.
 */
export function customWorkOperatorEmail(input: {
  visitorName: string;
  visitorEmail: string;
  description: string;
  linkUrl?: string | null;
  scope: string;
  confidence: number;
  evidence: readonly string[];
  route: string;
  boardUrl: string;
}): RenderedEmail {
  return renderEmail({
    subject: `Custom work lead: ${input.visitorName}`,
    preheader: `${input.visitorEmail} was routed to a discovery call.`,
    blocks: [
      { kind: 'heading', text: 'A custom work lead' },
      {
        kind: 'facts',
        rows: [
          { label: 'Name', value: input.visitorName },
          { label: 'Email', value: input.visitorEmail },
          ...(input.linkUrl ? [{ label: 'Link', value: input.linkUrl }] : []),
          { label: 'Scope', value: input.scope },
          { label: 'Confidence', value: input.confidence.toFixed(2) },
          { label: 'Route', value: input.route },
        ],
      },
      { kind: 'quote', text: input.description },
      ...(input.evidence.length > 0
        ? [{ kind: 'list' as const, items: [...input.evidence] }]
        : []),
      { kind: 'button', label: 'Open the board', href: input.boardUrl },
    ],
  });
}
