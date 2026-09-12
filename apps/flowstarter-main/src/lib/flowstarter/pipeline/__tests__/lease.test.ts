/**
 * The operator board's half of the lease rule.
 *
 * A row that says `running` used to mean "hands off" unconditionally, which is
 * how a worker that died mid-build left a paid job nothing on the system would
 * touch: a restarted worker walked past it, and this endpoint refused it. The
 * lease turns `running` into a question with an answer.
 */
import { describe, expect, it } from 'vitest';
import {
  abandonedByWorker,
  DEFAULT_LEASE_TTL_MS,
  leaseDeadline,
  leaseExpired,
} from '../lease';

const NOW = Date.parse('2026-09-12T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe('leaseDeadline', () => {
  it('is the lease column when there is one', () => {
    expect(
      leaseDeadline({ status: 'running', lease_expires_at: iso(30_000) })
    ).toBe(NOW + 30_000);
  });

  it('falls back to one TTL after the start, for a row claimed before leases existed', () => {
    expect(leaseDeadline({ status: 'running', started_at: iso(0) })).toBe(
      NOW + DEFAULT_LEASE_TTL_MS
    );
  });

  it('is unknown for a row with neither', () => {
    expect(leaseDeadline({ status: 'running' })).toBe(null);
    expect(leaseDeadline({ status: 'running', started_at: 'whenever' })).toBe(
      null
    );
  });
});

describe('abandonedByWorker', () => {
  it('is true for a running build nobody is checking in on', () => {
    expect(
      abandonedByWorker(
        {
          status: 'running',
          leased_by: 'build-1:9:ff',
          lease_expires_at: iso(-1),
        },
        NOW
      )
    ).toBe(true);
  });

  it('is false while the worker is still checking in', () => {
    expect(
      abandonedByWorker(
        {
          status: 'running',
          leased_by: 'build-1:9:ff',
          lease_expires_at: iso(60_000),
        },
        NOW
      )
    ).toBe(false);
  });

  it('is false for a row that is not running at all', () => {
    expect(
      abandonedByWorker({ status: 'queued', lease_expires_at: iso(-1) }, NOW)
    ).toBe(false);
  });

  it('is false for a running row nothing can date', () => {
    // Refusing beats guessing: yanking a live build out from under its worker
    // is worse than making an operator look at it.
    expect(abandonedByWorker({ status: 'running' }, NOW)).toBe(false);
    expect(leaseExpired({ status: 'running' }, NOW)).toBe(false);
  });
});
