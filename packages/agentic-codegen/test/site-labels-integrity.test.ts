/**
 * The `[integrity]` gate for `src/content/site-labels.md`.
 *
 * The fixture below is the real file from the production incident this gate
 * exists to catch: job `7508bf52` (2026-09-14, workspace `flowstarter-dgtcyh`)
 * shipped `src/content/site-labels.md` 277 lines long, opening with `---` on
 * line 1 and never closing it. Astro's own frontmatter parser found no
 * closing fence and parsed no labels at all, so every page shipped with an
 * empty `<h1>` and a bare "Home" `<title>` — silently, because
 * `required-label-blocks.ts`'s line-scan still found `hero:` and
 * `contactPage:` as plain lines of text and reported nothing missing.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { splitFrontmatter } from '../src/yaml-blocks';
import { missingRequiredLabelBlocksFromParsed } from '../src/flowstarter/required-label-blocks';
import {
  checkSiteLabelsIntegrity,
  LABELS_UNPARSEABLE,
  SiteLabelsUnparseableError,
} from '../src/flowstarter/site-labels-integrity';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function workspaceWithFile(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'site-labels-integrity-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'src/content'), { recursive: true });
  await writeFile(join(root, 'src/content/site-labels.md'), content, 'utf8');
  return root;
}

/**
 * `run5/site-labels-unterminated.md`, verbatim: 277 lines, `---` on line 1,
 * no closing fence anywhere, the client's approved headline on line 20, and
 * a YAML block scalar (`hero.text: |`) partway through — real enough that a
 * repair that only handled a toy one-block file would not prove anything.
 */
