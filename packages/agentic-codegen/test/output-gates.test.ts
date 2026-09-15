import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRIEF_INPUT_VERSION,
  EMPTY_IMAGE_SHIPPED,
  PERSON_ABSENT,
  PERSON_ABSENT_ASK,
  findInventedProjectIssue,
  findPlaceholderCopyIssue,
  FullSiteBuildWorker,
  GENERATED_HTML_UNSAFE,
  INVENTED_PROJECT,
  PAGE_BUDGET_EXCEEDED,
  PLACEHOLDER_COPY_SHIPPED,
  TEMPLATE_EFFECTS_DROPPED,
  PreviewGenerationPipeline,
  ProjectState,
  prunedScaffold,
  derivePageSet,
  type BrandConfig,
  type BriefInput,
  type BriefPerson,
  type BusinessIntakePayload,
  type FullSiteBuildJobStore,
  type PiSdkFlowstarterAgents,
  type PreviewPublisher,
  type PullRequestPublisher,
  type SafeGitWorktreeManager,
  type ScrapeCorpus,
  type SiteValidator,
  type TemplateLibrary,
  type TemplateScaffoldFile,
} from '../src/index';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const PROJECT_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

/** A seven-page template scaffold, the shape every library template ships. */
function templateFiles(): TemplateScaffoldFile[] {
  const page = (name: string) => ({
    path: `src/pages/${name}.astro`,
    content: `<h1>${name}</h1>`,
    type: 'file' as const,
  });
  return [
    { path: 'src/pages/index.astro', content: '<h1>home</h1>', type: 'file' },
    page('work'),
    page('about'),
    page('services'),
    page('blog'),
    page('contact'),
    page('book'),
    {
      path: 'src/pages/case-studies/[slug].astro',
      content: '<h1>case study</h1>',
      type: 'file',
    },
    {
      path: 'src/content/site.md',
      content: 'Template copy for the studio',
      type: 'file',
    },
  ];
}

describe('prunedScaffold', () => {
  it('cuts a seven-page template down to what a four-page brief buys', () => {
    const pageSet = derivePageSet({
      pageCount: 'lt-5',
      businessType: 'Creative & design',
      hasBookingLink: false,
    });
    const scaffold = prunedScaffold(
      {
        template: {
          metadata: {
            slug: 'creative-portfolio',
            displayName: 'Creative Portfolio',
            description: '',
            category: 'portfolio',
            useCase: [],
            fileCount: 9,
            totalLOC: 9,
          },
          config: {},
        },
        files: templateFiles(),
      },
      pageSet,
    );
    const paths = scaffold.files.map((file) => file.path);
    expect(paths).not.toContain('src/pages/book.astro');
    expect(paths).not.toContain('src/pages/blog.astro');
    expect(paths).not.toContain('src/pages/services.astro');
    expect(paths).toContain('src/pages/case-studies/[slug].astro');
    // The template metadata is untouched; only the file set changes.
    expect(scaffold.template.metadata.slug).toBe('creative-portfolio');
  });
});

describe('findPlaceholderCopyIssue', () => {
  it('names the file and carries the failure code', () => {
    const issue = findPlaceholderCopyIssue([
      {
        path: 'src/content/site-labels.md',
        content: 'ready to send once you connect this form',
      },
    ]);
    expect(issue).toContain(PLACEHOLDER_COPY_SHIPPED);
    expect(issue).toContain('src/content/site-labels.md');
  });

  it('can be narrowed to the files the preview agent may repair', () => {
    const files = [
      { path: 'src/pages/book.astro', content: 'calendly.com/your-username' },
    ];
    expect(findPlaceholderCopyIssue(files)).toBeDefined();
    expect(
      findPlaceholderCopyIssue(files, { editableOnly: true }),
    ).toBeUndefined();
  });

  it('says nothing about an honest site', () => {
    expect(
      findPlaceholderCopyIssue([
        { path: 'src/content/site-labels.md', content: 'Calm Path Therapy' },
      ]),
    ).toBeUndefined();
  });
});

describe('findInventedProjectIssue', () => {
  it('names the heading, the page and the projects the client actually has', () => {
    const issue = findInventedProjectIssue(
      [
        {
          path: 'dist/work/index.html',
          content: '<h2>Ereno</h2><h2>Northwind Bank</h2>',
        },
      ],
      ['Ereno'],
    );
    expect(issue).toContain(INVENTED_PROJECT);
    expect(issue).toContain('Northwind Bank');
    expect(issue).toContain('dist/work/index.html');
    expect(issue).toContain('Ereno');
  });

  it('says nothing when the brief listed no projects to check against', () => {
    expect(
      findInventedProjectIssue(
        [{ path: 'dist/work/index.html', content: '<h2>Northwind Bank</h2>' }],
        [],
      ),
    ).toBeUndefined();
  });
});

