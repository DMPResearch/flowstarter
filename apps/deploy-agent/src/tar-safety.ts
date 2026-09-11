/**
 * Trusted extraction for the gzipped ustar archives `flowstarter-main` and
 * the build worker send us (see `packages/agentic-codegen/src/flowstarter/
 * site-tarball.ts`, which packs the same header layout this file parses).
 *
 * The agent used to shell out to the system `tar -xzf`, which happily
 * follows symlinks, hardlinks and device entries and writes wherever a `..`
 * in a name points it. A generated site's file names were chosen by a
 * language model, so every entry is parsed and validated here — path,
 * type, size — before anything is written, and nothing is written until
 * every entry in the archive has passed.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const BLOCK = 512;

export class TarSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarSafetyError';
  }
}

export interface TarEntry {
  /** Slash-joined, trailing slashes stripped. Never starts with `/`. */
  path: string;
  /** '0' regular file, '5' directory. Anything else fails validation. */
  typeflag: string;
  size: number;
  /** Byte offset of the entry's content within the decompressed tar. */
  offset: number;
}

/** Types this agent will materialize. Everything else — symlink ('2'),
 * hardlink ('1'), device/fifo ('3','4','6','7') — is rejected rather than
 * guessed at. The metadata-only extensions ('g','x','L','K') never reach
 * this set: `parseTarEntries` consumes them (see METADATA_TYPEFLAGS). */
const SAFE_TYPEFLAGS = new Set(['0', '5']);

/**
 * Header types that carry metadata about the *next* entry rather than a
 * file of their own.
 *
 * These are not exotic. `tar -czf site.tar.gz -C dist .` on macOS writes a
 * pax extended header ('x') before every entry, and GNU tar writes a
 * longname header ('L') for any path over 100 bytes. Rejecting them meant
 * refusing the most ordinary way there is to produce a site tarball, so
 * they are parsed: the records they carry override the name and size of the
 * entry that follows, and that entry is then validated exactly like any
 * other. Nothing here relaxes what gets written to disk — a pax `path`
 * record pointing at `../etc` fails `assertSafeTarEntry` the same way a
 * ustar name would.
 *
 * 'K' (GNU longlink) is consumed too, but only so the link entry behind it
 * is reached and rejected on its own type.
 */
const METADATA_TYPEFLAGS = new Set(['g', 'x', 'L', 'K']);

/** Bounds a single metadata header. Real ones are a few hundred bytes. */
const MAX_METADATA_BYTES = 1024 * 1024;

/**
 * Strips the noise a real tar writer adds — the `./` prefix from
 * `tar -C dist .`, trailing slashes on directories, doubled separators —
 * without touching anything that decides whether a path is safe. A leading
 * `/` survives, `..` segments survive, and both are rejected downstream.
 */
function normalizeEntryPath(raw: string): string {
  let path = raw.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  while (path.startsWith('./')) path = path.slice(2);
  return path === '.' ? '' : path;
}

/**
 * Decodes the `"<len> <key>=<value>\n"` records of a pax header. `len` is a
 * byte count that includes itself, so this walks bytes rather than
 * characters: a UTF-8 filename would otherwise desynchronize the walk.
 */
function parsePaxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    let space = offset;
    while (space < data.length && data[space] !== 0x20) space++;
    if (space >= data.length) break;
    const length = Number.parseInt(
      Buffer.from(data.subarray(offset, space)).toString('ascii'),
      10
    );
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) {
      break;
    }
    const record = Buffer.from(data.subarray(space + 1, offset + length - 1)).toString(
      'utf8'
    );
    const eq = record.indexOf('=');
    if (eq > 0) records.set(record.slice(0, eq), record.slice(eq + 1));
    offset += length;
  }
  return records;
}

