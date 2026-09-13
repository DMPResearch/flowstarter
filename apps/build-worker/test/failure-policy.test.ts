/**
 * The retry rule, asserted as a rule: a recorded failure in, one word out.
 *
 * The defect these exist for has a job id. `b52b241f-686b-4871-bc64-21cf61fb5f79`,
 * 2026-09-13: a change-request build whose commit message was outside the
 * commit policy. That is a deterministic refusal — the same build, the same
 * policy, the same answer — and #120's sweep ran it three times, thirty-one
 * minutes and three full agent passes to learn it twice more than necessary.
 * The same sweep had already erased the record on five earlier jobs, whose
 * `error_code` now reads the reason their *last* attempt died rather than the
 * gate verdict that explained them.
 */
import { describe, expect, it } from 'vitest';
import {
  appendFailureToLedger,
  classifyBuildFailure,
  firstRecordedFailureCode,
  isRetryableBuildFailure,
  readFailureLedger,
  TERMINAL_BUILD_FAILURE_CODES,
  FAILURE_LEDGER_MAX,
} from '../src/failure-policy';

describe('classifyBuildFailure', () => {
  it('calls every gate verdict terminal', () => {
    // The list is imported from the gates themselves, so this walks whatever
    // is in it rather than restating a copy that could drift.
    expect(TERMINAL_BUILD_FAILURE_CODES.size).toBeGreaterThan(8);
    for (const code of TERMINAL_BUILD_FAILURE_CODES) {
      expect(classifyBuildFailure({ error_code: code })).toBe('terminal');
      expect(isRetryableBuildFailure({ error_code: code })).toBe(false);
    }
    // The five that this workspace actually failed on, named out loud.
    for (const code of [
      'PAGE_BUDGET_EXCEEDED',
      'PLACEHOLDER_IMAGE_SHIPPED',
      'GENERATED_HTML_UNSAFE',
      'CHANGE_REQUEST_NOT_APPLIED',
      'INVENTED_PROJECT',
    ]) {
      expect(TERMINAL_BUILD_FAILURE_CODES.has(code)).toBe(true);
    }
  });

  it('calls a lost lease transient, which is what #120 and #136 exist for', () => {
    // A worker died holding this job, or was overtaken and cancelled at its
    // next phase. Nothing was decided about the site either way, and taking
    // the retry away here would undo the durability those two added.
    expect(classifyBuildFailure({ error_code: 'BUILD_LEASE_EXPIRED' })).toBe(
      'transient',
    );
    expect(classifyBuildFailure({ error_code: 'BUILD_LEASE_LOST' })).toBe(
      'transient',
    );
  });

  it('reads the detail only for the codes that say nothing', () => {
    // A generic wrapper means "something threw"; the message is the evidence.
    const transient = [
      'fetch failed: ECONNRESET while installing dependencies',
      'request to https://registry.npmjs.org failed, EAI_AGAIN',
      'socket hang up',
      'the build timed out after 900000ms',
      'docker: Cannot connect to the Docker daemon',
      'the sandbox refused to start',
      'upstream returned 503',
      'this job lost its lease while the agent was running',
    ];
    for (const detail of transient) {
      expect(
        classifyBuildFailure({
          error_code: 'CHANGE_REQUEST_BUILD_FAILED',
          error_detail: detail,
        }),
      ).toBe('transient');
    }

    // The one that started this. Nothing transient about it, and three
    // attempts proved it.
    expect(
      classifyBuildFailure({
        error_code: 'CHANGE_REQUEST_BUILD_FAILED',
        error_detail: 'Commit message is outside the Flowstarter build policy',
      }),
    ).toBe('terminal');
  });

  it('never lets a gate’s wording override a gate’s code', () => {
    // A gate message may contain any word at all. Its code has decided.
    expect(
      classifyBuildFailure({
        error_code: 'PAGE_BUDGET_EXCEEDED',
        error_detail: 'the docker build timed out on a network of 503s',
      }),
    ).toBe('terminal');
  });

  it('defaults to terminal for anything it cannot name', () => {
    // Retryable *only* when the cause is known to be transient. A guess here
    // is spent out of a paying client's build budget.
    expect(classifyBuildFailure({})).toBe('terminal');
    expect(classifyBuildFailure({ error_code: null })).toBe('terminal');
    expect(classifyBuildFailure({ error_code: 'SOMETHING_NEW' })).toBe(
      'terminal',
    );
    expect(
      classifyBuildFailure({
        error_code: 'SOMETHING_NEW',
        error_detail: 'ECONNRESET',
      }),
    ).toBe('terminal');
  });

  it('reads a code however it was written', () => {
    expect(classifyBuildFailure({ error_code: '  build_lease_expired ' })).toBe(
      'transient',
    );
  });
});

describe('the failure ledger', () => {
  const first = {
    attempt: 1,
    code: 'PAGE_BUDGET_EXCEEDED',
    detail: 'added 5 new pages to a site that had 0',
    at: '2026-09-12T20:10:00.000Z',
  };

  it('appends rather than overwrites', () => {
    const payload = { trigger: 'operator_build', failures: [first] };
    const ledger = appendFailureToLedger(payload, {
      attempt: 2,
      code: 'CHANGE_REQUEST_BUILD_FAILED',
      detail: 'Commit message is outside the Flowstarter build policy',
      at: '2026-09-13T22:24:55.000Z',
    });
    expect(ledger.map((entry) => entry.code)).toEqual([
      'PAGE_BUDGET_EXCEEDED',
      'CHANGE_REQUEST_BUILD_FAILED',
    ]);
    // The first verdict is the one that explained the build, and it survives.
    expect(firstRecordedFailureCode({ failures: ledger }, 'ANYTHING')).toBe(
      'PAGE_BUDGET_EXCEEDED',
    );
  });

  it('is the current code when nothing failed before', () => {
    expect(firstRecordedFailureCode({}, 'GENERATED_HTML_UNSAFE')).toBe(
      'GENERATED_HTML_UNSAFE',
    );
    expect(firstRecordedFailureCode(null, 'GENERATED_HTML_UNSAFE')).toBe(
      'GENERATED_HTML_UNSAFE',
    );
  });

  it('survives a payload somebody edited', () => {
    expect(readFailureLedger(null)).toEqual([]);
    expect(readFailureLedger('not an object')).toEqual([]);
    expect(readFailureLedger([first])).toEqual([]);
    expect(readFailureLedger({ failures: 'nope' })).toEqual([]);
    // Entries with no code carry no information and are dropped; the rest are
    // repaired rather than thrown away.
    expect(
      readFailureLedger({
        failures: [{ detail: 'no code' }, { code: 'X' }],
      }),
    ).toEqual([{ attempt: 1, code: 'X', detail: '', at: '' }]);
  });

  it('keeps the most recent attempts and does not grow forever', () => {
    let payload: unknown = {};
    for (let attempt = 1; attempt <= FAILURE_LEDGER_MAX + 3; attempt += 1) {
      payload = {
        failures: appendFailureToLedger(payload, {
          attempt,
          code: `CODE_${attempt}`,
          detail: '',
          at: '',
        }),
      };
    }
    const ledger = readFailureLedger(payload);
    expect(ledger).toHaveLength(FAILURE_LEDGER_MAX);
    expect(ledger.at(-1)?.code).toBe(`CODE_${FAILURE_LEDGER_MAX + 3}`);
  });
});
