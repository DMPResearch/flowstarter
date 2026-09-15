import { describe, expect, it } from 'vitest';
import {
  siteVersionAuthor,
  siteVersionAuthorLabel,
} from '../site-version-author';

describe('siteVersionAuthor', () => {
  it('names our own work as the team, whichever build wrote it', () => {
    for (const createdBy of [
      'system:operator_edit_build:9f3a0a2c-1111-4222-8333-444455556666',
      'system:change_request_build:9f3a0a2c-1111-4222-8333-444455556666',
    ]) {
      const author = siteVersionAuthor(createdBy, 'user_client');
      expect(author.kind).toBe('flowstarter-team');
      expect(author.label).toBe('Built by the Flowstarter team');
    }
  });

  it('never leaks the job id or an operator id to the client', () => {
    const jobId = '9f3a0a2c-1111-4222-8333-444455556666';
    const author = siteVersionAuthor(
      `system:operator_edit_build:${jobId}`,
      'user_client'
    );
    expect(author.label).not.toContain(jobId);
    expect(author.label).not.toContain('user_');
  });

  it('calls the delivered baseline what it is', () => {
    expect(siteVersionAuthor('system').kind).toBe('delivered');
    expect(siteVersionAuthor('system').label).toBe(
      'The site as it was delivered'
    );
    // A `system:` qualifier this rule does not know is still the system, not a
    // person, and must never fall through to "someone on your team".
    expect(siteVersionAuthor('system:something_new').kind).toBe('delivered');
  });

  it('says "You" only to the person who made the change', () => {
    expect(siteVersionAuthor('user_abc', 'user_abc').label).toBe('You');
    expect(siteVersionAuthor('user_abc', 'user_zzz').label).toBe(
      'Someone on your team'
    );
    // With no viewer we cannot honestly say "You", so we do not.
    expect(siteVersionAuthor('user_abc', null).label).toBe(
      'Someone on your team'
    );
  });

  it('says nothing rather than guessing when there is no author', () => {
    expect(siteVersionAuthor(null).label).toBeNull();
    expect(siteVersionAuthor(undefined).label).toBeNull();
    expect(siteVersionAuthor('   ').label).toBeNull();
    expect(siteVersionAuthor('').kind).toBe('unknown');
  });

  it('reads a version row through the same rule', () => {
    expect(
      siteVersionAuthorLabel({
        createdBy:
          'system:operator_edit_build:9f3a0a2c-1111-4222-8333-444455556666',
      })
    ).toBe('Built by the Flowstarter team');
    expect(siteVersionAuthorLabel({})).toBeNull();
    expect(siteVersionAuthorLabel({ createdBy: null })).toBeNull();
  });
});