function readCString(buf: Uint8Array, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return Buffer.from(nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8');
}

function readOctalField(buf: Uint8Array, start: number, len: number): number {
  const raw = readCString(buf, start, len).trim();
  if (!raw) return 0;
  const n = parseInt(raw, 8);
  if (!Number.isFinite(n)) {
    throw new TarSafetyError('malformed tar header: unreadable numeric field');
  }
  return n;
}

/** Parses a decompressed ustar byte stream into its entries. Does not
 * validate paths or types — call `assertSafeTarEntry` on each result. */
export function parseTarEntries(tar: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  // Set by a pax 'x' or GNU 'L' header, consumed by the very next entry.
  let pendingPath: string | null = null;
  let pendingSize: number | null = null;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const name = readCString(header, 0, 100);
    const size = readOctalField(header, 124, 12);
    const rawTypeflag = String.fromCharCode(header[156] ?? 0);
    const prefix = readCString(header, 345, 155);
    const ustarPath = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + BLOCK;
    if (size < 0 || dataStart + size > tar.length) {
      throw new TarSafetyError(`tar entry "${ustarPath}" overruns the archive`);
    }
    const nextOffset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    const typeflag = rawTypeflag === '\0' ? '0' : rawTypeflag;

    if (METADATA_TYPEFLAGS.has(typeflag)) {
      if (size > MAX_METADATA_BYTES) {
        throw new TarSafetyError(
          `tar metadata header "${ustarPath}" is implausibly large (${size} bytes)`
        );
      }
      const data = tar.subarray(dataStart, dataStart + size);
      if (typeflag === 'x') {
        const records = parsePaxRecords(data);
        const paxPath = records.get('path');
        if (paxPath !== undefined) pendingPath = paxPath;
        const paxSize = records.get('size');
        if (paxSize !== undefined) {
          const parsed = Number.parseInt(paxSize, 10);
          if (!Number.isInteger(parsed) || parsed < 0) {
            throw new TarSafetyError('malformed pax header: unreadable size record');
          }
          pendingSize = parsed;
        }
      } else if (typeflag === 'L') {
        pendingPath = readCString(data, 0, data.length);
      }
      // 'g' (pax global) and 'K' (GNU longlink) carry nothing this agent
      // acts on. Skipping 'K' still leaves its link entry to be rejected.
      offset = nextOffset;
      continue;
    }

    const effectivePath = normalizeEntryPath(pendingPath ?? ustarPath);
    const effectiveSize = pendingSize ?? size;
    pendingPath = null;
    pendingSize = null;
    if (dataStart + effectiveSize > tar.length) {
      throw new TarSafetyError(`tar entry "${effectivePath}" overruns the archive`);
    }

    // `tar -C dist .` writes the destination directory itself as `./`.
    // That is not an entry to materialize; the extractor creates destDir.
    if (effectivePath === '' && typeflag === '5') {
      offset = nextOffset;
      continue;
    }

    entries.push({
      path: effectivePath,
      typeflag,
      size: effectiveSize,
      offset: dataStart,
    });
    // A pax `size` record replaces the ustar field rather than annotating
    // it (the ustar field is written as 0 for a size that cannot fit), so
    // the block walk has to advance by the effective size or every entry
    // after this one is read from the wrong offset.
    offset = dataStart + Math.ceil(effectiveSize / BLOCK) * BLOCK;
  }
  return entries;
}

/** Throws unless `entry` is a plain file or directory with a path that
 * cannot escape the directory it is extracted into. */
export function assertSafeTarEntry(entry: TarEntry): void {
  const { path, typeflag } = entry;
  if (!path) {
    throw new TarSafetyError('tar entry has an empty path');
  }
  if (path.startsWith('/') || path.includes('\0') || path.includes('\\')) {
    throw new TarSafetyError(`unsafe tar entry path: "${path}"`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new TarSafetyError(`unsafe tar entry path: "${path}"`);
  }
  if (!SAFE_TYPEFLAGS.has(typeflag)) {
    throw new TarSafetyError(
      `unsupported tar entry type "${typeflag}" for "${path}" — only regular files and directories are extracted`
    );
  }
}

export interface SafeExtractOptions {
  /** Refuses an archive whose entries sum past this many uncompressed
   * bytes. Default 256 MiB — generous for a static site, bounded against a
   * decompression bomb. */
  maxTotalBytes?: number;
  /** Refuses an archive with more entries than this. Default 20000. */
  maxEntries?: number;
}

/**
 * Decompresses and validates every entry in `tarballPath`, then writes them
 * under `destDir`. Validation runs to completion for the whole archive
 * before a single byte is written, so a hostile entry anywhere in the
 * archive leaves `destDir` untouched.
 */
export async function safeExtractTarball(
  tarballPath: string,
  destDir: string,
  options: SafeExtractOptions = {}
): Promise<void> {
  const maxTotalBytes = options.maxTotalBytes ?? 256 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 20000;

  const gz = await readFile(tarballPath);
  let tar: Buffer;
  try {
    tar = gunzipSync(gz);
  } catch (e) {
    throw new TarSafetyError(
      `not a valid gzip archive: ${e instanceof Error ? e.message : 'unknown'}`
    );
  }

  const entries = parseTarEntries(tar);
  if (entries.length > maxEntries) {
    throw new TarSafetyError(
      `archive has too many entries (${entries.length} > ${maxEntries})`
    );
  }

  const resolvedDest = resolve(destDir);
  let total = 0;
  const targets: { entry: TarEntry; target: string }[] = [];
  for (const entry of entries) {
    assertSafeTarEntry(entry);
    total += entry.size;
    if (total > maxTotalBytes) {
      throw new TarSafetyError('archive exceeds the extraction size limit');
    }
    const target = resolve(resolvedDest, entry.path);
    if (target !== resolvedDest && !target.startsWith(`${resolvedDest}/`)) {
      throw new TarSafetyError(`tar entry escapes destination: "${entry.path}"`);
    }
    targets.push({ entry, target });
  }

  // Every entry validated. Now, and only now, materialize them.
  await mkdir(resolvedDest, { recursive: true });
  for (const { entry, target } of targets) {
    if (entry.typeflag === '5') {
      await mkdir(target, { recursive: true, mode: 0o755 });
      continue;
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    const content = tar.subarray(entry.offset, entry.offset + entry.size);
    await writeFile(target, content, { mode: 0o644 });
  }
}
