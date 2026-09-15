/**
 * The `TEMPLATE_EFFECTS_DROPPED` gate.
 *
 * Half of this file is fixtures, and the half that matters is not: the defect
 * it exists for — a delivered portfolio whose compiled pages carried the
 * template's reveal script and no element for it to observe — would have
 * passed any assertion written against a hand-made string. So the second
 * describe block copies the real templates, runs the real `astro build`, and
 * measures the real `dist/` against the manifest derived from the real
 * source: unmodified first (the baseline has to pass, or the gate is a
 * liability), then with one section component rewritten the way the agent
 * rewrote them, then with a content-only edit of the kind the agent is now
 * told to make instead.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import {
  cssRules,
  deriveTemplateEffectsManifest,
  describeTemplateEffectsIssue,
  describeTemplateEffectsRegressions,
  describeTemplateEffectsRepair,
  findTemplateEffectsFindings,
  findTemplateEffectsRegressions,
  pageOutputPath,
  readTemplateEffectsSource,
  TEMPLATE_EFFECTS_DROPPED,
  type TemplateEffectsFile,
} from '../src/flowstarter/template-effects';

const run = promisify(execFile);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const templatesRoot = join(repoRoot, 'apps/flowstarter-templates');

/* -------------------------------------------------------------------------
 * A small template, so the rules can be stated one at a time
 * ---------------------------------------------------------------------- */

const LAYOUT = `---
---
<html>
  <body><slot /></body>
  <script>
    import '../scripts/site.js';
  </script>
</html>
`;

const SITE_JS = `import { reveal } from './hooks/useReveal.js';
reveal('[data-story-reveal]');
document.querySelector('[data-menu]')?.classList.add('is-open');
`;

const REVEAL_HOOK = `export function reveal(selector) {
  document.querySelectorAll(selector).forEach((element) => {
    element.classList.add('is-visible');
  });
}
`;

const STORY = `---
const { story } = Astro.props;
---
<section class="story" data-story-reveal>
  <p class="story__line">{story.line}</p>
</section>
<style>
  .story__line { opacity: 1; }
  .story.is-visible .story__line { opacity: 1; transform: none; }
  .story__aside { position: sticky; top: 0; }
</style>
`;

const INDEX = `---
import Layout from '../layouts/Layout.astro';
import Story from '../components/Story.astro';
---
<Layout><Story story={{ line: 'hello' }} /></Layout>
`;

function template(
  overrides: Record<string, string> = {},
): TemplateEffectsFile[] {
  const files: Record<string, string> = {
    'src/layouts/Layout.astro': LAYOUT,
    'src/scripts/site.js': SITE_JS,
    'src/scripts/hooks/useReveal.js': REVEAL_HOOK,
    'src/components/Story.astro': STORY,
    'src/pages/index.astro': INDEX,
    ...overrides,
  };
  return Object.entries(files)
    .filter(([, content]) => content !== '')
    .map(([path, content]) => ({ path, content }));
}

/** A compiled page, as `collectBuiltSiteText` hands one to the gate. */
function built(
  html: string,
  css = '.story.is-visible .story__line{opacity:1}.story__aside{position:sticky}',
): TemplateEffectsFile[] {
  return [
    {
      path: 'dist/index.html',
      content: `<!doctype html><html><body>${html}</body></html>`,
    },
    { path: 'dist/_astro/site.css', content: css },
  ];
}

