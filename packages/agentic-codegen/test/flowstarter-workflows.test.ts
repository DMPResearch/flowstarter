import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepTempDir } from './helpers';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FullSiteBuildWorker,
  operatorNotesFeedback,
  blankStringLiterals,
  collapseDeclarationValues,
  replyExcerpt,
  stripBlockComments,
  PreviewGenerationPipeline,
  ProjectState,
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
} from '../src/index';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Flowstarter preview-to-build orchestration', () => {
  it('turns an approved intake into a published, template-based preview', async () => {
    const calls: string[] = [];
    let previewWorkspace = '';
    const intake = validIntake();
    const corpus = validCorpus(intake.projectId);
    const brandConfig = validBrandConfig();

    const agents = {
      analyzeBrand: async () => {
        calls.push('agent:brand-intelligence');
        return brandConfig;
      },
      selectTemplate: async () => {
        calls.push('agent:template-selector');
        return {
          slug: 'wellness-therapy',
          reason: 'Trust-led service journey with a consultation conversion.',
          matchedSignals: ['therapy', 'warm', 'bookings'],
          confidence: 0.94,
        };
      },
      buildPreview: async (input: {
        workspaceRoot: string;
        templateConfig?: Record<string, unknown>;
      }) => {
        calls.push('agent:preview-builder');
        previewWorkspace = input.workspaceRoot;
        expect(input.templateConfig).toEqual({ palettes: [] });
        const source = join(input.workspaceRoot, 'src/content/site.md');
        expect(await readFile(source, 'utf8')).toBe('Template copy');
        // References the client's cached portrait, satisfying the media check.
        await writeFile(
          source,
          'Calm Path Therapy preview /assets/portrait.webp',
          'utf8',
        );
        return {
          summary: 'Preview tailored',
          changedPaths: ['src/content/site.md'],
        };
      },
    } as unknown as PiSdkFlowstarterAgents;

    const library: TemplateLibrary = {
      search: async () => [],
      getDetails: async () => ({}),
      scaffold: async (slug) => {
        calls.push('mcp:scaffold');
        expect(slug).toBe('wellness-therapy');
        return {
          template: {
            metadata: {
              slug,
              displayName: 'Wellness & Therapy',
              description: 'Trust-led service template.',
              category: 'services',
              useCase: ['therapy'],
              fileCount: 1,
              totalLOC: 1,
            },
            config: { palettes: [] },
          },
          files: [
            {
              path: 'src/content/site.md',
              content: 'Template copy',
              type: 'file',
            },
          ],
        };
      },
      close: async () => undefined,
    };

    const validator: SiteValidator = {
      validate: async (workspaceRoot, phase) => {
        calls.push(`validator:${phase}`);
        expect(
          await readFile(join(workspaceRoot, 'src/content/site.md'), 'utf8'),
        ).toBe('Calm Path Therapy preview /assets/portrait.webp');
      },
    };

    const publisher: PreviewPublisher = {
      publish: async (input) => {
        calls.push('publisher:preview');
        const content = await readFile(
          join(input.workspaceRoot, 'src/content/site.md'),
          'utf8',
        );
        return {
          previewUrl: 'https://preview.flowstarter.net/calm-path',
          artifactUrl: 's3://flowstarter-previews/calm-path.tar.gz',
          files: [{ path: 'src/content/site.md', content, type: 'file' }],
        };
      },
    };

    const pipeline = new PreviewGenerationPipeline(
      agents,
      library,
      validator,
      publisher,
    );
    const result = await pipeline.run({
      intake,
      corpus,
      cachedAssets: [
        { sourceId: 'image-1', publicPath: '/assets/portrait.webp' },
      ],
    });

    expect(result.template.slug).toBe('wellness-therapy');
    expect(result.previewUrl).toBe('https://preview.flowstarter.net/calm-path');
    expect(result.files[0]?.content).toBe(
      'Calm Path Therapy preview /assets/portrait.webp',
    );
    expect(calls).toEqual([
      'agent:brand-intelligence',
      'agent:template-selector',
      'mcp:scaffold',
      'agent:preview-builder',
      'validator:preview',
      'publisher:preview',
    ]);
    await expect(access(previewWorkspace)).rejects.toThrow();
  });

  it('materializes cachedAssetFiles into the workspace and hands them to the agent', async () => {
    const intake = validIntake();
    const photo = Buffer.from([7, 7, 7]).toString('base64');
    let seenAssets: Array<{ sourceId: string; publicPath: string }> = [];
    let assetBytesInWorkspace: Buffer | undefined;
    const mediaFeedbacks: Array<string | undefined> = [];

    const agents = {
      analyzeBrand: async () => validBrandConfig(),
      selectTemplate: async () => ({
        slug: 'wellness-therapy',
        reason: 'Fits.',
        matchedSignals: ['therapy'],
        confidence: 0.9,
      }),
      buildPreview: async (input: {
        workspaceRoot: string;
        cachedAssets: Array<{ sourceId: string; publicPath: string }>;
        feedback?: string;
      }) => {
        mediaFeedbacks.push(input.feedback);
        seenAssets = input.cachedAssets;
        assetBytesInWorkspace = await readFile(
          join(input.workspaceRoot, 'public/flowstarter-assets/profile.jpg'),
        );
        const source = join(input.workspaceRoot, 'src/content/site.md');
        // First pass ignores the client's photos; the trusted media check
        // must trigger exactly one repair pass that names them.
        const content = input.feedback
          ? 'Calm Path Therapy preview /flowstarter-assets/profile.jpg'
          : 'Calm Path Therapy preview';
        await writeFile(source, content, 'utf8');
        return { summary: 'done', changedPaths: ['src/content/site.md'] };
      },
    } as unknown as PiSdkFlowstarterAgents;

    const pipeline = new PreviewGenerationPipeline(
      agents,
      staticLibrary(),
      { validate: async () => undefined },
      staticPublisher(),
    );
    await pipeline.run({
      intake,
      corpus: validCorpus(intake.projectId),
      cachedAssets: [{ sourceId: 'seed', publicPath: '/assets/seed.webp' }],
      cachedAssetFiles: [
        { sourceId: 'profile', fileName: 'profile.jpg', contentBase64: photo },
      ],
    });

    expect(seenAssets).toEqual([
      { sourceId: 'seed', publicPath: '/assets/seed.webp' },
      {
        sourceId: 'profile',
        publicPath: '/flowstarter-assets/profile.jpg',
        // Unparseable stub bytes: no dimensions, so not hero-eligible.
        heroEligible: false,
      },
    ]);
    expect(assetBytesInWorkspace).toEqual(Buffer.from([7, 7, 7]));
    expect(mediaFeedbacks).toHaveLength(2);
    expect(mediaFeedbacks[0]).toBeUndefined();
    expect(mediaFeedbacks[1]).toContain("client's own photos");
    expect(mediaFeedbacks[1]).toContain('/flowstarter-assets/profile.jpg');
  });

  it('accepts a repair pass that correctly changes nothing', async () => {
    const intake = validIntake();
    let passes = 0;

    const agents = {
      analyzeBrand: async () => validBrandConfig(),
      selectTemplate: async () => ({
        slug: 'wellness-therapy',
        reason: 'Fits.',
        matchedSignals: ['therapy'],
        confidence: 0.9,
      }),
      buildPreview: async (input: { workspaceRoot: string }) => {
        passes += 1;
        if (passes === 1) {
          // Writes the client's content, but without their business name, so
          // the trusted check asks for one repair pass.
          await writeFile(
            join(input.workspaceRoot, 'src/content/site.md'),
            'a personalized preview',
            'utf8',
          );
          return { summary: 'first', changedPaths: ['src/content/site.md'] };
        }
        // The repair pass fixes the file but reports no new paths — the shape
        // a model returns when it decides the edit is already in place.
        await writeFile(
          join(input.workspaceRoot, 'src/content/site.md'),
          'Calm Path Therapy preview',
          'utf8',
        );
        return { summary: 'nothing further to change', changedPaths: [] };
      },
    } as unknown as PiSdkFlowstarterAgents;

    const pipeline = new PreviewGenerationPipeline(
      agents,
      staticLibrary(),
      { validate: async () => undefined },
      staticPublisher(),
    );

    await expect(
      pipeline.run({
        intake,
        corpus: validCorpus(intake.projectId),
        cachedAssets: [],
      }),
    ).resolves.toMatchObject({
      previewUrl: 'https://preview.flowstarter.net/static',
    });
    expect(passes).toBe(2);
  });

  it('bars a client photo that is not hero-eligible from the hero slot', async () => {
    const intake = validIntake();
    const big = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]),
      Buffer.from('IHDR', 'ascii'),
      // 1080x1350 — clears the hero resolution floor.
      Buffer.from([0, 0, 0x04, 0x38, 0, 0, 0x05, 0x46, 8, 6, 0, 0, 0]),
    ]).toString('base64');
    const feedbacks: Array<string | undefined> = [];

    const agents = {
      analyzeBrand: async () => validBrandConfig(),
      selectTemplate: async () => ({
        slug: 'wellness-therapy',
        reason: 'Fits.',
        matchedSignals: ['therapy'],
        confidence: 0.9,
      }),
      buildPreview: async (input: {
        workspaceRoot: string;
        feedback?: string;
      }) => {
        feedbacks.push(input.feedback);
        // First pass puts the barred snapshot in the hero.
        const hero = input.feedback?.includes('heroEligible')
          ? '/flowstarter-assets/portrait.png'
          : '/flowstarter-assets/snapshot.png';
        await writeFile(
          join(input.workspaceRoot, 'src/content/site.md'),
          `Calm Path Therapy preview\n  image: "${hero}"\n`,
          'utf8',
        );
        return { summary: 'done', changedPaths: ['src/content/site.md'] };
      },
    } as unknown as PiSdkFlowstarterAgents;

    const pipeline = new PreviewGenerationPipeline(
      agents,
      staticLibrary(),
      { validate: async () => undefined },
      staticPublisher(),
    );
    await pipeline.run({
      intake,
      corpus: validCorpus(intake.projectId),
      cachedAssets: [],
      cachedAssetFiles: [
        { sourceId: 'snap', fileName: 'snapshot.png', contentBase64: big },
        {
          sourceId: 'portrait',
          fileName: 'portrait.png',
          contentBase64: big,
          heroEligible: true,
        },
      ],
    });

    const heroFeedback = feedbacks.find((f) => f?.includes('heroEligible'));
    expect(heroFeedback).toBeDefined();
    expect(heroFeedback).toContain('/flowstarter-assets/snapshot.png');
    expect(heroFeedback).toContain('/flowstarter-assets/portrait.png');
  });

  it('repairs a hero left empty when the client vouched for a photo', async () => {
    const intake = validIntake();
    const big = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]),
      Buffer.from('IHDR', 'ascii'),
      Buffer.from([0, 0, 0x04, 0x38, 0, 0, 0x05, 0x46, 8, 6, 0, 0, 0]),
    ]).toString('base64');
    const feedbacks: Array<string | undefined> = [];

    const agents = {
      analyzeBrand: async () => validBrandConfig(),
      selectTemplate: async () => ({
        slug: 'wellness-therapy',
        reason: 'Fits.',
        matchedSignals: ['therapy'],
        confidence: 0.9,
      }),
      buildPreview: async (input: {
        workspaceRoot: string;
        feedback?: string;
      }) => {
        feedbacks.push(input.feedback);
        // First pass leaves the hero on the template's placeholder panel.
        const hero = input.feedback?.includes('hero image is empty')
          ? '/flowstarter-assets/portrait.png'
          : '';
        await writeFile(
          join(input.workspaceRoot, 'src/content/site.md'),
          `Calm Path Therapy preview /flowstarter-assets/portrait.png\n  image: "${hero}"\n`,
          'utf8',
        );
        return { summary: 'done', changedPaths: ['src/content/site.md'] };
      },
    } as unknown as PiSdkFlowstarterAgents;

    const pipeline = new PreviewGenerationPipeline(
      agents,
      staticLibrary(),
      { validate: async () => undefined },
      staticPublisher(),
    );
    await pipeline.run({
      intake,
      corpus: validCorpus(intake.projectId),
      cachedAssets: [],
      cachedAssetFiles: [
        {
          sourceId: 'portrait',
          fileName: 'portrait.png',
          contentBase64: big,
          heroEligible: true,
        },
      ],
    });

    const heroFeedback = feedbacks.find((f) =>
      f?.includes('hero image is empty'),
    );
    expect(heroFeedback).toBeDefined();
    expect(heroFeedback).toContain('/flowstarter-assets/portrait.png');
  });

  it('leaves an eligible hero photo alone', async () => {
    const intake = validIntake();
    const big = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]),
      Buffer.from('IHDR', 'ascii'),
      Buffer.from([0, 0, 0x04, 0x38, 0, 0, 0x05, 0x46, 8, 6, 0, 0, 0]),
    ]).toString('base64');
    const feedbacks: Array<string | undefined> = [];

    const agents = {
      analyzeBrand: async () => validBrandConfig(),
      selectTemplate: async () => ({
        slug: 'wellness-therapy',
        reason: 'Fits.',
        matchedSignals: ['therapy'],
        confidence: 0.9,
      }),
      buildPreview: async (input: {
        workspaceRoot: string;
        feedback?: string;
      }) => {
        feedbacks.push(input.feedback);
        await writeFile(
          join(input.workspaceRoot, 'src/content/site.md'),
          'Calm Path Therapy preview\n  image: "/flowstarter-assets/portrait.png"\n',
          'utf8',
        );
        return { summary: 'done', changedPaths: ['src/content/site.md'] };
      },
    } as unknown as PiSdkFlowstarterAgents;

    const pipeline = new PreviewGenerationPipeline(
      agents,
      staticLibrary(),
      { validate: async () => undefined },
      staticPublisher(),
    );
    await pipeline.run({
      intake,
      corpus: validCorpus(intake.projectId),
      cachedAssets: [],
      cachedAssetFiles: [
        {
          sourceId: 'portrait',
          fileName: 'portrait.png',
          contentBase64: big,
          heroEligible: true,
        },
      ],
    });

    expect(feedbacks.some((f) => f?.includes('heroEligible'))).toBe(false);
  });

  it('retries personalization with feedback when the agent leaves the template untouched', async () => {
    const feedbacks: Array<string | undefined> = [];
    const intake = validIntake();

    const agents = {
      analyzeBrand: async () => validBrandConfig(),
      selectTemplate: async () => ({
        slug: 'wellness-therapy',
        reason: 'Fits the service journey.',
        matchedSignals: ['therapy'],
        confidence: 0.9,
      }),
      buildPreview: async (input: {
        workspaceRoot: string;
        feedback?: string;
      }) => {
        feedbacks.push(input.feedback);
        if (feedbacks.length === 1) {
          return { summary: 'No changes made', changedPaths: [] };
        }
        const source = join(input.workspaceRoot, 'src/content/site.md');
        await writeFile(source, 'Calm Path Therapy preview', 'utf8');
        return {
          summary: 'Preview tailored',
          changedPaths: ['src/content/site.md'],
        };
      },
    } as unknown as PiSdkFlowstarterAgents;

    const pipeline = new PreviewGenerationPipeline(
      agents,
      staticLibrary(),
      { validate: async () => undefined },
      staticPublisher(),
    );
    const result = await pipeline.run({
      intake,
      corpus: validCorpus(intake.projectId),
      cachedAssets: [],
    });

    expect(result.previewUrl).toBe('https://preview.flowstarter.net/static');
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[0]).toBeUndefined();
    expect(feedbacks[1]).toContain('without modifying any file');
  });

  it('gives the agent one bounded repair pass when preview validation fails', async () => {
    const feedbacks: Array<string | undefined> = [];
    let validations = 0;
    const intake = validIntake();

    const agents = {
      analyzeBrand: async () => validBrandConfig(),
      selectTemplate: async () => ({
        slug: 'wellness-therapy',
        reason: 'Fits the service journey.',
        matchedSignals: ['therapy'],
        confidence: 0.9,
      }),
      buildPreview: async (input: {
        workspaceRoot: string;
        feedback?: string;
      }) => {
        feedbacks.push(input.feedback);
        const source = join(input.workspaceRoot, 'src/content/site.md');
        await writeFile(source, 'Calm Path Therapy preview', 'utf8');
        return {
          summary: 'Preview tailored',
          changedPaths: ['src/content/site.md'],
        };
      },
    } as unknown as PiSdkFlowstarterAgents;

    const validator: SiteValidator = {
      validate: async () => {
        validations++;
        if (validations === 1)
          throw new Error('Astro check failed: bad frontmatter');
      },
    };

    const pipeline = new PreviewGenerationPipeline(
      agents,
      staticLibrary(),
      validator,
      staticPublisher(),
    );
    await pipeline.run({
      intake,
      corpus: validCorpus(intake.projectId),
      cachedAssets: [],
    });

    expect(validations).toBe(2);
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[1]).toContain('Astro check failed: bad frontmatter');
  });

  it('moves a deposit-paid project through the full-build agents into human QA', async () => {
    const calls: string[] = [];
    const projectId = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
    const worktreeRoot = await deepTempDir('flowstarter-worker-test');
    temporaryDirectories.push(worktreeRoot);

    const store: FullSiteBuildJobStore = {
      claim: async (jobId) => {
        calls.push('store:claim');
        expect(jobId).toBe('job-1');
        return {
          id: jobId,
          projectId,
          kind: 'FULL_SITE_BUILD',
          projectState: ProjectState.DEPOSIT_PAID,
          intake: validIntake(),
          brandConfig: validBrandConfig(),
          approvedPreviewFiles: [
            {
              path: 'src/content/site.md',
              content: 'Approved preview',
              type: 'file',
            },
          ],
          requiredIntegrations: ['cal.com', 'newsletter', 'lead-form'],
        };
      },
      markAgentWorking: async (_jobId, worktree) => {
        calls.push('store:agents-working');
        expect(worktree.branch).toBe(`client/flowstarter-${projectId}`);
      },
      markRebuildStarted: async () => {
        calls.push('store:rebuild-started');
      },
      markRebuilt: async () => {
        calls.push('store:rebuilt');
      },
      markHumanQa: async (_jobId, result) => {
        calls.push('store:human-qa');
        expect(result).toEqual({
          commitSha: 'abc123def456',
          pullRequestUrl: 'https://github.com/flowstarter/sites/pull/42',
          stagingUrl: 'https://calm-path.preview.flowstarter.net',
        });
      },
      markFailed: async () => {
        calls.push('store:failed');
      },
    };

    const worktrees = {
      create: async (id: string) => {
        calls.push('git:create-worktree');
        expect(id).toBe(projectId);
        return {
          branch: `client/flowstarter-${projectId}`,
          path: worktreeRoot,
        };
      },
      commit: async (_worktree: unknown, message: string) => {
        calls.push('git:commit');
        expect(message).toBe(`build: initialize Flowstarter site ${projectId}`);
        expect(
          await readFile(
            join(
              worktreeRoot,
              'generated-sites',
              projectId,
              'src/pages/about.astro',
            ),
            'utf8',
          ),
        ).toContain('Human-ready full site');
        return 'abc123def456';
      },
    } as unknown as SafeGitWorktreeManager;

    const agents = {
      buildFullSite: async (input: {
        workspaceRoot: string;
        requiredIntegrations: string[];
      }) => {
        calls.push('agent:full-site-builder');
        expect(input.requiredIntegrations).toEqual([
          'cal.com',
          'newsletter',
          'lead-form',
        ]);
        expect(
          await readFile(
            join(input.workspaceRoot, 'src/content/site.md'),
            'utf8',
          ),
        ).toBe('Approved preview');
        await mkdir(join(input.workspaceRoot, 'src/pages'), {
          recursive: true,
        });
        await writeFile(
          join(input.workspaceRoot, 'src/pages/about.astro'),
          '<main>Human-ready full site</main>',
          'utf8',
        );
        return {
          summary: 'Full site built',
          changedPaths: ['src/pages/about.astro'],
        };
      },
    } as unknown as PiSdkFlowstarterAgents;

    const validator: SiteValidator = {
      validate: async (workspaceRoot, phase) => {
        calls.push(`validator:${phase}`);
        expect(phase).toBe('full');
        expect(
          await readFile(join(workspaceRoot, 'src/pages/about.astro'), 'utf8'),
        ).toContain('Human-ready full site');
      },
    };

    const pullRequests: PullRequestPublisher = {
      create: async (input) => {
        calls.push('publisher:pr-staging');
        expect(input.branch).toBe(`client/flowstarter-${projectId}`);
        expect(input.commitSha).toBe('abc123def456');
        return {
          pullRequestUrl: 'https://github.com/flowstarter/sites/pull/42',
          stagingUrl: 'https://calm-path.preview.flowstarter.net',
        };
      },
    };

    const worker = new FullSiteBuildWorker(
      store,
      worktrees,
      agents,
      validator,
      pullRequests,
    );
    await worker.run('job-1');

    expect(calls).toEqual([
      'store:claim',
      'git:create-worktree',
      'store:agents-working',
      'agent:full-site-builder',
      'validator:full',
      'git:commit',
      'publisher:pr-staging',
      'store:human-qa',
    ]);
  });

  it("keeps the operator board informed and folds the team's notes into the next pass", async () => {
    const projectId = validIntake().projectId;
    const worktreeRoot = await deepTempDir('flowstarter-worker-notes');
    temporaryDirectories.push(worktreeRoot);

    const events: Array<{ kind: string; body: string }> = [];
    const feedbacks: Array<string | undefined> = [];
    // One note waiting before the build starts, one that arrives while the
    // agents are busy with the first pass.
    const notes = [
      {
        id: 'n1',
        body: 'Use the client logo in every header.',
        actor: 'user_1',
        createdAt: '2026-09-08T10:00:00.000Z',
      },
      {
        id: 'n2',
        body: 'Add the Saturday opening hours to the contact page.',
        actor: 'user_2',
        createdAt: '2026-09-08T10:05:00.000Z',
      },
    ];
    let released = 1;

    const store: FullSiteBuildJobStore = {
      claim: async (jobId) => ({
        id: jobId,
        projectId,
        kind: 'FULL_SITE_BUILD',
        projectState: ProjectState.DEPOSIT_PAID,
        intake: validIntake(),
        brandConfig: validBrandConfig(),
        approvedPreviewFiles: [
          {
            path: 'src/content/site.md',
            content: 'Approved preview',
            type: 'file',
          },
        ],
        requiredIntegrations: [],
      }),
      markAgentWorking: async () => undefined,
      markRebuildStarted: async () => undefined,
      markRebuilt: async () => undefined,
      markHumanQa: async () => undefined,
      markFailed: async () => undefined,
      appendEvent: async (_jobId, event) => {
        events.push({ kind: event.kind, body: event.body });
      },
      readOperatorNotes: async (_jobId, after) =>
        notes
          .slice(0, released)
          .filter((note) => !after || note.createdAt > after),
    };
    const worktrees = {
      create: async () => ({
        branch: `client/flowstarter-${projectId}`,
        path: worktreeRoot,
      }),
      commit: async () => 'abc123',
    } as unknown as SafeGitWorktreeManager;
    const agents = {
      buildFullSite: async (input: {
        workspaceRoot: string;
        feedback?: string;
      }) => {
        feedbacks.push(input.feedback);
        // The second note lands while this pass runs.
        released = 2;
        await mkdir(join(input.workspaceRoot, 'src/pages'), {
          recursive: true,
        });
        await writeFile(
          join(input.workspaceRoot, 'src/pages/index.astro'),
          '<main />',
          'utf8',
        );
        return {
          summary: `Done: applied ${input.feedback ? 'the notes' : 'the brief'}.`,
          changedPaths: ['src/pages/index.astro'],
        };
      },
    } as unknown as PiSdkFlowstarterAgents;
    const validator: SiteValidator = { validate: async () => undefined };
    const pullRequests: PullRequestPublisher = {
      create: async () => ({
        pullRequestUrl: 'https://example.test/pr/1',
        stagingUrl: 'https://staging.test',
      }),
    };

    await new FullSiteBuildWorker(
      store,
      worktrees,
      agents,
      validator,
      pullRequests,
    ).run('job-3');

    // The first pass carried the waiting note, the dedicated pass the late one.
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[0]).toContain('OPERATOR NOTES');
    expect(feedbacks[0]).toContain('1. Use the client logo in every header.');
    expect(feedbacks[0]).not.toContain('Saturday');
    expect(feedbacks[1]).toContain('1. Add the Saturday opening hours');
    expect(feedbacks[1]).not.toContain('logo');

    const phases = events.filter((e) => e.kind === 'phase').map((e) => e.body);
    expect(phases).toEqual([
      'Preparing a clean worktree',
      'Materializing the approved preview',
      'Agents expanding the site, with 1 note from the team',
      'Checking the build',
      'Applying 1 note from the team',
      'Checking the build',
      'Checking the site matches the brief',
      'Checking for placeholder copy',
      'Checking for placeholder images',
      'Committing the site',
      'Publishing for review',
      'Handed to human QA',
    ]);
    // Each pass ends with the agents' own words on the board.
    expect(events.filter((e) => e.kind === 'reply').map((e) => e.body)).toEqual(
      ['Done: applied the notes.', 'Done: applied the notes.'],
    );
  });

  it('builds silently, and unchanged, for a store without the conversation channel', async () => {
    // Covered by the first test in this block: its store has neither
    // appendEvent nor readOperatorNotes and the call order is asserted exactly.
    expect(
      operatorNotesFeedback([
        {
          id: 'a',
          body: '  Make   the hero  warmer ',
          actor: 'u',
          createdAt: 't',
        },
      ]),
    ).toContain('1. Make the hero warmer');
  });

  it('refuses to build when the 20% deposit gate has not been reached', async () => {
    const calls: string[] = [];
    const store: FullSiteBuildJobStore = {
      claim: async () => ({
        id: 'job-2',
        projectId: validIntake().projectId,
        kind: 'FULL_SITE_BUILD',
        projectState: ProjectState.PREVIEW_READY,
        intake: validIntake(),
        brandConfig: validBrandConfig(),
        approvedPreviewFiles: [],
        requiredIntegrations: [],
      }),
      markAgentWorking: async () => undefined,
      markRebuildStarted: async () => undefined,
      markRebuilt: async () => undefined,
      markHumanQa: async () => undefined,
      markFailed: async (_jobId, error) => {
        calls.push(error.code);
      },
    };
    const worktrees = {
      create: async () => {
        calls.push('worktree-created');
        throw new Error('must not run');
      },
    } as unknown as SafeGitWorktreeManager;

    const worker = new FullSiteBuildWorker(
      store,
      worktrees,
      {} as PiSdkFlowstarterAgents,
      {} as SiteValidator,
      {} as PullRequestPublisher,
    );
    await worker.run('job-2');

    expect(calls).toEqual(['INVALID_PROJECT_STATE']);
  });

  it("puts a client's published edit live without an agent and without moving the project", async () => {
    const calls: string[] = [];
    const events: Array<{ kind: string; body: string }> = [];
    const projectId = validIntake().projectId;
    const worktreeRoot = await deepTempDir('flowstarter-rebuild-test');
    temporaryDirectories.push(worktreeRoot);

    const store: FullSiteBuildJobStore = {
      claim: async (jobId) => ({
        id: jobId,
        projectId,
        kind: 'SITE_REBUILD',
        // A rebuild happens long after the deposit build finished, so the
        // project is live, not waiting to be built.
        projectState: ProjectState.LIVE_SUBSCRIPTION,
        intake: validIntake(),
        brandConfig: validBrandConfig(),
        approvedPreviewFiles: [
          {
            path: 'src/content/site.md',
            content: 'The edit the client published',
            type: 'file',
          },
        ],
        requiredIntegrations: [],
      }),
      markAgentWorking: async () => {
        calls.push('store:agents-working');
      },
      markHumanQa: async () => {
        calls.push('store:human-qa');
      },
      markRebuildStarted: async (_jobId, worktree) => {
        calls.push('store:rebuild-started');
        expect(worktree.path).toBe(worktreeRoot);
      },
      markRebuilt: async (_jobId, result) => {
        calls.push('store:rebuilt');
        expect(result).toEqual({
          commitSha: 'reb1u1ld',
          pullRequestUrl: 'https://example.test/deploy/9',
          stagingUrl: 'https://calm-path.flowstarter.net',
        });
      },
      markFailed: async (_jobId, error) => {
        calls.push(`store:failed:${error.code}`);
      },
      appendEvent: async (_jobId, event) => {
        events.push({ kind: event.kind, body: event.body });
      },
    };

    const worktrees = {
      discard: async () => {
        calls.push('git:discard');
      },
      create: async () => {
        calls.push('git:create-worktree');
        return {
          branch: `client/flowstarter-${projectId}`,
          path: worktreeRoot,
        };
      },
      commit: async (_worktree: unknown, message: string) => {
        calls.push('git:commit');
        expect(message).toContain('publish client edit');
        return 'reb1u1ld';
      },
    } as unknown as SafeGitWorktreeManager;

    // Calling this at all would be the bug: a rebuild is the client's own
    // words, and an agent pass could only disagree with them.
    const agents = {
      buildFullSite: async () => {
        calls.push('agent:full-site-builder');
        throw new Error('the rebuild must not call an agent');
      },
    } as unknown as PiSdkFlowstarterAgents;

    const validator: SiteValidator = {
      validate: async (workspaceRoot, phase) => {
        calls.push(`validator:${phase}`);
        expect(
          await readFile(join(workspaceRoot, 'src/content/site.md'), 'utf8'),
        ).toBe('The edit the client published');
      },
    };

    const pullRequests: PullRequestPublisher = {
      create: async (input) => {
        calls.push('publisher:deploy');
        expect(input.commitSha).toBe('reb1u1ld');
        expect(input.siteRoot).toBe(
          join(worktreeRoot, 'generated-sites', projectId),
        );
        return {
          pullRequestUrl: 'https://example.test/deploy/9',
          stagingUrl: 'https://calm-path.flowstarter.net',
        };
      },
    };

    await new FullSiteBuildWorker(
      store,
      worktrees,
      agents,
      validator,
      pullRequests,
    ).run('job-rebuild');

    expect(calls).toEqual([
      'git:discard',
      'git:create-worktree',
      'store:rebuild-started',
      'validator:full',
      'git:commit',
      'publisher:deploy',
      'store:rebuilt',
    ]);
    // Neither of the two state-moving store methods was touched.
    expect(calls).not.toContain('store:agents-working');
    expect(calls).not.toContain('store:human-qa');
    expect(calls).not.toContain('agent:full-site-builder');

    expect(events.filter((e) => e.kind === 'phase').map((e) => e.body)).toEqual(
      [
        'Preparing a clean worktree',
        'Materializing the published edit',
        'Checking the build',
        'Committing the site',
        'Publishing',
        'Live',
      ],
    );
  });

  it('leaves the live site alone when the published edit does not build', async () => {
    const calls: string[] = [];
    const events: Array<{ kind: string; body: string }> = [];
    const projectId = validIntake().projectId;
    const worktreeRoot = await deepTempDir('flowstarter-rebuild-fail');
    temporaryDirectories.push(worktreeRoot);

    const store: FullSiteBuildJobStore = {
      claim: async (jobId) => ({
        id: jobId,
        projectId,
        kind: 'SITE_REBUILD',
        projectState: ProjectState.HUMAN_QA,
        intake: validIntake(),
        brandConfig: validBrandConfig(),
        approvedPreviewFiles: [
          { path: 'src/content/site.md', content: 'Broken', type: 'file' },
        ],
        requiredIntegrations: [],
      }),
      markAgentWorking: async () => undefined,
      markHumanQa: async () => undefined,
      markRebuildStarted: async () => undefined,
      markRebuilt: async () => {
        calls.push('store:rebuilt');
      },
      markFailed: async (_jobId, error) => {
        calls.push(`store:failed:${error.code}`);
        expect(error.detail).toContain('astro check: 1 error');
      },
      appendEvent: async (_jobId, event) => {
        events.push({ kind: event.kind, body: event.body });
      },
    };
    const worktrees = {
      create: async () => ({
        branch: `client/flowstarter-${projectId}`,
        path: worktreeRoot,
      }),
      commit: async () => {
        calls.push('git:commit');
        return 'nope';
      },
    } as unknown as SafeGitWorktreeManager;
    const validator: SiteValidator = {
      validate: async () => {
        calls.push('validator:full');
        throw new Error('astro check: 1 error in src/content/site.md');
      },
    };
    const pullRequests: PullRequestPublisher = {
      create: async () => {
        calls.push('publisher:deploy');
        throw new Error('must not publish a build that failed');
      },
    };

    await expect(
      new FullSiteBuildWorker(
        store,
        worktrees,
        {} as PiSdkFlowstarterAgents,
        validator,
        pullRequests,
      ).run('job-rebuild-fail'),
    ).rejects.toThrow(/astro check/);

    // Nothing was committed and nothing was deployed: the site that is live
    // stays live.
    expect(calls).toEqual([
      'validator:full',
      'store:failed:SITE_REBUILD_FAILED',
    ]);
    expect(events.filter((e) => e.kind === 'log').map((e) => e.body)).toEqual([
      'Rebuild failed: astro check: 1 error in src/content/site.md',
    ]);
  });
});