describe('the preview pipeline applies the page set and refuses placeholder copy', () => {
  function pipelineFor(options: {
    onWrite: (workspaceRoot: string) => Promise<void>;
    scaffoldFiles?: TemplateScaffoldFile[];
  }) {
    const scaffoldPaths: string[][] = [];
    const agents = {
      analyzeBrand: async () => validBrandConfig(),
      selectTemplate: async () => ({
        slug: 'creative-portfolio',
        reason: 'portfolio',
        matchedSignals: [],
        confidence: 0.9,
      }),
      buildPreview: async (input: { workspaceRoot: string }) => {
        await options.onWrite(input.workspaceRoot);
        return {
          summary: 'done',
          changedPaths: ['src/content/site.md'],
        };
      },
    } as unknown as PiSdkFlowstarterAgents;

    const library: TemplateLibrary = {
      search: async () => [],
      getDetails: async () => ({}),
      scaffold: async (slug) => ({
        template: {
          metadata: {
            slug,
            displayName: 'Creative Portfolio',
            description: '',
            category: 'portfolio',
            useCase: [],
            fileCount: 9,
            totalLOC: 9,
          },
          config: {},
        },
        files: options.scaffoldFiles ?? templateFiles(),
      }),
      close: async () => undefined,
    };

    const validator: SiteValidator = { validate: async () => undefined };
    const publisher: PreviewPublisher = {
      publish: async (input) => {
        const { readdir } = await import('node:fs/promises');
        scaffoldPaths.push(
          await readdir(join(input.workspaceRoot, 'src/pages')),
        );
        return {
          previewUrl: 'https://example.com/preview',
          artifactUrl: 'local://preview',
          files: [],
        };
      },
    };

    return {
      pipeline: new PreviewGenerationPipeline(
        agents,
        library,
        validator,
        publisher,
      ),
      scaffoldPaths,
    };
  }

  it('never materializes a booking page for a brief with no booking link', async () => {
    const { pipeline, scaffoldPaths } = pipelineFor({
      onWrite: async (root) => {
        await writeFile(
          join(root, 'src/content/site.md'),
          'Calm Path Therapy, in her own words.',
          'utf8',
        );
      },
    });

    await pipeline.run({
      intake: intakeWith({ pageCount: 'lt-5' }),
      corpus: validCorpus(),
      cachedAssets: [],
      hasBookingLink: false,
    });

    expect(scaffoldPaths[0]).toBeDefined();
    expect(scaffoldPaths[0]).not.toContain('book.astro');
    expect(scaffoldPaths[0]).not.toContain('blog.astro');
    expect(scaffoldPaths[0]).toContain('index.astro');
    expect(scaffoldPaths[0]).toContain('contact.astro');
  });

  it('materializes the booking page when the workspace has a link', async () => {
    const { pipeline, scaffoldPaths } = pipelineFor({
      onWrite: async (root) => {
        await writeFile(
          join(root, 'src/content/site.md'),
          'Calm Path Therapy, in her own words.',
          'utf8',
        );
      },
    });

    await pipeline.run({
      intake: intakeWith({ pageCount: 'lt-5' }),
      corpus: validCorpus(),
      cachedAssets: [],
      hasBookingLink: true,
    });

    expect(scaffoldPaths[0]).toContain('book.astro');
  });

  it('sends the agent back once, then fails, when placeholder copy survives', async () => {
    const feedbacks: Array<string | undefined> = [];
    const agents = {
      analyzeBrand: async () => validBrandConfig(),
      selectTemplate: async () => ({
        slug: 'creative-portfolio',
        reason: 'portfolio',
        matchedSignals: [],
        confidence: 0.9,
      }),
      buildPreview: async (input: {
        workspaceRoot: string;
        feedback?: string;
      }) => {
        feedbacks.push(input.feedback);
        await writeFile(
          join(input.workspaceRoot, 'src/content/site.md'),
          'Calm Path Therapy. Your message is ready to send once you connect this form to your inbox.',
          'utf8',
        );
        return { summary: 'done', changedPaths: ['src/content/site.md'] };
      },
    } as unknown as PiSdkFlowstarterAgents;

    const library: TemplateLibrary = {
      search: async () => [],
      getDetails: async () => ({}),
      scaffold: async (slug) => ({
        template: {
          metadata: {
            slug,
            displayName: 'Creative Portfolio',
            description: '',
            category: 'portfolio',
            useCase: [],
            fileCount: 9,
            totalLOC: 9,
          },
          config: {},
        },
        files: templateFiles(),
      }),
      close: async () => undefined,
    };

    const pipeline = new PreviewGenerationPipeline(
      agents,
      library,
      { validate: async () => undefined },
      {
        publish: async () => ({
          previewUrl: 'https://example.com/preview',
          artifactUrl: 'local://preview',
          files: [],
        }),
      },
    );

    await expect(
      pipeline.run({
        intake: intakeWith({ pageCount: 'lt-5' }),
        corpus: validCorpus(),
        cachedAssets: [],
        hasBookingLink: false,
      }),
    ).rejects.toThrow(new RegExp(PLACEHOLDER_COPY_SHIPPED));

    // One personalization pass, then exactly one repair pass carrying the
    // gate's own sentence. The gate fails; it does not merely flag.
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[0]).toBeUndefined();
    expect(feedbacks[1]).toContain(PLACEHOLDER_COPY_SHIPPED);
  });
});

