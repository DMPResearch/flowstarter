/**
 * The one place the template's own stand-in images are catalogued, so a paid
 * build can be checked against the same list a template author maintains.
 *
 * Placeholder *copy* has a gate (`placeholder-copy.ts`); placeholder *images*
 * did not, and a client paid for a site that shipped the creative-portfolio
 * family's design-review guide graphic (`about-me-photo.svg` — a circle on a
 * grid with an orange frame, drawn to mark where a photo goes, never meant to
 * render on a real page) as their own About-page photo, plus the template's
 * stock UI screenshots (a bakery app, a budget planner, a news site — none of
 * them the client's) standing in for an invented case study.
 *
 * Three things are deliberate, matching `placeholder-copy.ts`:
 *
 * - **The manifest is closed and literal.** Each row below names a real file
 *   this repository ships, by template and path, with the sha256 of the bytes
 *   as they exist today. Adding a row is a code change with a test.
 * - **A role decides whether a match is a defect.** `portrait` and
 *   `work-thumb` stand in for content a specific brief may simply not have
 *   (the owner's photo, a screenshot of a real project) and shipping them
 *   pretends that content exists. `hero` and `decoration` are template
 *   atmosphere — mood photography and abstract shapes reused across every
 *   site the template ever produces — and are never a promise about *this*
 *   client, so they ship freely.
 * - **Matching does not stop at exact bytes.** A file can be renamed on its
 *   way through a build, so the gate also matches by content hash regardless
 *   of path, and a future template can flag a new stand-in before this file
 *   is ever updated by following the naming and marker conventions below.
 */

import { createHash } from 'node:crypto';

/** The job fails with this when a paid build still ships a gated placeholder. */
export const PLACEHOLDER_IMAGE_SHIPPED = 'PLACEHOLDER_IMAGE_SHIPPED';

export type PlaceholderImageRole =
  | 'portrait'
  | 'work-thumb'
  | 'hero'
  | 'decoration';

/**
 * The two roles a paid build must never carry. A brief with no portrait and
 * no project screenshot is common, not an error, and the honest response is
 * the layout in `about-fallback.ts`-style components (no image, or initials),
 * not a stand-in image dressed up as content.
 */
export const GATED_PLACEHOLDER_IMAGE_ROLES: readonly PlaceholderImageRole[] = [
  'portrait',
  'work-thumb',
];

export function isGatedPlaceholderImageRole(
  role: PlaceholderImageRole,
): boolean {
  return (GATED_PLACEHOLDER_IMAGE_ROLES as readonly string[]).includes(role);
}

export interface PlaceholderImageAsset {
  /** Stable id, so a test and a job log can name one without quoting a path. */
  id: string;
  /** The template slug this file ships under, e.g. `creative-portfolio`. */
  template: string;
  /** Template-relative path, e.g. `public/images/about-me-photo.svg`. */
  path: string;
  role: PlaceholderImageRole;
  /** sha256 of the file exactly as it ships, in hex. */
  sha256: string;
  /** Why it is what it is, in the words an operator would use. */
  why: string;
}

/**
 * Every placeholder image this repository is known to ship, gated and not.
 *
 * `hero` and `decoration` rows exist so the manifest tells the whole story of
 * a template's asset library, not only the part the gate acts on, and so a
 * test can assert the allowed roles really do pass the gate.
 */
