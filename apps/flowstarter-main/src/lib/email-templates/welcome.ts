/**
 * The first email a new account gets.
 *
 * The subject used to carry an emoji, which the house style bans everywhere
 * else in this directory and which reads as marketing in an inbox full of
 * transactional mail. The copy used to promise "beautiful websites" and list
 * three things to explore. Both are gone: somebody who just signed up needs
 * one sentence about what they have and one link to it.
 */
import { renderEmail, type RenderedEmail } from './base';

interface WelcomeEmailProps {
  userName?: string;
  dashboardUrl: string;
}

export function welcomeEmail({
  userName,
  dashboardUrl,
}: WelcomeEmailProps): RenderedEmail {
  const name = userName?.trim();
  return renderEmail({
    subject: 'Welcome to Flowstarter',
    preheader: 'Your account is ready and your dashboard is waiting.',
    blocks: [
      { kind: 'heading', text: 'Your account is ready' },
      { kind: 'paragraph', content: name ? `Hi ${name},` : 'Hi there,' },
      {
        kind: 'paragraph',
        content:
          'Your Flowstarter account is set up. Your dashboard is where your ' +
          'project lives: the brief you gave us, the preview when it is ' +
          'ready, and the site once it is live.',
      },
      { kind: 'button', label: 'Open your dashboard', href: dashboardUrl },
      {
        kind: 'note',
        content:
          'Questions at any point, reply to this email. A person reads it.',
      },
    ],
  });
}
