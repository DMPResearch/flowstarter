import 'server-only';

/**
 * Making a built preview's images the optimised outputs rather than the
 * originals.
 *
 * Astro optimises what it compiles and copies what it is given. Everything a
 * template keeps under `src/` comes out the far side hashed, minified and
 * bundled into `_astro/`; everything under `public/` is copied into `dist/`
 * byte for byte, untouched, whether or not the built site ever points at it.
 * None of the five site templates use `astro:assets`, so every picture they
 * ship takes the second path.
 *
 * Measured on the portfolio family, which is the one that broke:
 *
 *   dist/_astro   120 KiB   — the compiled site
 *   dist/images  11.7 MiB   — `public/images/*.png`, verbatim
 *
 * 2.7 MiB of that is one `hero.png`. 2.4 MiB is `hero-image-wrong.png`, which
 * nothing on any page references and which has been shipped to every preview
 * ever generated from that template. The packed artifact came to 11.05 MiB,
 * the `tenant-assets` bucket refuses objects over 10 MiB, and a correct
 * generated site was never hosted because of it.
 *
 * So this runs between `astro build` and reading `dist/` back, and it applies
 * two rules to the verbatim copy — never to `_astro/`, which is Astro's own
 * output and already optimised:
 *
 *  1. AN IMAGE NOTHING REFERENCES IS NOT PART OF THE BUILT SITE. It is dropped.
 *     "References" is decided by searching every text file in `dist/` for the
 *     file's *basename*, not its full path: a page may build a path by
 *     concatenation, and a rule that deletes a picture a visitor can still
 *     reach would be a far worse defect than the one it fixes. Matching the
 *     basename is the conservative direction — it keeps files a stricter rule
 *     would remove.
 *  2. A RASTER ORIGINAL IS RE-ENCODED TO WEBP, and every reference to it in
 *     the built site is rewritten to the new name. The reference in a built
 *     page is always the whole rooted path (`/images/hero.png`) because that
 *     is the only form `public/` serves under, so the rewrite is a literal
 *     string substitution with no parsing and no ambiguity.
 *
 * Both rules are per-file fail-open. A picture sharp cannot read, or one WebP
 * makes *bigger* (already-optimised PNGs, flat-colour SVG-ish art), is left
 * exactly as it was: the budget check in `preview-artifact-budget.ts` is the
 * thing that must never be silent, and this step is an optimisation, not a
 * gate. Nothing here can fail a build.
 *
 * SVG is deliberately untouched. It is already the optimised form of what it
 * draws, re-encoding it to a bitmap would be a downgrade, and it is the one
 * image type in `public/` that can carry script — a file this module should
 * be reading, not rewriting.
 */

import {
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * Below this, re-encoding is not worth the CPU or the risk: a 40 KiB PNG that
 * becomes a 34 KiB WebP has bought six kilobytes against a 16 MiB budget and
 * spent a reference rewrite to get them.
 */
const RE_ENCODE_FLOOR_BYTES = 64 * 1024;

/**
 * WebP quality. 82 is the knee of the curve for photographic content — visually
 * indistinguishable from the PNG at 1x and roughly a tenth of the bytes — and
 * a preview is a thing somebody looks at for ninety seconds and then claims.
 */
const WEBP_QUALITY = 82;

/** The raster formats a template ships as originals. */
const RE_ENCODABLE = /\.(png|jpe?g)$/i;

/** Everything a reference to an asset could be written inside. */
const TEXT_EXTENSIONS = new Set([
  'html',
  'htm',
  'xhtml',
  'css',
  'js',
  'mjs',
  'cjs',
  'json',
  'map',
  'svg',
  'txt',
  'xml',
  'webmanifest',
]);

/**
 * Astro's own output. Content-hashed, already optimised, and referenced by
 * names this module has no business rewriting.
 */
const COMPILED_OUTPUT_DIR = '_astro';

export interface PreviewDistAssetReport {
  /** Rooted paths of the images nothing referenced, dropped from `dist/`. */
  removed: string[];
  /** `{ from, to }` for each original re-encoded to WebP. */
  converted: { from: string; to: string; before: number; after: number }[];
  bytesBefore: number;
  bytesAfter: number;
}

function isTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.has(path.split('.').pop()?.toLowerCase() ?? '');
}

/** Every file under `root`, as paths relative to it, with `/` separators. */
async function walkFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      // Symlinks are not followed, matching `collectDistFiles`: the target may
      // sit outside the tree and a static host has no use for one.
      if (!entry.isFile()) continue;
      found.push(relative(root, absolute).split(sep).join('/'));
    }
  }
  await walk(root);
  return found;
}

/**
 * The rooted URL a file in `dist/` is served at. `dist/images/hero.png` is
 * requested as `/images/hero.png`, which is the exact string a built page
 * carries.
 */
export function servedPath(distRelativePath: string): string {
  return `/${distRelativePath}`;
}

/**
 * Re-encodes one image, or answers null.
 *
 * Null covers every reason not to swap the file: sharp is unavailable (a test
 * environment with no native binary), the bytes are not a raster image sharp
 * will decode, or the WebP came out no smaller than what we already had. All
 * three mean "keep the original", which is why they share a return value.
 *
 * `animated: false` and `limitInputPixels` mirror `profile-image.ts`: these
 * are template-shipped files rather than an anonymous upload, but a generated
 * workspace can carry whatever the pipeline put in it and the decoder is still
 * the most expensive thing in this step.
 */
