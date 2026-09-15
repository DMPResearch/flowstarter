import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
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
  DEAD_LINK,
  describeDeadLinkIssue,
  findDeadLinkFindings,
} from '../src/flowstarter/dead-link';
import {
  applyPageSetToScaffold,
  derivePageSet,
} from '../src/flowstarter/page-set';
import type { TemplateScaffoldFile } from '../src/flowstarter/types';

const run = promisify(execFile);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const templatesRoot = join(repoRoot, 'apps/flowstarter-templates');

function page(body: string): string {
  return `<!doctype html><html><head><title>Acme</title></head><body>${body}</body></html>`;
}

describe('findDeadLinkFindings', () => {
  test('passes a nav that only links to pages the build produced', () => {
    const files = [
      { path: 'dist/index.html', content: page('<a href="/about">About</a>') },
      { path: 'dist/about/index.html', content: page('<h1>About</h1>') },
    ];
    expect(findDeadLinkFindings(files)).toEqual([]);
  });

  test('flags a link to a page dist/ never emitted', () => {
    const files = [
      {
        path: 'dist/index.html',
        content: page('<a href="/services">Explore our services</a>'),
      },
      { path: 'dist/about/index.html', content: page('<h1>About</h1>') },
    ];
    const findings = findDeadLinkFindings(files);
    expect(findings).toEqual([
      {
        path: 'dist/index.html',
        line: 1,
        href: '/services',
        target: '/services',
      },
    ]);
  });

  test('accepts a trailing slash either way, and the site root', () => {
    const files = [
      {
        path: 'dist/index.html',
        content: page(
          '<a href="/about/">About</a><a href="/about">About again</a><a href="/">Home</a>',
        ),
      },
      { path: 'dist/about/index.html', content: page('<h1>About</h1>') },
    ];
    expect(findDeadLinkFindings(files)).toEqual([]);
  });

  test('reads a flat-format build (about.html, not about/index.html) the same way', () => {
    const files = [
      { path: 'dist/index.html', content: page('<a href="/about">About</a>') },
      { path: 'dist/about.html', content: page('<h1>About</h1>') },
    ];
    expect(findDeadLinkFindings(files)).toEqual([]);
  });

  test('checks case-study detail routes as real pages', () => {
    const files = [
      {
        path: 'dist/work/index.html',
        content: page('<a href="/case-studies/alpha">Alpha</a>'),
      },
      {
        path: 'dist/case-studies/alpha/index.html',
        content: page('<h1>Alpha</h1>'),
      },
    ];
    expect(findDeadLinkFindings(files)).toEqual([]);
  });

  test('flags a sitemap <loc> for a page the build did not produce', () => {
    const files = [
      { path: 'dist/index.html', content: page('<h1>Home</h1>') },
      {
        path: 'dist/sitemap.xml',
        content:
          '<?xml version="1.0"?><urlset>' +
          '<url><loc>https://acme.flowstarter.dev/</loc></url>' +
          '<url><loc>https://acme.flowstarter.dev/blog</loc></url>' +
          '</urlset>',
      },
    ];
    const findings = findDeadLinkFindings(files);
    expect(findings).toEqual([
      {
        path: 'dist/sitemap.xml',
        line: null,
        href: 'https://acme.flowstarter.dev/blog',
        target: '/blog',
      },
    ]);
  });

  test('ignores an anchor, a mailto, a tel and an external origin', () => {
    const files = [
      {
        path: 'dist/index.html',
        content: page(
          '<a href="#top">Top</a>' +
            '<a href="mailto:hi@acme.test">Email</a>' +
            '<a href="tel:+15551234567">Call</a>' +
            '<a href="https://instagram.com/acme">Instagram</a>',
        ),
      },
    ];
    expect(findDeadLinkFindings(files)).toEqual([]);
  });

  test('ignores a link to an asset path, which a text-only file list cannot verify', () => {
    const files = [
      {
        path: 'dist/index.html',
        content: page(
          '<a href="/downloads/brochure.pdf">Brochure</a><a href="/favicon.ico">icon</a>',
        ),
      },
    ];
    expect(findDeadLinkFindings(files)).toEqual([]);
  });

  test('only looks at HTML pages and the sitemap, not scripts or stylesheets', () => {
    const files = [
      {
        path: 'dist/_astro/app.js',
        content: 'const href = "/services"; console.log(href);',
      },
      { path: 'dist/index.html', content: page('<h1>Home</h1>') },
    ];
    expect(findDeadLinkFindings(files)).toEqual([]);
  });

  test('is not tripped up by an <a>-shaped string inside a script or a comment', () => {
    const files = [
      {
        path: 'dist/index.html',
        content: page(
          '<script>const s = \'<a href="/nowhere">x</a>\';</script>' +
            '<!-- <a href="/nowhere-else">x</a> -->',
        ),
      },
    ];
    expect(findDeadLinkFindings(files)).toEqual([]);
  });

  test('reports every dead link across every page, in file order', () => {
    const files = [
      {
        path: 'dist/index.html',
        content: page('<a href="/services">Services</a>'),
      },
      {
        path: 'dist/about/index.html',
        content: page('<a href="/blog">Blog</a>'),
      },
    ];
    const findings = findDeadLinkFindings(files);
    expect(findings.map((f) => f.path)).toEqual([
      'dist/index.html',
      'dist/about/index.html',
    ]);
  });
});

