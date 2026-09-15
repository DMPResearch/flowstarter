/**
 * `@flowstarter/sigma-flowstarter`'s real `warmSigma()` loads an actual ONNX
 * model from disk (see packages/sigma-core/src/encoder.ts) — not something a
 * unit test should depend on being cached on the machine that runs it. This
 * mocks the package boundary and asserts this module's own contract: never
 * throw, flip `getSigmaHealth()` to 'ready' or 'missing', and say why on a
 * failure. `src/__tests__/instrumentation.test.ts` covers that `register()`
 * actually calls `warmSigmaOrWarn()`; `route.test.ts` under
 * `src/app/api/health/__tests__/` covers that the health endpoint reports
 * whatever this module last recorded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { warmSigmaMock } = vi.hoisted(() => ({ warmSigmaMock: vi.fn() }));

vi.mock('@flowstarter/sigma-flowstarter', () => ({
  warmSigma: warmSigmaMock,
}));

import {
  getSigmaHealth,
  resetSigmaHealthForTests,
  warmSigmaOrWarn,
} from '../warm';

describe('sigma warm-up', () => {
  beforeEach(() => {
    resetSigmaHealthForTests();
    warmSigmaMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to missing before warm-up ever runs', () => {
    expect(getSigmaHealth()).toBe('missing');
  });

  it('reports ready and logs once warm-up succeeds', async () => {
    warmSigmaMock.mockResolvedValue(undefined);
    // process.stdout.write, not console.log: next.config.mjs strips every
    // console.* CALL EXPRESSION in production (compiler.removeConsole) —
    // see this module's own doc comment for why that made the ORIGINAL
    // console.log version of this line invisible in a real deploy's logs.
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await warmSigmaOrWarn();

    expect(warmSigmaMock).toHaveBeenCalledTimes(1);
    expect(getSigmaHealth()).toBe('ready');
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('model ready')
    );
  });

  it('reports missing and warns, without throwing, when the model cache is absent', async () => {
    warmSigmaMock.mockRejectedValue(
      new Error(
        'sigma encoder artifacts are missing under /opt/flowstarter/sigma-model-cache'
      )
    );
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await expect(warmSigmaOrWarn()).resolves.toBeUndefined();

    expect(getSigmaHealth()).toBe('missing');
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('sigma encoder artifacts are missing')
    );
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('fail open to')
    );
  });

  it('reports missing and warns, without throwing, on a non-Error rejection', async () => {
    // Not every failure mode is a thrown Error — a broken native binding can
    // reject with a string or a plain object. The catch must not assume.
    warmSigmaMock.mockRejectedValue(
      'onnxruntime_binding.node: not a valid ELF file'
    );
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await expect(warmSigmaOrWarn()).resolves.toBeUndefined();

    expect(getSigmaHealth()).toBe('missing');
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('not a valid ELF file')
    );
  });

  it('resetSigmaHealthForTests can force an arbitrary state for callers under test', () => {
    resetSigmaHealthForTests('ready');
    expect(getSigmaHealth()).toBe('ready');

    resetSigmaHealthForTests();
    expect(getSigmaHealth()).toBe('missing');
  });
});