describe('the full-site build gates its own output', () => {
  function workerFor(input: {
    calls: string[];
    feedbacks: Array<string | undefined>;
    /** Paths written into dist/ by the "build". */
    dist: () => Record<string, string>;
    calComUrl?: string;
    /** The approved preview manifest this build seeds from. */
    seed?: TemplateScaffoldFile[];
    /** The real projects the brief lists, if it was asked at all. */
    projects?: BusinessIntakePayload['projects'];
    /**
     * The person section on the brief the job carries, or absent when the
     * client was never asked. The `PERSON_ABSENT` gate reads this off
     * `job.briefInput`, not off the intake, because the brief is where the
     * client wrote it.
     */
    person?: BriefPerson | null;
    /** Site-rooted path of the client's portrait, when the brief has one. */
    portraitPath?: string;
  }) {
    const agents = {
      buildFullSite: async (pass: { feedback?: string; pageSet?: string }) => {
        input.feedbacks.push(pass.feedback);
        input.calls.push(`pageSet:${pass.pageSet ? 'stated' : 'missing'}`);
        return { summary: 'ok', changedPaths: ['src/pages/about.astro'] };
      },
    } as unknown as PiSdkFlowstarterAgents;

    let siteRoot = '';
    const validator: SiteValidator = {
      validate: async (root) => {
        siteRoot = root;
        const files = input.dist();
        for (const [path, content] of Object.entries(files)) {
          const absolute = join(root, 'dist', path);
          await mkdir(join(absolute, '..'), { recursive: true });
          await writeFile(absolute, content, 'utf8');
        }
      },
    };

    const store: FullSiteBuildJobStore = {
      claim: async (jobId) => ({
        id: jobId,
        projectId: PROJECT_ID,
        kind: 'FULL_SITE_BUILD',
        projectState: ProjectState.DEPOSIT_PAID,
        intake: intakeWith(
          { pageCount: 'lt-5' },
          input.projects ? { projects: input.projects } : {},
        ),
        brandConfig: validBrandConfig(),
        approvedPreviewFiles: input.seed ?? templateFiles(),
        requiredIntegrations: [],
        ...(input.calComUrl ? { calComUrl: input.calComUrl } : {}),
        ...(input.person !== undefined || input.portraitPath
          ? {
              briefInput: briefInputWith(
                input.person ?? null,
                input.portraitPath,
              ),
            }
          : {}),
      }),
      markAgentWorking: async () => {
        input.calls.push('store:agents-working');
      },
      markRebuildStarted: async () => undefined,
      markRebuilt: async () => undefined,
      markHumanQa: async () => {
        input.calls.push('store:human-qa');
      },
      markFailed: async (_jobId, error) => {
        input.calls.push(`store:failed:${error.code}`);
      },
    };

    const worktrees = {
      create: async () => {
        const root = await mkdtemp(join(tmpdir(), 'flowstarter-gates-'));
        temporaryDirectories.push(root);
        return { branch: `client/flowstarter-${PROJECT_ID}`, path: root };
      },
      commit: async () => 'abc123def456',
    } as unknown as SafeGitWorktreeManager;

    const pullRequests: PullRequestPublisher = {
      create: async () => ({
        pullRequestUrl: 'https://example.com/pr',
        stagingUrl: 'https://example.com/site',
      }),
    };

    const worker = new FullSiteBuildWorker(
      store,
      worktrees,
      agents,
      validator,
      pullRequests,
    );
    return { worker, siteRootRef: () => siteRoot };
  }

  it('ships a build that matches the brief, and states the page set to the agent', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const { worker } = workerFor({
      calls,
      feedbacks,
      dist: () => ({
        'index.html': '<h1>Calm Path</h1>',
        'work/index.html': '<h1>Work</h1>',
        'about/index.html': '<h1>About</h1>',
        'contact/index.html': '<h1>Contact</h1>',
        'case-studies/one/index.html': '<h1>One</h1>',
      }),
    });

    await worker.run('job-1');
    expect(calls).toContain('store:human-qa');
    expect(calls).toContain('pageSet:stated');
  });

  it('fails the job with PAGE_BUDGET_EXCEEDED when the build outgrows the brief', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const { worker } = workerFor({
      calls,
      feedbacks,
      dist: () => ({
        'index.html': '<h1>Calm Path</h1>',
        'work/index.html': '<h1>Work</h1>',
        'about/index.html': '<h1>About</h1>',
        'services/index.html': '<h1>Services</h1>',
        'blog/index.html': '<h1>Journal</h1>',
        'contact/index.html': '<h1>Contact</h1>',
        'book/index.html': '<h1>Book</h1>',
      }),
    });

    await expect(worker.run('job-1')).rejects.toThrow(
      new RegExp(PAGE_BUDGET_EXCEEDED),
    );
    expect(calls).toContain(`store:failed:${PAGE_BUDGET_EXCEEDED}`);
    expect(calls).not.toContain('store:human-qa');
    // One expansion pass, then exactly one repair pass carrying the verdict.
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[1]).toContain(PAGE_BUDGET_EXCEEDED);
    expect(feedbacks[1]).toContain('no validated booking link');
  });

  it('fails the job with PLACEHOLDER_COPY_SHIPPED when the built site still promises a calendar', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const { worker } = workerFor({
      calls,
      feedbacks,
      dist: () => ({
        'index.html': '<h1>Calm Path</h1>',
        'work/index.html': '<h1>Work</h1>',
        'about/index.html': '<h1>About</h1>',
        'contact/index.html':
          '<p>Your message is ready to send once you connect this form to your inbox.</p>',
      }),
    });

    await expect(worker.run('job-1')).rejects.toThrow(
      new RegExp(PLACEHOLDER_COPY_SHIPPED),
    );
    expect(calls).toContain(`store:failed:${PLACEHOLDER_COPY_SHIPPED}`);
    expect(feedbacks[1]).toContain(PLACEHOLDER_COPY_SHIPPED);
  });

  it('strips the funnel preview teaser out of the approved preview it seeds from', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const { worker, siteRootRef } = workerFor({
      calls,
      feedbacks,
      seed: [
        ...templateFiles(),
        {
          path: 'src/layouts/Layout.astro',
          content:
            '<html><head>\n<!-- flowstarter-preview-teaser -->' +
            '<link rel="stylesheet" href="/flowstarter-preview-teaser.css" />' +
            '<script defer src="/flowstarter-preview-teaser.js"></script>\n' +
            '</head><body><slot /></body></html>',
          type: 'file',
        },
        {
          path: 'public/flowstarter-preview-teaser.js',
          content: '/* teaser */',
          type: 'file',
        },
        {
          path: 'public/flowstarter-preview-teaser.css',
          content: '.fs-teaser-locked{}',
          type: 'file',
        },
      ],
      dist: () => ({
        'index.html': '<h1>Calm Path</h1>',
        'work/index.html': '<h1>Work</h1>',
        'about/index.html': '<h1>About</h1>',
        'contact/index.html': '<h1>Contact</h1>',
      }),
    });

    await worker.run('job-1');
    expect(calls).toContain('store:human-qa');

    const { access, readFile } = await import('node:fs/promises');
    const siteRoot = siteRootRef();
    // The assets never reach the worktree at all.
    await expect(
      access(join(siteRoot, 'public/flowstarter-preview-teaser.js')),
    ).rejects.toThrow();
    await expect(
      access(join(siteRoot, 'public/flowstarter-preview-teaser.css')),
    ).rejects.toThrow();
    // And the layout the agent will edit has no reference left in it.
    const layout = await readFile(
      join(siteRoot, 'src/layouts/Layout.astro'),
      'utf8',
    );
    expect(layout).not.toContain('flowstarter-preview-teaser');
    expect(layout).toContain('<slot />');
  });

  it('ships a work section built from the projects the brief lists', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const { worker } = workerFor({
      calls,
      feedbacks,
      projects: [{ name: 'Ereno' }, { name: 'Halden Studio' }],
      dist: () => ({
        'index.html': '<h1>Calm Path</h1>',
        'work/index.html':
          '<h2>Selected work</h2><h2>Ereno, a calm inbox</h2><h2>Halden Studio</h2>',
        'about/index.html': '<h1>About</h1>',
        'contact/index.html': '<h1>Contact</h1>',
      }),
    });

    await worker.run('job-1');
    expect(calls).toContain('store:human-qa');
    // No repair pass: the build was right the first time.
    expect(feedbacks).toHaveLength(1);
  });

  it('fails the job with INVENTED_PROJECT when the site names a client the brief never did', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const { worker } = workerFor({
      calls,
      feedbacks,
      projects: [{ name: 'Ereno' }],
      dist: () => ({
        'index.html': '<h1>Calm Path</h1>',
        'work/index.html': '<h2>Ereno</h2><h2>Northwind Bank</h2>',
        'about/index.html': '<h1>About</h1>',
        'contact/index.html': '<h1>Contact</h1>',
      }),
    });

    await expect(worker.run('job-1')).rejects.toThrow(
      new RegExp(INVENTED_PROJECT),
    );
    expect(calls).toContain(`store:failed:${INVENTED_PROJECT}`);
    expect(calls).not.toContain('store:human-qa');
    // One build pass, then exactly one repair pass carrying the verdict.
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[1]).toContain('Northwind Bank');
  });

  // ── PERSON_ABSENT ───────────────────────────────────────────────────────
  //
  // Four legs, because the gate has four answers and they are not variations
  // of one another: it can pass, it can fail and be repaired, it can fail and
  // stay failed, and it can decline to fail at all because there is nothing
  // an agent could write that would help. That last one is the reason the
  // gate is not just another copy check.

  const STORY =
    'I have designed for founders for eleven years, and I would still ' +
    'rather sit in a support queue for an afternoon than run a workshop.';

  it('ships a portfolio whose about page carries the client story', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const { worker } = workerFor({
      calls,
      feedbacks,
      person: personWith({ name: 'Ana Pop', story: STORY }),
      dist: () => ({
        'index.html': '<h1>Ana Pop</h1>',
        'work/index.html': '<h1>Work</h1>',
        'about/index.html': `<h1>Ana Pop</h1><p>${STORY}</p>`,
        'contact/index.html': '<h1>Contact</h1>',
      }),
    });

    await worker.run('job-1');
    expect(calls).toContain('store:human-qa');
    // No repair pass: the agent put the person on the page first time.
    expect(feedbacks).toHaveLength(1);
  });

  it('repairs a portfolio that had the story and wrote boilerplate instead', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    let pass = 0;
    const { worker } = workerFor({
      calls,
      feedbacks,
      person: personWith({ name: 'Ana Pop', story: STORY }),
      dist: () => {
        pass += 1;
        return {
          'index.html': '<h1>Ana Pop</h1>',
          'work/index.html': '<h1>Work</h1>',
          // The first build is studio boilerplate; the repair pass writes the
          // client's own sentences, which is exactly what the feedback asked
          // for and exactly what an agent can do.
          'about/index.html':
            pass === 1
              ? '<h1>About the studio</h1><p>We deliver bespoke digital experiences for ambitious brands.</p>'
              : `<h1>Ana Pop</h1><p>${STORY}</p>`,
          'contact/index.html': '<h1>Contact</h1>',
        };
      },
    });

    await worker.run('job-1');
    expect(calls).toContain('store:human-qa');
    expect(calls).not.toContain(`store:failed:${PERSON_ABSENT}`);
    // One build pass, then exactly one repair pass carrying the verdict, and
    // the verdict carries the client's sentences rather than a code.
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[1]).toContain(STORY);
  });

  it('fails the job with PERSON_ABSENT when the repair pass does not put the person back', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const { worker } = workerFor({
      calls,
      feedbacks,
      person: personWith({ name: 'Ana Pop', story: STORY }),
      portraitPath: '/flowstarter-media/ana-portrait.jpg',
      dist: () => ({
        'index.html': '<h1>Ana Pop</h1>',
        'work/index.html': '<h1>Work</h1>',
        'about/index.html':
          '<h1>About the studio</h1><p>We deliver bespoke digital experiences for ambitious brands.</p>',
        'contact/index.html': '<h1>Contact</h1>',
      }),
    });

    await expect(worker.run('job-1')).rejects.toThrow(
      new RegExp(PERSON_ABSENT),
    );
    expect(calls).toContain(`store:failed:${PERSON_ABSENT}`);
    expect(calls).not.toContain('store:human-qa');
    expect(feedbacks).toHaveLength(2);
    // Both halves are named: the words that were dropped and the photograph
    // that was never placed.
    expect(feedbacks[1]).toContain(STORY);
    expect(feedbacks[1]).toContain('/flowstarter-media/ana-portrait.jpg');
  });

  it('holds with the client ask, and spends no repair pass, when the brief had nothing', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const { worker } = workerFor({
      calls,
      feedbacks,
      // Asked, and every answer skipped. Not the same as never asked, and it
      // is the difference this leg exists to prove.
      person: personWith({}),
      dist: () => ({
        'index.html': '<h1>Ana Pop</h1>',
        'work/index.html': '<h1>Work</h1>',
        'about/index.html': '<h1>About</h1>',
        'contact/index.html': '<h1>Contact</h1>',
      }),
    });

    await expect(worker.run('job-1')).rejects.toThrow(
      new RegExp(PERSON_ABSENT_ASK.slice(0, 40)),
    );
    expect(calls).toContain(`store:failed:${PERSON_ABSENT}`);
    // THE ASSERTION. No second agent run: nothing an agent could write fixes
    // an empty brief, so the build does not pay for a pass at guessing.
    expect(feedbacks).toHaveLength(1);
  });

  it('passes a portfolio whose client sent a photograph and no story', async () => {
    // The real case this rule is shaped around: a personal trainer who would
    // not write three sentences about himself but did send a face. A
    // photograph is something of him, so the site is about somebody, and the
    // build runs. Placing it is all the gate asks for.
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const { worker } = workerFor({
      calls,
      feedbacks,
      person: personWith({ name: 'Tom Brennan' }),
      portraitPath: '/flowstarter-media/tom-portrait.jpg',
      dist: () => ({
        'index.html': '<h1>Tom Brennan</h1>',
        'work/index.html': '<h1>Work</h1>',
        'about/index.html':
          '<h1>Tom Brennan</h1><img src="/flowstarter-media/tom-portrait.jpg" alt="Tom Brennan">',
        'contact/index.html': '<h1>Contact</h1>',
      }),
    });

    await worker.run('job-1');
    expect(calls).toContain('store:human-qa');
    expect(feedbacks).toHaveLength(1);
  });

  it('has no opinion at all about a brief nobody was ever asked', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const { worker } = workerFor({
      calls,
      feedbacks,
      // Every workspace taken before the person section existed.
      person: null,
      dist: () => ({
        'index.html': '<h1>Calm Path</h1>',
        'work/index.html': '<h1>Work</h1>',
        'about/index.html': '<h1>About the studio</h1>',
        'contact/index.html': '<h1>Contact</h1>',
      }),
    });

    await worker.run('job-1');
    expect(calls).toContain('store:human-qa');
    expect(feedbacks).toHaveLength(1);
  });

  it('fails the job with GENERATED_HTML_UNSAFE when the built site runs a script the policy does not allow', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const { worker } = workerFor({
      calls,
      feedbacks,
      dist: () => ({
        'index.html':
          '<h1>Calm Path</h1><script>fetch("https://evil.example")</script>',
        'work/index.html': '<h1>Work</h1>',
        'about/index.html': '<h1>About</h1>',
        'contact/index.html': '<h1>Contact</h1>',
      }),
    });

    await expect(worker.run('job-1')).rejects.toThrow(
      new RegExp(GENERATED_HTML_UNSAFE),
    );
    expect(calls).toContain(`store:failed:${GENERATED_HTML_UNSAFE}`);
    expect(calls).not.toContain('store:human-qa');
    // One build pass, then exactly one repair pass carrying the verdict —
    // the same repair-then-recheck shape as every gate above it.
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[1]).toContain('evil.example');
  });

  it('fails the job with EMPTY_IMAGE_SHIPPED when the built site ships an img with no src', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const { worker } = workerFor({
      calls,
      feedbacks,
      dist: () => ({
        'index.html': '<h1>Calm Path</h1>',
        'work/index.html': '<h1>Work</h1>',
        'about/index.html': '<h1>About</h1><img src="" alt="Founder portrait">',
        'contact/index.html': '<h1>Contact</h1>',
      }),
    });

    await expect(worker.run('job-1')).rejects.toThrow(
      new RegExp(EMPTY_IMAGE_SHIPPED),
    );
    expect(calls).toContain(`store:failed:${EMPTY_IMAGE_SHIPPED}`);
    expect(calls).not.toContain('store:human-qa');
    // No repair pass for a markup bug like this one: one build pass, then
    // straight to the gate failing the job.
    expect(feedbacks).toHaveLength(1);
  });

  /**
   * The effect layer, end to end through the worker.
   *
   * `effectSeed()` is a scaffold in the shape every real template has: a
   * layout that loads one script module, a script that observes an attribute
   * and adds a state class, and a section component that renders the
   * attribute and styles itself off that class. The `dist` each test supplies
   * is what the "build" emitted, which is the only thing the gate reads.
   */
  function effectSeed(): TemplateScaffoldFile[] {
    const file = (path: string, content: string) => ({
      path,
      content,
      type: 'file' as const,
    });
    return [
      // The template's own homepage is replaced below with one that imports
      // the effect-carrying section; everything else stays as it ships.
      ...templateFiles().filter(
        (entry) => entry.path !== 'src/pages/index.astro',
      ),
      file(
        'src/layouts/Layout.astro',
        '<html><body><slot /></body>' +
          "<script>import '../scripts/site.js';</script></html>",
      ),
      file(
        'src/scripts/site.js',
        "document.querySelectorAll('[data-story-reveal]').forEach((el) => " +
          "el.classList.add('is-visible'));",
      ),
      file(
        'src/components/Story.astro',
        '<section class="story" data-story-reveal>' +
          '<p class="story__line">Copy</p></section>' +
          '<style>.story.is-visible .story__line { opacity: 1; }</style>',
      ),
      file(
        'src/pages/index.astro',
        "---\nimport Layout from '../layouts/Layout.astro';\n" +
          "import Story from '../components/Story.astro';\n---\n" +
          '<Layout><Story /></Layout>',
      ),
    ];
  }

  const EFFECT_CSS = '.story.is-visible .story__line{opacity:1}';

  it('fails the job with TEMPLATE_EFFECTS_DROPPED when a section keeps its shape and loses its hook', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const { worker } = workerFor({
      calls,
      feedbacks,
      seed: effectSeed(),
      dist: () => ({
        // The section is still there — same classes, new markup — and the
        // attribute its script reads is gone. This is the delivered
        // portfolio's defect, reduced to one page.
        'index.html':
          '<section class="story"><p class="story__line">Copy</p></section>',
        'work/index.html': '<h1>Work</h1>',
        'about/index.html': '<h1>About</h1>',
        'contact/index.html': '<h1>Contact</h1>',
        '_astro/site.css': EFFECT_CSS,
      }),
    });

    await expect(worker.run('job-1')).rejects.toThrow(
      new RegExp(TEMPLATE_EFFECTS_DROPPED),
    );
    expect(calls).toContain(`store:failed:${TEMPLATE_EFFECTS_DROPPED}`);
    expect(calls).not.toContain('store:human-qa');
    // One build pass, one repair pass carrying the repair brief.
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[1]).toContain('data-story-reveal');
    expect(feedbacks[1]).toContain('src/components/Story.astro');
  });

  it('ships the build when the repair pass puts the hook back', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    let repaired = false;
    const { worker } = workerFor({
      calls,
      feedbacks,
      seed: effectSeed(),
      dist: () => {
        const story = repaired
          ? '<section class="story" data-story-reveal>' +
            '<p class="story__line">Copy</p></section>'
          : '<section class="story"><p class="story__line">Copy</p></section>';
        repaired = true;
        return {
          'index.html': story,
          'work/index.html': '<h1>Work</h1>',
          'about/index.html': '<h1>About</h1>',
          'contact/index.html': '<h1>Contact</h1>',
          '_astro/site.css': EFFECT_CSS,
        };
      },
    });

    await worker.run('job-1');
    expect(calls).toContain('store:human-qa');
    expect(feedbacks).toHaveLength(2);
  });

  it('says nothing about a section the build did not render at all', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const { worker } = workerFor({
      calls,
      feedbacks,
      seed: effectSeed(),
      dist: () => ({
        // No story section: an honest editorial decision, not a lost effect.
        'index.html': '<h1>Calm Path</h1>',
        'work/index.html': '<h1>Work</h1>',
        'about/index.html': '<h1>About</h1>',
        'contact/index.html': '<h1>Contact</h1>',
        '_astro/site.css': EFFECT_CSS,
      }),
    });

    await worker.run('job-1');
    expect(calls).toContain('store:human-qa');
    expect(feedbacks).toHaveLength(1);
  });

  it('allows the booking page once the workspace carries a Cal.com link', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const { worker } = workerFor({
      calls,
      feedbacks,
      calComUrl: 'https://cal.com/calm-path/intro',
      dist: () => ({
        'index.html': '<h1>Calm Path</h1>',
        'work/index.html': '<h1>Work</h1>',
        'about/index.html': '<h1>About</h1>',
        'contact/index.html': '<h1>Contact</h1>',
        'book/index.html': '<h1>Book</h1>',
      }),
    });

    await worker.run('job-1');
    expect(calls).toContain('store:human-qa');
  });
});