const RUN5_UNTERMINATED_SITE_LABELS = `---
siteMeta:
  title: "Flowstarter — AI-driven website studio"
  description: "Flowstarter builds professional websites with AI agents, supervised by people. Sharp, fast sites that earn your visitors' trust and turn interest into enquiries."
header:
  logo: "Flowstarter"
  menuAriaLabel: "Toggle menu"
  ctaLabel: "Start your enquiry"
  navLinks:
    - label: "Home"
      href: "/"
    - label: "Work"
      href: "/work"
    - label: "Studio"
      href: "/about"
    - label: "Contact"
      href: "/contact"
hero:
  label: "AI-driven website studio"
  title: "I build websites with AI agents, supervised by people"
  text: |
    I build professional websites for founders and small business owners. AI agents handle the heavy lifting while I check every detail.

    The result is a site that looks sharp, loads fast, and turns curious visitors into real enquiries — at a pace a traditional studio cannot match.
  image: "/flowstarter-assets/generated-hero.png"
  highlights:
    - "supervised by people"
    - "AI agents"
    - "looks sharp"
    - "real enquiries"
  actions:
    - label: "Start your enquiry"
      href: "/contact"
      outline: false
  tags:
    - "AI-assisted design"
    - "Human oversight"
    - "Fast delivery"
    - "Built for trust"
cta:
  heading: "Need a site that earns trust? Tell me about your business and I will show you how I would build it."
  buttonLabel: "Start your enquiry"
  buttonHref: "/contact"
caseStudies:
  sectionLabel: "Selected work"
  sectionTitle: "Sites I have built"
  sectionDescription: "Three projects built with AI agents under human supervision — each shipped fast, reviewed line by line, and tuned to earn trust."
  projects:
    - title: "Flowstarter"
      category: "Website studio"
      imageSrc: "/flowstarter-media/brief-7e491496.jpg"
      href: "https://flowstarter.net"
      description: "AI-powered websites for small businesses: brand discovery, tailored previews, reviewed builds, managed hosting, and an AI editor."
      color: "#1B2A4A"
    - title: "Ereno"
      category: "Travel companion"
      imageSrc: "/flowstarter-media/brief-34341965.jpg"
      href: "https://ereno.flowstarter.dev"
      description: "Conversational travel companion for trip planning and base scouting. A greenfield rebuild of Ask Sage."
      color: "#3D6A9F"
    - title: "DMPResearch"
      category: "Studio site"
      imageSrc: "/flowstarter-media/brief-ffd08125.jpg"
      href: "https://dmpresearch.flowstarter.dev"
      description: "The studio site: premium websites, web apps and product systems, where agents do the grind and people keep the judgment."
      color: "#B55418"
followBar:
  title: "Where to find me →"
  socials:
    - label: "Contact"
      href: "/contact"
expertise:
  sectionLabel: "How I work"
  sectionTitle: "AI speed, human judgement"
  items:
    - number: "01"
      title: "Tell me about the business"
      description: "I start with what you sell, who you sell it to, and what a visitor needs to believe before they get in touch."
about:
  sectionLabel: "What I believe"
  title: "A good website is one that earns trust"
  circles:
    - line1: "BUILT"
      line2: "BY AI"
    - line1: "CHECKED"
    - line1: "BY"
      line2: "ME"
  text: "AI makes the work fast and affordable. My oversight is what makes it good."
services:
  sectionLabel: "What I do"
  sectionTitleLines:
    - "Websites that"
    - "work as hard as you do"
  items:
    - title: "Professional websites"
      description: "A complete site for your business, built fast and checked line by line by me"
servicesPage:
  heroLines:
    - text: "Websites built"
    - text: "by AI agents,"
    - text: "supervised"
      accent: "by me"
  faq:
    title: "The questions founders ask me first"
    items:
      - question: "What does 'AI agents, supervised by people' actually mean?"
        answer: "My AI agents draft and assemble the site. I then review and correct everything before it reaches you."
aboutStory:
  title: "The studio"
  paragraphs:
    - "Flowstarter is my AI-driven website studio, built around a simple idea: let agents do the heavy lifting, and supervise every step myself."
  buttonLabel: "More about the studio"
  buttonHref: "/about"
aboutPage:
  heroLines:
    - text: "An AI-driven studio where"
    - text: "every site is built fast and"
      accent: "with care"
  intro:
    eyebrow: "Small by design, fast by method"
    paragraphs:
      - "Flowstarter pairs automated speed with human oversight."
    buttonLabel: "Connect with me"
    buttonHref: "/contact"
    imageSrc: ""
    imageAlt: ""
    portraitPlaceholder: "A photograph of me will follow."
  journey:
    title: "Studio milestones"
    intro: ""
    items: []
  articles:
    title: "Notes from the studio"
    buttonLabel: "Read more insights"
    buttonHref: "/contact"
blogPage:
  heroLines:
    - text: "Notes on building"
      accent: "trustworthy websites"
contactPage:
  heroLines:
    - text: "Tell me about"
      accent: "your business"
    - text: "and I will show you"
      accent: "how I would build it"
  introText: ""
  form:
    title: "Start your enquiry"
    note: "All fields are required"
    submitLabel: "Send message"
    successMessage: "Thank you. Your email application should now be open with your message ready to send."
  details:
    emailLabel: "Website"
    emailValue: "flowstarter.net"
    emailHref: "https://flowstarter.net"
    strategicCallLabel: "Start your enquiry"
    strategicCallHref: "/contact"
stats:
  items: []
testimonials: []
footer:
  logo: "Flowstarter"
  tagline: "An AI-driven website studio. Websites built by AI agents, supervised by people."
  columns:
    - heading: "Studio"
      links:
        - label: "Home"
          href: "/"
    - heading: "Contact"
      links:
        - label: "Start your enquiry"
          href: "/contact"
  socialAriaLabels:
    - "LinkedIn"
    - "Contact"
    - "Email"
  copyrightSuffix: "Flowstarter. All rights reserved."
`;

