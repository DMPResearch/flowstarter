/**
 * The seed half of the `PLACEHOLDER_IMAGE_SHIPPED` gate (#110).
 *
 * #110 gates the *output*: the worker hashes everything in `dist/` and fails
 * a paid build that still carries one of the template's own stand-in pictures.
 * That is the right gate and it is the gate of record. What it did not have
 * was an answer for a site that was published *before* it existed.
 *
 * Every one of those sites has a manifest that carries the whole template
 * asset library under `public/images/` — `about-me-photo.svg`, `boutique.png`,
 * `somalia.png` and the rest — because that is what the template shipped and
 * nothing ever took them out. Astro copies `public/` into `dist/` verbatim, so
 * the hash check fires on files the page never points at, at "Checking the
 * build", before a single request-specific rule has run. Job
 * `2716f978-b2ed-474b-b485-f0d5584fbda7` did exactly the change it was asked
 * for — a case study removed, six pages where there had been seven — and
 * failed anyway, on nine pictures nobody had looked at since the day the site
 * was generated.
 *
 * The agent cannot fix it: the change-request prompt tells it to leave every
 * other file on the site exactly as it is, and asking a model to delete files
 * out of a paid client's site to satisfy a gate is not a rule, it is a
 * negotiation. So this is a rule, applied at materialise time, before the
 * agent is started:
 *
 *   - a gated placeholder nothing references is **removed** from the seed;
 *   - a gated placeholder something *does* reference has the reference
 *     rewritten to the same no-image fallback a fresh build renders — the
 *     no-portrait layout, the typographic project tile, or no hero image —
 *     and is then removed too, because nothing points at it any more;
 *   - a client-supplied file is never touched, whatever it is a copy of;
 *   - a seed with no gated placeholders in it comes back unchanged, object
 *     for object, so the rule costs a clean site nothing.
 *
 * Matching is by the same content hashes #110 uses, and by nothing else. A
 * file that merely *shares a name* with a template placeholder may be the
 * client's own replacement, and deleting one of those to satisfy a gate would
 * be a worse failure than the one being fixed. The gate still names it, and
 * the agent is now allowed to delete a file the gate names by path.
 */

import {
  GATED_PLACEHOLDER_IMAGE_HASHES,
  isGatedPlaceholderImageRole,
  sha256Hex,
  type PlaceholderImageAsset,
  type PlaceholderImageRole,
} from './placeholder-images';

/** The one directory a client's own rights-confirmed pictures live in. */
export const CLIENT_MEDIA_SEED_PREFIX = 'public/flowstarter-media/';

/** File extensions worth hashing against the manifest. */
const IMAGE_EXTENSIONS = /\.(svg|png|jpe?g|webp|gif)$/i;

/**
 * The slot a reference sits in, which decides how it reads on the board and,
 * in a template, what renders once the picture is gone.
 *
 * Every one of these is applied the same way — the reference is emptied — and
 * that is deliberate: the fallbacks #110 shipped (`AboutStory.astro`'s
 * initials disc, `CaseStudyCard.astro`'s typographic tile) are all triggered
 * by the image being *absent*, so honouring them means removing the value and
 * nothing more. The slot decides the words, not the mechanism.
 */
export type PlaceholderSlotKind =
  | 'portrait'
  | 'project-cover'
  | 'hero'
  | 'image';

/** A gated placeholder file taken out of the seed. */
export interface SeedPlaceholderRemoval {
  /** Manifest path, e.g. `public/images/somalia.png`. */
  path: string;
  /** The site-rooted string a page would have used, e.g. `/images/somalia.png`. */
  reference: string;
  role: PlaceholderImageRole;
  /** The manifest row it matched, by hash. */
  assetId: string;
  /** True when something in the seed actually pointed at it. */
  wasReferenced: boolean;
}

/** One reference to a gated placeholder, rewritten to the no-image fallback. */
export interface SeedPlaceholderRewrite {
  /** The source file the reference was in. */
  file: string;
  reference: string;
  slot: PlaceholderSlotKind;
  /**
   * Where it sat, in the template's own words: a top-level content key
   * (`caseStudies`, `aboutStory`), or the element that carried it.
   */
  section: string;
}

