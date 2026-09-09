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
    });
    expect(payload.message).not.toContain('[Project]');
  });
});