async function toWebp(bytes: Buffer): Promise<Buffer | null> {
  try {
    const sharp = (await import('sharp')).default;
    const encoded = await sharp(bytes, { animated: false, failOn: 'error' })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    return encoded.byteLength < bytes.byteLength ? encoded : null;
  } catch {
    return null;
  }
}

/**
 * Applies both rules to a built `dist/` in place and reports what it did.
 *
 * In place, rather than returning a transformed manifest, because the caller
 * reads `dist/` back through `collectDistFiles` immediately afterwards and two
 * descriptions of the same tree is exactly how one of them goes stale.
 */
export async function optimisePreviewDistImages(
  distRoot: string
): Promise<PreviewDistAssetReport> {
  const report: PreviewDistAssetReport = {
    removed: [],
    converted: [],
    bytesBefore: 0,
    bytesAfter: 0,
  };

  let paths: string[];
  try {
    paths = await walkFiles(distRoot);
  } catch {
    // No dist, or an unreadable one. The caller's own read is what should
    // report that, with its own message.
    return report;
  }

  const textPaths = paths.filter(isTextPath);
  const candidates = paths.filter(
    (path) =>
      !path.startsWith(`${COMPILED_OUTPUT_DIR}/`) && RE_ENCODABLE.test(path)
  );
  for (const path of paths) {
    try {
      report.bytesBefore += (await stat(join(distRoot, path))).size;
    } catch {
      /* a file that vanished between the walk and the stat is not our problem */
    }
  }
  if (candidates.length === 0) {
    report.bytesAfter = report.bytesBefore;
    return report;
  }

  // One read of the built site's text, reused by both rules. These are the
  // bytes a browser would be served, so a reference that is not in here is a
  // reference no visitor can make.
  const sources = new Map<string, string>();
  for (const path of textPaths) {
    try {
      sources.set(path, await readFile(join(distRoot, path), 'utf8'));
    } catch {
      /* unreadable text is text that references nothing */
    }
  }
  const haystack = Array.from(sources.values()).join('\n');

  // Rule 1: drop what nothing points at.
  const kept: string[] = [];
  for (const path of candidates) {
    const basename = path.slice(path.lastIndexOf('/') + 1);
    if (haystack.includes(basename)) {
      kept.push(path);
      continue;
    }
    try {
      await rm(join(distRoot, path), { force: true });
      report.removed.push(servedPath(path));
    } catch {
      kept.push(path);
    }
  }

  // Rule 2: re-encode what is left, and rewrite the references to it.
  const rewrites = new Map<string, string>();
  for (const path of kept) {
    const absolute = join(distRoot, path);
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch {
      continue;
    }
    if (bytes.byteLength < RE_ENCODE_FLOOR_BYTES) continue;

    const encoded = await toWebp(bytes);
    if (!encoded) continue;

    const webpPath = path.replace(RE_ENCODABLE, '.webp');
    // A template that already ships `hero.webp` next to `hero.png` would have
    // this overwrite the one the page actually uses. Leave those alone; they
    // are already the optimised output this rule is trying to produce.
    if (kept.includes(webpPath) || sources.has(webpPath)) continue;

    try {
      await writeFile(join(distRoot, webpPath), encoded);
      await rm(absolute, { force: true });
    } catch {
      continue;
    }
    rewrites.set(servedPath(path), servedPath(webpPath));
    report.converted.push({
      from: servedPath(path),
      to: servedPath(webpPath),
      before: bytes.byteLength,
      after: encoded.byteLength,
    });
  }

  // `Array.from` rather than iterating the Map directly: this package compiles
  // below the target that allows a bare `for…of` over one.
  const rewritePairs = Array.from(rewrites.entries());
  if (rewritePairs.length > 0) {
    for (const [path, content] of Array.from(sources.entries())) {
      let next = content;
      for (const [from, to] of rewritePairs) {
        if (!next.includes(from)) continue;
        next = next.split(from).join(to);
      }
      if (next === content) continue;
      try {
        await writeFile(join(distRoot, path), next, 'utf8');
      } catch {
        // The bytes are gone and the reference is not rewritten: the page now
        // points at a file that is not there. Put the original back, so a
        // broken write degrades to an oversized preview rather than a broken
        // one.
        await restoreUnrewritten(distRoot, rewrites);
        break;
      }
    }
  }

  for (const path of await walkFiles(distRoot).catch(() => [] as string[])) {
    try {
      report.bytesAfter += (await stat(join(distRoot, path))).size;
    } catch {
      /* see above */
    }
  }
  return report;
}

/**
 * The one failure this module cannot shrug off: bytes swapped, references not.
 *
 * Renaming the WebP back to the original extension is wrong (the bytes are
 * WebP, the name would say PNG) — but a static host serves it by extension
 * only as a `Content-Type` hint, every browser sniffs the actual format, and a
 * picture that renders under a misleading name is strictly better than a
 * missing one on a page a visitor is about to judge us by.
 */
async function restoreUnrewritten(
  distRoot: string,
  rewrites: ReadonlyMap<string, string>
): Promise<void> {
  for (const [from, to] of Array.from(rewrites.entries())) {
    try {
      await rename(join(distRoot, to.slice(1)), join(distRoot, from.slice(1)));
    } catch {
      /* best effort, by definition */
    }
  }
}