function staticLibrary(): TemplateLibrary {
  return {
    search: async () => [],
    getDetails: async () => ({}),
    scaffold: async (slug) => ({
      template: {
        metadata: {
          slug,
          displayName: 'Wellness & Therapy',
          description: 'Trust-led service template.',
          category: 'services',
          useCase: ['therapy'],
          fileCount: 1,
          totalLOC: 1,
        },
        config: {},
      },
      files: [
        { path: 'src/content/site.md', content: 'Template copy', type: 'file' },
      ],
    }),
    close: async () => undefined,
  };
}

function staticPublisher(): PreviewPublisher {
  return {
    publish: async () => ({
      previewUrl: 'https://preview.flowstarter.net/static',
      artifactUrl: 's3://flowstarter-previews/static.tar.gz',
      files: [],
    }),
  };
}

function validIntake(): BusinessIntakePayload {
  return {
    projectId: '0f4e1088-8d8f-4f18-83b1-406cc292b23c',
    business: {
      name: 'Calm Path Therapy',
      niche: 'Therapy practice',
      location: 'Cluj-Napoca, Romania',
      description: 'Calm, practical therapy for founders and creatives.',
      targetAudience: 'Founders and creative professionals',
      primaryGoal: 'bookings',
    },
    socialMedia: [
      {
        platform: 'instagram',
        profileUrl: 'https://www.instagram.com/calmpaththerapy',
        scraper: { provider: 'approved-worker' },
      },
      {
        platform: 'linkedin',
        profileUrl: 'https://www.linkedin.com/company/calmpaththerapy',
        scraper: { provider: 'approved-worker' },
      },
    ],
    locale: 'en-RO',
    submittedAt: '2026-08-11T10:00:00.000Z',
    consent: {
      publicProfileAnalysis: true,
      acceptedAt: '2026-08-11T10:00:00.000Z',
    },
  };
}

