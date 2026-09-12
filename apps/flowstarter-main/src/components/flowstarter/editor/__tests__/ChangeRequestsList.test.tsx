/**
 * What a client reads on their own change request, at each stage.
 *
 * The one that matters is `paid`. It used to say "your team is on it" forever,
 * because there was nothing for the team to be on it with: the operator's only
 * button moved a status and shipped nothing, and a client who paid EUR 190 on
 * 2026-09-12 read that sentence indefinitely. A paid request with a build
 * attached now says the work is happening, and a finished one names the
 * version it went live in.
 */
import { describe, expect, it } from 'vitest';
import type { ChangeRequestView } from '@/lib/flowstarter/change-requests';
import { changeRequestProgress } from '../ChangeRequestsList';

function view(overrides: Partial<ChangeRequestView> = {}): ChangeRequestView {
  return {
    id: '72fe7f79-0e83-4cf6-9b4a-2502842b9a54',
    request: 'Add a small gallery to the case study pages',
    classification: 'structural',
    matchedRules: ['structural:new-thing'],
    status: 'paid',
    quoteMinor: 19_000,
    currency: 'eur',
    quoteNote: null,
    quotedAt: '2026-09-12T09:12:00.000Z',
    respondedAt: '2026-09-12T09:13:00.000Z',
    paidAt: '2026-09-12T09:14:53.953Z',
    completedAt: null,
    createdAt: '2026-09-12T09:10:00.000Z',
    buildJobId: null,
    builtVersion: null,
    completedVia: null,
    ...overrides,
  };
}

describe('changeRequestProgress', () => {
  it('says the work is happening once a build has been started', () => {
    expect(view({ buildJobId: 'job-1' })).toBeTruthy();
    expect(changeRequestProgress(view({ buildJobId: 'job-1' }))).toBe(
      'In progress, we are making the change now'
    );
  });

  it('still says the team has it when nothing has been started', () => {
    expect(changeRequestProgress(view())).toBe('Paid, your team is on it');
  });

  it('names the version the finished change went live in', () => {
    expect(
      changeRequestProgress(
        view({
          status: 'done',
          buildJobId: 'job-1',
          builtVersion: 5,
          completedVia: 'build',
        })
      )
    ).toBe('Done, live in version 5');
  });

  it('says only "Done" when it was closed by hand with no version', () => {
    expect(
      changeRequestProgress(
        view({ status: 'done', completedVia: 'manual', builtVersion: null })
      )
    ).toBe('Done');
  });

  it('leaves the other statuses exactly as they read before', () => {
    expect(changeRequestProgress(view({ status: 'requested' }))).toBe(
      'With your team for a quote'
    );
    expect(changeRequestProgress(view({ status: 'quoted' }))).toBe('Quoted');
    expect(changeRequestProgress(view({ status: 'accepted' }))).toBe(
      'Accepted, finish the payment to start the work'
    );
    expect(changeRequestProgress(view({ status: 'declined' }))).toBe(
      'Declined'
    );
  });
});