export const PLACEHOLDER_IMAGE_MANIFEST: readonly PlaceholderImageAsset[] = [
  // --- portrait: the About-page photo slot, forbidden on a paid build ---
  {
    id: 'creative-portfolio-about-me-photo',
    template: 'creative-portfolio',
    path: 'public/images/about-me-photo.svg',
    role: 'portrait',
    sha256: 'a4ab24e230a6db237fe5bafd46920257291957b30793a8539b574294c36d4110',
    why: 'A design-review guide graphic — a circle on a grid with an orange frame, marking where a photo goes. It shipped as the About-page photo on a paid site.',
  },
  {
    id: 'dorin-portfolio-about-me-photo',
    template: 'dorin-portfolio',
    path: 'public/images/about-me-photo.svg',
    role: 'portrait',
    sha256: 'a4ab24e230a6db237fe5bafd46920257291957b30793a8539b574294c36d4110',
    why: 'The same guide graphic as creative-portfolio, byte for byte; dorin-portfolio forked the template before this was fixed.',
  },

  // --- work-thumb: case-study art for a project the client never did ---
  {
    id: 'creative-portfolio-boutique',
    template: 'creative-portfolio',
    path: 'public/images/boutique.png',
    role: 'work-thumb',
    sha256: '3e820ef18abcb6778a83b3594f8d7192943f5fd6872f56b1b944c843812cf20a',
    why: 'A screenshot of a bakery e-commerce app that is not the client’s work, catalogued as "fallback case-study art" and shipped as one on a paid site.',
  },
  {
    id: 'creative-portfolio-sweet-box',
    template: 'creative-portfolio',
    path: 'public/images/sweet-box.webp',
    role: 'work-thumb',
    sha256: '8f90241998be2e8832add0de52d4237cf6a38c7f4ff08d79883abcff3d2ade12',
    why: 'A screenshot of the same fictitious bakery’s website; not the client’s work.',
  },
  {
    id: 'creative-portfolio-budget-dark',
    template: 'creative-portfolio',
    path: 'public/images/budget-dark.png',
    role: 'work-thumb',
    sha256: 'fd70b9521f6e61a11ace4670aca4c5746a57fca147697daee1863d24334f9819',
    why: 'A screenshot of a fictitious budgeting app; not the client’s work.',
  },
  {
    id: 'creative-portfolio-budget-neomorphism',
    template: 'creative-portfolio',
    path: 'public/images/budget-neoMorphism.png',
    role: 'work-thumb',
    sha256: '0426c5dd72dcb81c38ac45be2664d74b58d02ee96ce3a11a1250bb0152a460fa',
    why: 'A second screenshot of the same fictitious finance app; not the client’s work.',
  },
  {
    id: 'creative-portfolio-hotblocks',
    template: 'creative-portfolio',
    path: 'public/images/hotBlocks.png',
    role: 'work-thumb',
    sha256: '46dc9792fb0519b93c51ec80f9b617deb25ec5bf924f47c706242c9890a9fdb9',
    why: 'A UI-kit collage for a design system that does not exist; not the client’s work.',
  },
  {
    id: 'creative-portfolio-somalia',
    template: 'creative-portfolio',
    path: 'public/images/somalia.png',
    role: 'work-thumb',
    sha256: 'f93287c9da496e4b3005352c8e8adf7ebd3f0afebd0a1e7daf9f9510ee9f9e9f',
    why: 'An editorial web design that is not the client’s work; the exact image named in the 2026-09 delivered-portfolio incident.',
  },
  {
    id: 'creative-portfolio-masonry',
    template: 'creative-portfolio',
    path: 'public/images/masonry.png',
    role: 'work-thumb',
    sha256: '50d3973e44b1f775354d36a23805c2483bf396d3634e9e13e0525c96420b55f7',
    why: 'A portfolio-grid mockup that is not the client’s work.',
  },
  {
    id: 'dorin-portfolio-boutique',
    template: 'dorin-portfolio',
    path: 'public/images/boutique.png',
    role: 'work-thumb',
    sha256: '3e820ef18abcb6778a83b3594f8d7192943f5fd6872f56b1b944c843812cf20a',
    why: 'Same fictitious bakery app screenshot as creative-portfolio.',
  },
  {
    id: 'dorin-portfolio-sweet-box',
    template: 'dorin-portfolio',
    path: 'public/images/sweet-box.webp',
    role: 'work-thumb',
    sha256: '8f90241998be2e8832add0de52d4237cf6a38c7f4ff08d79883abcff3d2ade12',
    why: 'Same fictitious bakery website screenshot as creative-portfolio.',
  },
  {
    id: 'dorin-portfolio-budget-dark',
    template: 'dorin-portfolio',
    path: 'public/images/budget-dark.png',
    role: 'work-thumb',
    sha256: 'fd70b9521f6e61a11ace4670aca4c5746a57fca147697daee1863d24334f9819',
    why: 'Same fictitious budgeting app screenshot as creative-portfolio.',
  },
  {
    id: 'dorin-portfolio-budget-neomorphism',
    template: 'dorin-portfolio',
    path: 'public/images/budget-neoMorphism.png',
    role: 'work-thumb',
    sha256: '0426c5dd72dcb81c38ac45be2664d74b58d02ee96ce3a11a1250bb0152a460fa',
    why: 'Same fictitious finance app screenshot as creative-portfolio.',
  },
  {
    id: 'dorin-portfolio-hotblocks',
    template: 'dorin-portfolio',
    path: 'public/images/hotBlocks.png',
    role: 'work-thumb',
    sha256: '46dc9792fb0519b93c51ec80f9b617deb25ec5bf924f47c706242c9890a9fdb9',
    why: 'Same UI-kit collage as creative-portfolio.',
  },
  {
    id: 'dorin-portfolio-somalia',
    template: 'dorin-portfolio',
    path: 'public/images/somalia.png',
    role: 'work-thumb',
    sha256: 'f93287c9da496e4b3005352c8e8adf7ebd3f0afebd0a1e7daf9f9510ee9f9e9f',
    why: 'Same editorial web design screenshot as creative-portfolio.',
  },
  {
    id: 'dorin-portfolio-masonry',
    template: 'dorin-portfolio',
    path: 'public/images/masonry.png',
    role: 'work-thumb',
    sha256: '50d3973e44b1f775354d36a23805c2483bf396d3634e9e13e0525c96420b55f7',
    why: 'Same portfolio-grid mockup as creative-portfolio.',
  },

  // --- decoration: abstract shapes, allowed on a paid build ---
  {
    id: 'creative-portfolio-studio-portrait',
    template: 'creative-portfolio',
    path: 'public/images/studio-portrait.svg',
    role: 'decoration',
    sha256: '219b2ac30ca26f8366b29ef9ba5b52814fc6635377498650eb04fff506a68dce',
    why: 'A label-free abstract composition, catalogued as fallback section art. No client, no product, nothing to misrepresent.',
  },
  {
    id: 'creative-portfolio-studio-desk',
    template: 'creative-portfolio',
    path: 'public/images/studio-desk.svg',
    role: 'decoration',
    sha256: 'fd507a6bbf2326e1f53d553067ec09f1c91e6a633c9c4a8b15ac4c2d4a863d5c',
    why: 'Abstract fallback section art.',
  },
  {
    id: 'creative-portfolio-studio-detail',
    template: 'creative-portfolio',
    path: 'public/images/studio-detail.svg',
    role: 'decoration',
    sha256: 'f1bf098c107cff015a6bda8e47ec58878fb4c1625feff58c7e0bc2c52d259ec3',
    why: 'Abstract fallback section art.',
  },
  {
    id: 'creative-portfolio-studio-field',
    template: 'creative-portfolio',
    path: 'public/images/studio-field.svg',
    role: 'decoration',
    sha256: '43addb0b5a294145f8226d441bf39cc0af73d4beb05ec72c509df8026b818d77',
    why: 'Abstract fallback section art.',
  },
  {
    id: 'creative-portfolio-work-halden',
    template: 'creative-portfolio',
    path: 'public/images/work-halden.svg',
    role: 'decoration',
    sha256: '52702a2f152ba973a9a19f73839ae95f0ab7102ba9586fc69be3156c36dfbc20',
    why: 'Label-free abstract composition, catalogued as fallback case-study art for when a project has no screenshot.',
  },
  {
    id: 'creative-portfolio-work-marrow',
    template: 'creative-portfolio',
    path: 'public/images/work-marrow.svg',
    role: 'decoration',
    sha256: '2e4ed2cf8fe6fcbc8e02c0c87cd91c646c074d2b95fdabcbabcf5f1b44ae2762',
    why: 'Abstract fallback case-study art.',
  },
  {
    id: 'creative-portfolio-work-kestrel',
    template: 'creative-portfolio',
    path: 'public/images/work-kestrel.svg',
    role: 'decoration',
    sha256: 'c4773dc0915226f024b9346481d15cf99248be5e5d2e88e35283f4edff8e9429',
    why: 'Abstract fallback case-study art.',
  },
  {
    id: 'creative-portfolio-work-fieldnotes',
    template: 'creative-portfolio',
    path: 'public/images/work-fieldnotes.svg',
    role: 'decoration',
    sha256: '7ae6fd4f3f163a8576e8bebea90bc5341a7fa65573c72dfd227a169bc194ede5',
    why: 'Abstract fallback case-study art.',
  },
  {
    id: 'creative-portfolio-work-sable',
    template: 'creative-portfolio',
    path: 'public/images/work-sable.svg',
    role: 'decoration',
    sha256: '80f9a98cad42e5030be6dd0453dfca362ff65879c9e2736d4ee99ebca93d5e16',
    why: 'Abstract fallback case-study art.',
  },
  {
    id: 'creative-portfolio-work-lumen',
    template: 'creative-portfolio',
    path: 'public/images/work-lumen.svg',
    role: 'decoration',
    sha256: 'd82826f03525f222d47a15268ab60ba798ff08aaf183f9a97e2607726ed18645',
    why: 'Abstract fallback case-study art.',
  },
  {
    id: 'local-trade-workshop-bench',
    template: 'local-trade',
    path: 'public/images/workshop-bench.svg',
    role: 'decoration',
    sha256: '654371cc4f4588338c9cd967ccf5f74f4e3c5a9d4485415147bb143595a13ac6',
    why: 'A label-free line drawing of a workbench, catalogued as fallback art. Not a photo of any client’s premises or work.',
  },

  // --- hero: template atmosphere, allowed on a paid build ---
  {
    id: 'creative-portfolio-hero',
    template: 'creative-portfolio',
    path: 'public/images/hero.png',
    role: 'hero',
    sha256: '9caebf3538a6005b6675d26ee8e351a2ff0e6f1181579264b9b3caedcaef5b67',
    why: 'Mood photography of the template’s demo persona. Catalogued as never to be presented as the client; used for atmosphere, not identity.',
  },
] as const;