function intakeWith(
  business: Partial<BusinessIntakePayload['business']>,
  brief: Partial<BusinessIntakePayload> = {},
): BusinessIntakePayload {
  return {
    projectId: PROJECT_ID,
    business: {
      name: 'Calm Path Therapy',
      niche: 'Creative and design',
      location: 'Cluj-Napoca, Romania',
      description: 'A portfolio of design work for founders.',
      targetAudience: 'Founders',
      primaryGoal: 'leads',
      ...business,
    },
    socialMedia: [],
    locale: 'en-RO',
    submittedAt: '2026-09-11T10:00:00.000Z',
    consent: { publicProfileAnalysis: false, acceptedAt: '' },
    ...brief,
  };
}

/**
 * A brief carrying a person, for the gate that reads one.
 *
 * Minimal on purpose: every other field is the empty answer, so a test that
 * changes the verdict changes exactly one thing. `person: null` is a real and
 * different input from an all-empty section, and both are exercised below.
 */
function briefInputWith(
  person: BriefPerson | null,
  portraitPath?: string,
): BriefInput {
  return {
    version: BRIEF_INPUT_VERSION,
    composedAt: '2026-09-15T09:00:00.000Z',
    reason: 'brief_ready',
    offer: 'Design work for founders, one project at a time.',
    projects: [],
    noProjects: true,
    designReferences: [],
    photos: [],
    portrait: portraitPath
      ? {
          assetId: '0d1f3a21-5b6c-4d7e-8f90-1a2b3c4d5e6f',
          publicPath: portraitPath,
          manifestPath: `public${portraitPath}`,
          role: 'portrait',
          caption: 'The client',
          mime: 'image/jpeg',
          width: 1600,
          height: 2000,
        }
      : null,
    person,
  };
}