describe('checkSiteLabelsIntegrity — the run5 shape', () => {
  it('closes the unterminated frontmatter deterministically and parses the client’s approved headline', async () => {
    const root = await workspaceWithFile(RUN5_UNTERMINATED_SITE_LABELS);

    const result = await checkSiteLabelsIntegrity(root);

    expect(result?.repaired).toBe(true);
    expect(result?.parsed.hero).toMatchObject({
      title: 'I build websites with AI agents, supervised by people',
    });
    expect(result?.parsed.contactPage).toBeDefined();

    // The fix is on disk, not just in memory: the file itself now opens AND
    // closes, so every other reader (Astro's real build, a second call to
    // this same check) sees the same, now-valid file.
    const onDisk = await readFile(
      join(root, 'src/content/site-labels.md'),
      'utf8',
    );
    const fm = splitFrontmatter(onDisk);
    expect(fm.hasFm).toBe(true);
    expect(onDisk.trimEnd().endsWith('---')).toBe(true);

    // Nothing about the labels changed — only the missing fence was added.
    expect(onDisk.startsWith(RUN5_UNTERMINATED_SITE_LABELS.trimEnd())).toBe(
      true,
    );
  });

  it('leaves the required-blocks check with nothing missing once repaired', async () => {
    const root = await workspaceWithFile(RUN5_UNTERMINATED_SITE_LABELS);
    const result = await checkSiteLabelsIntegrity(root);
    expect(
      missingRequiredLabelBlocksFromParsed(
        result?.parsed,
        'professional-services',
      ),
    ).toEqual([]);
  });

  it('is a no-op (repaired: false) on a properly closed file', async () => {
    const closed = `${RUN5_UNTERMINATED_SITE_LABELS.trimEnd()}\n---\n`;
    const root = await workspaceWithFile(closed);
    const result = await checkSiteLabelsIntegrity(root);
    expect(result?.repaired).toBe(false);
    expect(result?.parsed.hero).toMatchObject({
      title: 'I build websites with AI agents, supervised by people',
    });
    const onDisk = await readFile(
      join(root, 'src/content/site-labels.md'),
      'utf8',
    );
    expect(onDisk).toBe(closed);
  });
});

describe('checkSiteLabelsIntegrity — failure modes', () => {
  it('returns undefined when there is no file to check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'site-labels-integrity-'));
    temporaryDirectories.push(root);
    expect(await checkSiteLabelsIntegrity(root)).toBeUndefined();
  });

  it('fails with LABELS_UNPARSEABLE when the file does not open with a fence at all', async () => {
    const root = await workspaceWithFile('hero:\n  title: "No fence here"\n');
    await expect(checkSiteLabelsIntegrity(root)).rejects.toMatchObject({
      code: LABELS_UNPARSEABLE,
    });
  });

  it('fails with LABELS_UNPARSEABLE when an unterminated fence’s remainder is not valid YAML', async () => {
    // The same shape as run5, but truncated mid-value: this is not "add the
    // missing fence and it works", it genuinely cannot be repaired without
    // guessing what the rest of the line was supposed to say.
    const brokenRemainder = '---\nhero:\n  title: "unterminated string\n';
    const root = await workspaceWithFile(brokenRemainder);
    let caught: unknown;
    try {
      await checkSiteLabelsIntegrity(root);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SiteLabelsUnparseableError);
    expect((caught as SiteLabelsUnparseableError).code).toBe(
      LABELS_UNPARSEABLE,
    );
    expect((caught as SiteLabelsUnparseableError).message).not.toBe('');

    // Never repaired: the file on disk is untouched.
    const onDisk = await readFile(
      join(root, 'src/content/site-labels.md'),
      'utf8',
    );
    expect(onDisk).toBe(brokenRemainder);
  });

  it('fails with LABELS_UNPARSEABLE when the fences close onto something other than a map', async () => {
    const root = await workspaceWithFile('---\n- just\n- a\n- list\n---\n');
    await expect(checkSiteLabelsIntegrity(root)).rejects.toMatchObject({
      code: LABELS_UNPARSEABLE,
    });
  });

  it('fails with LABELS_UNPARSEABLE when the fences close onto YAML that does not parse', async () => {
    const root = await workspaceWithFile(
      '---\nhero:\n  title: "unterminated\n---\n',
    );
    await expect(checkSiteLabelsIntegrity(root)).rejects.toMatchObject({
      code: LABELS_UNPARSEABLE,
    });
  });
});