function validCorpus(projectId: string): ScrapeCorpus {
  return {
    projectId,
    documents: [
      {
        sourceId: 'text-1',
        platform: 'instagram',
        kind: 'caption',
        text: 'A calmer, practical way through change.',
      },
    ],
    images: [
      {
        sourceId: 'image-1',
        objectKey: 'private/calmpath/portrait.webp',
        mediaType: 'image/webp',
      },
    ],
    completedAt: '2026-08-11T10:05:00.000Z',
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
      directness: 0.66,
      adjectives: ['calm', 'credible', 'personal'],
      avoidPhrases: ['unlock your potential'],
      sampleHeadline: 'A calmer path through change.',
      sampleBody: 'Practical support for founders and creative professionals.',
      primaryCta: 'Book a session',
    },
    ideas: {
      positioning: 'Practical therapy for demanding creative work.',
      heroAngle: 'Lead with calm, relevant support.',
      sections: [
        {
          id: 'services',
          purpose: 'Explain the therapy offer.',
          evidenceSourceIds: ['text-1'],
        },
      ],
      contentThemes: ['calm support', 'practical change'],
    },
    evidence: {
      textSourceIds: ['text-1'],
      imageSourceIds: ['image-1'],
      assumptions: [],
    },
  };
}

describe('preview teaser injection', () => {
  it('injects assets and patches layouts idempotently', async () => {
    const { injectPreviewTeaser } = await import(
      '../src/flowstarter/preview-teaser'
    );
    const { mkdtemp, mkdir, writeFile, readFile } = await import(
      'node:fs/promises'
    );
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'fs-teaser-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'src/layouts'), { recursive: true });
    await writeFile(
      join(root, 'src/layouts/Base.astro'),
      '<html><head><title>x</title></head><body><slot /></body></html>',
      'utf8',
    );

    const first = await injectPreviewTeaser(root, { keepHomeSections: 2 });
    expect(first.layoutsPatched).toBe(1);
    const layout = await readFile(join(root, 'src/layouts/Base.astro'), 'utf8');
    expect(layout).toContain('flowstarter-preview-teaser.css');
    expect(layout).toContain('flowstarter-preview-teaser.js');
    const js = await readFile(
      join(root, 'public/flowstarter-preview-teaser.js'),
      'utf8',
    );
    expect(js).toContain("location.pathname === '/' ? 2 : 1");

    // Second run must not double-inject.
    const second = await injectPreviewTeaser(root, { keepHomeSections: 2 });
    expect(second.layoutsPatched).toBe(1);
    const again = await readFile(join(root, 'src/layouts/Base.astro'), 'utf8');
    expect(again.split('flowstarter-preview-teaser.css').length).toBe(2);
  });

  it('leaves the top of each locked section readable and always holds the last sections back', async () => {
    const { injectPreviewTeaser } = await import(
      '../src/flowstarter/preview-teaser'
    );
    const { mkdtemp, mkdir, writeFile, readFile } = await import(
      'node:fs/promises'
    );
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'fs-teaser-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'src/layouts'), { recursive: true });
    await writeFile(
      join(root, 'src/layouts/Base.astro'),
      '<html><head></head><body><slot /></body></html>',
      'utf8',
    );

    await injectPreviewTeaser(root, {
      keepHomeSections: 6,
      minLockedSections: 2,
      revealTop: 0.35,
    });

    const css = await readFile(
      join(root, 'public/flowstarter-preview-teaser.css'),
      'utf8',
    );
    // The veil is masked: clear for the top 35%, fully blurred from 55% down.
    expect(css).toContain('transparent 35%, #000 55%');
    // The chip and button sit in the blurred part, not over the readable top.
    expect(css).toMatch(/\.fs-teaser-gate \{[^}]*top: 55%/);

    const js = await readFile(
      join(root, 'public/flowstarter-preview-teaser.js'),
      'utf8',
    );
    expect(js).toContain('sections.length - 2');
    expect(js).not.toContain('__MIN_LOCKED__');
    expect(js).toContain("gate.className = 'fs-teaser-gate'");

    // Out-of-range reveals are clamped rather than producing a broken mask.
    await injectPreviewTeaser(root, { revealTop: 2 });
    const clamped = await readFile(
      join(root, 'public/flowstarter-preview-teaser.css'),
      'utf8',
    );
    expect(clamped).toContain('transparent 70%, #000 90%');
  });

  it('turns the locked overlay into a checkout link that escapes the frame', async () => {
    const { injectPreviewTeaser } = await import(
      '../src/flowstarter/preview-teaser'
    );
    const { mkdtemp, mkdir, writeFile, readFile } = await import(
      'node:fs/promises'
    );
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'fs-teaser-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'src/layouts'), { recursive: true });
    await writeFile(
      join(root, 'src/layouts/Base.astro'),
      '<html><head></head><body><slot /></body></html>',
      'utf8',
    );

    await injectPreviewTeaser(root, {
      unlockUrl: 'https://app.flowstarter.dev/unlock/9ab5',
      unlockLabel: 'Unlock the full site',
    });

    const js = await readFile(
      join(root, 'public/flowstarter-preview-teaser.js'),
      'utf8',
    );
    expect(js).toContain(
      'var UNLOCK_URL = "https://app.flowstarter.dev/unlock/9ab5"',
    );
    expect(js).toContain('var UNLOCK_LABEL = "Unlock the full site"');
    // Anchor, not a div, and it must break out of the funnel's iframe.
    expect(js).toContain("createElement(UNLOCK_URL ? 'a' : 'div')");
    expect(js).toContain("veil.target = '_top'");
    expect(js).toContain("veil.rel = 'noopener'");
  });

  it('keeps the overlay inert when no unlock destination is configured', async () => {
    const { injectPreviewTeaser } = await import(
      '../src/flowstarter/preview-teaser'
    );
    const { mkdtemp, mkdir, writeFile, readFile } = await import(
      'node:fs/promises'
    );
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'fs-teaser-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'src/layouts'), { recursive: true });
    await writeFile(
      join(root, 'src/layouts/Base.astro'),
      '<html><head></head><body><slot /></body></html>',
      'utf8',
    );

    await injectPreviewTeaser(root, {});
    const js = await readFile(
      join(root, 'public/flowstarter-preview-teaser.js'),
      'utf8',
    );
    expect(js).toContain('var UNLOCK_URL = ""');
  });

  it('refuses an unlock destination that is not a navigable https origin', async () => {
    const { injectPreviewTeaser } = await import(
      '../src/flowstarter/preview-teaser'
    );
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'fs-teaser-'));
    temporaryDirectories.push(root);

    await expect(
      injectPreviewTeaser(root, { unlockUrl: 'javascript:alert(1)' }),
    ).rejects.toThrow(/must use HTTPS/);
    await expect(
      injectPreviewTeaser(root, { unlockUrl: 'http://evil.example.com/pay' }),
    ).rejects.toThrow(/must use HTTPS/);
    await expect(
      injectPreviewTeaser(root, { unlockUrl: '/relative/path' }),
    ).rejects.toThrow(/must be absolute/);
    // Loopback stays usable for local development.
    await expect(
      injectPreviewTeaser(root, {
        unlockUrl: 'http://localhost:3000/unlock/x',
      }),
    ).resolves.toBeTruthy();
  });

  it('leaves the agent boundary intact — teaser is operator code on layouts', async () => {
    const { injectPreviewTeaser } = await import(
      '../src/flowstarter/preview-teaser'
    );
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'fs-teaser-'));
    temporaryDirectories.push(root);
    // No layouts at all: injector degrades gracefully.
    const result = await injectPreviewTeaser(root);
    expect(result.layoutsPatched).toBe(0);
  });
});

