/**
 * Renders every email template to disk so a person can look at it.
 *
 * An email is the one surface in this product with no dev server, no hot
 * reload and no way to check a change short of sending yourself a copy. So
 * this is the check: fixtures through the real templates, HTML on disk, and
 * optionally two screenshots per template, light and dark, at the width a
 * phone gives an email.
 *
 *   node scripts/render-email-previews.mjs               # HTML only
 *   node scripts/render-email-previews.mjs --screenshots # + Chrome shots
 *
 * The templates are TypeScript with path aliases, so esbuild bundles them to
 * one ESM file in a temp directory first. `EMAIL_ASSET_BASE_URL` points the
 * wordmark at the local `public/` tree, because the hosted one is not up yet
 * when you are looking at a change to it.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const outDir = path.join(appRoot, '.email-previews');
const shotDir = '/tmp/fs-email';

process.env.EMAIL_ASSET_BASE_URL = pathToFileURL(
  path.join(appRoot, 'public')
).href;

/**
 * Bundles the fixtures (and, through them, the templates) so plain node can
 * import them. The fixtures live in `__tests__` because they are invented
 * data; sharing them means the browser preview and the assertions cannot
 * disagree.
 */
async function loadFixtures() {
  const tmp = path.join(os.tmpdir(), `fs-email-bundle-${process.pid}.mjs`);
  await build({
    entryPoints: [
      path.join(
        appRoot,
        'src/lib/email-templates/__tests__/preview-fixtures.ts'
      ),
    ],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: tmp,
    logLevel: 'error',
  });
  return import(pathToFileURL(tmp).href);
}

async function screenshot(entries) {
  const { chromium } = await import('playwright');
  // The bundled Chromium download stalls on this machine; the installed
  // Chrome is what the design gallery screenshots use too.
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    for (const scheme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 640, height: 1200 },
        deviceScaleFactor: 2,
        colorScheme: scheme,
      });
      const page = await context.newPage();
      for (const { name } of entries) {
        const file = path.join(outDir, `${name}.html`);
        await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
        await page.screenshot({
          path: path.join(shotDir, `${name}.${scheme}.png`),
          fullPage: true,
        });
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const wantShots = process.argv.includes('--screenshots');
  const { emailFixtures, lintEmailHtml } = await loadFixtures();
  const entries = emailFixtures();

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  if (wantShots) await mkdir(shotDir, { recursive: true });

  let failed = 0;
  const index = [];
  for (const { name, mail } of entries) {
    await writeFile(path.join(outDir, `${name}.html`), mail.html, 'utf8');
    await writeFile(path.join(outDir, `${name}.txt`), mail.text, 'utf8');
    const problems = lintEmailHtml(mail.html);
    const kb = (Buffer.byteLength(mail.html, 'utf8') / 1024).toFixed(1);
    index.push({ name, subject: mail.subject, kb });
    if (problems.length) {
      failed += 1;
      console.error(`  FAIL ${name}: ${problems.join(', ')}`);
    } else {
      console.log(
        `  ok   ${name.padEnd(30)} ${kb.padStart(5)} KB  ${mail.subject}`
      );
    }
  }

  await writeFile(
    path.join(outDir, 'index.html'),
    `<!DOCTYPE html><meta charset="utf-8"><title>Flowstarter email previews</title>` +
      `<body style="font:16px -apple-system,sans-serif;background:#fbf7ef;color:#120a22;padding:40px;">` +
      `<h1 style="font-size:22px;">Flowstarter email previews</h1><ul style="line-height:1.9;">` +
      index
        .map(
          (e) =>
            `<li><a href="./${e.name}.html">${e.name}</a> &middot; ${e.subject} &middot; ${e.kb} KB &middot; <a href="./${e.name}.txt">text</a></li>`
        )
        .join('') +
      `</ul></body>`,
    'utf8'
  );

  console.log(`\n${entries.length} templates -> ${outDir}`);
  if (wantShots) {
    if (!existsSync(shotDir)) await mkdir(shotDir, { recursive: true });
    await screenshot(entries);
    console.log(`screenshots -> ${shotDir} (light and dark)`);
  }
  if (failed) {
    console.error(`\n${failed} template(s) failed the email CSS rules`);
    process.exit(1);
  }
}

// Importable for the tests, which reuse the fixtures and the linter.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
