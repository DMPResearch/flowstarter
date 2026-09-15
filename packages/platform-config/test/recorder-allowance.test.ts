import { describe, expect, it } from 'vitest';

import {
  RECORDER_HEADER_NAME,
  RECORDER_SECRET_ENV,
  isRecorderRequestAllowed,
  readRecorderAllowanceEnvFromProcess,
  type RecorderAllowanceEnvInput,
} from '../src/recorder-allowance';

const SECRET = 'a'.repeat(64); // shape of `openssl rand -hex 32`

const STAGING: RecorderAllowanceEnvInput = {
  flowstarterEnv: 'staging',
  recorderSecret: SECRET,
};

const DEVELOPMENT: RecorderAllowanceEnvInput = {
  flowstarterEnv: 'development',
  recorderSecret: SECRET,
};

const PRODUCTION: RecorderAllowanceEnvInput = {
  flowstarterEnv: 'production',
  recorderSecret: SECRET,
};

describe('isRecorderRequestAllowed', () => {
  it('header absent: existing behaviour, request is not allowed through this rule', async () => {
    expect(await isRecorderRequestAllowed(null, STAGING)).toBe(false);
    expect(await isRecorderRequestAllowed(undefined, STAGING)).toBe(false);
    expect(await isRecorderRequestAllowed('', STAGING)).toBe(false);
  });

  it('header present with the wrong value: refused', async () => {
    expect(await isRecorderRequestAllowed('not-the-secret', STAGING)).toBe(
      false,
    );
    // Same length as the real secret, still wrong.
    expect(await isRecorderRequestAllowed('b'.repeat(64), STAGING)).toBe(false);
  });

  it('correct value on staging: allowed', async () => {
    expect(await isRecorderRequestAllowed(SECRET, STAGING)).toBe(true);
  });

  it('correct value in development: allowed (not production)', async () => {
    expect(await isRecorderRequestAllowed(SECRET, DEVELOPMENT)).toBe(true);
  });

  it('correct value with FLOWSTARTER_ENV=production: refused regardless of the header', async () => {
    expect(await isRecorderRequestAllowed(SECRET, PRODUCTION)).toBe(false);
  });

  it('no secret configured: refused even with a header, e.g. prod.env never setting it', async () => {
    const noSecret: RecorderAllowanceEnvInput = {
      flowstarterEnv: 'staging',
      recorderSecret: undefined,
    };
    expect(await isRecorderRequestAllowed(SECRET, noSecret)).toBe(false);
    expect(await isRecorderRequestAllowed('anything', noSecret)).toBe(false);
  });

  it('production wins even if a secret is somehow present in a prod env file', async () => {
    expect(await isRecorderRequestAllowed(SECRET, PRODUCTION)).toBe(false);
  });
});

describe('readRecorderAllowanceEnvFromProcess', () => {
  it('reads FLOWSTARTER_ENV and FLOWSTARTER_RECORDER_SECRET from the given source', () => {
    const env = readRecorderAllowanceEnvFromProcess({
      FLOWSTARTER_ENV: 'staging',
      [RECORDER_SECRET_ENV]: SECRET,
    });
    expect(env).toEqual({ flowstarterEnv: 'staging', recorderSecret: SECRET });
  });

  it('treats an empty-string secret as unset', () => {
    const env = readRecorderAllowanceEnvFromProcess({
      FLOWSTARTER_ENV: 'staging',
      [RECORDER_SECRET_ENV]: '',
    });
    expect(env.recorderSecret).toBeUndefined();
  });

  it('returns undefined fields when nothing is set', () => {
    expect(readRecorderAllowanceEnvFromProcess({})).toEqual({
      flowstarterEnv: undefined,
      recorderSecret: undefined,
    });
  });
});

describe('RECORDER_HEADER_NAME', () => {
  it('is the lowercase header name the recorder sends', () => {
    expect(RECORDER_HEADER_NAME).toBe('x-flowstarter-recorder');
  });
});