describe('rendered-audit repair loop', () => {
  it('repairs and republishes once when the audit reports a defect', async () => {
    const { PreviewGenerationPipeline } = await import(
      '../src/flowstarter/workflows'
    );
    const { mkdir: mkdirP, writeFile: writeF } = await import(
      'node:fs/promises'
    );
    const { join: joinP } = await import('node:path');

    const calls: string[] = [];
    let teardowns = 0;
    const agents = {
      analyzeBrand: async () => validBrandConfig(),
      selectTemplate: async () => ({
        slug: 'wellness-therapy',
        reason: 'r',
        matchedSignals: [],
        confidence: 0.9,
      }),
      buildPreview: async (input: {
        workspaceRoot: string;
        feedback?: string;
      }) => {
        calls.push(
          input.feedback
            ? `personalize:${input.feedback.slice(0, 30)}`
            : 'personalize:first',
        );
        const target = joinP(input.workspaceRoot, 'src/content/site.md');
        await mkdirP(joinP(input.workspaceRoot, 'src/content'), {
          recursive: true,
        });
        await writeF(target, `# ${validIntake().business.name}`, 'utf8');
        return { summary: 'ok', changedPaths: ['src/content/site.md'] };
      },
    } as never;
    const library = {
      search: async () => [],
      getDetails: async () => ({}),
      scaffold: async () => ({
        template: {
          metadata: {
            slug: 'wellness-therapy',
            displayName: 'x',
            description: 'x',
            category: 'services',
            useCase: [],
            fileCount: 1,
            totalLOC: 1,
          },
          config: {},
        },
        files: [{ path: 'src/content/site.md', content: 'seed', type: 'file' }],
      }),
      close: async () => undefined,
    } as never;
    const validator = { validate: async () => undefined } as never;
    const publisher = {
      publish: async () => {
        calls.push('publish');
        return {
          previewUrl: `http://preview/${calls.filter((c) => c === 'publish').length}`,
          artifactUrl: 'local://x',
          files: [],
          teardown: async () => {
            teardowns++;
          },
        };
      },
    } as never;

    let audits = 0;
    const pipeline = new PreviewGenerationPipeline(
      agents,
      library,
      validator,
      publisher,
      undefined,
      {
        renderedAudit: async (url: string) => {
          audits++;
          calls.push(`audit:${url}`);
          return audits === 1
            ? 'hero heading renders dark-on-dark in the dark scheme'
            : undefined;
        },
      },
    );

    const result = await pipeline.run({
      intake: validIntake(),
      corpus: validCorpus(validIntake().projectId),
      cachedAssets: [],
    });

    expect(calls).toEqual([
      'personalize:first',
      'publish',
      'audit:http://preview/1',
      'personalize:A rendered review of the publi',
      'publish',
    ]);
    expect(teardowns).toBe(1);
    expect(result.previewUrl).toBe('http://preview/2');
  });

  it('keeps the first publish when the auditor throws', async () => {
    const { PreviewGenerationPipeline } = await import(
      '../src/flowstarter/workflows'
    );
    const { mkdir: mkdirP, writeFile: writeF } = await import(
      'node:fs/promises'
    );
    const { join: joinP } = await import('node:path');

    const agents = {
      analyzeBrand: async () => validBrandConfig(),
      selectTemplate: async () => ({
        slug: 'wellness-therapy',
        reason: 'r',
        matchedSignals: [],
        confidence: 0.9,
      }),
      buildPreview: async (input: { workspaceRoot: string }) => {
        const target = joinP(input.workspaceRoot, 'src/content/site.md');
        await mkdirP(joinP(input.workspaceRoot, 'src/content'), {
          recursive: true,
        });
        await writeF(target, `# ${validIntake().business.name}`, 'utf8');
        return { summary: 'ok', changedPaths: ['src/content/site.md'] };
      },
    } as never;
    const library = {
      search: async () => [],
      getDetails: async () => ({}),
      scaffold: async () => ({
        template: {
          metadata: {
            slug: 'wellness-therapy',
            displayName: 'x',
            description: 'x',
            category: 'services',
            useCase: [],
            fileCount: 1,
            totalLOC: 1,
          },
          config: {},
        },
        files: [{ path: 'src/content/site.md', content: 'seed', type: 'file' }],
      }),
      close: async () => undefined,
    } as never;
    const validator = { validate: async () => undefined } as never;
    const publisher = {
      publish: async () => ({
        previewUrl: 'http://preview/kept',
        artifactUrl: 'local://x',
        files: [],
      }),
    } as never;

    const pipeline = new PreviewGenerationPipeline(
      agents,
      library,
      validator,
      publisher,
      undefined,
      {
        renderedAudit: async () => {
          throw new Error('browser failed to launch');
        },
      },
    );

    const result = await pipeline.run({
      intake: validIntake(),
      corpus: validCorpus(validIntake().projectId),
      cachedAssets: [],
    });
    expect(result.previewUrl).toBe('http://preview/kept');
  });
});

describe('the quality sweep is decided by a residue check, not run by habit', () => {
  const SAMPLE =
    'I work with people carrying anxiety, burnout, or the weight of a life that no longer quite fits.';
  const scaffoldFiles = [
    {
      path: 'src/content/site.md',
      content: [
        '---',
        'header:',
        '  logo: "Marsh & Fern"',
        '  navLinks:',
        '    - label: "Home"',
        '      href: "/"',
        'hero:',
        '  title: "FOR ADULTS WHO ARE TIRED OF JUST HOLDING IT TOGETHER"',
        '  image: "/images/blog-3.jpg"',
        '  text: |',
        `    ${SAMPLE}`,
        '---',
      ].join('\n'),
      type: 'file' as const,
    },
    {
      path: 'src/pages/index.astro',
      content: `<p>${SAMPLE}</p>`,
      type: 'file' as const,
    },
  ];

  it('lists the sentence-like sample copy of the content files only', async () => {
    const { templateSampleStrings } = await import(
      '../src/flowstarter/workflows'
    );
    const samples = templateSampleStrings(scaffoldFiles);
    expect([...samples.keys()]).toEqual(['src/content/site.md']);
    expect(samples.get('src/content/site.md')).toEqual([
      'FOR ADULTS WHO ARE TIRED OF JUST HOLDING IT TOGETHER',
      SAMPLE,
    ]);
  });

  async function workspaceWith(content: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'residue-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'src/content'), { recursive: true });
    await writeFile(join(root, 'src/content/site.md'), content, 'utf8');
    return root;
  }

  it('names a surviving template sentence, and a collective voice', async () => {
    const { findTemplateResidue } = await import(
      '../src/flowstarter/workflows'
    );
    const kept = await workspaceWith(
      `title: "Ionescu Dental"\ntext: |\n  ${SAMPLE}\n`,
    );
    const residue = await findTemplateResidue(kept, scaffoldFiles);
    expect(residue).toContain('still present verbatim');
    expect(residue).toContain(SAMPLE);

    const studio = await workspaceWith(
      'text: "We are a studio. Our team, our craft, our promise to us and ours: we deliver."',
    );
    expect(await findTemplateResidue(studio, scaffoldFiles)).toMatch(
      /we\/our\/us \d+ times/,
    );

    const clean = await workspaceWith(
      'title: "Ionescu Dental"\ntext: "I do cosmetic dentistry in Cluj, one patient at a time."',
    );
    expect(await findTemplateResidue(clean, scaffoldFiles)).toBeUndefined();
  });

  function libraryWith(files: typeof scaffoldFiles): TemplateLibrary {
    return {
      search: async () => [],
      getDetails: async () => ({}),
      scaffold: async (slug) => ({
        template: {
          metadata: {
            slug,
            displayName: 'Wellness & Therapy',
            description: 'Trust-led service template.',
            category: 'services',
            useCase: ['therapy'],
            fileCount: files.length,
            totalLOC: 1,
          },
          config: {},
        },
        files,
      }),
      close: async () => undefined,
    };
  }

  async function runWith(firstPassContent: string, sweep: boolean | 'always') {
    const feedbacks: Array<string | undefined> = [];
    const agents = {
      analyzeBrand: async () => validBrandConfig(),
      selectTemplate: async () => ({
        slug: 'wellness-therapy',
        reason: 'Fits.',
        matchedSignals: ['therapy'],
        confidence: 0.9,
      }),
      buildPreview: async (input: {
        workspaceRoot: string;
        feedback?: string;
      }) => {
        feedbacks.push(input.feedback);
        await writeFile(
          join(input.workspaceRoot, 'src/content/site.md'),
          input.feedback
            ? 'title: "Calm Path Therapy"\ntext: "I rewrote it."'
            : firstPassContent,
          'utf8',
        );
        return { summary: 'done', changedPaths: ['src/content/site.md'] };
      },
    } as unknown as PiSdkFlowstarterAgents;
    const intake = validIntake();
    const pipeline = new PreviewGenerationPipeline(
      agents,
      libraryWith(scaffoldFiles),
      { validate: async () => undefined },
      staticPublisher(),
      undefined,
      { qualitySweep: sweep },
    );
    await pipeline.run({
      intake,
      corpus: validCorpus(intake.projectId),
      cachedAssets: [],
    });
    return feedbacks;
  }

  it('skips the sweep when the first pass left nothing behind', async () => {
    const feedbacks = await runWith(
      'title: "Calm Path Therapy"\ntext: "I help adults in Bristol through anxiety."',
      true,
    );
    expect(feedbacks).toEqual([undefined]);
  });

  it('runs the sweep with the exact findings when sample copy survived', async () => {
    const feedbacks = await runWith(
      `title: "Calm Path Therapy"\ntext: |\n  ${SAMPLE}\n`,
      true,
    );
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[1]).toContain('Quality sweep');
    expect(feedbacks[1]).toContain(SAMPLE);
  });

  it("still runs unconditionally when asked to 'always'", async () => {
    const feedbacks = await runWith(
      'title: "Calm Path Therapy"\ntext: "I help adults in Bristol through anxiety."',
      'always',
    );
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[1]).toContain('Quality sweep');
  });
});

