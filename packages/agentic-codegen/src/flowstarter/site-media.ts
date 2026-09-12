/**
 * Client-owned media on a delivered site.
 *
 * After handover a client wants their own photographs in the slots the build
 * filled with template artwork — their projects, their services, the faces on
 * their testimonials. That is a media swap, not a code change, so it never
 * goes near the coding agent: this module enumerates the image slots the
 * template already renders and replaces one of them in place.
 *
 * The shape of the site is therefore fixed. A client can change what an image
 * *is*, never how many there are or where they sit, which keeps a self-service
 * upload from drifting into a layout edit.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { probeImageSize } from './preview-assets';

/**
 * Content files a template may keep its rendered copy in.
 *
 * Exported because a module that is handed files in memory rather than a
 * workspace on disk (`portrait-slot.ts`, which judges where the client's own
 * photograph ended up) still has to recognise a content file by its path, and
 * two lists of the same two file names are two lists that can disagree.
 */
export const CONTENT_FILES = [
  'src/content/site-labels.md',
  'src/content/content.md',
] as const;

/** Keys whose value is a rendered image path. */
const IMAGE_KEY =
  /^(\s*)-?\s*(image|imageSrc|authorImage|logo|avatar):\s*(["'])(.*?)\3\s*$/;
/**
 * Some templates reuse `logo` for a text wordmark, so a key name alone does
 * not make a value an image. Only site-rooted image paths are offered for
 * replacement. SVG counts here because template placeholder art is often SVG
 * and a client should be able to replace it — uploads themselves stay raster
 * only, which `assertSafeUploadedImage` enforces.
 */
const IMAGE_VALUE = /^\/[\w\-./]+\.(png|jpe?g|webp|gif|avif|svg)$/i;
/** Top-level YAML key, e.g. `caseStudies:` — used to label the slot's section. */
const SECTION_KEY = /^([A-Za-z][A-Za-z0-9_]*):\s*$/;
const ALT_KEY = /^\s*-?\s*(imageAlt|alt):\s*(["'])(.*?)\2\s*$/;

export interface SiteImageSlot {
  /** Stable address for this slot: content file plus 1-based line. */
  id: string;
  file: string;
  line: number;
  /** The path the site currently renders, e.g. `/images/boutique.png`. */
  currentPath: string;
  /** Top-level content group the slot sits in (caseStudies, testimonials…). */
  section: string;
  /** The key that held it, so a UI can say "project image" vs "avatar". */
  key: string;
  /** Adjacent alt text, when the template stores one. */
  alt?: string;
}

/**
 * Every image slot in one content file's text, in document order.
 *
 * Pure, and separate from the workspace read below, because the same parse is
 * needed by callers who never touch the disk: the build gates hold the site's
 * files in memory, and a second regex pass written against the same YAML would
 * be a second answer to "where are this site's pictures".
 *
 * `file` is only ever copied into the slot's `file` and `id`, so a caller with
 * a prefixed path (`dist/`, an absolute workspace path) gets slots addressed
 * the way it addressed the file.
 */
export function parseSiteImageSlots(
  file: string,
  source: string,
): SiteImageSlot[] {
  const slots: SiteImageSlot[] = [];
  const lines = source.split('\n');
  let section = 'general';
  lines.forEach((line, index) => {
    const sectionMatch = SECTION_KEY.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1] as string;
      return;
    }
    const match = IMAGE_KEY.exec(line);
    if (!match) return;
    const currentPath = match[4] as string;
    if (!IMAGE_VALUE.test(currentPath)) return;
    // Alt text sits on an adjacent line in every template we ship.
    const altLine = lines[index + 1] ?? '';
    const altMatch = ALT_KEY.exec(altLine);
    slots.push({
      id: `${file}#${index + 1}`,
      file,
      line: index + 1,
      currentPath,
      section,
      key: match[2] as string,
      ...(altMatch ? { alt: altMatch[3] as string } : {}),
    });
  });
  return slots;
}

/**
 * Lists every image the delivered site renders, in document order, so a client
 * UI can show each slot with its current picture and offer a replacement.
 */
export async function listSiteImageSlots(
  workspaceRoot: string,
): Promise<SiteImageSlot[]> {
  const slots: SiteImageSlot[] = [];
  for (const file of CONTENT_FILES) {
    let source: string;
    try {
      source = await readFile(join(workspaceRoot, file), 'utf8');
    } catch {
      continue;
    }
    slots.push(...parseSiteImageSlots(file, source));
  }
  return slots;
}

/** Formats a client upload is allowed to be. SVG is excluded: it can script. */
const MAGIC: Array<{ ext: string; test: (b: Buffer) => boolean }> = [
  { ext: 'png', test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 },
  {
    ext: 'gif',
    test: (b) => b.length > 6 && b.toString('ascii', 0, 3) === 'GIF',
  },
  {
    ext: 'webp',
    test: (b) =>
      b.length > 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
];

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * The default floor on the longest edge, in pixels. Below it a picture put in
 * a section or a hero reads as blurry, which is what the error says.
 *
 * Exported, and overridable per call, because one caller is filing a picture
 * it already knows is small. A portrait read from a provider's public profile
 * is 100 square on Instagram, and a hundred-pixel face is still worth keeping
 * as a round avatar; refusing it here would be this function deciding a
 * placement question. So a caller that knows what it is filing passes its own
 * floor, and the rule that keeps a small picture out of a hero slot lives with
 * that caller rather than in the byte check.
 */
export const MIN_EDGE_PX = 200;
const MAX_EDGE_PX = 8_000;

export interface VerifiedUpload {
  extension: string;
  width?: number;
  height?: number;
}

/**
 * Validates an upload by its actual bytes rather than its declared name or
 * content type, so a renamed script or an SVG cannot reach a client's site.
 */
export function assertSafeUploadedImage(
  bytes: Buffer,
  options?: { minEdge?: number },
): VerifiedUpload {
  if (bytes.length === 0) throw new Error('Uploaded image is empty');
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error('Uploaded image is larger than 8MB');
  }
  const format = MAGIC.find((candidate) => candidate.test(bytes));
  if (!format) {
    throw new Error('Uploaded file is not a PNG, JPEG, GIF or WebP image');
  }
  const size = probeImageSize(bytes);
  if (size) {
    // The effective floor: the caller's when it named one, ours otherwise, so
    // every existing caller keeps exactly the behaviour it had.
    const minEdge = options?.minEdge ?? MIN_EDGE_PX;
    const longest = Math.max(size.width, size.height);
    if (longest < minEdge) {
      throw new Error(
        `Uploaded image is only ${longest}px on its longest side; it would look blurry on the site`,
      );
    }
    if (longest > MAX_EDGE_PX) {
      throw new Error(
        'Uploaded image is larger than 8000px on its longest side',
      );
    }
  }
  return { extension: format.ext, ...(size ?? {}) };
}

/** Client media lives apart from template artwork so handover stays legible. */
const CLIENT_MEDIA_DIR = 'public/flowstarter-media';

/**
 * Leading and trailing `-` counted off rather than stripped with
 * `/^-+|-+$/`: the trailing half of that pattern backtracks from every offset
 * on a name that is all dashes.
 */
function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

function safeMediaName(slot: SiteImageSlot, extension: string): string {
  const base = basename(slot.currentPath).replace(/\.[a-z0-9]+$/i, '');
  const stem = trimDashes(base.replace(/[^a-z0-9-]+/gi, '-')).toLowerCase();
  return `${stem || 'image'}-${slot.line}.${extension}`;
}

export interface ReplaceSiteImageResult {
  slotId: string;
  publicPath: string;
  previousPath: string;
}

/**
 * Swaps the picture in one slot: writes the client's file into the site and
 * rewrites exactly the line the slot came from.
 *
 * The caller must pass the slot it read a moment ago; if that line no longer
 * holds the expected path the edit is refused rather than applied to whatever
 * moved into its place.
 */
export async function replaceSiteImage(
  workspaceRoot: string,
  input: { slot: SiteImageSlot; bytes: Buffer; alt?: string },
): Promise<ReplaceSiteImageResult> {
  const verified = assertSafeUploadedImage(input.bytes);
  const path = join(workspaceRoot, input.slot.file);
  const source = await readFile(path, 'utf8');
  const lines = source.split('\n');
  const index = input.slot.line - 1;
  const line = lines[index];
  if (line === undefined) throw new Error('Image slot no longer exists');

  const match = IMAGE_KEY.exec(line);
  if (!match || match[4] !== input.slot.currentPath) {
    throw new Error(
      'The site changed since this image slot was read; reload and try again',
    );
  }

  const fileName = safeMediaName(input.slot, verified.extension);
  await mkdir(join(workspaceRoot, CLIENT_MEDIA_DIR), { recursive: true });
  await writeFile(
    join(workspaceRoot, CLIENT_MEDIA_DIR, fileName),
    input.bytes,
    {
      mode: 0o644,
    },
  );

  const publicPath = `/flowstarter-media/${fileName}`;
  lines[index] = line.replace(
    `${match[3]}${match[4]}${match[3]}`,
    `${match[3]}${publicPath}${match[3]}`,
  );

  if (input.alt !== undefined) {
    const altIndex = index + 1;
    const altLine = lines[altIndex];
    const altMatch = altLine === undefined ? null : ALT_KEY.exec(altLine);
    if (altMatch) {
      // Quotes and YAML meaning must survive whatever the client typed.
      const safeAlt = input.alt
        .replace(/["'\\\r\n]/g, ' ')
        .trim()
        .slice(0, 160);
      lines[altIndex] = altLine!.replace(
        `${altMatch[2]}${altMatch[3]}${altMatch[2]}`,
        `${altMatch[2]}${safeAlt}${altMatch[2]}`,
      );
    }
  }

  await writeFile(path, lines.join('\n'), 'utf8');
  return {
    slotId: input.slot.id,
    publicPath,
    previousPath: input.slot.currentPath,
  };
}