/** A person section with only the fields a test cares about filled in. */
function personWith(fields: Partial<BriefPerson>): BriefPerson {
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

function validCorpus(): ScrapeCorpus {
  return {
    projectId: PROJECT_ID,
    documents: [
      {
        sourceId: 'text-1',
        platform: 'intake',
        kind: 'intake_answer',
        text: 'A portfolio of design work.',
      },
    ],
    images: [],
    completedAt: '2026-09-11T10:05:00.000Z',
  };
}

function validBrandConfig(): BrandConfig {
  return {
    schemaVersion: '1.0',
    colors: {
      primary: '#19352D',
      onPrimary: '#FFFFFF',
      secondary: '#B36A44',
      onSecondary: '#FFFFFF',
      accent: '#8A3B12',
      onAccent: '#FFFFFF',
      background: '#FFFFFF',
      surface: '#F3EEE5',
      text: '#111111',
      mutedText: '#555555',
    },
    typography: {
      headingFont: 'Newsreader',
      bodyFont: 'Source Sans 3',
      fallbackStack: 'sans-serif',
      source: 'google_fonts',
    },
    voice: {
      formality: 0.7,
      warmth: 0.88,
      energy: 0.35,
      playfulness: 0.15,
      directness: 0.7,
      adjectives: ['calm', 'practical', 'warm'],
      avoidPhrases: ['hustle'],
      sampleHeadline: 'A calmer way through change',
      sampleBody: 'Practical therapy for founders and creatives.',
      primaryCta: 'Get in touch',
    },
    ideas: {
      positioning: 'Calm, practical therapy',
      heroAngle: 'A calmer way through change',
      sections: [],
      contentThemes: ['calm'],
    },
    evidence: {
      textSourceIds: ['text-1'],
      imageSourceIds: [],
      assumptions: [],
    },
  };
}