describe('deriveTemplateEffectsManifest — what a template declares', () => {
  test('binds only what a loaded script actually selects on', () => {
    const manifest = deriveTemplateEffectsManifest(template());
    expect(manifest.boundAttributes).toEqual([
      'data-menu',
      'data-story-reveal',
    ]);
    expect(manifest.stateClasses).toEqual(['is-open', 'is-visible']);
  });

  test('walks the page import graph for the sections a page renders', () => {
    const manifest = deriveTemplateEffectsManifest(template());
    const [page] = manifest.pages;
    expect(page?.source).toBe('src/pages/index.astro');
    expect(page?.output).toBe('index.html');
    expect(page?.sections).toEqual(['src/components/Story.astro']);
    expect(manifest.sections[0]?.hooks).toEqual(['data-story-reveal']);
  });

  test('a data- attribute no script reads is not the gate’s business', () => {
    const manifest = deriveTemplateEffectsManifest(
      template({
        'src/components/Story.astro': STORY.replace(
          'data-story-reveal',
          'data-story-reveal data-flowstarter-id="story"',
        ),
      }),
    );
    expect(manifest.sections[0]?.hooks).toEqual(['data-story-reveal']);
  });

  test('an attribute bound to an expression is not something a build can be held to', () => {
    const manifest = deriveTemplateEffectsManifest(
      template({
        'src/components/Story.astro': STORY.replace(
          'data-story-reveal',
          'data-story-reveal={story.reveal}',
        ),
      }),
    );
    expect(manifest.sections[0]?.hooks).toEqual([]);
  });

  test('a class whose styles key off a state class is a reveal; sticky is its own', () => {
    const [section] = deriveTemplateEffectsManifest(template()).sections;
    expect(section?.component).toBe('src/components/Story.astro');
    expect(section?.markers).toEqual(['story', 'story__line']);
    expect(section?.reveals).toEqual(['story']);
    expect(section?.sticky).toEqual(['story__aside']);
  });

  test('shared furniture does not identify a section', () => {
    // `wrap` is written by two components and `page` is styled globally, so
    // neither can answer "is this section still on the page". Only `story`
    // and `story__line` are left, and a component with nothing of its own is
    // dropped from the contract rather than guessed at.
    const manifest = deriveTemplateEffectsManifest(
      template({
        'src/styles/global.css': '.page { margin: 0; }\n',
        'src/components/Story.astro': STORY.replace(
          'class="story"',
          'class="story wrap page"',
        ),
        'src/components/Aside.astro':
          '<div class="wrap page" data-story-reveal></div>\n',
      }),
    );
    const story = manifest.sections.find(
      (section) => section.component === 'src/components/Story.astro',
    );
    expect(story?.markers).toEqual(['story', 'story__line']);
    expect(manifest.sections.map((section) => section.component)).not.toContain(
      'src/components/Aside.astro',
    );
  });

  test('a hook module nothing imports is an orphan: it can never run', () => {
    const manifest = deriveTemplateEffectsManifest(
      template({ 'src/scripts/hooks/useTimeline.js': 'export const x = 1;\n' }),
    );
    expect(manifest.orphans.modules).toEqual([
      'src/scripts/hooks/useTimeline.js',
    ]);
  });

  test('a selector no page renders is an orphan binding', () => {
    const manifest = deriveTemplateEffectsManifest(template());
    // `[data-menu]` is selected by site.js and rendered by nothing.
    expect(manifest.orphans.bindings).toEqual(['data-menu']);
  });

  test('page outputs follow astro’s directory format; dynamic routes have none', () => {
    expect(pageOutputPath('src/pages/index.astro')).toBe('index.html');
    expect(pageOutputPath('src/pages/404.astro')).toBe('404.html');
    expect(pageOutputPath('src/pages/about.astro')).toBe('about/index.html');
    expect(pageOutputPath('src/pages/case-studies/[slug].astro')).toBeNull();
  });
});

describe('cssRules — enough CSS to ask two questions', () => {
  test('reads rules out of at-rules and minified text alike', () => {
    const rules = cssRules(
      '@media (min-width:900px){.a{position:sticky}}.b{color:red}/* .c{} */',
    );
    expect(rules.map((rule) => rule.selector)).toEqual(['.a', '.b']);
  });

  test('a comment that never closes takes the rest of the file with it', () => {
    // Scanned rather than matched: `\\/\\*[\\s\\S]*?\\*\\/` over a stylesheet
    // an agent wrote is quadratic on exactly this input.
    expect(
      cssRules('.a{color:red}/* .b{color:blue}').map((r) => r.selector),
    ).toEqual(['.a']);
  });
});

describe('the source scanners — what a regular expression got wrong', () => {
  test('a script block closed with a space is still a script block', () => {
    // `</script >` is a close tag to a browser and was not one to the pattern
    // this replaced, so the selector inside it read as markup the page
    // renders. It is script, and script is not the contract.
    const manifest = deriveTemplateEffectsManifest(
      template({
        'src/components/Story.astro':
          '<section class="story" data-story-reveal>' +
          '<p class="story__line">hi</p></section>\n' +
          '<script >document.querySelector("[data-menu]");</script >\n' +
          '<style>.story.is-visible .story__line { opacity: 1; }</style>',
      }),
    );
    expect(manifest.sections[0]?.hooks).toEqual(['data-story-reveal']);
    expect(manifest.sections[0]?.markers).toEqual(['story', 'story__line']);
  });

  test('a block that never closes ends the file, as it would in a browser', () => {
    const manifest = deriveTemplateEffectsManifest(
      template({
        'src/components/Story.astro':
          '<section class="story" data-story-reveal></section>\n' +
          '<script>document.querySelector("[data-menu]");',
      }),
    );
    // No style block survives, so the section carries its hook and nothing
    // from inside the unterminated script.
    expect(manifest.sections[0]?.hooks).toEqual(['data-story-reveal']);
    expect(manifest.sections[0]?.reveals).toEqual([]);
  });

  test('reads every import shape, and the word alone is not one', () => {
    const manifest = deriveTemplateEffectsManifest(
      template({
        'src/pages/index.astro': `---
import Layout from '../layouts/Layout.astro';
import {
  Story,
} from '../components/Story.astro';
const note = 'important: not an import';
const here = import.meta.url;
---
<Layout><Story /></Layout>`,
      }),
    );
    expect(manifest.pages[0]?.sections).toEqual(['src/components/Story.astro']);
  });
});