describe('describeDeadLinkIssue', () => {
  test('names the gate, the file and the target, in plain words', () => {
    const message = describeDeadLinkIssue([
      {
        path: 'dist/index.html',
        line: 12,
        href: '/services',
        target: '/services',
      },
    ]);
    expect(message).toContain(DEAD_LINK);
    expect(message).toContain('dist/index.html line 12');
    expect(message).toContain('/services');
  });

  test('truncates a long list and says how many more', () => {
    const findings = Array.from({ length: 20 }, (_, i) => ({
      path: `page-${i}/index.html`,
      line: 1,
      href: '/nowhere',
      target: '/nowhere',
    }));
    const message = describeDeadLinkIssue(findings);
    expect(message).toContain('…and 8 more.');
  });
});

/**
 * The defect this gate exists for only shows up once a real page-set drop
 * has run through the real pruning rewrite and a real `astro build` has
 * compiled the result — a hand-written fixture proves the gate's own logic,
 * not that the fix actually reaches every template. So this reads each real
 * template from disk, derives a page set narrow enough to drop `services`,
 * `blog` and `book`, prunes the scaffold through `applyPageSetToScaffold`
 * exactly as a full-site build does, builds the pruned copy with the real
 * `astro build`, and runs the gate over the real `dist/` it produces.
 *
 * This is also the "removed page yields a 404, not the home page" proof the
 * fix calls for, read from the artifact rather than from a live Caddy: a
 * dropped page's own HTML is provably absent from `dist/`
 * (`servedPagePaths` below), which is what `try_files ... =404` in
 * `site-runtime.Caddyfile` (#165/#166, already covered by
 * `caddy-snippet.test.ts` and the Docker build proof in that PR) answers
 * with a real 404 for — there is no `index.html` left for a fallback to find.
 *
 * Skipped, loudly, for a template with no installed `astro` binary.
 */
describe('a real pruned build links only to pages it kept', () => {
  async function templateDirs(): Promise<string[]> {
    const entries = await readdir(templatesRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(templatesRoot, entry.name))
      .sort();
  }

  test('every template, pruned to drop services/blog/book, builds with no dead links', async () => {
    const dirs = await templateDirs();
    const buildable = dirs.filter((dir) =>
      existsSync(join(dir, 'node_modules/.bin/astro')),
    );
    if (buildable.length === 0) {
      console.warn(
        'no template has an installed astro binary; skipping the real-build ' +
          'dead-link gate check (run `pnpm install` first)',
      );
      return;
    }

    const pageSet = derivePageSet({
      pageCount: 'lt-5',
      businessType: 'Creative & design — a product builder and designer',
      hasBookingLink: false,
    });
    expect(pageSet.dropped).toContain('services');
    expect(pageSet.dropped).toContain('blog');
    expect(pageSet.dropped).toContain('book');

    const workspaces: string[] = [];
    try {
      for (const dir of buildable) {
        const name = dir.slice(templatesRoot.length + 1);

        const scaffold = await readTemplateScaffold(dir);
        const pruned = applyPageSetToScaffold(scaffold, pageSet);

        const workspace = await mkdtemp(
          join(tmpdir(), `dead-link-build-${name}-`),
        );
        workspaces.push(workspace);
        for (const file of pruned.files) {
          const absolute = join(workspace, file.path);
          await mkdir(dirname(absolute), { recursive: true });
          await writeFile(
            absolute,
            file.encoding === 'base64'
              ? Buffer.from(file.content, 'base64')
              : file.content,
          );
        }
        await symlink(
          join(dir, 'node_modules'),
          join(workspace, 'node_modules'),
          'dir',
        );

        // Same isolated Vite cache trick `empty-image.test.ts` and
        // `markup-policy.test.ts` use, for the same reason: parallel
        // `astro build`s over a shared symlinked `node_modules` race on
        // Vite's own dependency-optimizer cache directory otherwise.
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
            if (!/\.html?$/i.test(entry.name) && !/\.xml$/i.test(entry.name))
              continue;
            outputFiles.push({
              path: `dist/${relative(distDir, absolute).split(sep).join('/')}`,
              content: await readFile(absolute, 'utf8'),
            });
          }
        };
        await walk(distDir);
        expect(
          outputFiles.length,
          `${name}: astro build produced no HTML under dist/`,
        ).toBeGreaterThan(0);

        // The dropped pages really are gone — the other half of the fix, and
        // what makes the Caddy `=404` fallback answer for real rather than
        // falling through to a stale index.html.
        const servedPagePaths = outputFiles.map((f) => f.path);
        expect(servedPagePaths).not.toContain('dist/services/index.html');
        expect(servedPagePaths).not.toContain('dist/services.html');
        expect(servedPagePaths).not.toContain('dist/blog/index.html');
        expect(servedPagePaths).not.toContain('dist/blog.html');
        expect(servedPagePaths).not.toContain('dist/book/index.html');
        expect(servedPagePaths).not.toContain('dist/book.html');

        const findings = findDeadLinkFindings(outputFiles);
        const message =
          findings.length > 0
            ? `${name}: ${describeDeadLinkIssue(findings)}`
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

/** Every file under a template directory, read as an in-memory scaffold. */
async function readTemplateScaffold(
  dir: string,
): Promise<TemplateScaffoldFile[]> {
  const files: TemplateScaffoldFile[] = [];
  const skip = new Set(['node_modules', 'dist', '.astro', '.git']);
  const binary = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.ico',
    '.woff',
    '.woff2',
  ]);
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const relPath = relative(dir, absolute).split(sep).join('/');
      const dot = entry.name.lastIndexOf('.');
      const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : '';
      if (binary.has(ext)) {
        const content = await readFile(absolute);
        files.push({
          path: relPath,
          content: content.toString('base64'),
          type: 'file',
          encoding: 'base64',
        });
        continue;
      }
      files.push({
        path: relPath,
        content: await readFile(absolute, 'utf8'),
        type: 'file',
      });
    }
  };
  await walk(dir);
  return files;
}