export interface SeedPlaceholderCatalog {
  /**
   * The manifest rows to match against. Defaults to the shipped one; a test
   * passes its own so the rule can be exercised without the real bytes.
   */
  manifest?: readonly PlaceholderImageAsset[];
  /**
   * Extra site-rooted paths that belong to the client — anything with a
   * rights record. Anything under `public/flowstarter-media/` is protected
   * whether or not it is listed here.
   */
  clientAssetPaths?: readonly string[];
}

export interface SanitisedSeed<T> {
  files: T[];
  removed: SeedPlaceholderRemoval[];
  rewritten: SeedPlaceholderRewrite[];
  /** The board line, or null when the seed was already clean. */
  summary: string | null;
}

/** `public/images/x.png` -> `/images/x.png`; anything else keeps its path. */
function referenceFor(path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  return clean.startsWith('public/')
    ? `/${clean.slice('public/'.length)}`
    : `/${clean}`;
}

/** True for a file the client owns, which this rule never touches. */
function isClientAsset(
  path: string,
  protectedPaths: ReadonlySet<string>,
): boolean {
  const clean = path.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  return (
    clean.startsWith(CLIENT_MEDIA_SEED_PREFIX) ||
    protectedPaths.has(clean) ||
    protectedPaths.has(referenceFor(clean))
  );
}

/** The bytes of one seed entry, however the manifest stored them. */
function bytesOf(file: { content: string; encoding?: 'base64' }): Buffer {
  return Buffer.from(
    file.content,
    file.encoding === 'base64' ? 'base64' : 'utf8',
  );
}

const HERO_CONTEXT = /hero|banner|masthead/i;
const PORTRAIT_CONTEXT =
  /about|portrait|founder|team|author|profile|avatar|headshot|owner|person/i;
const PROJECT_CONTEXT = /case|project|work|portfolio|thumb|study|studies/i;

/**
 * Which slot a reference sits in, read off the content key it was found
 * under first and the asset's own catalogued role second.
 *
 * Context wins over role because the role says what the picture *is* and the
 * slot says what the page will render without it: a portrait placeholder used
 * as a hero image leaves a hero with no image, not an initials disc.
 */
export function classifyPlaceholderSlot(input: {
  role: PlaceholderImageRole;
  section?: string;
  key?: string;
}): PlaceholderSlotKind {
  const context = `${input.section ?? ''} ${input.key ?? ''}`;
  if (HERO_CONTEXT.test(context)) return 'hero';
  if (PORTRAIT_CONTEXT.test(context)) return 'portrait';
  if (PROJECT_CONTEXT.test(context)) return 'project-cover';
  if (input.role === 'portrait') return 'portrait';
  if (input.role === 'work-thumb') return 'project-cover';
  if (input.role === 'hero') return 'hero';
  return 'image';
}

/** Text worth rewriting. Bytes are never searched for a path. */
const TEXT_EXTENSIONS =
  /\.(astro|md|mdx|html?|css|ts|tsx|js|mjs|json|xml|svg)$/i;

/** A top-level YAML key, `caseStudies:`, which labels the block beneath it. */
const SECTION_LINE = /^([A-Za-z][A-Za-z0-9_]*):\s*$/;

/**
 * A `key: "value"` line, list item or not, whose value is the whole reference.
 * This is the shape every template keeps its rendered image paths in, and the
 * shape `site-media.ts` already reads for the client's own image swaps.
 */
function blankYamlValue(line: string, reference: string): string | null {
  const pattern = new RegExp(
    `^(\\s*(?:-\\s+)?[A-Za-z][A-Za-z0-9_]*\\s*:\\s*)(["']?)${escapeRegExp(reference)}\\2\\s*$`,
  );
  const match = pattern.exec(line);
  if (!match) return null;
  // Emptied, never deleted. Deleting the line is the tempting move and it is
  // wrong: `imageSrc` is often the first key of a list item or the only key
  // of a block, and removing it there turns valid YAML into a null the page
  // then reads a property off. An empty string is falsy in every template
  // fallback #110 shipped, which is exactly the layout we want.
  return `${match[1]}""`;
}

