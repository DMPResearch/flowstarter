import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandSiteValidator,
  NoopSiteValidator,
  SiteValidationError,
  VALIDATOR_OUTPUT_LINES,
} from '../src/validator';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function siteWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'flowstarter-validator-'));
  temporaryDirectories.push(root);
  await writeFile(join(root, 'package.json'), '{"name":"site"}', 'utf8');
  await mkdir(join(root, 'src'), { recursive: true });
  return root;
}

/** Stands in for `pnpm run build`: writes the dist/ output the gate requires. */
const BUILD_OK = {
  bin: 'node',
  args: ['-e', 'require("node:fs").mkdirSync("dist",{recursive:true})'],
};

describe('NoopSiteValidator', () => {
  it('passes without a package manifest or dist output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowstarter-noop-validator-'));
    temporaryDirectories.push(root);
    const validator = new NoopSiteValidator();
    await expect(validator.validate(root, 'full')).resolves.toBeUndefined();
    await expect(validator.validate(root, 'preview')).resolves.toBeUndefined();
  });
});

describe('CommandSiteValidator', () => {
  it('passes a site that installs, builds and emits output', async () => {
    const root = await siteWorkspace();
    const validator = new CommandSiteValidator({
      commands: [BUILD_OK],
      timeoutMs: 30_000,
    });
    await expect(validator.validate(root, 'full')).resolves.toBeUndefined();
  });

  it('fails the job when a build command exits non-zero', async () => {
    const root = await siteWorkspace();
    const validator = new CommandSiteValidator({
      commands: [
        {
          bin: 'node',
          args: ['-e', 'console.error("build broke");process.exit(1)'],
        },
      ],
      timeoutMs: 30_000,
    });
    await expect(validator.validate(root, 'full')).rejects.toThrow(
      /build broke/,
    );
  });

  it('fails when the commands succeed but produce no output directory', async () => {
    const root = await siteWorkspace();
    const validator = new CommandSiteValidator({
      commands: [{ bin: 'node', args: ['-e', '0'] }],
      timeoutMs: 30_000,
    });
    await expect(validator.validate(root, 'full')).rejects.toThrow(
      /no dist\/ output directory/,
    );
  });

  it('refuses a workspace missing its manifest or sources before running anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowstarter-validator-'));
    temporaryDirectories.push(root);
    const validator = new CommandSiteValidator({
      commands: [{ bin: 'node', args: ['-e', 'process.exit(1)'] }],
      timeoutMs: 30_000,
    });
    await expect(validator.validate(root, 'full')).rejects.toThrow(
      /no package manifest/,
    );
  });

  it('is not the preview gate and says so rather than silently passing', async () => {
    const root = await siteWorkspace();
    const validator = new CommandSiteValidator({
      commands: [BUILD_OK],
      timeoutMs: 30_000,
    });
    await expect(validator.validate(root, 'preview')).rejects.toThrow(
      SiteValidationError,
    );
  });

  it('kills a command that hangs past the build timeout', async () => {
    const root = await siteWorkspace();
    const validator = new CommandSiteValidator({
      commands: [{ bin: 'node', args: ['-e', 'setTimeout(()=>{},60000)'] }],
      timeoutMs: 1_000,
    });
    await expect(validator.validate(root, 'full')).rejects.toThrow(/timed out/);
  });

  it('refuses a workspace that has a manifest but no source directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowstarter-validator-'));
    temporaryDirectories.push(root);
    await writeFile(join(root, 'package.json'), '{"name":"site"}', 'utf8');
    const validator = new CommandSiteValidator({
      commands: [{ bin: 'node', args: ['-e', 'process.exit(1)'] }],
      timeoutMs: 30_000,
    });
    await expect(validator.validate(root, 'full')).rejects.toThrow(
      /no source directory/,
    );
  });

  it('fails on stdout alone when a command exits non-zero without writing to stderr', async () => {
    const root = await siteWorkspace();
    const validator = new CommandSiteValidator({
      commands: [
        {
          bin: 'node',
          args: ['-e', 'console.log("only stdout, no stderr");process.exit(1)'],
        },
      ],
      timeoutMs: 30_000,
    });
    await expect(validator.validate(root, 'full')).rejects.toThrow(
      /only stdout, no stderr/,
    );
  });

  it('reports a spawn failure (missing binary) through the message fallback, not a crash', async () => {
    const root = await siteWorkspace();
    const validator = new CommandSiteValidator({
      commands: [
        { bin: 'flowstarter-command-that-does-not-exist-anywhere', args: [] },
      ],
      timeoutMs: 30_000,
    });
    // Neither stdout nor stderr exist on a spawn failure, so tailLines() and
    // the error detail both have to fall all the way back to error.message
    // rather than throwing on `undefined`.
    await expect(validator.validate(root, 'full')).rejects.toThrow(
      SiteValidationError,
    );
  });
});

/**
 * Whatever the build printed is the most useful thing in a build log, and
 * until now it only existed in a lost child-process buffer. These prove it
 * reaches the caller on both paths, bounded, so a chatty build cannot flood
 * the record it is written to.
 */
describe('CommandSiteValidator command output', () => {
  it('forwards what a passing command printed', async () => {
    const root = await siteWorkspace();
    const output: Array<{ command: string; lines: string[] }> = [];
    const validator = new CommandSiteValidator({
      commands: [
        {
          bin: 'node',
          args: [
            '-e',
            'console.log("building the site");console.error("1 hint");' +
              'require("node:fs").mkdirSync("dist",{recursive:true})',
          ],
        },
      ],
      timeoutMs: 30_000,
      onOutput: (command, lines) => output.push({ command, lines }),
    });

    await validator.validate(root, 'full');

    expect(output).toHaveLength(1);
    expect(output[0]?.command).toContain('node');
    expect(output[0]?.lines).toEqual(['building the site', '1 hint']);
  });

  it('forwards what a failing command printed, before it throws', async () => {
    const root = await siteWorkspace();
    const output: string[][] = [];
    const validator = new CommandSiteValidator({
      commands: [
        {
          bin: 'node',
          args: [
            '-e',
            'console.log("step one");console.error("PhoneField.astro:22:1 broken");' +
              'process.exit(1)',
          ],
        },
      ],
      timeoutMs: 30_000,
      onOutput: (_command, lines) => output.push(lines),
    });

    await expect(validator.validate(root, 'full')).rejects.toThrow(
      SiteValidationError,
    );
    expect(output).toHaveLength(1);
    expect(output[0]).toEqual(['step one', 'PhoneField.astro:22:1 broken']);
  });

  it('keeps only the last 200 lines of a chatty command', async () => {
    const root = await siteWorkspace();
    let forwarded: string[] = [];
    const validator = new CommandSiteValidator({
      commands: [
        {
          bin: 'node',
          args: [
            '-e',
            'for(let i=0;i<1000;i++)console.log("line "+i);' +
              'require("node:fs").mkdirSync("dist",{recursive:true})',
          ],
        },
      ],
      timeoutMs: 30_000,
      onOutput: (_command, lines) => (forwarded = lines),
    });

    await validator.validate(root, 'full');

    expect(forwarded).toHaveLength(VALIDATOR_OUTPUT_LINES);
    expect(forwarded[0]).toBe('line 800');
    expect(forwarded.at(-1)).toBe('line 999');
  });
});
