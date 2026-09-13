/**
 * The seed that failed, as a fixture.
 *
 * Version 4 of workspace `c009105e-f8ec-42bf-bdcf-cf92bb500f45`, the manifest
 * job `2716f978-b2ed-474b-b485-f0d5584fbda7` was seeded from on 2026-09-12:
 * five routes, and a `public/images/` that still holds the whole
 * creative-portfolio asset library because the site was published before #110
 * existed and nothing ever took it out. Two of those nine pictures are
 * actually pointed at — `boutique.png` as a case-study cover and
 * `studio-portrait.svg` in the home story section — and the other seven have
 * been dead weight since the day the site was generated.
 *
 * The bytes are the real ones, read out of the template library, because the
 * gate this fixture exists to exercise matches by content hash and a
 * plausible-looking stand-in would prove nothing.
 *
 * Shared between the codegen tests (the rule) and the build-worker tests (the
 * gate of record) rather than written twice: the whole point of the fixture is
 * that both halves are looking at the same site.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TemplateScaffoldFile } from '../../src/flowstarter/types';

/** Where the live template library actually lives, from this file. */
const TEMPLATES = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'apps',
  'flowstarter-templates',
);

/** The top-level routes this site has, as `seedPageNames` reads them. */
export const LEGACY_SEED_ROUTES = [
  '(home)',
  'about',
  'case-studies',
  'contact',
  'work',
] as const;

/**
 * Every picture the template shipped into `public/images/`, in the order the
 * failure listed them. Seven are never referenced; `boutique.png` is a
 * case-study cover and `studio-portrait.svg` is the home story photo.
 */
export const LEGACY_SEED_IMAGES = [
  'about-me-photo.svg',
  'boutique.png',
  'budget-dark.png',
  'budget-neoMorphism.png',
  'hotBlocks.png',
  'masonry.png',
  'somalia.png',
  'sweet-box.webp',
  'studio-portrait.svg',
] as const;

/** The two of them something on the site actually points at. */
export const LEGACY_SEED_REFERENCED = [
  '/images/boutique.png',
  '/images/studio-portrait.svg',
] as const;

/** The client's own rights-confirmed upload, already folded into the seed. */
export const LEGACY_SEED_CLIENT_ASSET =
  'public/flowstarter-media/cr-b104b1e0.jpg';

const BINARY = /\.(png|jpe?g|webp|gif|avif)$/i;

function page(title: string, body = ''): string {
  return (
    '---\nimport Base from "../layouts/Base.astro";\n---\n' +
    `<Base title="${title}">\n  <h1>${title}</h1>\n${body}</Base>\n`
  );
}

/**
 * The content file the whole site renders from, with the two live references
 * in the shape the template writes them: a `key: "value"` line under a
 * top-level content key.
 */
const SITE_LABELS = `---
header:
  logo: "Halden & Roe"

hero:
  title: "Design that earns its keep"
  text: "A studio for founders who would rather be specific than safe."

homeStory:
  title: "In the studio"
  paragraphs:
    - "We have spent ten years making identities, books and digital work."
  imageSrc: "/images/studio-portrait.svg"
  imageAlt: "In the studio, at the desk where the work happens"

caseStudies:
  sectionTitle: "Selected work"
  projects:
    - title: "Sable Coffee Roasters"
      category: "Identity & Retail"
      color: "#231A14"
      imageSrc: "/images/boutique.png"
      href: "/case-studies/sable-coffee-roasters"
    - title: "Riverside Clinic"
      category: "Brand & Web"
      color: "#1C1B20"
      href: "/case-studies/riverside-clinic"

aboutStory:
  title: "About the studio"
  paragraphs:
    - "We keep the studio deliberately small."
  buttonLabel: "More about us"
  buttonHref: "/about"
  imageAlt: "About the studio"
---

The rendered copy for this site lives in the frontmatter above.
`;

/**
 * The seed as the worker receives it: source files as text, images as base64
 * exactly the way `readSiteWorkspaceFiles` stores them.
 */
export async function legacySeedFiles(): Promise<TemplateScaffoldFile[]> {
  const images = await Promise.all(
    LEGACY_SEED_IMAGES.map(async (name) => {
      const bytes = await readFile(
        join(TEMPLATES, 'creative-portfolio', 'public', 'images', name),
      );
      return BINARY.test(name)
        ? {
            path: `public/images/${name}`,
            content: bytes.toString('base64'),
            encoding: 'base64' as const,
            type: 'file' as const,
          }
        : {
            path: `public/images/${name}`,
            content: bytes.toString('utf8'),
            type: 'file' as const,
          };
    }),
  );

  return [
    { path: 'src/pages/index.astro', content: page('Home'), type: 'file' },
    { path: 'src/pages/about.astro', content: page('About'), type: 'file' },
    { path: 'src/pages/work.astro', content: page('Work'), type: 'file' },
    {
      path: 'src/pages/contact.astro',
      content: page('Contact'),
      type: 'file',
    },
    {
      path: 'src/pages/case-studies/[slug].astro',
      content: page('Case study'),
      type: 'file',
    },
    {
      path: 'src/layouts/Base.astro',
      content: '---\nconst { title } = Astro.props;\n---\n<slot />\n',
      type: 'file',
    },
    { path: 'src/content/site-labels.md', content: SITE_LABELS, type: 'file' },
    {
      path: 'src/content/case-studies/sable-coffee-roasters.md',
      content: '---\ntitle: Sable Coffee Roasters\n---\nWhat we did.\n',
      type: 'file',
    },
    {
      path: 'src/content/case-studies/riverside-clinic.md',
      content: '---\ntitle: Riverside Clinic\n---\nWhat we did.\n',
      type: 'file',
    },
    {
      path: 'public/robots.txt',
      content: 'User-agent: *\nAllow: /\n',
      type: 'file',
    },
    {
      // The client's own picture, rights confirmed, folded in at claim time.
      // Nothing in this rule may ever touch it.
      path: LEGACY_SEED_CLIENT_ASSET,
      content: Buffer.from('not-really-a-jpeg').toString('base64'),
      encoding: 'base64',
      type: 'file',
    },
    ...images,
  ];
}
