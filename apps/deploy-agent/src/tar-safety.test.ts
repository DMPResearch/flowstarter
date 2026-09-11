import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { safeExtractTarball, TarSafetyError } from './tar-safety';
// The packer flowstarter-main and the build worker both use. If the agent
// cannot extract what that function produces, nothing deploys.
import { packSiteTarball } from '../../../packages/agentic-codegen/src/flowstarter/site-tarball';

const BLOCK = 512;

/** Minimal, self-contained ustar writer for test fixtures. Deliberately
 * independent of `packages/agentic-codegen/src/flowstarter/site-tarball.ts`
 * so these tests exercise the parser against the format, not against that
 * module's choices. */
function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function writeField(block: Uint8Array, offset: number, width: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  block.set(bytes.subarray(0, width), offset);
}

function tarHeader(path: string, size: number, typeflag: string): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeField(block, 0, 100, path);
  writeField(block, 100, 8, octal(0o644, 8));
  writeField(block, 108, 8, octal(0, 8));
  writeField(block, 116, 8, octal(0, 8));
  writeField(block, 124, 12, octal(size, 12));
  writeField(block, 136, 12, octal(0, 12));
  block.fill(0x20, 148, 156);
  block[156] = typeflag.charCodeAt(0);
  writeField(block, 257, 6, 'ustar\0');
  writeField(block, 263, 2, '00');
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i] as number;
  writeField(block, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

interface FixtureEntry {
  path: string;
  content?: string;
  typeflag?: string;
  /** Binary bodies (a pax record block, a GNU longname) go here instead. */
  body?: Uint8Array;
}

function buildTarGz(entries: FixtureEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.from(entry.content ?? '', 'utf8');
    chunks.push(tarHeader(entry.path, body.length, entry.typeflag ?? '0'));
    if (body.length > 0) {
      chunks.push(body);
      const padding = (BLOCK - (body.length % BLOCK)) % BLOCK;
      if (padding > 0) chunks.push(new Uint8Array(padding));
    }
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  const tar = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return new Uint8Array(gzipSync(tar));
}

/** `"<len> <key>=<value>\n"`, where len counts itself. */
function paxRecords(records: Record<string, string>): Uint8Array {
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(records)) {
    const tail = Buffer.from(` ${key}=${value}\n`, 'utf8');
    let length = tail.length + 1;
    // The digit count is part of the length, so it can carry itself over.
    while (String(length).length + tail.length !== length) {
      length = String(length).length + tail.length;
    }
    parts.push(Buffer.concat([Buffer.from(String(length), 'ascii'), tail]));
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** What `tar -C dist .` writes: a pax header, then the entry it describes. */
function paxEntry(path: string, content: string): FixtureEntry[] {
  return [
    { path: 'PaxHeader/file', typeflag: 'x', body: paxRecords({ path }) },
    // The ustar name a pax writer falls back to is deliberately different,
    // so a test failure means the pax record was ignored.
    { path: 'ustar-fallback-name', content },
  ];
}

async function writeFixture(entries: FixtureEntry[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tar-safety-fixture-'));
  const path = join(dir, 'site.tar.gz');
  await writeFile(path, buildTarGz(entries));
  return path;
}

describe('safeExtractTarball', () => {
  test('extracts regular files and directories at their given paths', async () => {
    const tarballPath = await writeFixture([
      { path: 'index.html', content: '<h1>hi</h1>' },
      { path: 'assets/', typeflag: '5' },
      { path: 'assets/app.js', content: 'console.log(1)' },
    ]);
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await safeExtractTarball(tarballPath, destDir);
      expect(await readFile(join(destDir, 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
      expect(await readFile(join(destDir, 'assets/app.js'), 'utf8')).toBe('console.log(1)');
      expect((await stat(join(destDir, 'assets'))).isDirectory()).toBe(true);
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('rejects a path that escapes the destination with ..', async () => {
    const tarballPath = await writeFixture([{ path: '../evil.txt', content: 'x' }]);
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await expect(safeExtractTarball(tarballPath, destDir)).rejects.toThrow(TarSafetyError);
      // Nothing partially written outside destDir either.
      await expect(stat(join(destDir, '..', 'evil.txt'))).rejects.toThrow();
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('rejects an absolute path', async () => {
    const tarballPath = await writeFixture([{ path: '/etc/passwd', content: 'x' }]);
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await expect(safeExtractTarball(tarballPath, destDir)).rejects.toThrow(TarSafetyError);
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('rejects a symlink entry', async () => {
    const tarballPath = await writeFixture([
      { path: 'link', typeflag: '2', content: '' },
    ]);
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await expect(safeExtractTarball(tarballPath, destDir)).rejects.toThrow(TarSafetyError);
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('rejects a hardlink entry', async () => {
    const tarballPath = await writeFixture([
      { path: 'index.html', content: 'safe' },
      { path: 'hard', typeflag: '1', content: '' },
    ]);
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await expect(safeExtractTarball(tarballPath, destDir)).rejects.toThrow(TarSafetyError);
      // The whole archive is rejected — the earlier safe entry is not
      // written either.
      await expect(stat(join(destDir, 'index.html'))).rejects.toThrow();
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('rejects a device special file entry', async () => {
    const tarballPath = await writeFixture([{ path: 'dev', typeflag: '3', content: '' }]);
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await expect(safeExtractTarball(tarballPath, destDir)).rejects.toThrow(TarSafetyError);
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('rejects an entry with a .. path segment in the middle', async () => {
    const tarballPath = await writeFixture([{ path: 'a/../../b', content: 'x' }]);
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await expect(safeExtractTarball(tarballPath, destDir)).rejects.toThrow(TarSafetyError);
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('rejects an archive past the total byte limit', async () => {
    const tarballPath = await writeFixture([{ path: 'big.bin', content: 'x'.repeat(2048) }]);
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await expect(
        safeExtractTarball(tarballPath, destDir, { maxTotalBytes: 1024 })
      ).rejects.toThrow(TarSafetyError);
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('accepts the ./-prefixed entries `tar -C dist .` writes', async () => {
    const tarballPath = await writeFixture([
      { path: './', typeflag: '5' },
      { path: './index.html', content: '<h1>hi</h1>' },
      { path: './assets/', typeflag: '5' },
      { path: './assets/app.css', content: 'body{}' },
    ]);
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await safeExtractTarball(tarballPath, destDir);
      expect(await readFile(join(destDir, 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
      expect(await readFile(join(destDir, 'assets/app.css'), 'utf8')).toBe('body{}');
      // The `./` entry is the destination itself, not a file called ".".
      await expect(stat(join(destDir, '.', 'index.html'))).resolves.toBeDefined();
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('a pax extended header names the entry that follows it', async () => {
    const tarballPath = await writeFixture(paxEntry('_astro/app.BxYz.css', 'body{margin:0}'));
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await safeExtractTarball(tarballPath, destDir);
      expect(await readFile(join(destDir, '_astro/app.BxYz.css'), 'utf8')).toBe('body{margin:0}');
      await expect(stat(join(destDir, 'ustar-fallback-name'))).rejects.toThrow();
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('a pax path that escapes the destination is rejected like any other', async () => {
    const tarballPath = await writeFixture(paxEntry('../../etc/cron.d/pwn', 'x'));
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await expect(safeExtractTarball(tarballPath, destDir)).rejects.toThrow(TarSafetyError);
      await expect(stat(join(destDir, 'ustar-fallback-name'))).rejects.toThrow();
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('a pax header applies to one entry only, not to the rest of the archive', async () => {
    const tarballPath = await writeFixture([
      ...paxEntry('first.txt', 'one'),
      { path: 'second.txt', content: 'two' },
    ]);
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await safeExtractTarball(tarballPath, destDir);
      expect(await readFile(join(destDir, 'first.txt'), 'utf8')).toBe('one');
      expect(await readFile(join(destDir, 'second.txt'), 'utf8')).toBe('two');
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('a pax global header is skipped rather than treated as a file', async () => {
    const tarballPath = await writeFixture([
      { path: 'pax_global_header', typeflag: 'g', body: paxRecords({ comment: 'anything' }) },
      { path: 'index.html', content: 'ok' },
    ]);
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await safeExtractTarball(tarballPath, destDir);
      expect(await readFile(join(destDir, 'index.html'), 'utf8')).toBe('ok');
      await expect(stat(join(destDir, 'pax_global_header'))).rejects.toThrow();
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('a GNU longname header names the entry that follows it', async () => {
    const longPath = `_astro/${'a'.repeat(120)}.js`;
    const tarballPath = await writeFixture([
      {
        path: '././@LongLink',
        typeflag: 'L',
        body: new Uint8Array(Buffer.from(`${longPath}\0`, 'utf8')),
      },
      { path: 'truncated-name', content: 'console.log(1)' },
    ]);
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await safeExtractTarball(tarballPath, destDir);
      expect(await readFile(join(destDir, longPath), 'utf8')).toBe('console.log(1)');
      await expect(stat(join(destDir, 'truncated-name'))).rejects.toThrow();
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('a symlink behind a GNU longlink header is still rejected', async () => {
    const tarballPath = await writeFixture([
      {
        path: '././@LongLink',
        typeflag: 'K',
        body: new Uint8Array(Buffer.from('/etc/shadow\0', 'utf8')),
      },
      { path: 'link', typeflag: '2' },
    ]);
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await expect(safeExtractTarball(tarballPath, destDir)).rejects.toThrow(TarSafetyError);
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('a pax size record moves the block walk, so later entries still parse', async () => {
    // A pax writer that puts the real size in the record and 0 in the ustar
    // header. Reading the ustar 0 would resynchronize onto the body.
    const body = 'x'.repeat(600);
    const chunks: Uint8Array[] = [];
    chunks.push(tarHeader('PaxHeader/big', 0, 'x'));
    const records = paxRecords({ size: String(body.length) });
    // Rewrite the pax header's own size field now that we know it.
    chunks[0] = tarHeader('PaxHeader/big', records.length, 'x');
    chunks.push(records);
    chunks.push(new Uint8Array((BLOCK - (records.length % BLOCK)) % BLOCK));
    chunks.push(tarHeader('big.bin', 0, '0'));
    chunks.push(Buffer.from(body, 'utf8'));
    chunks.push(new Uint8Array((BLOCK - (body.length % BLOCK)) % BLOCK));
    chunks.push(tarHeader('after.txt', 5, '0'));
    chunks.push(Buffer.from('after', 'utf8'));
    chunks.push(new Uint8Array(BLOCK - 5));
    chunks.push(new Uint8Array(BLOCK * 2));

    const dir = await mkdtemp(join(tmpdir(), 'tar-safety-fixture-'));
    const tarballPath = join(dir, 'site.tar.gz');
    await writeFile(
      tarballPath,
      gzipSync(Buffer.concat(chunks.map((c) => Buffer.from(c))))
    );
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await safeExtractTarball(tarballPath, destDir);
      expect(await readFile(join(destDir, 'big.bin'), 'utf8')).toBe(body);
      expect(await readFile(join(destDir, 'after.txt'), 'utf8')).toBe('after');
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('a plain non-gzip file is rejected, not silently accepted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tar-safety-fixture-'));
    const path = join(dir, 'not-gzip.tar.gz');
    await writeFile(path, 'this is not gzip data');
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await expect(safeExtractTarball(path, destDir)).rejects.toThrow(TarSafetyError);
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });
});

describe('safeExtractTarball — archives real producers emit', () => {
  test('extracts what packSiteTarball produces, including a binary asset', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bytes = packSiteTarball([
      { path: 'index.html', content: '<h1>generated</h1>' },
      { path: '_astro/app.BxYz12.css', content: 'body{margin:0}' },
      { path: 'images/logo.png', content: png.toString('base64'), encoding: 'base64' },
    ]);
    const dir = await mkdtemp(join(tmpdir(), 'tar-safety-packed-'));
    const tarballPath = join(dir, 'site.tar.gz');
    await writeFile(tarballPath, bytes);
    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await safeExtractTarball(tarballPath, destDir);
      expect(await readFile(join(destDir, 'index.html'), 'utf8')).toBe('<h1>generated</h1>');
      expect(await readFile(join(destDir, '_astro/app.BxYz12.css'), 'utf8')).toBe('body{margin:0}');
      // Byte-for-byte: a base64 entry decoded as UTF-8 corrupts every image.
      expect(Buffer.compare(await readFile(join(destDir, 'images/logo.png')), png)).toBe(0);
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('extracts an archive produced by the system tar', async () => {
    const srcDir = await mkdtemp(join(tmpdir(), 'tar-safety-src-'));
    await mkdir(join(srcDir, 'assets'), { recursive: true });
    await writeFile(join(srcDir, 'index.html'), '<h1>hi</h1>');
    await writeFile(join(srcDir, 'assets', 'app.css'), 'body{}');
    const tarballPath = join(srcDir, '..', `system-tar-${Date.now()}.tar.gz`);

    const tar = Bun.spawnSync({
      cmd: ['tar', '-czf', tarballPath, '-C', srcDir, '.'],
      // Without this, macOS tar attaches AppleDouble ._ files.
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    expect(tar.exitCode).toBe(0);

    const destDir = await mkdtemp(join(tmpdir(), 'tar-safety-dest-'));
    try {
      await safeExtractTarball(tarballPath, destDir);
      expect(await readFile(join(destDir, 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
      expect(await readFile(join(destDir, 'assets', 'app.css'), 'utf8')).toBe('body{}');
    } finally {
      await rm(destDir, { recursive: true, force: true });
      await rm(tarballPath, { force: true });
    }
  });
});
