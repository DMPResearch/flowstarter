/**
 * The package manager's configuration, as a boundary the coding agent cannot
 * cross.
 *
 * The rule this replaced denied `package.json` and anything with "lock" in its
 * name. That left `.pnpmfile.cjs`, `.npmrc` and `pnpm-workspace.yaml` writable
 * by an agent — three files `pnpm install` reads before a line of the site is
 * compiled, in the one step that is allowed outbound network. A pnpmfile in
 * particular is plain Node code that pnpm loads during resolution, and
 * `--ignore-scripts` has nothing to say about it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPackageManagerConfigPath } from '../src/flowstarter/pi-sdk';

describe('isPackageManagerConfigPath', () => {
  it('denies every file a package manager reads before it installs', () => {
    for (const path of [
      '.pnpmfile.cjs',
      '.pnpmfile.js',
      '.pnpmfile.mjs',
      '.npmrc',
      'pnpm-workspace.yaml',
      'pnpm-workspace.yml',
      'package.json',
      'pnpm-lock.yaml',
      'package-lock.json',
      'npm-shrinkwrap.json',
      'yarn.lock',
      'bun.lockb',
      '.yarnrc',
      '.yarnrc.yml',
      'bunfig.toml',
    ]) {
      expect(isPackageManagerConfigPath(path), path).toBe(true);
    }
  });

  it('denies one in any directory, because pnpm reads one per package', () => {
    expect(isPackageManagerConfigPath('src/content/.npmrc')).toBe(true);
    expect(isPackageManagerConfigPath('packages/theme/.pnpmfile.cjs')).toBe(
      true,
    );
    expect(isPackageManagerConfigPath('nested/deep/package.json')).toBe(true);
    // The package manager's own directories, which hold code it executes.
    expect(isPackageManagerConfigPath('.yarn/releases/yarn.cjs')).toBe(true);
    expect(isPackageManagerConfigPath('.pnpm/anything')).toBe(true);
  });

  it('denies the same names in whatever case the filesystem accepted', () => {
    // macOS and Windows will happily hand pnpm the file an agent wrote as
    // `.NPMRC`, and both are case-insensitive about finding it.
    expect(isPackageManagerConfigPath('.NPMRC')).toBe(true);
    expect(isPackageManagerConfigPath('src/.PnpmFile.CJS')).toBe(true);
    expect(isPackageManagerConfigPath('PNPM-WORKSPACE.YAML')).toBe(true);
  });

  it('leaves the site itself alone', () => {
    for (const path of [
      'src/pages/index.astro',
      'src/content/site.md',
      'src/styles/tokens.css',
      'public/flowstarter-assets/portrait.jpg',
      // Not a manifest: a page about the client's packaging service.
      'src/content/packages.md',
      'src/data/npmrc-explained.md',
    ]) {
      expect(isPackageManagerConfigPath(path), path).toBe(false);
    }
  });

  it('is the rule the write tool actually asks', () => {
    // The boundary is only worth anything if the tool calls it, and a unit
    // test of an unexported `assertMutableAgentPath` cannot say so. This
    // asserts the wiring against the source it protects.
    const source = readFileSync(
      join(__dirname, '../src/flowstarter/pi-sdk.ts'),
      'utf8',
    );
    expect(source).toContain('isPackageManagerConfigPath(normalized)');
    expect(
      source.match(/assertMutableAgentPath\(params\.path, mode\)/g),
    ).toHaveLength(2);
  });
});
