import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import {
  describeEmptyImageIssue,
  EMPTY_IMAGE_SHIPPED,
  findEmptyImageFindings,
  findEmptyImagesInHtml,
} from '../src/flowstarter/empty-image';

const run = promisify(execFile);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const templatesRoot = join(repoRoot, 'apps/flowstarter-templates');

function page(body: string): string {
  return `<!doctype html><html><head><title>Acme</title></head><body>${body}</body></html>`;
}

describe('findEmptyImagesInHtml', () => {
  test('flags an <img> with an empty src', () => {
    const findings = findEmptyImagesInHtml(
      'about/index.html',
      page('<img src="" alt="Founder portrait">'),
    );
    expect(findings).toEqual([
      {
        path: 'about/index.html',
        line: 1,
        reason: 'blank',
        alt: 'Founder portrait',
      },
    ]);
  });

  test('flags an <img> with a whitespace-only src', () => {
    const findings = findEmptyImagesInHtml(
      'index.html',
      page('<img src="   " alt="">'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toBe('blank');
  });

  test('flags an <img> with no src attribute at all', () => {
    const findings = findEmptyImagesInHtml(
      'index.html',
      page('<img alt="No src">'),
    );
    expect(findings).toEqual([
      { path: 'index.html', line: 1, reason: 'missing', alt: 'No src' },
    ]);
  });

  test('passes an <img> with a real src', () => {
    expect(
      findEmptyImagesInHtml(
        'index.html',
        page('<img src="/images/x.png" alt="">'),
      ),
    ).toEqual([]);
  });

  test('passes a same-origin relative src and a data: image', () => {
    expect(
      findEmptyImagesInHtml('index.html', page('<img src="/_astro/a.png">')),
    ).toEqual([]);
    expect(
      findEmptyImagesInHtml(
        'index.html',
        page('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">'),
      ),
    ).toEqual([]);
  });

  test('is not tripped up by an <img>-shaped string inside a script or a comment', () => {
    expect(
      findEmptyImagesInHtml(
        'index.html',
        page('<!-- <img src=""> --><script>var s = "<img src=\'\'>";</script>'),
      ),
    ).toEqual([]);
  });

  test('never matches on srcset or a data-src lazy-load placeholder', () => {
    expect(
      findEmptyImagesInHtml(
        'index.html',
        page('<img src="/images/x.png" srcset="" data-src="">'),
      ),
    ).toEqual([]);
  });
});

describe('findEmptyImageFindings', () => {
  test('only looks at HTML files', () => {
    const findings = findEmptyImageFindings([
      { path: 'index.html', content: page('<img src="">') },
      { path: '_astro/page.js', content: 'document.write(\'<img src="">\');' },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe('index.html');
  });

  test('collects findings across every page', () => {
    const findings = findEmptyImageFindings([
      { path: 'about/index.html', content: page('<img src="" alt="Founder">') },
      {
        path: 'work/index.html',
        content: page('<img src="/images/cover.png">'),
      },
      { path: 'services/index.html', content: page('<img alt="Hero">') },
    ]);
    expect(findings.map((f) => f.path)).toEqual([
      'about/index.html',
      'services/index.html',
    ]);
  });
});

describe('describeEmptyImageIssue', () => {
  test('names the gate, the file and the reason, in plain words', () => {
    const message = describeEmptyImageIssue([
      {
        path: 'about/index.html',
        line: 12,
        reason: 'blank',
        alt: 'Founder portrait',
      },
    ]);
    expect(message).toContain(EMPTY_IMAGE_SHIPPED);
    expect(message).toContain('about/index.html line 12');
    expect(message).toContain('empty src');
    expect(message).toContain('Founder portrait');
    // Plain words: no gate jargon like "reason: blank" leaking into the text.
    expect(message).not.toContain('reason:');
  });

  test('names a missing src distinctly from a blank one', () => {
    const message = describeEmptyImageIssue([
      { path: 'index.html', line: null, reason: 'missing', alt: null },
    ]);
    expect(message).toContain('no src attribute at all');
  });

  test('truncates a long list and says how many more', () => {
    const findings = Array.from({ length: 20 }, (_, i) => ({
      path: `page-${i}/index.html`,
      line: 1,
      reason: 'blank' as const,
      alt: null,
    }));
    const message = describeEmptyImageIssue(findings);
    expect(message).toContain('…and 8 more.');
  });
});

/**
 * Every other assertion in this file is made over a fixture string. That is
 * worth having and it is not enough: the defect this gate exists for
 * (`AboutStory.astro` and its siblings rendering `<img src="">` once the
 * seed cleaner blanks a gated placeholder — see `seed-placeholders.ts`)
 * only shows up once Astro has actually compiled the template, because the
 * bug is in what a component decides to render, not in a string a test
 * wrote by hand. So this copies every real template, blanks every
 * `imageSrc:` the same way the seed cleaner does (`imageSrc: ""`, never a
 * deleted key), runs the real `astro build`, and runs the gate over the
 * real `dist/` it produces.
 *
 * Skipped, loudly, for a template with no installed `astro` binary — a
 * developer who has not run `pnpm install` should get a skip with a reason,
 * not a failure about a missing binary.
 */
describe('a real build with every photo slot empty', () => {
  async function templateDirs(): Promise<string[]> {
    const entries = await readdir(templatesRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(templatesRoot, entry.name))
      .sort();
  }

  test('passes EMPTY_IMAGE_SHIPPED for every template with no client photo', async () => {
    const dirs = await templateDirs();
    const buildable = dirs.filter((dir) =>
      existsSync(join(dir, 'node_modules/.bin/astro')),
    );
    if (buildable.length === 0) {
      console.warn(
        'no template has an installed astro binary; skipping the real-build ' +
          'empty-image gate check (run `pnpm install` first)',
      );
      return;
    }

    const workspaces: string[] = [];
    try {
      for (const dir of buildable) {
        const name = dir.slice(templatesRoot.length + 1);
        const workspace = await mkdtemp(
          join(tmpdir(), `empty-image-build-${name}-`),
        );
        workspaces.push(workspace);
        await cp(dir, workspace, {
          recursive: true,
          filter: (source) =>
            !source.includes(`${dir}${sep}node_modules`) &&
            !source.includes(`${dir}${sep}dist`) &&
            !source.includes(`${dir}${sep}.astro`),
        });
        await symlink(
          join(dir, 'node_modules'),
          join(workspace, 'node_modules'),
          'dir',
        );

        // The same end-state `sanitiseSeedPlaceholders` leaves behind: every
        // `imageSrc:` value blanked to `""`, never a deleted key — a brief
        // with no client photo at all, the worst case for this gate.
        const labelsPath = join(workspace, 'src/content/site-labels.md');
        const labels = await readFile(labelsPath, 'utf8').catch(() => null);
        if (labels) {
          const blanked = labels.replace(
            /imageSrc:\s*"[^"]*"/g,
            'imageSrc: ""',
          );
          await writeFile(labelsPath, blanked);
        }

        // `node_modules` is a symlink to the real, *shared* template
        // directory — cheap, but it means Vite's own dependency-optimizer
        // cache (`node_modules/.vite`) is shared too. `markup-policy.test.ts`
        // runs this same real-build shape over the same templates, and two
        // `astro build`s racing to write that one shared cache directory at
        // once produce an `ENOTEMPTY` from Vite's own temp-dir rename — a
        // false failure with nothing wrong in either build. Pointing this
        // build's cache at a directory unique to this workspace removes the
        // only thing the two runs actually shared.
        // Astro's `--config` resolves relative to `cwd` — an absolute path
        // here is reported "does not exist" even though it does, so the
        // config file name (not its full path) is what gets passed below.
        const configOverrideName = 'flowstarter-test-astro.config.mjs';
        await writeFile(
          join(workspace, configOverrideName),
          "import { mergeConfig } from 'astro/config';\n" +
            "import base from './astro.config.mjs';\n" +
            `export default mergeConfig(base, { vite: { cacheDir: ${JSON.stringify(join(workspace, '.vite-cache'))} } });\n`,
          'utf8',
        );

        await run(
          join(dir, 'node_modules/.bin/astro'),
          ['build', '--config', configOverrideName],
          { cwd: workspace },
        );

        const distDir = join(workspace, 'dist');
        const outputFiles: Array<{ path: string; content: string }> = [];
        const walk = async (current: string): Promise<void> => {
          const entries = await readdir(current, { withFileTypes: true });
          for (const entry of entries) {
            const absolute = join(current, entry.name);
            if (entry.isDirectory()) {
              await walk(absolute);
              continue;
            }
            if (!/\.html?$/i.test(entry.name)) continue;
            outputFiles.push({
              path: relative(distDir, absolute).split(sep).join('/'),
              content: await readFile(absolute, 'utf8'),
            });
          }
        };
        await walk(distDir);
        expect(
          outputFiles.length,
          `${name}: astro build produced no HTML under dist/`,
        ).toBeGreaterThan(0);

        const findings = findEmptyImageFindings(outputFiles);
        const message =
          findings.length > 0
            ? `${name}: ${describeEmptyImageIssue(findings)}`
            : name;
        expect(findings, message).toEqual([]);
      }
    } finally {
      await Promise.all(
        workspaces.map((workspace) =>
          rm(workspace, { recursive: true, force: true }),
        ),
      );
    }
  }, 300_000);
});