describe('findTemplateEffectsFindings — what a build dropped', () => {
  const manifest = deriveTemplateEffectsManifest(template());

  test('the template’s own markup passes', () => {
    const findings = findTemplateEffectsFindings(
      built(
        '<section class="story" data-story-reveal><p class="story__line">hi</p>' +
          '</section><aside class="story__aside"></aside>',
      ),
      manifest,
    );
    expect(findings).toEqual([]);
  });

  test('a rewritten section that lost the hook is named, with its page', () => {
    const findings = findTemplateEffectsFindings(
      built(
        '<section class="story"><p class="story__line">hi</p></section>' +
          '<aside class="story__aside"></aside>',
      ),
      manifest,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      page: 'index.html',
      kind: 'hook',
      name: 'data-story-reveal',
    });
    const message = describeTemplateEffectsIssue(findings);
    expect(message.startsWith(`${TEMPLATE_EFFECTS_DROPPED}:`)).toBe(true);
    expect(message).toContain('index.html');
    expect(message).toContain('data-story-reveal');
    expect(describeTemplateEffectsRepair(findings)).toContain(
      'data-story-reveal',
    );
  });

  test('a section the build did not render at all is not a dropped effect', () => {
    // A brief with no testimonials buys a homepage with no testimonial
    // section. The delivered portfolio that prompted this gate had dropped
    // `Stats` and `Testimonial` outright and had *also* rewritten the
    // expertise column out of its sticky wrapper; only the second is a defect
    // this rule is allowed to have an opinion about.
    const findings = findTemplateEffectsFindings(
      built('<main><h1>Acme</h1></main>'),
      manifest,
    );
    expect(findings).toEqual([]);
  });

  test('a section renamed out of its own animation is a reveal finding', () => {
    const findings = findTemplateEffectsFindings(
      built(
        '<section class="testimonials" data-story-reveal>' +
          '<p class="story__line">hi</p></section>' +
          '<aside class="story__aside"></aside>',
      ),
      manifest,
    );
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'reveal', name: 'story' }),
    ]);
  });

  test('a sticky panel that stopped being sticky is its own finding', () => {
    const findings = findTemplateEffectsFindings(
      built(
        '<section class="story" data-story-reveal><p class="story__line">hi</p>' +
          '</section><aside class="story__aside"></aside>',
        '.story.is-visible .story__line{opacity:1}.story__aside{position:relative}',
      ),
      manifest,
    );
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'sticky', name: 'story__aside' }),
    ]);
  });

  test('a page the brief never bought is not a page that lost its effects', () => {
    // The page set is decided long before this runs; `about/index.html` was
    // pruned, so nothing about it is measured.
    const pruned = deriveTemplateEffectsManifest(
      template({ 'src/pages/about.astro': INDEX }),
    );
    expect(pruned.pages).toHaveLength(2);
    const findings = findTemplateEffectsFindings(
      built(
        '<section class="story" data-story-reveal><p class="story__line">hi</p>' +
          '</section><aside class="story__aside"></aside>',
      ),
      pruned,
    );
    expect(findings).toEqual([]);
  });

  test('a build that emitted no HTML is measured by the validator, not here', () => {
    expect(findTemplateEffectsFindings([], manifest)).toEqual([]);
  });
});

