/**
 * `next.config.mjs`'s `compiler.removeConsole` strips `console.*` calls from
 * production bundles. Left at its blanket default (`true` in production) it
 * strips every sigma, acceptable-use, scope and policy decision log
 * (`console.warn`/`console.error` lines like `[scope] classification failed
 * ...`, `[sigma] ...`, `[policy] ...`) too, leaving an operator with nothing
 * but the boot line to read on staging or prod. `warn` and `error` must stay,
 * since that is the level every decision log in `src/lib/policy`,
 * `src/lib/ai/classify-scope*.ts` and `src/lib/sigma` is written at.
 *
 * `next.config.mjs` isn't imported directly (it's ESM config evaluated by
 * webpack's own require, not something vitest wants to load as a module), so
 * this reads the object literal out of the file's own source, which is
 * enough to pin the shape here without building anything.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CONFIG_PATH = path.resolve(__dirname, '../../next.config.mjs');
const source = readFileSync(CONFIG_PATH, 'utf8');

describe('next.config.mjs compiler.removeConsole', () => {
  it('never sets removeConsole to a bare boolean', () => {
    // A bare `true` (or `process.env.NODE_ENV === 'production'` with nothing
    // else) strips every console call, warn and error included. Any bare
    // boolean expression assigned straight to `removeConsole` is the bug.
    expect(source).toMatch(/removeConsole:\s*\n?\s*process\.env\.NODE_ENV/);
    expect(source).not.toMatch(
      /removeConsole:\s*process\.env\.NODE_ENV === 'production',/
    );
  });

  it('excludes error and warn from console removal', () => {
    expect(source).toMatch(/exclude:\s*\[\s*'error',\s*'warn'\s*\]/);
  });

  it('keeps the exclusion inside the production branch, not unconditionally', () => {
    // Dev already keeps every console call (no minification pass runs on
    // `next dev`); this only has to prove production is not still a bare
    // `true`/`false` toggle.
    const removeConsoleBlock = source.slice(
      source.indexOf('compiler:'),
      source.indexOf('allowedDevOrigins:')
    );
    expect(removeConsoleBlock).toContain(
      "process.env.NODE_ENV === 'production'"
    );
    expect(removeConsoleBlock).toContain("exclude: ['error', 'warn']");
  });
});
