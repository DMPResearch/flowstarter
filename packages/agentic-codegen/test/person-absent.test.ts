/**
 * The PERSON_ABSENT gate, over fixture markup and over two real Astro builds.
 *
 * The fixture assertions are the rule; the two real builds are the proof that
 * the rule is looking at what a template actually emits. They matter for the
 * same reason `empty-image.test.ts` builds for real: the defect this gate
 * exists for is a defect in a rendered page, and a string a test wrote by hand
 * cannot tell you whether the about component put the client's sentences on
 * the page or quietly dropped them.
 *
 * One build is English and one is Romanian, because the story match is word
 * based and a rule that only ever ran over English would have gone unnoticed
 * failing on diacritics.
 *
 * Skipped, loudly, when the template has no installed `astro` binary: a
 * developer who has not run `pnpm install` deserves a reason, not a failure
 * about a missing file.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import {
  MIN_STORY_PHRASES,
  PERSON_ABSENT,
  PERSON_ABSENT_ASK,
  judgePersonAbsent,
  pageCarriesStory,
  shingles,
  storyPhraseMatches,
} from '../src/flowstarter/person-absent';
import {
  describePerson,
  hasPersonStory,
  parsePerson,
  personStoryText,
  type BriefPerson,
} from '../src/flowstarter/person';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const templatesRoot = join(repoRoot, 'apps/flowstarter-templates');

function person(fields: Partial<BriefPerson>): BriefPerson {
  return {
    name: '',
    headline: '',
    story: '',
    howIWork: '',
    values: '',
    feel: '',
    toneWords: [],
    links: [],
    proudestWork: '',
    activity: { what: '', who: '', typical: '', knownFor: '', years: '' },
    sourcedBio: null,
    ...fields,
  };
}

const SAM_STORY =
  'I spent six years inside product teams before going out on my own, ' +
  'which is why I would rather sit in a support queue for an afternoon ' +
  'than run a workshop about personas.';

const IOANA_STORY =
  'Am inceput sa fotografiez nunti pentru ca mi-a placut sa privesc ' +
  'oamenii cand uita ca sunt priviti. Nu regizez nimic si nu cer ' +
  'nimanui sa zambeasca la comanda.';

function aboutPage(body: string): { path: string; content: string } {
  return {
    path: 'about/index.html',
    content: `<!doctype html><html><head><title>About</title></head><body>${body}</body></html>`,
  };
}

const PORTFOLIO = { businessType: 'Creative & design freelance designer' };

// ───────────────────────────────────────────────────────────────────────────
// The rule
// ───────────────────────────────────────────────────────────────────────────

describe('pageCarriesStory', () => {
  test('accepts the story quoted verbatim', () => {
    expect(pageCarriesStory(`<p>${SAM_STORY}</p>`, SAM_STORY)).toBe(true);
  });

  test('accepts the story after the light editing the agent is told to do', () => {
    // Re-punctuated and trimmed, which is exactly what "quote and lightly
    // edit" produces and exactly what an exact-match gate would fail.
    const edited =
      '<p>Six years inside product teams before going out on my own. ' +
      'Which is why I would rather sit in a support queue for an afternoon ' +
      'than run a workshop about personas.</p>';
    expect(pageCarriesStory(edited, SAM_STORY)).toBe(true);
  });

  test('rejects studio boilerplate that shares no words with the story', () => {
    const generic =
      '<p>We are a multidisciplinary studio delivering bespoke digital ' +
      'experiences for ambitious brands across every sector.</p>';
    expect(pageCarriesStory(generic, SAM_STORY)).toBe(false);
  });

  test('reads Romanian prose, diacritics and all', () => {
    expect(pageCarriesStory(`<p>${IOANA_STORY}</p>`, IOANA_STORY)).toBe(true);
    expect(
      pageCarriesStory(
        '<p>Un studio creativ care ofera solutii vizuale complete.</p>',
        IOANA_STORY,
      ),
    ).toBe(false);
  });

  test('ignores markup, scripts and styles', () => {
    const noisy =
      `<style>.x{content:"nothing"}</style><script>var a="nothing"</script>` +
      `<div class="prose"><p><em>${SAM_STORY}</em></p></div>`;
    expect(pageCarriesStory(noisy, SAM_STORY)).toBe(true);
  });

  test('measures runs of words rather than a bag of them', () => {
    expect(shingles('one two three four five six seven')).toContain(
      'one two three four five six',
    );
    // The regression this shape exists for: a page that shares a genre's
    // vocabulary with the story, and not one phrase of it. The first version
    // of this rule counted matching words and passed a real build carrying a
    // different person's story entirely.
    const sameVocabulary =
      '<p>Eleven years of product work with support teams, before and ' +
      'after going out on my own, in a workshop rather than a queue.</p>';
    expect(storyPhraseMatches(sameVocabulary, SAM_STORY, 1)).toBeGreaterThan(
      MIN_STORY_PHRASES,
    );
    expect(pageCarriesStory(sameVocabulary, SAM_STORY)).toBe(false);
  });
});

describe('judgePersonAbsent', () => {
  test('has no opinion about a services business', () => {
    const verdict = judgePersonAbsent(
      [aboutPage('<p>We fit boilers across south Leeds.</p>')],
      {
        businessType: 'Plumbing and heating, boilers and bathrooms',
        person: person({ story: SAM_STORY }),
      },
    );
    expect(verdict.verdict).toBe('not-applicable');
  });

  test('has no opinion when nobody was ever asked', () => {
    // Every workspace taken before the person section existed. A gate that
    // guessed here would fail the whole backlog.
    const verdict = judgePersonAbsent(
      [aboutPage('<p>A studio for ambitious brands.</p>')],
      { ...PORTFOLIO, person: null },
    );
    expect(verdict.verdict).toBe('not-applicable');
  });

  test('passes a portfolio whose about page is made of the client words', () => {
    const verdict = judgePersonAbsent(
      [
        aboutPage(
          `<h1>Sam Okafor</h1><p>${SAM_STORY}</p>` +
            `<img src="/flowstarter-media/sam-portrait.jpg" alt="Sam Okafor">`,
        ),
      ],
      {
        ...PORTFOLIO,
        person: person({ name: 'Sam Okafor', story: SAM_STORY }),
        portraitPath: '/flowstarter-media/sam-portrait.jpg',
      },
    );
    expect(verdict.verdict).toBe('pass');
  });

  test('fails a portfolio that had the story and wrote boilerplate instead', () => {
    const verdict = judgePersonAbsent(
      [
        aboutPage(
          '<h1>About the studio</h1><p>We are a multidisciplinary studio ' +
            'delivering bespoke digital experiences for ambitious brands.</p>' +
            '<img src="/flowstarter-media/sam-portrait.jpg" alt="Sam">',
        ),
      ],
      {
        ...PORTFOLIO,
        person: person({ name: 'Sam Okafor', story: SAM_STORY }),
        portraitPath: '/flowstarter-media/sam-portrait.jpg',
      },
    );
    expect(verdict.verdict).toBe('fail');
    if (verdict.verdict !== 'fail') return;
    expect(verdict.findings.map((f) => f.code)).toContain(
      'story_not_on_about_page',
    );
    // The feedback carries the sentences the agent is to use, not a code.
    expect(verdict.issue).toContain(PERSON_ABSENT);
    expect(verdict.issue).toContain(SAM_STORY);
  });

  test('fails a portfolio that had the photograph and did not place it', () => {
    const verdict = judgePersonAbsent(
      [aboutPage(`<h1>Sam Okafor</h1><p>${SAM_STORY}</p>`)],
      {
        ...PORTFOLIO,
        person: person({ name: 'Sam Okafor', story: SAM_STORY }),
        portraitPath: '/flowstarter-media/sam-portrait.jpg',
      },
    );
    expect(verdict.verdict).toBe('fail');
    if (verdict.verdict !== 'fail') return;
    expect(verdict.findings.map((f) => f.code)).toContain(
      'portrait_not_placed',
    );
    expect(verdict.issue).toContain('/flowstarter-media/sam-portrait.jpg');
  });

  test('fails a portfolio with no about page at all', () => {
    const verdict = judgePersonAbsent(
      [
        {
          path: 'index.html',
          content: '<html><body><h1>Hi</h1></body></html>',
        },
      ],
      { ...PORTFOLIO, person: person({ story: SAM_STORY }) },
    );
    expect(verdict.verdict).toBe('fail');
  });

  test('holds with an ask when the brief has neither', () => {
    // The accountant who was asked and skipped everything. No attempt at
    // writing can fix this, so it never gets a repair pass.
    const verdict = judgePersonAbsent(
      [aboutPage('<p>Bookkeeping and VAT for small limited companies.</p>')],
      { ...PORTFOLIO, person: person({}) },
    );
    expect(verdict.verdict).toBe('hold');
    if (verdict.verdict !== 'hold') return;
    expect(verdict.ask).toBe(PERSON_ABSENT_ASK);
    // The ask names both ways out and neither of them is jargon.
    expect(verdict.ask).toContain('photograph');
    expect(verdict.ask).toContain('own words');
    expect(verdict.ask).not.toContain(PERSON_ABSENT);
  });

  test('finds the about section on a one-page site', () => {
    const verdict = judgePersonAbsent(
      [
        {
          path: 'index.html',
          content: `<html><body><section id="about"><p>${SAM_STORY}</p></section></body></html>`,
        },
      ],
      { ...PORTFOLIO, person: person({ story: SAM_STORY }) },
    );
    expect(verdict.verdict).toBe('pass');
  });

  test('an approved sourced bio counts as a story and a pending one does not', () => {
    const pending = person({
      sourcedBio: {
        excerpt: SAM_STORY,
        source: 'github-bio',
        sourceUrl: 'https://github.com/samokafor',
        fetchedAt: '2026-09-15T09:00:00.000Z',
        adoptedAt: null,
      },
    });
    expect(hasPersonStory(pending)).toBe(false);
    expect(personStoryText(pending)).toBe('');

    const adopted = person({
      sourcedBio: {
        ...pending.sourcedBio!,
        adoptedAt: '2026-09-15T10:00:00.000Z',
      },
    });
    expect(hasPersonStory(adopted)).toBe(true);
    expect(personStoryText(adopted)).toBe(SAM_STORY);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// What the agent is told
// ───────────────────────────────────────────────────────────────────────────

describe('describePerson', () => {
  test('says the client phrasing wins, and quotes it', () => {
    const paragraph = describePerson(
      person({
        name: 'Sam Okafor',
        story: SAM_STORY,
        howIWork: 'I start with whatever is already shipped.',
        toneWords: ['plain', 'direct', 'warm'],
        activity: {
          what: 'Product and interface design.',
          who: 'Small software teams',
          typical: '',
          knownFor: 'Untangling onboarding',
          years: 'eleven years',
        },
      }),
    );
    expect(paragraph).toContain("client's phrasing wins");
    expect(paragraph).toContain(SAM_STORY);
    expect(paragraph).toContain('Never invent biography');
    expect(paragraph).toContain('plain, direct, warm');
    // The activity block is what stops the services page saying nothing.
    expect(paragraph).toContain('Untangling onboarding');
    expect(paragraph).toContain('bespoke solutions');
  });

  test('says nothing at all about a person who was never asked', () => {
    expect(describePerson(null)).toBe('');
  });

  test('says nothing about a person who was asked and skipped', () => {
    expect(describePerson(person({}))).toBe('');
  });

  test('warns the agent off a bio nobody approved', () => {
    const paragraph = describePerson(
      person({
        name: 'Sam Okafor',
        sourcedBio: {
          excerpt: SAM_STORY,
          source: 'github-bio',
          sourceUrl: 'https://github.com/samokafor',
          fetchedAt: '2026-09-15T09:00:00.000Z',
          adoptedAt: null,
        },
      }),
    );
    expect(paragraph).toContain('has NOT');
    expect(paragraph).toContain('Do not use it');
  });

  test('keeps Romanian prose intact on the way to the prompt', () => {
    const paragraph = describePerson(
      person({ name: 'Ioana Petrescu', story: IOANA_STORY }),
    );
    expect(paragraph).toContain(IOANA_STORY);
  });
});

describe('parsePerson', () => {
  test('tells "never asked" from "asked and skipped"', () => {
    expect(parsePerson(null)).toBeNull();
    expect(parsePerson(undefined)).toBeNull();
    expect(parsePerson('not an object')).toBeNull();
    expect(parsePerson({})).not.toBeNull();
  });

  test('refuses a link that is not somewhere we would publish', () => {
    const parsed = parsePerson({
      links: [
        { kind: 'github', url: 'http://github.com/x', consented: true },
        { kind: 'linkedin', url: 'https://u:p@linkedin.com/in/x' },
        { kind: 'website', url: 'https://example.com', consented: true },
        { kind: 'nonsense', url: 'https://example.org' },
      ],
    });
    expect(parsed?.links.map((link) => link.kind)).toEqual(['website']);
  });

  test('drops a sourced bio with no page behind it', () => {
    // Provenance is the entire point of the field, so an excerpt nobody can
    // check is not kept at a lower confidence, it is not kept.
    expect(
      parsePerson({
        sourcedBio: {
          excerpt: SAM_STORY,
          source: 'github-bio',
          sourceUrl: '',
        },
      })?.sourcedBio,
    ).toBeNull();
  });

  test('keeps at most three tone words and lowercases them', () => {
    expect(
      parsePerson({ toneWords: ['Plain', 'Direct', 'Warm', 'Loud'] })
        ?.toneWords,
    ).toEqual(['plain', 'direct', 'warm']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Two real builds
// ───────────────────────────────────────────────────────────────────────────

/**
 * Builds `creative-portfolio` with one persona's own words written into the
 * about section of `site-labels.md`, then runs the gate over the real `dist/`.
 *
 * This is the whole path the agent is asked to walk, minus the agent: the
 * client's sentences go into the content layer, Astro renders them, and the
 * gate reads the rendered page. If the about component ever stops rendering
 * `intro.paragraphs`, or an author renames the key, this fails here rather
 * than on somebody's paid build.
 */