/** Every gated-role hash in the manifest, for the by-hash half of the gate. */
export const GATED_PLACEHOLDER_IMAGE_HASHES: ReadonlyMap<
  string,
  PlaceholderImageAsset
> = new Map(
  PLACEHOLDER_IMAGE_MANIFEST.filter((asset) =>
    isGatedPlaceholderImageRole(asset.role),
  ).map((asset) => [asset.sha256, asset]),
);

/**
 * The convention a *new* template follows so a stand-in image is caught
 * before this manifest is ever updated for it: name the file with this
 * prefix and a role right after it. `placeholder-portrait-founder.svg` and
 * `placeholder-work-thumb-1.png` both match; `placeholder-favicon.svg` does
 * not, because `favicon` is not a gated role and a sentinel that fires on an
 * honest filename is worse than no sentinel.
 */
export const PLACEHOLDER_IMAGE_FILENAME_PREFIX = 'placeholder-';

const FILENAME_CONVENTION_PATTERN =
  /^placeholder-(portrait|work-thumb)(?:[-.].*)?\.(svg|png|jpe?g|webp|gif)$/i;

/**
 * The attribute a template puts on the element it renders when it must, for
 * now, keep a hand-authored stand-in visual in markup rather than a public
 * asset file (an inline SVG, say). `portrait` and `work-thumb` are caught by
 * the gate; any other value is the template documenting a deliberate,
 * allowed placeholder (typically `decoration`) rather than hiding one.
 */
