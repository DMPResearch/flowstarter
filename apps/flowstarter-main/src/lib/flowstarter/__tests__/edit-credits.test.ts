/**
 * The monthly edit allowance.
 *
 * Two things are worth defending here. The first is the tier mapping: the
 * column still holds legacy strings and nulls, and a mapping that fell through
 * to "unlimited" would give away a plan we sell. The second is the month
 * boundary, which is the only arithmetic in the module that can be wrong on a
 * specific day of the year rather than every day.
 */
import { describe, expect, it } from 'vitest';
import {
  MONTHLY_EDIT_ALLOWANCE,
  creditsExhaustedMessage,
  editCreditPosition,
  editCreditsLine,
  formatResetDate,
  normaliseTierKey,
  startOfNextUtcMonth,
  startOfUtcMonth,
} from '../edit-credits';

describe('normaliseTierKey', () => {
  it('passes the canonical keys through', () => {
    for (const key of [
      'starter',
      'pro',
      'max',
      'ecommerce',
      'admin',
    ] as const) {
      expect(normaliseTierKey(key)).toBe(key);
    }
  });

  it('maps the legacy values the column still accepts', () => {
    expect(normaliseTierKey('essential')).toBe('starter');
    expect(normaliseTierKey('commerce')).toBe('ecommerce');
    expect(normaliseTierKey('custom')).toBe('admin');
    expect(normaliseTierKey('pro')).toBe('pro');
  });

  it('treats null, undefined and an unknown string as the Starter floor', () => {
    expect(normaliseTierKey(null)).toBe('starter');
    expect(normaliseTierKey(undefined)).toBe('starter');
    expect(normaliseTierKey('')).toBe('starter');
    expect(normaliseTierKey('enterprise')).toBe('starter');
  });

  it('ignores case and stray whitespace on the way in', () => {
    expect(normaliseTierKey('  PRO ')).toBe('pro');
    expect(normaliseTierKey('Essential')).toBe('starter');
  });
});

describe('the published allowances', () => {
  it('matches the numbers the care plans sell', () => {
    expect(MONTHLY_EDIT_ALLOWANCE.starter).toBe(50);
    expect(MONTHLY_EDIT_ALLOWANCE.pro).toBe(150);
  });

  it('never meters an admin plan', () => {
    expect(MONTHLY_EDIT_ALLOWANCE.admin).toBeNull();
  });

  it('does not give a dearer plan fewer edits than Pro', () => {
    expect(MONTHLY_EDIT_ALLOWANCE.max).toBeGreaterThanOrEqual(150);
    expect(MONTHLY_EDIT_ALLOWANCE.ecommerce).toBeGreaterThanOrEqual(150);
  });
});

describe('editCreditPosition', () => {
  const now = new Date('2026-09-10T12:00:00Z');

  it('counts what is left on a Starter plan', () => {
    const position = editCreditPosition({ tier: null, usedThisMonth: 4, now });
    expect(position).toMatchObject({
      tier: 'starter',
      allowance: 50,
      used: 4,
      remaining: 46,
      exhausted: false,
    });
  });

  it('leaves an admin plan unmetered', () => {
    const position = editCreditPosition({
      tier: 'admin',
      usedThisMonth: 900,
      now,
    });
    expect(position.allowance).toBeNull();
    expect(position.remaining).toBeNull();
    expect(position.exhausted).toBe(false);
  });

  it('clamps remaining at zero rather than going negative', () => {
    const position = editCreditPosition({
      tier: 'starter',
      usedThisMonth: 63,
      now,
    });
    expect(position.remaining).toBe(0);
    expect(position.exhausted).toBe(true);
  });

  it('flags exhausted on the edit that reaches the allowance, not after it', () => {
    expect(
      editCreditPosition({ tier: 'starter', usedThisMonth: 49, now }).exhausted
    ).toBe(false);
    expect(
      editCreditPosition({ tier: 'starter', usedThisMonth: 50, now }).exhausted
    ).toBe(true);
  });

  it('extends the allowance by an add-on pack', () => {
    const position = editCreditPosition({
      tier: 'starter',
      usedThisMonth: 50,
      addOnCredits: 25,
      now,
    });
    expect(position.allowance).toBe(75);
    expect(position.remaining).toBe(25);
    expect(position.exhausted).toBe(false);
  });

  it('refuses to let a negative add-on shrink the plan', () => {
    const position = editCreditPosition({
      tier: 'starter',
      usedThisMonth: 0,
      addOnCredits: -30,
      now,
    });
    expect(position.allowance).toBe(50);
  });

  it('treats a negative count as zero used', () => {
    expect(
      editCreditPosition({ tier: 'pro', usedThisMonth: -3, now }).used
    ).toBe(0);
  });
});

describe('the UTC month boundary', () => {
  it('starts the period at midnight on the first', () => {
    expect(startOfUtcMonth(new Date('2026-09-10T23:59:59.999Z'))).toBe(
      '2026-09-01T00:00:00.000Z'
    );
  });

  it('rolls a 31-day month into the first of the next one', () => {
    expect(startOfNextUtcMonth(new Date('2026-01-31T23:59:00Z'))).toBe(
      '2026-02-01T00:00:00.000Z'
    );
  });

  it('rolls February into March in a leap year', () => {
    expect(startOfNextUtcMonth(new Date('2028-02-29T12:00:00Z'))).toBe(
      '2028-03-01T00:00:00.000Z'
    );
  });

  it('rolls December into January of the next year', () => {
    expect(startOfNextUtcMonth(new Date('2026-12-31T23:59:59Z'))).toBe(
      '2027-01-01T00:00:00.000Z'
    );
  });

  it('resets on the first of the month after the one being counted', () => {
    const position = editCreditPosition({
      tier: 'pro',
      usedThisMonth: 1,
      now: new Date('2026-09-30T22:00:00Z'),
    });
    expect(position.resetsAt).toBe('2026-10-01T00:00:00.000Z');
    expect(formatResetDate(position.resetsAt)).toBe('1 October');
  });
});

describe('the words the client reads', () => {
  const now = new Date('2026-09-10T12:00:00Z');

  it('names the number left and the day it comes back', () => {
    const position = editCreditPosition({
      tier: 'starter',
      usedThisMonth: 4,
      now,
    });
    expect(editCreditsLine(position)).toBe(
      '46 of 50 edits left this month. Resets on 1 October.'
    );
  });

  it('does not count anything on an unmetered plan', () => {
    const position = editCreditPosition({
      tier: 'admin',
      usedThisMonth: 4,
      now,
    });
    expect(editCreditsLine(position)).toBe('Unlimited edits on your plan.');
  });

  it('explains an exhausted allowance with real numbers and no jargon', () => {
    const position = editCreditPosition({
      tier: 'starter',
      usedThisMonth: 50,
      now,
    });
    const message = creditsExhaustedMessage(position);
    expect(message).toBe(
      'You have used all 50 edits in your plan this month. ' +
        'Your allowance resets on 1 October. ' +
        'Message us if you need more before then.'
    );
    expect(message).not.toMatch(/tier|allowance_|starter|quota/i);
  });
});