async function buildWithStory(input: {
  label: string;
  story: string;
  eyebrow: string;
  siteTitle: string;
  portraitPath: string | null;
}): Promise<Array<{ path: string; content: string }>> {
  const template = join(templatesRoot, 'creative-portfolio');
  const workspace = await mkdtemp(
    join(tmpdir(), `person-absent-${input.label}-`),
  );
  try {
    await cp(template, workspace, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${template}${sep}node_modules`) &&
        !source.includes(`${template}${sep}dist`) &&
        !source.includes(`${template}${sep}.astro`),
    });
    await symlink(
      join(template, 'node_modules'),
      join(workspace, 'node_modules'),
      'dir',
    );

    const labelsPath = join(workspace, 'src/content/site-labels.md');
    const labels = await readFile(labelsPath, 'utf8');

    // The about intro, replaced with this person's own sentences: exactly
    // what a correct build produces and what the prompt instructs.
    const withStory = labels
      .replace(
        /(aboutPage:[\s\S]*?intro:\n)([\s\S]*?)(\n  freeTime:)/,
        (_whole, head: string, _body: string, tail: string) =>
          `${head}    eyebrow: ${JSON.stringify(input.eyebrow)}\n` +
          `    paragraphs:\n      - ${JSON.stringify(input.story)}\n` +
          `    buttonLabel: "CONTACT"\n` +
          `    buttonHref: "/contact"\n` +
          `    imageSrc: ${JSON.stringify(input.portraitPath ?? '')}\n` +
          `    imageAlt: ${JSON.stringify(input.siteTitle)}${tail}`,
      )
      .replace(
        /^(\s+)title: ".*"$/m,
        (_whole, indent: string) =>
          `${indent}title: ${JSON.stringify(input.siteTitle)}`,
      );
    expect(
      withStory,
      `${input.label}: the about intro block was not rewritten`,
    ).toContain(input.story);
    await writeFile(labelsPath, withStory);

    // Same reason `empty-image.test.ts` does this: `node_modules` is a
    // symlink to the shared template directory, so Vite's optimizer cache is
    // shared too, and two real builds racing to write it produce an
    // ENOTEMPTY that has nothing to do with either site.
    const configOverrideName = 'flowstarter-test-astro.config.mjs';
    await writeFile(
      join(workspace, configOverrideName),
      "import { mergeConfig } from 'astro/config';\n" +
        "import base from './astro.config.mjs';\n" +
        `export default mergeConfig(base, { vite: { cacheDir: ${JSON.stringify(
          join(workspace, '.vite-cache'),
        )} } });\n`,
      'utf8',
    );

    await run(
      join(template, 'node_modules/.bin/astro'),
      ['build', '--config', configOverrideName],
      { cwd: workspace },
    );

    const distDir = join(workspace, 'dist');
    const files: Array<{ path: string; content: string }> = [];
    const walk = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const absolute = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!/\.html?$/i.test(entry.name)) continue;
        files.push({
          path: relative(distDir, absolute).split(sep).join('/'),
          content: await readFile(absolute, 'utf8'),
        });
      }
    };
    await walk(distDir);
    expect(
      files.length,
      `${input.label}: astro build produced no HTML under dist/`,
    ).toBeGreaterThan(0);
    return files;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe('the gate on a real build of creative-portfolio', () => {
  const template = join(templatesRoot, 'creative-portfolio');
  const buildable = existsSync(join(template, 'node_modules/.bin/astro'));

  test('passes an English build whose about page carries the client story', async () => {
    if (!buildable) {
      console.warn(
        'creative-portfolio has no installed astro binary; skipping the ' +
          'real-build PERSON_ABSENT check (run `pnpm install` first)',
      );
      return;
    }
    const files = await buildWithStory({
      label: 'en',
      story: SAM_STORY,
      eyebrow: 'Sam Okafor, freelance product designer',
      siteTitle: 'Sam Okafor',
      portraitPath: null,
    });
    const verdict = judgePersonAbsent(files, {
      ...PORTFOLIO,
      person: person({ name: 'Sam Okafor', story: SAM_STORY }),
    });
    expect(
      verdict.verdict,
      verdict.verdict === 'fail' ? verdict.issue : '',
    ).toBe('pass');
  }, 300_000);

  test('passes a Romanian build, and fails the same build with generic copy', async () => {
    if (!buildable) return;
    const files = await buildWithStory({
      label: 'ro',
      story: IOANA_STORY,
      eyebrow: 'Ioana Petrescu, fotograf de nunta',
      siteTitle: 'Ioana Petrescu',
      portraitPath: null,
    });
    const ioana = person({ name: 'Ioana Petrescu', story: IOANA_STORY });
    expect(
      judgePersonAbsent(files, { ...PORTFOLIO, person: ioana }).verdict,
    ).toBe('pass');

    // The negative, over the same real pages: a different person's brief
    // against this site is the shape of the defect the gate exists for.
    const stranger = person({
      name: 'Sam Okafor',
      story: SAM_STORY,
    });
    const failed = judgePersonAbsent(files, {
      ...PORTFOLIO,
      person: stranger,
    });
    expect(failed.verdict).toBe('fail');
  }, 300_000);

  test('draws a designed panel rather than an empty box when there is no portrait', async () => {
    if (!buildable) return;
    const files = await buildWithStory({
      label: 'noportrait',
      story: SAM_STORY,
      eyebrow: 'Sam Okafor, freelance product designer',
      siteTitle: 'Sam Okafor',
      portraitPath: null,
    });
    const about = files.find((file) => file.path.startsWith('about/'));
    expect(about, 'the build emitted no about page').toBeDefined();
    // The monogram, not an <img src="">, and not a sentence apologising for
    // a photograph that does not exist.
    expect(about!.content).toContain('about-intro-section__monogram');
    expect(about!.content).not.toContain('src=""');
    expect(about!.content).not.toContain('will follow here');
  }, 300_000);
});
