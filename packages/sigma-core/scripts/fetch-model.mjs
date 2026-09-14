#!/usr/bin/env node
/**
 * Fetch the pinned encoder into the cache directory. Install/build time only.
 *
 * Every file is fetched at an exact commit sha and verified against the
 * sha256 in config/encoder.json. A file whose hash is blank in the config is
 * size-checked and its hash printed, so adding a file is: add it with an
 * empty hash, run this once, paste the hash it prints.
 *
 * Idempotent: a file already present with the right hash is left alone, so
 * this is cheap to wire into a build step.
 *
 *   node scripts/fetch-model.mjs            # fetch what is missing
 *   node scripts/fetch-model.mjs --force    # re-fetch everything
 *   node scripts/fetch-model.mjs --print    # print hashes, write nothing new
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CONFIG_PATH = join(ROOT, 'config', 'encoder.json');

const force = process.argv.includes('--force');
const printOnly = process.argv.includes('--print');

function expand(raw) {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const withHome = raw.startsWith('~') ? join(home, raw.slice(1)) : raw;
  return resolve(
    ROOT,
    withHome.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (all, name) => process.env[name] ?? all),
  );
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function existingHash(path) {
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const cacheDir = expand(process.env.SIGMA_MODEL_CACHE_DIR ?? config.cacheDir);
  const modelDir = join(cacheDir, ...config.model.split('/'));
  const base = `https://huggingface.co/${config.model}/resolve/${config.revision}`;

  console.log(`encoder : ${config.model}@${config.revision} (${config.dtype})`);
  console.log(`cache   : ${modelDir}`);

  const observed = [];
  let fetched = 0;
  for (const entry of config.files) {
    const target = join(modelDir, ...entry.path.split('/'));
    await mkdir(dirname(target), { recursive: true });

    if (!force) {
      const current = await existingHash(target);
      if (current && (entry.sha256 === '' || current === entry.sha256)) {
        const { size } = await stat(target);
        observed.push({ path: entry.path, sha256: current, bytes: size });
        console.log(`  ok    ${entry.path} (${(size / 1e6).toFixed(1)} MB, cached)`);
        continue;
      }
      if (current && entry.sha256 && current !== entry.sha256) {
        console.log(`  stale ${entry.path} (hash mismatch, re-fetching)`);
      }
    }

    const url = `${base}/${entry.path}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${url}: HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const hash = sha256(buffer);
    if (entry.sha256 && hash !== entry.sha256) {
      // A mirror that serves different weights would shift every calibrated
      // cosine. Refuse rather than silently invalidate the bands.
      throw new Error(
        `${entry.path}: sha256 mismatch\n  expected ${entry.sha256}\n  got      ${hash}`,
      );
    }
    if (entry.bytes && buffer.length !== entry.bytes) {
      throw new Error(`${entry.path}: expected ${entry.bytes} bytes, got ${buffer.length}`);
    }
    if (!printOnly) {
      const temporary = `${target}.partial`;
      await writeFile(temporary, buffer);
      await rename(temporary, target);
    }
    observed.push({ path: entry.path, sha256: hash, bytes: buffer.length });
    fetched += 1;
    console.log(`  got   ${entry.path} (${(buffer.length / 1e6).toFixed(1)} MB)`);
  }

  const blank = config.files.filter((entry) => !entry.sha256);
  if (blank.length > 0) {
    console.log('\nPaste these into config/encoder.json (files with a blank sha256):');
    for (const entry of observed) {
      if (blank.some((file) => file.path === entry.path)) {
        console.log(`  ${entry.path}\n    "sha256": "${entry.sha256}", "bytes": ${entry.bytes}`);
      }
    }
  }

  const total = observed.reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(`\n${observed.length} files, ${(total / 1e6).toFixed(1)} MB total, ${fetched} fetched.`);
}

main().catch((error) => {
  console.error(`fetch-model failed: ${error.message}`);
  process.exitCode = 1;
});