/** The YAML key on a `key: value` line, for slot classification. */
function yamlKeyOf(line: string): string {
  const match = /^\s*(?:-\s+)?([A-Za-z][A-Za-z0-9_]*)\s*:/.exec(line);
  return match?.[1] ?? '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** An `<img>`/`<source>`/`<image>` element, however it is closed. */
const IMAGE_ELEMENT = /<(img|source|image)\b[^>]*\/?>(?:\s*<\/\1>)?/gi;
/** A whole CSS declaration whose value is a `url(...)`. */
const CSS_DECLARATION = /[^;{}\n]*:\s*[^;{}]*url\([^)]*\)[^;{}]*;?/gi;
/** Any attribute whose value carries the reference. */
function attributePattern(reference: string): RegExp {
  return new RegExp(
    `([A-Za-z_:][-\\w:.]*\\s*=\\s*)(["'])[^"']*${escapeRegExp(reference)}[^"']*\\2`,
    'g',
  );
}

interface FileRewrite {
  content: string;
  rewrites: SeedPlaceholderRewrite[];
}

/**
 * One file's references to one placeholder, rewritten.
 *
 * Four narrow rewrites rather than one blunt string removal, in the order a
 * reference actually occurs: the content value a template renders from, the
 * markup element a page embeds, the CSS declaration a stylesheet paints with,
 * and finally any other attribute. A blunt removal would leave `src=""` in
 * markup and a dangling `url()` in CSS, both of which a browser reports as a
 * broken image on a paid client's site.
 */
function rewriteReference(
  path: string,
  source: string,
  reference: string,
  role: PlaceholderImageRole,
): FileRewrite {
  const rewrites: SeedPlaceholderRewrite[] = [];
  let content = source;

  // 1. Content values: `imageSrc: "/images/boutique.png"`.
  if (content.includes(reference)) {
    const lines = content.split('\n');
    let section = 'general';
    let touched = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] as string;
      const sectionMatch = SECTION_LINE.exec(line);
      if (sectionMatch) {
        section = sectionMatch[1] as string;
        continue;
      }
      if (!line.includes(reference)) continue;
      const blanked = blankYamlValue(line, reference);
      if (blanked === null) continue;
      lines[index] = blanked;
      touched = true;
      rewrites.push({
        file: path,
        reference,
        slot: classifyPlaceholderSlot({
          role,
          section,
          key: yamlKeyOf(line),
        }),
        section,
      });
    }
    if (touched) content = lines.join('\n');
  }

  // 2. Markup elements: the whole `<img>` goes, so the slot renders empty
  //    rather than broken.
  if (content.includes(reference)) {
    content = content.replace(IMAGE_ELEMENT, (element) => {
      if (!element.includes(reference)) return element;
      rewrites.push({
        file: path,
        reference,
        slot: classifyPlaceholderSlot({ role, section: path, key: 'img' }),
        section: 'markup',
      });
      return '';
    });
  }

  // 3. CSS: the declaration goes with the url, so no property is left half
  //    written.
  if (content.includes(reference)) {
    content = content.replace(CSS_DECLARATION, (declaration) => {
      if (!declaration.includes(reference)) return declaration;
      rewrites.push({
        file: path,
        reference,
        slot: classifyPlaceholderSlot({ role, section: path, key: 'css' }),
        section: 'stylesheet',
      });
      return '';
    });
  }

  // 4. Anything else that named it in an attribute — a component prop, say,
  //    which renders its own fallback on an empty string.
  if (content.includes(reference)) {
    content = content.replace(
      attributePattern(reference),
      (_whole, lead: string, quote: string) => {
        rewrites.push({
          file: path,
          reference,
          slot: classifyPlaceholderSlot({ role, section: path, key: 'prop' }),
          section: 'markup',
        });
        return `${lead}${quote}${quote}`;
      },
    );
  }

  // 5. The last resort, so the gate can never see the string again. Reached
  //    only by a reference in prose or in a shape none of the above knows.
  if (content.includes(reference)) {
    content = content.split(reference).join('');
    rewrites.push({
      file: path,
      reference,
      slot: classifyPlaceholderSlot({ role, section: path }),
      section: 'text',
    });
  }

  return { content, rewrites };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

const SLOT_PHRASE: Record<
  PlaceholderSlotKind,
  { one: string; many: (count: number) => string }
> = {
  portrait: {
    one: 'replaced the template portrait with the no-photo layout',
    many: (count) =>
      `replaced ${count} template portraits with the no-photo layout`,
  },
  'project-cover': {
    one: 'replaced the template project cover with the typographic tile',
    many: (count) =>
      `replaced ${count} template project covers with typographic tiles`,
  },
  hero: {
    one: 'removed the template hero image',
    many: (count) => `removed ${count} template hero images`,
  },
  image: {
    one: 'removed the template image',
    many: (count) => `removed ${count} template images`,
  },
};

