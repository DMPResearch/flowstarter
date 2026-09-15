/**
 * The OPERATOR_EDIT_BUILD contract: what the worker will accept off an
 * untrusted payload, what it commits, and what it tells a client afterwards.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILD_COMMIT_SUBJECTS,
  buildCommitMessage,
  isFlowstarterBuildCommitMessage,
} from '../src/flowstarter/worktree';
import {
  OPERATOR_EDIT_INVALID_STATE,
  OPERATOR_EDIT_MANIFEST_MISSING,
  OPERATOR_EDIT_NOTE_MAX,
  OPERATOR_EDIT_VERSION_SUMMARY,
  operatorEditCreatedBy,
  operatorEditSummary,
  parseOperatorEditIntent,
} from '../src/flowstarter/operator-edit-build';
import { subjectForFailureCode } from '../src/flowstarter/activity/friendly-names';

const SESSION = 'bb0ce0b6-2f22-4c2c-9a5a-1111aaaa2222';
const PROJECT = '2f2c9a10-0c4b-4a9e-9b9c-7e9b6f0a1111';

const payload = (overrides: Record<string, unknown> = {}) => ({
  trigger: 'operator_editor_ship',
  operatorEdit: {
    sessionId: SESSION,
    operatorId: 'user_operator',
    baseVersion: 4,
    commitSha: 'AbC1234def',
    note: 'added the pricing page',
    ...overrides,
  },
});

describe('parseOperatorEditIntent', () => {
  it('reads a well-formed payload', () => {
    const intent = parseOperatorEditIntent(payload());
    expect(intent).toEqual({
      sessionId: SESSION,
      operatorId: 'user_operator',
      baseVersion: 4,
      commitSha: 'abc1234def',
      note: 'added the pricing page',
    });
  });

  it('refuses a payload that names no session', () => {
    // The whole point: a job that cannot name its session must fail loudly
    // rather than publish whatever manifest it happens to find.
    expect(parseOperatorEditIntent(null)).toBeNull();
    expect(parseOperatorEditIntent('nope')).toBeNull();
    expect(parseOperatorEditIntent([])).toBeNull();
    expect(parseOperatorEditIntent({})).toBeNull();
    expect(parseOperatorEditIntent({ operatorEdit: 'x' })).toBeNull();
    expect(parseOperatorEditIntent({ operatorEdit: [] })).toBeNull();
    expect(parseOperatorEditIntent(payload({ sessionId: 'not-a-uuid' }))).toBeNull();
    expect(parseOperatorEditIntent(payload({ sessionId: 42 }))).toBeNull();
    expect(parseOperatorEditIntent(payload({ operatorId: '' }))).toBeNull();
    expect(parseOperatorEditIntent(payload({ operatorId: 7 }))).toBeNull();
  });

  it('drops a commit sha that is not one, rather than carrying it', () => {
    expect(parseOperatorEditIntent(payload({ commitSha: 'zz;rm -rf /' }))!.commitSha)
      .toBeNull();
    expect(parseOperatorEditIntent(payload({ commitSha: '' }))!.commitSha).toBeNull();
    expect(parseOperatorEditIntent(payload({ commitSha: 123 }))!.commitSha).toBeNull();
  });

  it('treats a missing or nonsense base version as 0', () => {
    expect(parseOperatorEditIntent(payload({ baseVersion: undefined }))!.baseVersion).toBe(0);
    expect(parseOperatorEditIntent(payload({ baseVersion: -3 }))!.baseVersion).toBe(0);
    expect(parseOperatorEditIntent(payload({ baseVersion: 1.5 }))!.baseVersion).toBe(0);
    expect(parseOperatorEditIntent(payload({ baseVersion: 'four' }))!.baseVersion).toBe(0);
  });

  it('caps the operator note instead of carrying whatever was typed', () => {
    const intent = parseOperatorEditIntent(payload({ note: 'x'.repeat(5_000) }))!;
    expect(intent.note!.length).toBe(OPERATOR_EDIT_NOTE_MAX);
    expect(parseOperatorEditIntent(payload({ note: '   ' }))!.note).toBeNull();
    expect(parseOperatorEditIntent(payload({ note: 9 }))!.note).toBeNull();
  });
});

describe('the commit policy', () => {
  it('knows the operator kind, so a ship cannot die at the last step', () => {
    // The defect #146 paid for: a kind the emitter wrote and the policy did
    // not know, discovered after gates had passed and a version was saved.
    const message = buildCommitMessage('OPERATOR_EDIT_BUILD', PROJECT);
    expect(message).toBe(
      `build: ship operator editor session to site ${PROJECT}`
    );
    expect(isFlowstarterBuildCommitMessage(message)).toBe(true);
  });

  it('carries no text a person typed', () => {
    expect(BUILD_COMMIT_SUBJECTS.OPERATOR_EDIT_BUILD).not.toMatch(/\{|\$|%s/);
    expect(
      isFlowstarterBuildCommitMessage(
        `build: ship operator editor session to site ${PROJECT} and also drop the db`
      )
    ).toBe(false);
  });

  it('refuses a project id that is not canonical', () => {
    expect(() => buildCommitMessage('OPERATOR_EDIT_BUILD', 'nope')).toThrow(
      /canonical UUID/
    );
  });
});

describe('what a client and an operator are told', () => {
  it('summarises the session without quoting the operator', () => {
    const intent = parseOperatorEditIntent(payload())!;
    const summary = operatorEditSummary(intent);
    expect(summary).toContain(SESSION);
    expect(summary).toContain('version 4');
    expect(summary).toContain('abc1234def');
    expect(summary).toContain('No agent runs here');
    // The note is printed separately by the caller, never folded into a
    // sentence the product speaks in its own voice.
    expect(summary).not.toContain('added the pricing page');
  });

  it('says "the site as it was delivered" for a workspace with no version', () => {
    const intent = parseOperatorEditIntent(
      payload({ baseVersion: 0, commitSha: null })
    )!;
    const summary = operatorEditSummary(intent);
    expect(summary).toContain('the site as it was delivered');
    expect(summary).not.toContain('committed it as');
  });

  it('tells the client the team did it, and names nobody', () => {
    expect(OPERATOR_EDIT_VERSION_SUMMARY).toBe(
      'Change made by the Flowstarter team'
    );
    expect(OPERATOR_EDIT_VERSION_SUMMARY).not.toMatch(/user_|operator/i);
  });

  it('stamps the version with the job that wrote it, so a rollback can find its own', () => {
    expect(operatorEditCreatedBy('job-1')).toBe(
      'system:operator_edit_build:job-1'
    );
  });
});

describe('failure codes reach the plain-words layer', () => {
  it('maps every operator-edit code to a gate subject rather than falling through blind', () => {
    expect(subjectForFailureCode('OPERATOR_EDIT_BUILD_FAILED')).toBe('gate.build');
    expect(subjectForFailureCode(OPERATOR_EDIT_MANIFEST_MISSING)).toBe('gate.other');
    expect(subjectForFailureCode(OPERATOR_EDIT_INVALID_STATE)).toBe('gate.other');
    // The gates the operator path actually runs, each with words of its own.
    expect(subjectForFailureCode('PLACEHOLDER_COPY_SHIPPED')).toBe('gate.copy');
    expect(subjectForFailureCode('PLACEHOLDER_IMAGE_SHIPPED')).toBe('gate.images');
    expect(subjectForFailureCode('EMPTY_IMAGE_SHIPPED')).toBe('gate.images');
    expect(subjectForFailureCode('GENERATED_HTML_UNSAFE')).toBe('gate.markup');
  });
});
