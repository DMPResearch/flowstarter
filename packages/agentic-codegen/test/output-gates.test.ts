import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findPlaceholderCopyIssue,
  FullSiteBuildWorker,
  PAGE_BUDGET_EXCEEDED,
  PLACEHOLDER_COPY_SHIPPED,
  PreviewGenerationPipeline,
  ProjectState,
  prunedScaffold,
  derivePageSet,
  type BrandConfig,
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
        intake: intakeWith({ pageCount: 'lt-5' }),
        brandConfig: validBrandConfig(),
        approvedPreviewFiles: input.seed ?? templateFiles(),
        requiredIntegrations: [],
        ...(input.calComUrl ? { calComUrl: input.calComUrl } : {}),
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