/** The order clauses read in, worst offence first. */
const SLOT_ORDER: PlaceholderSlotKind[] = [
  'portrait',
  'project-cover',
  'hero',
  'image',
];

/**
 * What the rule did, in the words an operator reading the board would use.
 * Null when it did nothing, so a clean seed says nothing at all.
 */
export function describeSeedPlaceholderSanitisation(
  removed: readonly SeedPlaceholderRemoval[],
  rewritten: readonly SeedPlaceholderRewrite[],
): string | null {
  const clauses: string[] = [];
  const unreferenced = removed.filter((entry) => !entry.wasReferenced).length;
  if (unreferenced > 0) {
    clauses.push(
      `Removed ${unreferenced} template placeholder ` +
        `${plural(unreferenced, 'image')} the site never referenced`,
    );
  }
  for (const slot of SLOT_ORDER) {
    const count = rewritten.filter((entry) => entry.slot === slot).length;
    if (count === 0) continue;
    const phrase = SLOT_PHRASE[slot];
    clauses.push(count === 1 ? phrase.one : phrase.many(count));
  }
  if (clauses.length === 0) return null;
  return `${clauses.join('; ')}.`;
}

/**
 * The seed a paid build actually gets: the client's published manifest with
 * the template's own gated stand-in pictures taken back out of it.
 *
 * Pure, and a no-op on a clean seed: when nothing matches, the very array
 * that came in is the array that goes back out.
 */
export function sanitiseSeedPlaceholders<
  T extends { path: string; content: string; encoding?: 'base64' },
>(files: readonly T[], catalog: SeedPlaceholderCatalog = {}): SanitisedSeed<T> {
  const gatedByHash = catalog.manifest
    ? new Map(
        catalog.manifest
          .filter((asset) => isGatedPlaceholderImageRole(asset.role))
          .map((asset) => [asset.sha256, asset] as const),
      )
    : GATED_PLACEHOLDER_IMAGE_HASHES;
  const protectedPaths = new Set(catalog.clientAssetPaths ?? []);

  // 1. Which files in this seed are gated placeholders, by content hash.
  const placeholders = new Map<
    string,
    { file: T; asset: PlaceholderImageAsset; reference: string }
  >();
  for (const file of files) {
    if (!IMAGE_EXTENSIONS.test(file.path)) continue;
    if (isClientAsset(file.path, protectedPaths)) continue;
    const asset = gatedByHash.get(sha256Hex(bytesOf(file)));
    if (!asset) continue;
    placeholders.set(file.path, {
      file,
      asset,
      reference: referenceFor(file.path),
    });
  }
  if (placeholders.size === 0) {
    return { files: files as T[], removed: [], rewritten: [], summary: null };
  }

  // 2. Every reference to them, rewritten to the no-image fallback.
  const references = Array.from(placeholders.values());
  const referenced = new Set<string>();
  const rewritten: SeedPlaceholderRewrite[] = [];
  const kept: T[] = [];
  for (const file of files) {
    if (placeholders.has(file.path)) continue; // handled below
    if (
      file.encoding === 'base64' ||
      !TEXT_EXTENSIONS.test(file.path) ||
      isClientAsset(file.path, protectedPaths)
    ) {
      kept.push(file);
      continue;
    }
    let content = file.content;
    for (const entry of references) {
      if (!content.includes(entry.reference)) continue;
      referenced.add(entry.reference);
      const result = rewriteReference(
        file.path,
        content,
        entry.reference,
        entry.asset.role,
      );
      content = result.content;
      rewritten.push(...result.rewrites);
    }
    kept.push(content === file.content ? file : { ...file, content });
  }

  // 3. The files themselves, which nothing points at any more.
  const removed: SeedPlaceholderRemoval[] = references
    .map((entry) => ({
      path: entry.file.path,
      reference: entry.reference,
      role: entry.asset.role,
      assetId: entry.asset.id,
      wasReferenced: referenced.has(entry.reference),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    files: kept,
    removed,
    rewritten,
    summary: describeSeedPlaceholderSanitisation(removed, rewritten),
  };
}
