/**
 * MVP readiness review, "Build and delivery": "The `dev:local` build worker
 * script hardcodes the stub agent. It swaps the real validator for a no-op
 * globally, not just for the Pi session... The script is still unfixed."
 *
 * The validator half of that was already correctly decoupled in
 * `src/config.ts` (`FLOWSTARTER_BUILD_SKIP_VALIDATION` is the only thing
 * that can swap in `NoopSiteValidator`, never the stub flag — see
 * `config-local.test.ts`). This is the other half: the script itself must
 * not force the stub on every run. `FLOWSTARTER_BUILD_STUB_AGENT=true` has
 * to come from the developer's own shell or `.env.local`, never from
 * `package.json`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };

describe('package.json "dev:local" script', () => {
  it('never hardcodes FLOWSTARTER_BUILD_STUB_AGENT — it must be opt-in only', () => {
    expect(pkg.scripts['dev:local']).not.toMatch(
      /FLOWSTARTER_BUILD_STUB_AGENT/,
    );
  });

  it('still sets FLOWSTARTER_BUILD_MODE=local, which the stub gate itself requires', () => {
    expect(pkg.scripts['dev:local']).toMatch(/FLOWSTARTER_BUILD_MODE=local\b/);
  });

  it('no script in this package sets FLOWSTARTER_BUILD_SKIP_VALIDATION', () => {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      expect(
        command,
        `script "${name}" must not force-skip validation`,
      ).not.toMatch(/FLOWSTARTER_BUILD_SKIP_VALIDATION/);
    }
  });
});
