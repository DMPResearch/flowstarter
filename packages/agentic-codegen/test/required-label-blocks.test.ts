import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { splitFrontmatter, topLevelKeys } from '../src/yaml-blocks';
import {
  findMissingLabelBlocks,
  repairMissingLabelBlocks,
  REQUIRED_LABEL_BLOCKS,
  type RequiredBlockRepairInput,
} from '../src/flowstarter/required-label-blocks';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function workspaceWithLabels(yamlBody: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'required-label-blocks-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'src/content'), { recursive: true });
  await writeFile(
    join(root, 'src/content/site-labels.md'),
    `---\n${yamlBody}\n---\n`,
    'utf8',
  );
  return root;
}

const FULL_LABELS = `siteMeta:
  title: "Halden & Roe"
  description: "A consultancy."
header:
  logo: "Halden & Roe"
hero:
  title: "Decisions that hold under pressure"
  text: "We help leaders decide well."
  actions:
    - label: "Book a session"
      href: "/book"
contactPage:
  titleLines:
    - text: "Tell us about the decision"
  introText: "Reach out."
  form:
    submitLabel: "Send message"`;

const MISSING_HERO_LABELS = `siteMeta:
  title: "Halden & Roe"
  description: "A consultancy."
header:
  logo: "Halden & Roe"
contactPage:
  titleLines:
    - text: "Tell us about the decision"
  introText: "Reach out."
  form:
    submitLabel: "Send message"`;

const REPAIR_INPUT: RequiredBlockRepairInput = {
  businessName: 'Halden & Roe',
  offer: 'Independent operations and strategy consulting.',
  ctaLabel: 'Book now',
  ctaHref: '/book',
};

describe('REQUIRED_LABEL_BLOCKS', () => {
  it('requires hero and contactPage for every real template, and leaves demo-coach out', () => {
    for (const [slug, blocks] of Object.entries(REQUIRED_LABEL_BLOCKS)) {
      expect(slug).not.toBe('demo-coach');
      expect(blocks).toEqual(expect.arrayContaining(['hero', 'contactPage']));
    }
    expect(REQUIRED_LABEL_BLOCKS['demo-coach']).toBeUndefined();
  });
});

describe('findMissingLabelBlocks', () => {
  it('reports hero missing when the file lacks it', async () => {
    const root = await workspaceWithLabels(MISSING_HERO_LABELS);
    expect(await findMissingLabelBlocks(root, 'professional-services')).toEqual(
      ['hero'],
    );
  });

  it('reports nothing missing for a fully-populated file', async () => {
    const root = await workspaceWithLabels(FULL_LABELS);
    expect(await findMissingLabelBlocks(root, 'professional-services')).toEqual(
      [],
    );
  });

  it('returns [] rather than throwing when the file cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'required-label-blocks-'));
    temporaryDirectories.push(root);
    expect(await findMissingLabelBlocks(root, 'professional-services')).toEqual(
      [],
    );
  });

  it('returns [] for a template with no required blocks configured', async () => {
    const root = await workspaceWithLabels(MISSING_HERO_LABELS);
    expect(await findMissingLabelBlocks(root, 'demo-coach')).toEqual([]);
    expect(await findMissingLabelBlocks(root, 'unknown-slug')).toEqual([]);
  });
});

describe('repairMissingLabelBlocks', () => {
  it('appends a deterministic hero block carrying the business name and CTA', async () => {
    const root = await workspaceWithLabels(MISSING_HERO_LABELS);
    await repairMissingLabelBlocks(root, ['hero'], REPAIR_INPUT);

    const raw = await readFile(
      join(root, 'src/content/site-labels.md'),
      'utf8',
    );
    const { yaml, hasFm } = splitFrontmatter(raw);
    expect(hasFm).toBe(true);
    expect(topLevelKeys(yaml)).toContain('hero');
    expect(yaml).toContain(REPAIR_INPUT.businessName);
    expect(yaml).toContain(REPAIR_INPUT.ctaLabel);
    expect(yaml).toContain(REPAIR_INPUT.ctaHref);
    // The rest of the file survives untouched.
    expect(topLevelKeys(yaml)).toContain('contactPage');
    expect(yaml).toContain('siteMeta:');
  });

  it('appends a deterministic contactPage block when that is what is missing', async () => {
    const noContactPage = `siteMeta:
  title: "Halden & Roe"
hero:
  title: "Decisions that hold under pressure"
  text: "We help leaders decide well."
  actions:
    - label: "Book a session"
      href: "/book"`;
    const root = await workspaceWithLabels(noContactPage);
    await repairMissingLabelBlocks(root, ['contactPage'], REPAIR_INPUT);

    const raw = await readFile(
      join(root, 'src/content/site-labels.md'),
      'utf8',
    );
    const { yaml } = splitFrontmatter(raw);
    expect(topLevelKeys(yaml)).toContain('contactPage');
    expect(yaml).toContain(REPAIR_INPUT.businessName);
    expect(yaml).toContain(REPAIR_INPUT.ctaLabel);
    expect(yaml).toContain(REPAIR_INPUT.ctaHref);
  });

  it('falls back to a generic sentence when the intake carried no offer', async () => {
    const root = await workspaceWithLabels(MISSING_HERO_LABELS);
    await repairMissingLabelBlocks(root, ['hero'], {
      businessName: 'Halden & Roe',
      ctaLabel: 'Get in touch',
      ctaHref: '/contact',
    });
    const raw = await readFile(
      join(root, 'src/content/site-labels.md'),
      'utf8',
    );
    const { yaml } = splitFrontmatter(raw);
    expect(yaml).toContain('Halden & Roe');
  });

  it('safely quotes a business name that could otherwise break the YAML', async () => {
    const root = await workspaceWithLabels(MISSING_HERO_LABELS);
    const hostile: RequiredBlockRepairInput = {
      businessName: 'Evil" \n injected: true\n#',
      offer: 'Say "hi"\nfor us',
      ctaLabel: 'Go',
      ctaHref: '/contact',
    };
    await repairMissingLabelBlocks(root, ['hero'], hostile);

    const raw = await readFile(
      join(root, 'src/content/site-labels.md'),
      'utf8',
    );
    const { yaml } = splitFrontmatter(raw);
    // No new top-level key was injected by the hostile string.
    expect(topLevelKeys(yaml).sort()).toEqual(
      ['siteMeta', 'header', 'contactPage', 'hero'].sort(),
    );
  });

  it('is a no-op when nothing is missing', async () => {
    const root = await workspaceWithLabels(FULL_LABELS);
    const before = await readFile(
      join(root, 'src/content/site-labels.md'),
      'utf8',
    );
    await repairMissingLabelBlocks(root, [], REPAIR_INPUT);
    const after = await readFile(
      join(root, 'src/content/site-labels.md'),
      'utf8',
    );
    expect(after).toBe(before);
  });

  it('throws a clear error for a block name it does not know how to construct', async () => {
    const root = await workspaceWithLabels(MISSING_HERO_LABELS);
    await expect(
      repairMissingLabelBlocks(root, ['someUnknownBlock'], REPAIR_INPUT),
    ).rejects.toThrow(/someUnknownBlock/);
  });
});
