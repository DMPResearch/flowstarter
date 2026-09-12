import { describe, it, expect } from 'vitest';
import { buildContactPayload } from '../contact-payload';

describe('buildContactPayload', () => {
  it('sends subject as its own field instead of folding it into the message', () => {
    const payload = buildContactPayload({
      name: 'Elena Popescu',
      email: 'elena@example.ro',
      subject: 'Project',
      message: 'Aș dori o programare pentru vineri.',
    });

    expect(payload).toEqual({
      name: 'Elena Popescu',
      email: 'elena@example.ro',
      subject: 'Project',
      message: 'Aș dori o programare pentru vineri.',
      website: '',
    });
    expect(payload.message).not.toContain('[Project]');
  });

  it('carries a filled honeypot through unchanged, so the route can catch it', () => {
    const payload = buildContactPayload({
      name: 'Bot',
      email: 'bot@example.com',
      subject: 'General',
      message: 'buy now',
      website: 'https://spam.example',
    });

    expect(payload.website).toBe('https://spam.example');
  });
});