describe('block comments are stripped by scanning, not by pattern', () => {
  it('removes a closed comment and leaves the rest of the line', () => {
    expect(stripBlockComments('a /* gone */ b')).toBe('a  b');
    expect(stripBlockComments('a /* gone */ b', ' ')).toBe('a   b');
  });

  it('removes every comment in a file, not just the first', () => {
    expect(stripBlockComments('/*one*/a/*two*/b/*three*/')).toBe('ab');
  });

  it('does not treat comments as nesting: the first close wins', () => {
    // CSS has no nested comments, so the inner `/*` is just text and the
    // trailing `*/` is left behind exactly as a CSS parser would see it.
    expect(stripBlockComments('a/* outer /* inner */ tail */b')).toBe(
      'a tail */b',
    );
  });

  it('leaves an unterminated comment, and everything after it, untouched', () => {
    const truncated = ':root { --a: 1; } /* the model stopped here';
    expect(stripBlockComments(truncated)).toBe(truncated);
    expect(stripBlockComments('/*done*/ then /* not done')).toBe(
      ' then /* not done',
    );
  });

  it('leaves a lone slash-star-slash alone: it never closed', () => {
    expect(stripBlockComments('/*/')).toBe('/*/');
    expect(stripBlockComments('/**/')).toBe('');
    expect(stripBlockComments('/***/')).toBe('');
  });

  it('cssSkeleton and cssSyntaxIssue read a commented stylesheet the same way', async () => {
    const { cssSkeleton, cssSyntaxIssue } = await import(
      '../src/flowstarter/workflows'
    );
    const bare = ':root { --a: 1; }';
    const commented = '/* tokens */ :root { /* brand */ --a: 1; }';
    expect(cssSkeleton(commented)).toBe(cssSkeleton(bare));
    expect(cssSyntaxIssue(commented)).toBeUndefined();
    // A brace inside a comment is not a brace.
    expect(cssSyntaxIssue(':root { --a: 1; /* } */ }')).toBeUndefined();
  });
});

async function cssSyntaxIssueOf(css: string): Promise<string | undefined> {
  const { cssSyntaxIssue } = await import('../src/flowstarter/workflows');
  return cssSyntaxIssue(css);
}

describe('declaration values are folded away by scanning, not by pattern', () => {
  it('keeps the property name and drops the value', () => {
    expect(collapseDeclarationValues('a { color: red; }')).toBe(
      'a { color:_; }',
    );
    expect(collapseDeclarationValues('--brand : #123456 ;')).toBe('--brand:_;');
  });

  it('folds every declaration in a block, not just the first', () => {
    expect(collapseDeclarationValues(':root{--a:1;--b:2;}')).toBe(
      ':root{--a:_;--b:_;}',
    );
  });

  it('leaves a declaration alone when a brace arrives before the semicolon', () => {
    // `a:hover {` is a selector, not a property that lost its value.
    expect(collapseDeclarationValues('a:hover { color: red; }')).toBe(
      'a:hover { color:_; }',
    );
    expect(collapseDeclarationValues('--a: 1 }')).toBe('--a: 1 }');
    expect(collapseDeclarationValues('--a: 1')).toBe('--a: 1');
  });

  it('reads a name that is nothing but dashes without walking it back', () => {
    // The shape CodeQL called out: the name run and the value class overlap,
    // so the old pattern retried from every dash in here.
    expect(collapseDeclarationValues('-'.repeat(64))).toBe('-'.repeat(64));
    expect(collapseDeclarationValues(`${'-'.repeat(64)}: 1;`)).toBe(
      `${'-'.repeat(64)}:_;`,
    );
  });

  it('does not start a name in the middle of one', () => {
    expect(collapseDeclarationValues('a b: 1;')).toBe('a b:_;');
  });
});

describe('quoted strings are blanked by scanning, not by pattern', () => {
  it('blanks a string and keeps what surrounds it', () => {
    expect(blankStringLiterals('content: "a: b";')).toBe('content: "";');
    expect(blankStringLiterals("content: 'a: b';")).toBe('content: "";');
  });

  it('reads a backslash escape, so an escaped quote does not close the string', () => {
    expect(blankStringLiterals('a "one \\" still one" b')).toBe('a "" b');
    expect(blankStringLiterals('a "trailing \\\\" b')).toBe('a "" b');
  });

  it('treats the other quote as ordinary text inside a string', () => {
    expect(blankStringLiterals(`a "it's fine" b`)).toBe('a "" b');
  });

  it('leaves an unterminated string alone', () => {
    expect(blankStringLiterals('a "never closed')).toBe('a "never closed');
    // A backslash is not an escape when a newline follows it, so this one
    // never closes either.
    expect(blankStringLiterals('a "x\\\ny"')).toBe('a "x\\\ny"');
  });

  it('reads a row of escaped quotes without retrying from each one', () => {
    const row = '\\"'.repeat(64);
    expect(blankStringLiterals(`"${row}`)).toBe(`"${row}`);
    expect(blankStringLiterals(`"${row}"`)).toBe('""');
  });

  it('cssSyntaxIssue still ignores syntax that only appears inside a string', async () => {
    expect(
      await cssSyntaxIssueOf('a::before { content: "a: b"; }'),
    ).toBeUndefined();
    expect(
      await cssSyntaxIssueOf('a::before { content: "}"; }'),
    ).toBeUndefined();
  });
});

describe('the reply the board shows is cut at the last Summary heading', () => {
  it('takes the tail from the heading, not the first mention of one', () => {
    const transcript = [
      'Let me look at the file.',
      '## Summary',
      'An early pass that got superseded.',
      'Let me check one more thing.',
      '## Summary',
      'The closing words the operator wants.',
    ].join('\n');

    expect(replyExcerpt(transcript)).toBe(
      ['## Summary', 'The closing words the operator wants.'].join('\n'),
    );
  });

  it('accepts a heading with no hashes, and any casing', () => {
    expect(replyExcerpt('Working.\nSUMMARY: it builds.')).toBe(
      'SUMMARY: it builds.',
    );
    expect(replyExcerpt('Working.\n   #### summary\nDone.')).toBe(
      '#### summary\nDone.',
    );
  });

  it('is not fooled by a word that merely starts with "summary"', () => {
    const transcript = 'I will summarywrite this.\nAnd then stop.';
    expect(replyExcerpt(transcript)).toBe(transcript);
  });

  it('falls back to the whole transcript when no heading was written', () => {
    expect(replyExcerpt('Just did the work.')).toBe('Just did the work.');
    expect(replyExcerpt('   \n\n  ')).toBe('Pass finished without a summary.');
  });
});

describe('the integrity gate on the files the agent edits', () => {
  const CSS = [
    '/* tokens */',
    ':root {',
    '  --brand: #123456;',
    '  --font-body: "Inter", sans-serif;',
    '}',
    'body { color: var(--brand); }',
  ].join('\n');

  /**
   * The same stylesheet with one extra declaration inside `:root`.
   *
   * Split/join rather than `CSS.replace('}', …)`: a string pattern rewrites
   * only the first match, which reads as a bug even where the fixture makes
   * it unambiguous. `\n}\n` is the `:root` close and nothing else.
   */
  const withRootDeclaration = (declaration: string) =>
    CSS.split('\n}\n').join(`\n  ${declaration}\n}\n`);
  const styleScaffold = [
    { path: 'src/styles/global.css', content: CSS, type: 'file' as const },
    {
      path: 'src/data/site.json',
      content: '{"name":"Marsh & Fern"}',
      type: 'file' as const,
    },
  ];

  it('reduces a stylesheet to a structure that ignores values, not syntax', async () => {
    const { cssSkeleton } = await import('../src/flowstarter/workflows');
    const recoloured = CSS.replace('#123456', 'hsl(210 40% 30%)').replace(
      '"Inter"',
      '"Fraunces"',
    );
    expect(cssSkeleton(recoloured)).toBe(cssSkeleton(CSS));
    // A missing semicolon is a different structure.
    expect(cssSkeleton(CSS.replace('#123456;', '#123456'))).not.toBe(
      cssSkeleton(CSS),
    );
    // So is a new declaration, or a lost brace.
    expect(cssSkeleton(withRootDeclaration('--extra: 1;'))).not.toBe(
      cssSkeleton(CSS),
    );
    expect(cssSkeleton(CSS.replace('body {', 'body '))).not.toBe(
      cssSkeleton(CSS),
    );
  });

  async function workspaceWith(
    css: string,
    json = '{"name":"Ionescu Dental"}',
  ) {
    const root = await mkdtemp(join(tmpdir(), 'integrity-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'src/styles'), { recursive: true });
    await mkdir(join(root, 'src/data'), { recursive: true });
    await writeFile(join(root, 'src/styles/global.css'), css, 'utf8');
    await writeFile(join(root, 'src/data/site.json'), json, 'utf8');
    return root;
  }

  it('passes value-only edits and flags broken CSS or JSON by path', async () => {
    const { findWorkspaceIntegrityIssue } = await import(
      '../src/flowstarter/workflows'
    );
    const fine = await workspaceWith(CSS.replace('#123456', '#0a2540'));
    expect(
      await findWorkspaceIntegrityIssue(fine, styleScaffold),
    ).toBeUndefined();

    const broken = await workspaceWith(
      CSS.replace('#123456;', '#0a2540'),
      '{"name": }',
    );
    const issue = await findWorkspaceIntegrityIssue(broken, styleScaffold);
    expect(issue?.paths).toEqual([
      'src/styles/global.css',
      'src/data/site.json',
    ]);
    expect(issue?.feedback).toContain('would not build');
    expect(issue?.feedback).toContain('not valid JSON');
    // The agent is told which declaration, not just which file.
    expect(issue?.feedback).toContain('malformed');
    expect(issue?.feedback).toContain('--brand: #0a2540');
  });

  it('lets a file that parses through even when its structure drifted', async () => {
    const { findWorkspaceIntegrityIssue } = await import(
      '../src/flowstarter/workflows'
    );
    // A new token the prompt forbids, but Astro builds it: no restore.
    const drifted = await workspaceWith(withRootDeclaration('--signal: #f00;'));
    expect(
      await findWorkspaceIntegrityIssue(drifted, styleScaffold),
    ).toBeUndefined();
  });

  it('tells sound CSS from the two ways a model breaks it', async () => {
    const { cssSyntaxIssue } = await import('../src/flowstarter/workflows');
    const sound = [
      '@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;600");',
      ':root { --shadow: 0 1px 2px rgb(0 0 0 / 0.1); --ratio: 16 / 9; }',
      '@media (min-width: 600px) { .hero { background: url(x.png) center / cover; color: red } }',
      'a::before { content: "a: b"; }',
    ].join('\n');
    expect(cssSyntaxIssue(sound)).toBeUndefined();
    expect(cssSyntaxIssue(':root { --a: 1; --b: 2;')).toMatch(/unclosed/);
    expect(cssSyntaxIssue(':root { --a: 1 --b: 2; }')).toMatch(/malformed/);
    expect(cssSyntaxIssue(':root { --a: 1; } }')).toMatch(/stray/);
  });

  it('gives the agent one repair pass, then restores the template file rather than failing the preview', async () => {
    const feedbacks: Array<string | undefined> = [];
    let styleAfterPublish = '';
    const agents = {
      analyzeBrand: async () => validBrandConfig(),
      selectTemplate: async () => ({
        slug: 'wellness-therapy',
        reason: 'Fits.',
        matchedSignals: ['therapy'],
        confidence: 0.9,
      }),
      buildPreview: async (input: {
        workspaceRoot: string;
        feedback?: string;
      }) => {
        feedbacks.push(input.feedback);
        // Every pass writes the client's content but breaks the stylesheet,
        // including the repair pass: the agent cannot fix it.
        await writeFile(
          join(input.workspaceRoot, 'src/content/site.md'),
          'Calm Path Therapy preview',
          'utf8',
        );
        await writeFile(
          join(input.workspaceRoot, 'src/styles/global.css'),
          CSS.replace('#123456;', '#0a2540'),
          'utf8',
        );
        return {
          summary: 'done',
          changedPaths: ['src/content/site.md', 'src/styles/global.css'],
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
            displayName: 'Wellness & Therapy',
            description: 'Trust-led service template.',
            category: 'services',
            useCase: ['therapy'],
            fileCount: 2,
            totalLOC: 1,
          },
          config: {},
        },
        files: [
          {
            path: 'src/content/site.md',
            content: 'Template copy',
            type: 'file',
          },
          { path: 'src/styles/global.css', content: CSS, type: 'file' },
        ],
      }),
      close: async () => undefined,
    };
    const publisher: PreviewPublisher = {
      publish: async (input) => {
        styleAfterPublish = await readFile(
          join(input.workspaceRoot, 'src/styles/global.css'),
          'utf8',
        );
        return {
          previewUrl: 'https://preview.flowstarter.net/x',
          artifactUrl: 's3://x',
          files: [],
        };
      },
    };
    const intake = validIntake();
    const pipeline = new PreviewGenerationPipeline(
      agents,
      library,
      { validate: async () => undefined },
      publisher,
    );
    await pipeline.run({
      intake,
      corpus: validCorpus(intake.projectId),
      cachedAssets: [],
    });

    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[1]).toContain('would not build');
    expect(feedbacks[1]).toContain('src/styles/global.css');
    // The template's own stylesheet shipped, so the preview still builds.
    expect(styleAfterPublish).toBe(CSS);
  });
});