export const PLACEHOLDER_IMAGE_MARKER_ATTR = 'data-flowstarter-placeholder';

const MARKER_ATTR_PATTERN = new RegExp(
  `${PLACEHOLDER_IMAGE_MARKER_ATTR}\\s*=\\s*["'](portrait|work-thumb)["']`,
  'gi',
);

/** Text worth reading for the marker attribute and known-path references. */
const TEXT_EXTENSIONS = /\.(astro|md|mdx|html?|css|ts|tsx|js|mjs|json|xml)$/i;

/** Image extensions worth hashing or checking against the naming convention. */
const IMAGE_EXTENSIONS = /\.(svg|png|jpe?g|webp|gif)$/i;

/** sha256 of a file's bytes, hex-encoded. Shared so every caller hashes alike. */
export function sha256Hex(bytes: Uint8Array | Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type PlaceholderImageFindingReason =
  | 'known-asset'
  | 'filename-convention'
  | 'marker-attribute';

export interface PlaceholderImageFinding {
  /** Where it was found: a compiled file path, or the asset's own path. */
  path: string;
  role: PlaceholderImageRole;
  reason: PlaceholderImageFindingReason;
  /** Present when matched against a manifest row, by hash or by path. */
  asset?: PlaceholderImageAsset;
}

/** The manifest row whose basename matches this path, template aside. */
function manifestAssetForBasename(
  basename: string,
): PlaceholderImageAsset | undefined {
  return PLACEHOLDER_IMAGE_MANIFEST.find(
    (asset) => asset.path.split('/').pop() === basename,
  );
}

/**
 * The gated finding a bare filename implies, whether that is a manifest hit
 * by basename or a new file following the naming convention. Returns
 * `undefined` for a filename that is neither — the common case.
 */
export function findPlaceholderImageByFilename(
  path: string,
): PlaceholderImageFinding | undefined {
  const clean = path.replace(/^\.?\/?/, '');
  const basename = clean.split('/').pop() ?? clean;

  const known = manifestAssetForBasename(basename);
  if (known && isGatedPlaceholderImageRole(known.role)) {
    return { path, role: known.role, reason: 'known-asset', asset: known };
  }

  const conventional = FILENAME_CONVENTION_PATTERN.exec(basename);
  FILENAME_CONVENTION_PATTERN.lastIndex = 0;
  if (conventional) {
    // The capture group is mandatory in the pattern, so it is always set
    // when `conventional` matched at all.
    const role = conventional[1]!.toLowerCase() as PlaceholderImageRole;
    return { path, role, reason: 'filename-convention' };
  }

  return undefined;
}

/** The gated finding these bytes imply, by content hash, regardless of name. */
export function findPlaceholderImageByHash(
  path: string,
  bytes: Uint8Array | Buffer,
): PlaceholderImageFinding | undefined {
  if (!IMAGE_EXTENSIONS.test(path)) return undefined;
  const asset = GATED_PLACEHOLDER_IMAGE_HASHES.get(sha256Hex(bytes));
  if (!asset) return undefined;
  return { path, role: asset.role, reason: 'known-asset', asset };
}

/** Every marker-attribute finding in one file's text. */
export function findPlaceholderImageMarkersInText(
  path: string,
  content: string,
): PlaceholderImageFinding[] {
  if (!TEXT_EXTENSIONS.test(path)) return [];
  const findings: PlaceholderImageFinding[] = [];
  // `Array.from` rather than a bare `for...of` over the iterator: a consumer
  // type-checking against an ES5 target (flowstarter-main's tsconfig) cannot
  // iterate a `RegExpStringIterator` directly without `downlevelIteration`.
  for (const match of Array.from(content.matchAll(MARKER_ATTR_PATTERN))) {
    // The capture group is mandatory in the pattern, so it is always set for
    // every match `matchAll` yields.
    findings.push({
      path,
      role: match[1]!.toLowerCase() as PlaceholderImageRole,
      reason: 'marker-attribute',
    });
  }
  return findings;
}

/**
 * Every gated placeholder reference in a set of compiled text files: known
 * paths and the marker attribute. Does not hash — callers with the actual
 * bytes on disk (the worker's dist scan) add {@link findPlaceholderImageByHash}
 * and {@link findPlaceholderImageByFilename} themselves; this half is enough
 * for the in-process repair pass, which only ever sees text.
 */
/**
 * Gated assets keyed by the `/images/...` string a page would actually embed
 * (an `img src`, a CSS `url(...)`), so two templates shipping the same bytes
 * under the same public path — creative-portfolio and dorin-portfolio both
 * name their guide graphic `about-me-photo.svg` — count as one reference, not
 * one per manifest row.
 */
const GATED_ASSETS_BY_REFERENCE: ReadonlyMap<string, PlaceholderImageAsset> =
  new Map(
    PLACEHOLDER_IMAGE_MANIFEST.filter((asset) =>
      isGatedPlaceholderImageRole(asset.role),
    ).map((asset) => [`/${asset.path.replace(/^public\//, '')}`, asset]),
  );

export function findPlaceholderImageReferencesInFiles(
  files: readonly { path: string; content: string }[],
): PlaceholderImageFinding[] {
  const findings: PlaceholderImageFinding[] = [];
  for (const file of files) {
    findings.push(
      ...findPlaceholderImageMarkersInText(file.path, file.content),
    );
    // `Array.from` rather than a bare `for...of` over the map, for the same
    // ES5-target reason as the marker scan above.
    for (const [needle, asset] of Array.from(GATED_ASSETS_BY_REFERENCE)) {
      if (file.content.includes(needle)) {
        findings.push({
          path: file.path,
          role: asset.role,
          reason: 'known-asset',
          asset,
        });
      }
    }
  }
  return findings;
}

const MAX_FINDINGS_LISTED = 8;

/** The findings, phrased once for the agent and for the job log. */
export function describePlaceholderImageIssue(
  findings: readonly PlaceholderImageFinding[],
): string {
  const listed = findings.slice(0, MAX_FINDINGS_LISTED);
  const detail = listed
    .map((finding) => {
      const label = finding.asset?.why ?? `matched by ${finding.reason}`;
      return `${finding.role} placeholder in ${finding.path} (${label})`;
    })
    .join('; ');
  const overflow =
    findings.length > listed.length
      ? ` and ${findings.length - listed.length} more`
      : '';
  return (
    `${PLACEHOLDER_IMAGE_SHIPPED}: the built site references a portrait or ` +
    'work-thumb placeholder image instead of the client’s own content. ' +
    'When there is no client photo, render the about section without one ' +
    '(or initials in a disc); when a project has no screenshot, render a ' +
    `typographic tile instead of stock art. Fix: ${detail}${overflow}.`
  );
}

/**
 * The files a repair pass is allowed to delete, named one per line.
 *
 * A repair brief that does not name its targets is an invitation to guess at
 * a paid site (#119 paid for that lesson with a 355-byte case-study page).
 * These are the template's own stand-in pictures, by the exact path they have
 * in the worktree, and deleting one of them is always the right answer: no
 * page should point at it, and the gate hashes `dist/`, which `public/` is
 * copied into whole, so a file left behind fails the build even once every
 * reference to it is gone.
 */
export function placeholderImageFilesToDelete(
  findings: readonly PlaceholderImageFinding[],
): string[] {
  const paths = new Set<string>();
  for (const finding of findings) {
    if (!finding.asset) continue;
    if (!isGatedPlaceholderImageRole(finding.asset.role)) continue;
    paths.add(finding.asset.path);
  }
  return Array.from(paths).sort();
}

/**
 * The whole repair brief: what is wrong, and the exact files that may go.
 *
 * Separate from {@link describePlaceholderImageIssue}, which is the gate's
 * verdict and belongs in the job's failure record unchanged. This is what an
 * agent is handed, and it is the only place in the change-request prompt set
 * that grants permission to delete a file under `public/`.
 */
export function describePlaceholderImageRepair(
  findings: readonly PlaceholderImageFinding[],
): string {
  const deletable = placeholderImageFilesToDelete(findings);
  if (deletable.length === 0) return describePlaceholderImageIssue(findings);
  return (
    `${describePlaceholderImageIssue(findings)}\n\n` +
    'These files are the template’s own placeholder pictures. Delete ' +
    'each one from the worktree, and take out every reference to it, leaving ' +
    'the component’s own no-image fallback to render:\n' +
    deletable.map((path) => `  - ${path}`).join('\n') +
    '\nDelete exactly these and no other file under public/. Add nothing ' +
    'under public/ and replace nothing under it.'
  );
}