describe('findTemplateEffectsRegressions — the same rule, source to source', () => {
  const seed = template();

  test('an untouched workspace has nothing to report', () => {
    expect(findTemplateEffectsRegressions(seed, template())).toEqual([]);
  });

  test('copy edited in place is not a regression', () => {
    const edited = template({
      'src/components/Story.astro': STORY.replace(
        '{story.line}',
        'A studio in Lisbon.',
      ),
    });
    expect(findTemplateEffectsRegressions(seed, edited)).toEqual([]);
  });

  test('a section rewritten without its hook and its sticky rule is named', () => {
    const rewritten = template({
      'src/components/Story.astro': `---
const { story } = Astro.props;
---
<section class="story">
  <p class="story__line">{story.line}</p>
</section>
<style>
  .story.is-visible .story__line { opacity: 1; }
  .story__aside { position: relative; }
</style>
`,
    });
    const regressions = findTemplateEffectsRegressions(seed, rewritten);
    expect(regressions).toEqual([
      {
        component: 'src/components/Story.astro',
        missing: ['data-story-reveal', 'story__aside'],
      },
    ]);
    expect(describeTemplateEffectsRegressions(regressions)).toContain(
      'data-story-reveal',
    );
  });

  test('a component deleted outright is the page’s business, not this rule’s', () => {
    const removed = template({ 'src/components/Story.astro': '' });
    expect(findTemplateEffectsRegressions(seed, removed)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * The real templates
 * ---------------------------------------------------------------------- */

async function templateDirs(): Promise<string[]> {
  const entries = await readdir(templatesRoot, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(templatesRoot, entry.name);
    try {
      if (!(await stat(join(dir, 'src'))).isDirectory()) continue;
    } catch {
      continue;
    }
    dirs.push(dir);
  }
  return dirs.sort();
}

function buildable(dirs: readonly string[]): string[] {
  return dirs.filter((dir) => existsSync(join(dir, 'node_modules/.bin/astro')));
}

/** A copy of a template that borrows its installed dependency tree. */
async function stageTemplate(dir: string, label: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `template-effects-${label}-`));
  await cp(dir, workspace, {
    recursive: true,
    filter: (source) =>
      !source.includes(`${dir}${sep}node_modules`) &&
      !source.includes(`${dir}${sep}dist`) &&
      !source.includes(`${dir}${sep}.astro`),
  });
  await symlink(
    join(dir, 'node_modules'),
    join(workspace, 'node_modules'),
    'dir',
  );
  // `node_modules` is a symlink to the shared template directory, so Vite's
  // dependency-optimizer cache under it is shared too, and two real-build
  // suites racing to write it produce an `ENOTEMPTY` from Vite's own temp-dir
  // rename — a false failure with nothing wrong in either build. See the same
  // note in `empty-image.test.ts`. Astro resolves `--config` against `cwd`,
  // so the file name rather than its full path is what gets passed.
  await writeFile(
    join(workspace, ASTRO_CONFIG_OVERRIDE),
    "import { mergeConfig } from 'astro/config';\n" +
      "import base from './astro.config.mjs';\n" +
      `export default mergeConfig(base, { vite: { cacheDir: ${JSON.stringify(
        join(workspace, '.vite-cache'),
      )} } });\n`,
    'utf8',
  );
  return workspace;
}

/** The per-workspace Astro config the staged copy is built with. */
const ASTRO_CONFIG_OVERRIDE = 'flowstarter-test-astro.config.mjs';

/** The compiled site, in the shape `collectBuiltSiteText` produces. */
async function collectBuilt(distDir: string): Promise<TemplateEffectsFile[]> {
  const files: TemplateEffectsFile[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!/\.(html?|css)$/i.test(entry.name)) continue;
      files.push({
        path: `dist/${relative(distDir, absolute).split(sep).join('/')}`,
        content: await readFile(absolute, 'utf8'),
      });
    }
  };
  await walk(distDir);
  return files;
}

/** Stage, optionally edit, build, and measure — the whole chain, for real. */
async function buildAndMeasure(
  dir: string,
  label: string,
  edit?: (workspace: string) => Promise<void>,
): Promise<{
  findings: ReturnType<typeof findTemplateEffectsFindings>;
  built: TemplateEffectsFile[];
}> {
  const workspace = await stageTemplate(dir, label);
  try {
    // The contract is the one the *seed* declares: derived before the edit,
    // exactly as the workflow derives it from the files it materialized.
    const manifest = deriveTemplateEffectsManifest(
      await readTemplateEffectsSource(workspace),
    );
    if (edit) await edit(workspace);
    await run(
      join(dir, 'node_modules/.bin/astro'),
      ['build', '--config', ASTRO_CONFIG_OVERRIDE],
      { cwd: workspace },
    );
    const output = await collectBuilt(join(workspace, 'dist'));
    expect(
      output.length,
      `${label}: astro build produced no dist/`,
    ).toBeGreaterThan(0);
    return {
      findings: findTemplateEffectsFindings(output, manifest),
      built: output,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** Rewrite one file the way an agent rewrites a section: in place, by text. */
async function editFile(
  workspace: string,
  relativePath: string,
  rewrite: (source: string) => string,
): Promise<void> {
  const target = join(workspace, relativePath);
  const source = await readFile(target, 'utf8');
  const next = rewrite(source);
  expect(next, `${relativePath}: the edit changed nothing`).not.toBe(source);
  await writeFile(target, next, 'utf8');
}

describe('the templates this gate describes', () => {
  test('every template ships a current effects.json', async () => {
    await run(
      join(repoRoot, 'node_modules/.bin/tsx'),
      [join(repoRoot, 'scripts/generate-template-effects.ts'), '--check'],
      { cwd: repoRoot },
    );
  }, 120_000);

  test('no template ships an effect module nothing loads', async () => {
    let checked = 0;
    for (const dir of await templateDirs()) {
      const name = relative(templatesRoot, dir);
      const manifest = deriveTemplateEffectsManifest(
        await readTemplateEffectsSource(dir),
      );
      checked += 1;
      // A hook module under `src/scripts/` that no loaded script imports is
      // an effect that can never run: `creative-portfolio` shipped
      // `useJourneyTimeline.js` this way, and its step timeline rendered step
      // one and never moved.
      expect(manifest.orphans.modules, name).toEqual([]);
    }
    expect(checked).toBeGreaterThan(0);
  }, 60_000);

  test('a real build of every template satisfies its own manifest', async () => {
    const dirs = buildable(await templateDirs());
    if (dirs.length === 0) {
      console.warn(
        'no template has an installed astro binary; skipping the real-build ' +
          'baseline (run `pnpm install` first)',
      );
      return;
    }
    for (const dir of dirs) {
      const name = relative(templatesRoot, dir);
      const { findings } = await buildAndMeasure(dir, name);
      expect(
        findings,
        `${name}: ${describeTemplateEffectsIssue(findings)}`,
      ).toEqual([]);
    }
  }, 600_000);

  test('a section rewritten without its hook fails, naming the page and the hook', async () => {
    const dir = join(templatesRoot, 'creative-portfolio');
    if (!existsSync(join(dir, 'node_modules/.bin/astro'))) return;
    const { findings } = await buildAndMeasure(dir, 'stripped', (workspace) =>
      // Exactly what the delivered build did: new markup for the section,
      // without the attribute the reveal script reads.
      editFile(workspace, 'src/components/Testimonial.astro', (source) =>
        source.replace(/\n\s*data-testimonial-reveal/, ''),
      ),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        page: 'index.html',
        kind: 'hook',
        name: 'data-testimonial-reveal',
      }),
    ]);
    expect(describeTemplateEffectsIssue(findings)).toContain('index.html');
  }, 300_000);

  test('the step timeline: its hooks and its sticky stage are both held to', async () => {
    const dir = join(templatesRoot, 'local-trade');
    if (!existsSync(join(dir, 'node_modules/.bin/astro'))) return;
    const { findings } = await buildAndMeasure(dir, 'timeline', (workspace) =>
      editFile(
        workspace,
        'src/components/about/AboutJourneySection.astro',
        (source) =>
          source
            .replace(/\n\s*data-journey-card/g, '')
            .replace(/position:\s*sticky/g, 'position: relative'),
      ),
    );
    const named = findings.map((finding) => `${finding.kind}:${finding.name}`);
    expect(named).toContain('hook:data-journey-card');
    expect(named).toContain('sticky:about-journey-section__sticky');
    for (const finding of findings)
      expect(finding.page).toBe('about/index.html');
  }, 300_000);

  test('a content-only edit passes, and the effects are still in the output', async () => {
    const dir = join(templatesRoot, 'creative-portfolio');
    if (!existsSync(join(dir, 'node_modules/.bin/astro'))) return;
    const headline = 'Portraits that hold a room.';
    const { findings, built: output } = await buildAndMeasure(
      dir,
      'content',
      (workspace) =>
        // The edit the agent is now told to make: the client's words, in the
        // content file, with the template's markup untouched.
        editFile(workspace, 'src/content/site-labels.md', (source) =>
          source.replace(
            'title: "We make work worth looking at twice."',
            `title: "${headline}"`,
          ),
        ),
    );
    expect(findings).toEqual([]);
    const index = output.find((file) => file.path === 'dist/index.html');
    expect(index?.content).toContain(headline);
    expect(index?.content).toContain('data-testimonial-reveal');
  }, 300_000);
});