describe('a run that is out of time ships what it has', () => {
  it('skips the optional passes when the deadline leaves no room, and still publishes', async () => {
    const feedbacks: Array<string | undefined> = [];
    const agents = {
      analyzeBrand: async () => validBrandConfig(),
      selectTemplate: async () => ({
        slug: 'wellness-therapy',
        reason: 'Fits.',
        matchedSignals: ['therapy'],
        confidence: 0.9,
      }),
      buildPreview: async (input: {
        workspaceRoot: string;
        feedback?: string;
      }) => {
        feedbacks.push(input.feedback);
        // Leaves the sample copy in place, which would normally earn a
        // sweep; the deadline says there is no time for one.
        await writeFile(
          join(input.workspaceRoot, 'src/content/site.md'),
          'Calm Path Therapy preview. Template copy that is long enough to count.',
          'utf8',
        );
        return {
          summary: 'partial',
          changedPaths: ['src/content/site.md'],
          timedOut: true,
        };
      },
    } as unknown as PiSdkFlowstarterAgents;
    const intake = validIntake();
    const pipeline = new PreviewGenerationPipeline(
      agents,
      {
        ...staticLibrary(),
        scaffold: async (slug) => ({
          ...(await staticLibrary().scaffold(slug)),
          files: [
            {
              path: 'src/content/site.md',
              content: 'Template copy that is long enough to count.',
              type: 'file',
            },
          ],
        }),
      },
      { validate: async () => undefined },
      staticPublisher(),
      undefined,
      { qualitySweep: true },
    );
    const result = await pipeline.run({
      intake,
      corpus: validCorpus(intake.projectId),
      cachedAssets: [],
      deadlineAt: Date.now() + 60_000,
    });
    expect(result.previewUrl).toBe('https://preview.flowstarter.net/static');
    expect(feedbacks).toEqual([undefined]);
  });
});

describe('an optional pass that runs out of clock is abandoned, not fatal', () => {
  it('ships the first pass when the sweep is refused by the deadline', async () => {
    const { PiRunDeadlineExceededError } = await import(
      '../src/flowstarter/pi-sdk'
    );
    let passes = 0;
    const agents = {
      analyzeBrand: async () => validBrandConfig(),
      selectTemplate: async () => ({
        slug: 'wellness-therapy',
        reason: 'Fits.',
        matchedSignals: ['therapy'],
        confidence: 0.9,
      }),
      buildPreview: async (input: {
        workspaceRoot: string;
        feedback?: string;
      }) => {
        passes += 1;
        if (input.feedback)
          throw new PiRunDeadlineExceededError('preview_generate');
        await writeFile(
          join(input.workspaceRoot, 'src/content/site.md'),
          'Calm Path Therapy preview. Template copy that is long enough to count.',
          'utf8',
        );
        return { summary: 'first', changedPaths: ['src/content/site.md'] };
      },
    } as unknown as PiSdkFlowstarterAgents;
    const intake = validIntake();
    const pipeline = new PreviewGenerationPipeline(
      agents,
      {
        ...staticLibrary(),
        scaffold: async (slug) => ({
          ...(await staticLibrary().scaffold(slug)),
          files: [
            {
              path: 'src/content/site.md',
              content: 'Template copy that is long enough to count.',
              type: 'file',
            },
          ],
        }),
      },
      { validate: async () => undefined },
      staticPublisher(),
      undefined,
      { qualitySweep: true },
    );
    const result = await pipeline.run({
      intake,
      corpus: validCorpus(intake.projectId),
      cachedAssets: [],
    });
    expect(passes).toBe(2);
    expect(result.previewUrl).toBe('https://preview.flowstarter.net/static');
  });

  it('does not count alt text as template residue', async () => {
    const { templateSampleStrings } = await import(
      '../src/flowstarter/workflows'
    );
    const samples = templateSampleStrings([
      {
        path: 'src/content/site.md',
        content: [
          'hero:',
          '  imageAlt: "An abstract editorial cover for an article on clarity"',
          '  alt: "A calm room with a plant and two chairs by the window"',
          '  text: "I work with people carrying anxiety and burnout."',
        ].join('\n'),
        type: 'file',
      },
    ]);
    expect(samples.get('src/content/site.md')).toEqual([
      'I work with people carrying anxiety and burnout.',
    ]);
  });
});

describe('the full-site build repairs a failed build once before giving up', () => {
  function workerFor(
    agents: PiSdkFlowstarterAgents,
    validator: SiteValidator,
    calls: string[],
  ) {
    const projectId = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
    const store: FullSiteBuildJobStore = {
      claim: async (jobId) => ({
        id: jobId,
        projectId,
        kind: 'FULL_SITE_BUILD',
        projectState: ProjectState.DEPOSIT_PAID,
        intake: validIntake(),
        brandConfig: validBrandConfig(),
        approvedPreviewFiles: [
          {
            path: 'src/content/site.md',
            content: 'Approved preview',
            type: 'file',
          },
        ],
        requiredIntegrations: [],
      }),
      markAgentWorking: async () => {
        calls.push('store:agents-working');
      },
      markRebuildStarted: async () => {
        calls.push('store:rebuild-started');
      },
      markRebuilt: async () => {
        calls.push('store:rebuilt');
      },
      markHumanQa: async () => {
        calls.push('store:human-qa');
      },
      markFailed: async (_jobId, error) => {
        calls.push(`store:failed:${error.detail.slice(0, 40)}`);
      },
    };
    const worktrees = {
      create: async () => {
        const root = await mkdtemp(
          join(tmpdir(), 'flowstarter-worker-repair-'),
        );
        temporaryDirectories.push(root);
        return { branch: `client/flowstarter-${projectId}`, path: root };
      },
      commit: async () => 'abc123def456',
    } as unknown as SafeGitWorktreeManager;
    const pullRequests: PullRequestPublisher = {
      create: async () => ({
        pullRequestUrl: 'https://example.com/pr',
        stagingUrl: 'https://example.com/site',
      }),
    };
    return new FullSiteBuildWorker(
      store,
      worktrees,
      agents,
      validator,
      pullRequests,
    );
  }

  it('hands the build output to the agent and ships when the repair passes', async () => {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const agents = {
      buildFullSite: async (input: { feedback?: string }) => {
        feedbacks.push(input.feedback);
        return { summary: 'ok', changedPaths: ['src/pages/about.astro'] };
      },
    } as unknown as PiSdkFlowstarterAgents;
    let validations = 0;
    const validator: SiteValidator = {
      validate: async () => {
        validations += 1;
        if (validations === 1) {
          throw new Error(
            'Validation command "pnpm run build" failed: PhoneField.astro:22:1 The closing frontmatter fence (---) is missing an opening fence',
          );
        }
      },
    };
    await workerFor(agents, validator, calls).run('job-1');
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[0]).toBeUndefined();
    expect(feedbacks[1]).toContain('PhoneField.astro:22:1');
    expect(calls).toContain('store:human-qa');
  });

  it('fails the attempt when the repair does not fix the build', async () => {
    const calls: string[] = [];
    const agents = {
      buildFullSite: async () => ({
        summary: 'ok',
        changedPaths: ['src/pages/about.astro'],
      }),
    } as unknown as PiSdkFlowstarterAgents;
    const validator: SiteValidator = {
      validate: async () => {
        throw new Error(
          'Validation command "pnpm run build" failed: still broken',
        );
      },
    };
    await expect(
      workerFor(agents, validator, calls).run('job-1'),
    ).rejects.toThrow(/still broken/);
    expect(calls.some((call) => call.startsWith('store:failed'))).toBe(true);
    expect(calls).not.toContain('store:human-qa');
  });
});

describe('a retried build starts clean', () => {
  it("discards the previous attempt's worktree and branch before creating", async () => {
    const { SafeGitWorktreeManager: Manager } = await import(
      '../src/flowstarter/worktree'
    );
    const { execFileSync } = await import('node:child_process');
    const repositoryRoot = await deepTempDir('fs-repo');
    const worktreesRoot = await deepTempDir('fs-worktrees');
    temporaryDirectories.push(repositoryRoot, worktreesRoot);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repositoryRoot });
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      { cwd: repositoryRoot },
    );
    const manager = new Manager({
      repositoryRoot,
      worktreesRoot,
      baseRef: 'main',
    });
    const projectId = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

    const first = await manager.create(projectId);
    await expect(manager.create(projectId)).rejects.toThrow(/already exists/);

    await manager.discard(projectId);
    await expect(access(first.path)).rejects.toThrow();
    const second = await manager.create(projectId);
    expect(second.branch).toBe(first.branch);
    // Discarding when nothing is there is a no-op, not an error.
    await manager.discard('11111111-2222-4333-8444-555555555555');
  });
});

