/**
 * Retention: the windows we publish have to be the windows the jobs use.
 *
 * `retention.ts` reads the two TTL environment variables itself rather than
 * importing the reapers, because both reaper modules are `server-only` and
 * carry the service-role Supabase client with them, which is not something a
 * marketing page should load to print a number. That duplication is only safe
 * if something checks it, so this file imports both sides and compares them.
 * If somebody changes `DEFAULT_PREVIEW_TTL_DAYS` from 14, this test fails
 * until the published page changes with it.
 */
import { describe, expect, it } from 'vitest';
import { funnelUploadSessionTtlHours } from '@/lib/flowstarter/funnel-assets';
import { previewTtlDays } from '@/lib/hosting/funnel-previews';
import {
  DATA_REQUEST_RESPONSE_DAYS,
  DATA_REQUEST_ROUTE,
  ON_REQUEST_RETENTION,
  dataRequestSentence,
  enforcedRetention,
} from '../retention';

describe('the windows a job enforces', () => {
  it('publishes the preview reaper’s own default', () => {
    const published = enforcedRetention({})[0];
    expect(published?.window).toBe(`${previewTtlDays({})} days`);
  });

  it('publishes the upload-session sweep’s own default', () => {
    const published = enforcedRetention({})[1];
    expect(published?.window).toBe(`${funnelUploadSessionTtlHours({})} hours`);
  });

  it('follows the env override the jobs follow', () => {
    const env = {
      FLOWSTARTER_PREVIEW_TTL_DAYS: '7',
      FLOWSTARTER_FUNNEL_UPLOAD_SESSION_TTL_HOURS: '6',
    };
    const published = enforcedRetention(env);
    expect(published[0]?.window).toBe('7 days');
    expect(published[1]?.window).toBe('6 hours');
    expect(published[0]?.window).toBe(`${previewTtlDays(env)} days`);
    expect(published[1]?.window).toBe(
      `${funnelUploadSessionTtlHours(env)} hours`
    );
  });

  it('ignores a nonsense override, exactly as the jobs do', () => {
    const env = {
      FLOWSTARTER_PREVIEW_TTL_DAYS: 'soon',
      FLOWSTARTER_FUNNEL_UPLOAD_SESSION_TTL_HOURS: '-3',
    };
    expect(enforcedRetention(env)[0]?.window).toBe(
      `${previewTtlDays(env)} days`
    );
    expect(enforcedRetention(env)[1]?.window).toBe(
      `${funnelUploadSessionTtlHours(env)} hours`
    );
  });

  it('says "1 day" rather than "1 days"', () => {
    expect(
      enforcedRetention({
        FLOWSTARTER_PREVIEW_TTL_DAYS: '1',
        FLOWSTARTER_FUNNEL_UPLOAD_SESSION_TTL_HOURS: '1',
      }).map((entry) => entry.window)
    ).toEqual(['1 day', '1 hour']);
  });

  it('names the job that does it, for anyone checking', () => {
    for (const entry of enforcedRetention({})) {
      expect(entry.enforcedBy.length).toBeGreaterThan(3);
      expect(entry.subject.length).toBeGreaterThan(20);
    }
  });
});

describe('everything with no job behind it', () => {
  it('publishes no number for any of it', () => {
    for (const entry of ON_REQUEST_RETENTION) {
      expect(entry.reason).not.toMatch(/\b\d+\s*(days?|months?|years?)\b/i);
    }
  });

  it('keeps the two claims that were flatly untrue off the page', () => {
    const prose = ON_REQUEST_RETENTION.map(
      (entry) => `${entry.subject} ${entry.reason}`
    ).join(' ');
    // There is no analytics events table and no email log table in the app,
    // so neither may be described as retained for any period.
    expect(prose).not.toMatch(/analytics event/i);
    expect(prose).not.toMatch(/email log/i);
  });

  it('is honest that tax records outlive an erasure request', () => {
    const billing = ON_REQUEST_RETENTION.find((entry) =>
      /invoice/i.test(entry.subject)
    );
    expect(billing?.reason).toMatch(/tax law/i);
  });

  it('writes no em dash', () => {
    const prose = ON_REQUEST_RETENTION.map((entry) => entry.reason).join(' ');
    expect(prose).not.toContain('—');
  });
});

describe('the data-request sentence', () => {
  it('points at the contact page rather than an address with no inbox', () => {
    expect(DATA_REQUEST_ROUTE).toBe('/contact');
    expect(dataRequestSentence()).toMatch(/contact page/i);
    expect(dataRequestSentence()).not.toMatch(/privacy@/);
  });

  it('states the response window from config', () => {
    expect(dataRequestSentence()).toContain(String(DATA_REQUEST_RESPONSE_DAYS));
  });

  it('commits to no more than the statutory month', () => {
    expect(DATA_REQUEST_RESPONSE_DAYS).toBeLessThanOrEqual(30);
  });
});
