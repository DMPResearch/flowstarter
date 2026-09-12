/**
 * The alert rules are pure, so these tests never touch Supabase, email, or
 * the real clock. Every `now` and every env override is passed in explicitly.
 */
import { describe, expect, it } from 'vitest';
import {
  alertSeverity,
  buildDedupeKey,
  dedupeWindowMs,
  shouldSendAlert,
  type AlertEvent,
} from '../alerts';

const EVENTS: AlertEvent[] = [
  'build_job_failed',
  'client_email_failed',
  'health_check_failed',
];

describe('alertSeverity', () => {
  it('classifies a failed paid build and a failed health check as critical', () => {
    expect(alertSeverity('build_job_failed')).toBe('critical');
    expect(alertSeverity('health_check_failed')).toBe('critical');
  });

  it('classifies a failed client email as a warning, not critical', () => {
    expect(alertSeverity('client_email_failed')).toBe('warning');
  });
});

describe('dedupeWindowMs', () => {
  it('falls back to a documented default when no env override is set', () => {
    expect(dedupeWindowMs('build_job_failed', {})).toBe(60 * 60_000);
    expect(dedupeWindowMs('client_email_failed', {})).toBe(240 * 60_000);
    expect(dedupeWindowMs('health_check_failed', {})).toBe(30 * 60_000);
  });

  it('reads a per-event override from the env it is given, not process.env', () => {
    const env = { OPS_ALERT_BUILD_JOB_FAILED_DEDUPE_MINUTES: '5' };
    expect(dedupeWindowMs('build_job_failed', env)).toBe(5 * 60_000);
    // A different event's window is untouched by an override for this one.
    expect(dedupeWindowMs('client_email_failed', env)).toBe(240 * 60_000);
  });

  it('ignores a non-positive or non-numeric override and falls back to the default', () => {
    for (const bad of ['0', '-5', 'not-a-number', '']) {
      expect(
        dedupeWindowMs('health_check_failed', {
          OPS_ALERT_HEALTH_CHECK_FAILED_DEDUPE_MINUTES: bad,
        })
      ).toBe(30 * 60_000);
    }
  });
});

describe('buildDedupeKey', () => {
  it('joins the event and the discriminator so two events never collide', () => {
    expect(buildDedupeKey('build_job_failed', 'job-1')).toBe(
      'build_job_failed:job-1'
    );
    expect(buildDedupeKey('client_email_failed', 'job-1')).toBe(
      'client_email_failed:job-1'
    );
  });
});

describe('shouldSendAlert', () => {
  const now = new Date('2026-09-12T12:00:00.000Z');

  it('always sends the first occurrence', () => {
    for (const event of EVENTS) {
      expect(shouldSendAlert(event, null, now)).toBe(true);
    }
  });

  it('suppresses a second occurrence inside the dedupe window', () => {
    const lastSentAt = new Date(now.getTime() - 5 * 60_000); // 5 minutes ago
    expect(shouldSendAlert('build_job_failed', lastSentAt, now)).toBe(false);
  });

  it('sends again once the dedupe window has elapsed', () => {
    const lastSentAt = new Date(now.getTime() - 61 * 60_000); // 61 minutes ago
    expect(shouldSendAlert('build_job_failed', lastSentAt, now)).toBe(true);
  });

  it('is exactly inclusive at the window boundary', () => {
    const lastSentAt = new Date(now.getTime() - 60 * 60_000); // exactly 60m
    expect(shouldSendAlert('build_job_failed', lastSentAt, now)).toBe(true);
    const oneMsShort = new Date(now.getTime() - 60 * 60_000 + 1);
    expect(shouldSendAlert('build_job_failed', oneMsShort, now)).toBe(false);
  });

  it('honours a per-event env override when deciding', () => {
    const lastSentAt = new Date(now.getTime() - 10 * 60_000); // 10 minutes ago
    const env = { OPS_ALERT_BUILD_JOB_FAILED_DEDUPE_MINUTES: '5' };
    // Default window (60m) would still suppress this...
    expect(shouldSendAlert('build_job_failed', lastSentAt, now)).toBe(false);
    // ...but a 5-minute override lets it through.
    expect(shouldSendAlert('build_job_failed', lastSentAt, now, env)).toBe(
      true
    );
  });
});