describe('CHANGE_REQUEST_BUILD: the paid change that used to ship nothing', () => {
  const CHANGE_ID = '72fe7f79-0e83-4cf6-9b4a-2502842b9a54';
  const ASSET_ID = 'b104b1e0-6d4c-4a3e-9230-13cc17b426a0';

  function changeIntent(overrides: Record<string, unknown> = {}) {
    return {
      changeRequestId: CHANGE_ID,
      request:
        'Please add a small gallery to the Flowstarter case study page with ' +
        'the screenshot I uploaded.',
      operatorNote: null,
      seedVersion: 4,
      assetSelection: 'named' as const,
      assets: [
        {
          assetId: ASSET_ID,
          publicPath: '/flowstarter-media/cr-b104b1e0.jpg',
          manifestPath: 'public/flowstarter-media/cr-b104b1e0.jpg',
          caption: 'The Flowstarter client dashboard',
          mime: 'image/jpeg',
          width: 1200,
          height: 750,
        },
      ],
      ...overrides,
    };
  }

  it('refuses to touch a site that does not exist yet', async () => {
    const calls: string[] = [];
    const store: FullSiteBuildJobStore = {
      claim: async (jobId) => ({
        id: jobId,
        projectId: validIntake().projectId,
        kind: 'CHANGE_REQUEST_BUILD',
        // No delivered site exists in this state, so there is nothing to
        // change and an agent pass would be inventing one.
        projectState: ProjectState.DEPOSIT_PAID,
        intake: validIntake(),
        brandConfig: validBrandConfig(),
        approvedPreviewFiles: [],
        requiredIntegrations: [],
        changeRequest: changeIntent(),
      }),
      markAgentWorking: async () => undefined,
      markRebuildStarted: async () => undefined,
      markRebuilt: async () => undefined,
      markHumanQa: async () => undefined,
      markFailed: async (_jobId, error) => {
        calls.push(error.code);
      },
    };
    const worktrees = {
      create: async () => {
        calls.push('worktree-created');
        throw new Error('must not run');
      },
    } as unknown as SafeGitWorktreeManager;

    await new FullSiteBuildWorker(
      store,
      worktrees,
      {} as PiSdkFlowstarterAgents,
      {} as SiteValidator,
      {} as PullRequestPublisher,
    ).run('job-cr-state');

    expect(calls).toEqual(['INVALID_PROJECT_STATE']);
  });

  it('refuses to run an agent over a live site with no instruction', async () => {
    const calls: string[] = [];
    const store: FullSiteBuildJobStore = {
      claim: async (jobId) => ({
        id: jobId,
        projectId: validIntake().projectId,
        kind: 'CHANGE_REQUEST_BUILD',
        projectState: ProjectState.LIVE_SUBSCRIPTION,
        intake: validIntake(),
        brandConfig: validBrandConfig(),
        approvedPreviewFiles: [],
        requiredIntegrations: [],
        // The payload carried nothing readable.
        changeRequest: null,
      }),
      markAgentWorking: async () => undefined,
      markRebuildStarted: async () => undefined,
      markRebuilt: async () => undefined,
      markHumanQa: async () => undefined,
      markFailed: async (_jobId, error) => {
        calls.push(error.code);
        expect(error.detail).toContain('left at paid');
      },
    };
    const worktrees = {
      create: async () => {
        calls.push('worktree-created');
        throw new Error('must not run');
      },
    } as unknown as SafeGitWorktreeManager;

    await new FullSiteBuildWorker(
      store,
      worktrees,
      {} as PiSdkFlowstarterAgents,
      {} as SiteValidator,
      {} as PullRequestPublisher,
    ).run('job-cr-empty');

    expect(calls).toEqual(['CHANGE_REQUEST_MISSING']);
  });

  it('does the change, saves a version, publishes it and only then marks it done', async () => {
    const calls: string[] = [];
    const events: Array<{ kind: string; body: string }> = [];
    const projectId = validIntake().projectId;
    const worktreeRoot = await deepTempDir('flowstarter-change-build');
    temporaryDirectories.push(worktreeRoot);
    let promptSeen = '';

    const store: FullSiteBuildJobStore = {
      claim: async (jobId) => ({
        id: jobId,
        projectId,
        kind: 'CHANGE_REQUEST_BUILD',
        projectState: ProjectState.LIVE_SUBSCRIPTION,
        intake: validIntake(),
        brandConfig: validBrandConfig(),
        approvedPreviewFiles: [
          {
            path: 'src/content/site.md',
            content: 'The site the client already has',
            type: 'file',
          },
          // The client's own picture, folded into the seed by the job store.
          {
            path: 'public/flowstarter-media/cr-b104b1e0.jpg',
            content: Buffer.from('not-really-a-jpeg').toString('base64'),
            encoding: 'base64',
            type: 'file',
          },
        ],
        requiredIntegrations: [],
        changeRequest: changeIntent(),
      }),
      markAgentWorking: async () => {
        calls.push('store:agents-working');
      },
      markHumanQa: async () => {
        calls.push('store:human-qa');
      },
      markRebuildStarted: async () => {
        calls.push('store:rebuild-started');
      },
      markRebuilt: async () => {
        calls.push('store:rebuilt');
      },
      markChangeRequestBuildStarted: async (_jobId, worktree) => {
        calls.push('store:change-started');
        expect(worktree.path).toBe(worktreeRoot);
      },
      saveChangeRequestVersion: async (_jobId, input) => {
        calls.push('store:version-saved');
        expect(input.changeRequestId).toBe(CHANGE_ID);
        // The manifest read back off disk is what the agents actually wrote.
        expect(
          input.files.find((file) => file.path === 'src/content/site.md')
            ?.content,
        ).toContain('/flowstarter-media/cr-b104b1e0.jpg');
        return { version: 5 };
      },
      markChangeRequestBuilt: async (_jobId, result) => {
        calls.push('store:change-done');
        expect(result.changeRequestId).toBe(CHANGE_ID);
        expect(result.version).toBe(5);
        expect(result.commitSha).toBe('cha09e5');
      },
      markFailed: async (_jobId, error) => {
        calls.push(`store:failed:${error.code}`);
      },
      appendEvent: async (_jobId, event) => {
        events.push({ kind: event.kind, body: event.body });
      },
    };

    const worktrees = {
      discard: async () => {
        calls.push('git:discard');
      },
      create: async () => {
        calls.push('git:create-worktree');
        return { branch: `change/${projectId}`, path: worktreeRoot };
      },
      commit: async (_worktree: unknown, message: string) => {
        calls.push('git:commit');
        expect(message).toContain('apply paid change request');
        return 'cha09e5';
      },
    } as unknown as SafeGitWorktreeManager;

    const agents = {
      buildFullSite: async (input: {
        workspaceRoot: string;
        feedback?: string;
      }) => {
        calls.push('agent:change-pass');
        promptSeen = input.feedback ?? '';
        const source = join(input.workspaceRoot, 'src/content/site.md');
        await writeFile(
          source,
          'The site the client already has, now with ' +
            '<img src="/flowstarter-media/cr-b104b1e0.jpg">',
          'utf8',
        );
        return { summary: 'Added the gallery', changedPaths: [source] };
      },
    } as unknown as PiSdkFlowstarterAgents;

    const validator: SiteValidator = {
      validate: async (_root, phase) => {
        calls.push(`validator:${phase}`);
      },
    };

    const pullRequests: PullRequestPublisher = {
      create: async (input) => {
        calls.push('publisher:deploy');
        // The deploy is where "your change is live" becomes true, so it is
        // the deploy that has to know which request it was.
        expect(input.changeRequestId).toBe(CHANGE_ID);
        expect(input.siteVersion).toBe(5);
        return {
          pullRequestUrl: 'https://example.test/deploy/12',
          stagingUrl: 'https://calm-path.flowstarter.net',
        };
      },
    };

    await new FullSiteBuildWorker(
      store,
      worktrees,
      agents,
      validator,
      pullRequests,
    ).run('job-cr-ok');

    expect(calls).toEqual([
      'git:discard',
      'git:create-worktree',
      'store:change-started',
      'agent:change-pass',
      'validator:full',
      'store:version-saved',
      'git:commit',
      'publisher:deploy',
      'store:change-done',
    ]);
    // Never the full build's state moves: a client who bought one more
    // section has not gone back into the build pipeline.
    expect(calls).not.toContain('store:agents-working');
    expect(calls).not.toContain('store:human-qa');

    // The prompt carries the client's words, the asset path and the rules.
    expect(promptSeen).toContain('PAID CHANGE REQUEST');
    expect(promptSeen).toContain('add a small gallery');
    expect(promptSeen).toContain('/flowstarter-media/cr-b104b1e0.jpg');
    expect(promptSeen).toContain('Invent nothing');

    const phases = events
      .filter((event) => event.kind === 'phase')
      .map((event) => event.body);
    expect(phases).toContain('Checking the paid change is on the site');
    expect(phases).toContain('Live, in version 5');
  });

  it('leaves the request at paid when the change was dropped', async () => {
    const calls: string[] = [];
    const projectId = validIntake().projectId;
    const worktreeRoot = await deepTempDir('flowstarter-change-dropped');
    temporaryDirectories.push(worktreeRoot);

    const store: FullSiteBuildJobStore = {
      claim: async (jobId) => ({
        id: jobId,
        projectId,
        kind: 'CHANGE_REQUEST_BUILD',
        projectState: ProjectState.HUMAN_QA,
        intake: validIntake(),
        brandConfig: validBrandConfig(),
        approvedPreviewFiles: [
          {
            path: 'src/content/site.md',
            content: 'The site the client already has',
            type: 'file',
          },
        ],
        requiredIntegrations: [],
        changeRequest: changeIntent(),
      }),
      markAgentWorking: async () => undefined,
      markRebuildStarted: async () => undefined,
      markRebuilt: async () => undefined,
      markHumanQa: async () => undefined,
      markChangeRequestBuildStarted: async () => {
        calls.push('store:change-started');
      },
      saveChangeRequestVersion: async () => {
        calls.push('store:version-saved');
        return { version: 5 };
      },
      markChangeRequestBuilt: async () => {
        calls.push('store:change-done');
      },
      markFailed: async (_jobId, error) => {
        calls.push(`store:failed:${error.code}`);
        expect(error.detail).toContain('/flowstarter-media/cr-b104b1e0.jpg');
        expect(error.detail).toContain('left at paid');
      },
    };

    const worktrees = {
      discard: async () => undefined,
      create: async () => ({
        branch: `change/${projectId}`,
        path: worktreeRoot,
      }),
      commit: async () => {
        calls.push('git:commit');
        return 'nope';
      },
    } as unknown as SafeGitWorktreeManager;

    // Both passes write something, and neither of them uses the picture: the
    // agents did work, they just did not do the work that was bought.
    let pass = 0;
    const agents = {
      buildFullSite: async (input: { workspaceRoot: string }) => {
        pass += 1;
        calls.push(`agent:pass-${pass}`);
        const source = join(input.workspaceRoot, 'src/content/site.md');
        await writeFile(source, `A rewrite, attempt ${pass}`, 'utf8');
        return { summary: 'done', changedPaths: [source] };
      },
    } as unknown as PiSdkFlowstarterAgents;

    const validator: SiteValidator = { validate: async () => undefined };
    const pullRequests: PullRequestPublisher = {
      create: async () => {
        calls.push('publisher:deploy');
        return { pullRequestUrl: 'x', stagingUrl: 'y' };
      },
    };

    await expect(
      new FullSiteBuildWorker(
        store,
        worktrees,
        agents,
        validator,
        pullRequests,
      ).run('job-cr-dropped'),
    ).rejects.toThrow(/does not carry the paid change/);

    // One repair pass, then the job fails. Nothing is saved, nothing is
    // deployed, and nothing anywhere says the work shipped.
    expect(calls).toEqual([
      'store:change-started',
      'agent:pass-1',
      'agent:pass-2',
      'store:failed:CHANGE_REQUEST_NOT_APPLIED',
    ]);
    expect(calls).not.toContain('store:version-saved');
    expect(calls).not.toContain('publisher:deploy');
    expect(calls).not.toContain('store:change-done');
  });

  it('fails rather than publishing when no version can be recorded', async () => {
    const calls: string[] = [];
    const projectId = validIntake().projectId;
    const worktreeRoot = await deepTempDir('flowstarter-change-noversion');
    temporaryDirectories.push(worktreeRoot);

    const store: FullSiteBuildJobStore = {
      claim: async (jobId) => ({
        id: jobId,
        projectId,
        kind: 'CHANGE_REQUEST_BUILD',
        projectState: ProjectState.HUMAN_QA,
        intake: validIntake(),
        brandConfig: validBrandConfig(),
        approvedPreviewFiles: [
          { path: 'src/content/site.md', content: 'seed', type: 'file' },
        ],
        requiredIntegrations: [],
        // No attached picture and no quoted wording, so the applied-change
        // check has nothing to evaluate and correctly passes.
        changeRequest: changeIntent({
          assets: [],
          request: 'Please make the contact page feel a bit warmer',
        }),
      }),
      markAgentWorking: async () => undefined,
      markRebuildStarted: async () => undefined,
      markRebuilt: async () => undefined,
      markHumanQa: async () => undefined,
      markFailed: async (_jobId, error) => {
        calls.push(`store:failed:${error.code}`);
      },
      // saveChangeRequestVersion deliberately absent: a store that cannot
      // record the result must not let the build publish one.
    };

    const worktrees = {
      discard: async () => undefined,
      create: async () => ({ branch: 'b', path: worktreeRoot }),
      commit: async () => {
        calls.push('git:commit');
        return 'nope';
      },
    } as unknown as SafeGitWorktreeManager;

    const agents = {
      buildFullSite: async (input: { workspaceRoot: string }) => {
        const source = join(input.workspaceRoot, 'src/content/site.md');
        await writeFile(source, 'warmer copy', 'utf8');
        return { summary: 'done', changedPaths: [source] };
      },
    } as unknown as PiSdkFlowstarterAgents;

    await expect(
      new FullSiteBuildWorker(
        store,
        worktrees,
        agents,
        { validate: async () => undefined } as SiteValidator,
        {
          create: async () => {
            calls.push('publisher:deploy');
            return { pullRequestUrl: 'x', stagingUrl: 'y' };
          },
        } as PullRequestPublisher,
      ).run('job-cr-noversion'),
    ).rejects.toThrow(/cannot save a site version/);

    expect(calls).toEqual(['store:failed:CHANGE_REQUEST_NOT_APPLIED']);
    expect(calls).not.toContain('publisher:deploy');
  });

  // ─── The page budget, on a manifest the size of a real one ───────────────

  /** The five routes workspace c009105e has had since its deposit build. */
  const SEED_ROUTES = ['(home)', 'about', 'case-studies', 'contact', 'work'];

  /**
   * The manifest those four failed jobs seeded from, in shape: published Astro
   * source with five routes, one of them dynamic, and not one path ending in
   * `.html`. That last fact is the whole bug -- the gate read this as a site
   * with no pages at all.
   */
  function fiveRouteSeed(): Array<{
    path: string;
    content: string;
    type: 'file';
    encoding?: 'base64';
  }> {
    const page = (title: string) =>
      "---\nimport Base from '../layouts/Base.astro';\n---\n" +
      `<Base><h1>${title}</h1><p>Written for this client and signed ` +
      'off by them before the site went live.</p></Base>\n';
    return [
      { path: 'src/pages/index.astro', content: page('Studio'), type: 'file' },
      { path: 'src/pages/about.astro', content: page('About'), type: 'file' },
      { path: 'src/pages/work.astro', content: page('Work'), type: 'file' },
      {
        path: 'src/pages/contact.astro',
        content: page('Contact'),
        type: 'file',
      },
      {
        // 7kB, the size of the file the repair pass cut to 355 bytes.
        path: 'src/pages/case-studies/[slug].astro',
        content: `${page('Case study')}<!--${'detail '.repeat(1_000)}-->\n`,
        type: 'file',
      },
      { path: 'src/layouts/Base.astro', content: '<slot />', type: 'file' },
      {
        path: 'src/content/case-studies/flowstarter.md',
        content: '---\ntitle: Flowstarter\n---\nWhat we did.\n',
        type: 'file',
      },
      {
        path: 'public/robots.txt',
        content: 'User-agent: *\nAllow: /\n',
        type: 'file',
      },
      {
        path: 'public/flowstarter-media/cr-b104b1e0.jpg',
        content: Buffer.from('not-really-a-jpeg').toString('base64'),
        encoding: 'base64',
        type: 'file',
      },
    ];
  }

  /** A `dist/` with exactly these top-level routes, as Astro emits them. */
  async function writeDist(
    root: string,
    routes: readonly string[],
    body = '',
  ): Promise<void> {
    await rm(join(root, 'dist'), { recursive: true, force: true });
    for (const route of routes) {
      const pages =
        route === '(home)'
          ? ['index.html']
          : route === 'case-studies'
            ? [
                'case-studies/flowstarter/index.html',
                'case-studies/riverside/index.html',
                'case-studies/northwind/index.html',
              ]
            : [`${route}/index.html`];
      for (const page of pages) {
        const file = join(root, 'dist', page);
        await mkdir(join(file, '..'), { recursive: true });
        await writeFile(
          file,
          `<html><body><h1>${route}</h1><p>The work this studio has ` +
            `shipped for its clients.</p>${body}</body></html>`,
          'utf8',
        );
      }
    }
  }

  /** One CHANGE_REQUEST_BUILD, with the agent's passes scripted. */
  async function runChangeBuild(input: {
    label: string;
    passes: Array<(root: string) => Promise<void>>;
    intent?: Record<string, unknown>;
  }): Promise<{
    calls: string[];
    logs: string[];
    prompts: string[];
    error: Error | null;
  }> {
    const calls: string[] = [];
    const logs: string[] = [];
    const prompts: string[] = [];
    const worktreeRoot = await deepTempDir(`flowstarter-${input.label}`);
    temporaryDirectories.push(worktreeRoot);
    const projectId = validIntake().projectId;

    const store: FullSiteBuildJobStore = {
      claim: async (jobId) => ({
        id: jobId,
        projectId,
        kind: 'CHANGE_REQUEST_BUILD',
        projectState: ProjectState.LIVE_SUBSCRIPTION,
        intake: validIntake(),
        brandConfig: validBrandConfig(),
        approvedPreviewFiles: fiveRouteSeed(),
        requiredIntegrations: [],
        changeRequest: changeIntent(input.intent ?? {}),
      }),
      markAgentWorking: async () => undefined,
      markRebuildStarted: async () => undefined,
      markRebuilt: async () => undefined,
      markHumanQa: async () => undefined,
      markChangeRequestBuildStarted: async () => {
        calls.push('store:change-started');
      },
      saveChangeRequestVersion: async () => {
        calls.push('store:version-saved');
        return { version: 5 };
      },
      markChangeRequestBuilt: async () => {
        calls.push('store:change-done');
      },
      markFailed: async (_jobId, error) => {
        calls.push(`store:failed:${error.code}`);
        logs.push(error.detail);
      },
      appendEvent: async (_jobId, event) => {
        if (event.kind === 'log') logs.push(event.body);
      },
    };

    let pass = 0;
    const agents = {
      buildFullSite: async (job: {
        workspaceRoot: string;
        feedback?: string;
      }) => {
        const step = input.passes[pass];
        pass += 1;
        calls.push(`agent:pass-${pass}`);
        prompts.push(job.feedback ?? '');
        if (step) await step(job.workspaceRoot);
        return {
          summary: `pass ${pass}`,
          changedPaths: [join(job.workspaceRoot, 'src/pages/index.astro')],
        };
      },
    } as unknown as PiSdkFlowstarterAgents;

    const worktrees = {
      discard: async () => undefined,
      create: async () => ({
        branch: `change/${projectId}`,
        path: worktreeRoot,
      }),
      commit: async () => 'cha09e5',
    } as unknown as SafeGitWorktreeManager;

    let error: Error | null = null;
    try {
      await new FullSiteBuildWorker(
        store,
        worktrees,
        agents,
        { validate: async () => undefined } as SiteValidator,
        {
          create: async () => {
            calls.push('publisher:deploy');
            return { pullRequestUrl: 'x', stagingUrl: 'y' };
          },
        } as PullRequestPublisher,
      ).run(`job-${input.label}`);
    } catch (thrown) {
      error = thrown as Error;
    }
    return { calls, logs, prompts, error };
  }

  it('ships the gallery request that failed four times on attempt 1', async () => {
    // Jobs 4d4f3a40, f9e68f3c, 9f967a07 and 050d83b3, 2026-09-12: the same
    // five-route manifest, the same request, and PAGE_BUDGET_EXCEEDED every
    // time because the seed read as a site with zero pages.
    const { calls, logs, error } = await runChangeBuild({
      label: 'cr-five-routes',
      passes: [
        async (root) =>
          writeDist(
            root,
            SEED_ROUTES,
            '<img src="/flowstarter-media/cr-b104b1e0.jpg" alt="dashboard">',
          ),
      ],
    });

    expect(error).toBeNull();
    expect(calls).toEqual([
      'store:change-started',
      'agent:pass-1',
      'store:version-saved',
      'publisher:deploy',
      'store:change-done',
    ]);
    expect(calls).not.toContain('store:failed:PAGE_BUDGET_EXCEEDED');
    // One agent pass: no repair was asked for, so nothing was told to delete.
    expect(calls.filter((call) => call.startsWith('agent:pass-'))).toHaveLength(
      1,
    );
    expect(
      logs.some((line) => line.includes('left all 5 pages of the site')),
    ).toBe(true);
  });

  it('passes a removal request instead of calling the deletions new pages', async () => {
    const { calls, logs, error } = await runChangeBuild({
      label: 'cr-removal',
      intent: {
        request: 'Please take the work page off the site entirely.',
        assets: [],
      },
      passes: [
        async (root) =>
          writeDist(
            root,
            SEED_ROUTES.filter((route) => route !== 'work'),
          ),
      ],
    });

    expect(error).toBeNull();
    expect(calls).toContain('store:change-done');
    expect(logs.some((line) => line.includes('removed 1 page (work)'))).toBe(
      true,
    );
    expect(logs.every((line) => !line.includes('new pages'))).toBe(true);
  });

  it('refuses to repair a build that already lost approved routes', async () => {
    const { calls, logs, error } = await runChangeBuild({
      label: 'cr-lost-routes',
      passes: [
        async (root) =>
          writeDist(root, ['(home)', 'blog', 'shop', 'pricing', 'careers']),
      ],
    });

    expect(error?.message).toContain('the client had already paid for');
    // One pass and then a stop: no second agent is turned loose on a site
    // that has already lost pages somebody bought.
    expect(calls).toEqual([
      'store:change-started',
      'agent:pass-1',
      'store:failed:PAGE_BUDGET_EXCEEDED',
    ]);
    expect(logs.some((line) => line.includes('The request stays paid.'))).toBe(
      true,
    );
  });

  it('fails the job when the repair pass damages the site it was trimming', async () => {
    // Exactly what happened after the gate fired on 2026-09-12: the agent was
    // told to "remove the pages the request did not ask for", and it emptied
    // the case-study route and pointed robots.txt at a domain nobody owns.
    const { calls, error } = await runChangeBuild({
      label: 'cr-repair-damage',
      passes: [
        async (root) =>
          writeDist(root, [...SEED_ROUTES, 'blog', 'shop', 'pricing']),
        async (root) => {
          await writeFile(
            join(root, 'src/pages/case-studies/[slug].astro'),
            '---\n---\n<p>Case study</p>\n',
            'utf8',
          );
          await writeFile(
            join(root, 'public/robots.txt'),
            'User-agent: *\nSitemap: https://darius-portfolio.example/sitemap.xml\n',
            'utf8',
          );
        },
      ],
    });

    expect(error?.message).toContain('damaged the site it was asked to trim');
    expect(error?.message).toContain('src/pages/case-studies/[slug].astro');
    expect(error?.message).toContain('darius-portfolio.example');
    expect(calls).toEqual([
      'store:change-started',
      'agent:pass-1',
      'agent:pass-2',
      'store:failed:CHANGE_REQUEST_REPAIR_DAMAGED_SITE',
    ]);
    expect(calls).not.toContain('store:version-saved');
    expect(calls).not.toContain('publisher:deploy');
  });

  it('still fails a repair pass that kept the pages it invented', async () => {
    const { calls, error, prompts } = await runChangeBuild({
      label: 'cr-repair-refused',
      passes: [
        async (root) =>
          writeDist(root, [...SEED_ROUTES, 'blog', 'shop', 'pricing']),
        // Touches something harmless and leaves the invented pages where
        // they are: no damage to refuse, and still over the allowance.
        async (root) =>
          writeFile(join(root, 'src/layouts/Base.astro'), '<slot />\n', 'utf8'),
      ],
    });

    expect(error?.message).toContain('added 3 new pages (blog, pricing, shop)');
    expect(calls).toEqual([
      'store:change-started',
      'agent:pass-1',
      'agent:pass-2',
      'store:failed:PAGE_BUDGET_EXCEEDED',
    ]);
    // The brief it was given named its targets and protected the rest, which
    // is the sentence the destructive repair of 2026-09-12 never had.
    const repairBrief = prompts[1] ?? '';
    expect(repairBrief).toContain(
      'Delete only these pages, which this pass created and the request did ' +
        'not ask for: blog, pricing, shop.',
    );
    expect(repairBrief).toContain('not emptied, not rewritten, not relinked');
    expect(repairBrief).toContain('case-studies');
    expect(repairBrief).toContain('Do not touch robots.txt');
    expect(repairBrief).not.toContain(
      'Remove the pages the request did not ask for',
    );
  });
});
