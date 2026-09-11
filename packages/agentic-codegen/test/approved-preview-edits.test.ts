/**
 * The client paid for the site they were shown, not for a site built from the
 * same brief.
 *
 * A visitor gets two free changes to their preview. In the 2026-09-11 run one
 * of them was "make the hero headline say I build websites with AI agents,
 * supervised by people"; it landed in the preview, the visitor paid, and the
 * published site carried the pre-edit sentence. These tests hold the two
 * halves of the fix: the build agent is told, in words, exactly what must
 * survive, and a build that drops it fails with its own error code instead of
 * being handed to QA looking finished.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deepTempDir } from './helpers';
import {
  APPROVED_EDIT_DROPPED,
  approvedPreviewFeedback,
  carriedApprovedEditsSummary,
  collectBuiltSiteText,
  collectSiteTextFiles,
  droppedApprovedEditsFeedback,
  findDroppedApprovedEdits,
  FULL_SITE_CODING_SYSTEM_PROMPT,
  FullSiteBuildWorker,
  normalizeApprovedPhrase,
  ProjectState,
  type ApprovedPreviewEdit,
  type BrandConfig,
  type BusinessIntakePayload,
  type FullSiteBuildEvent,
  type FullSiteBuildJobStore,
  type PiSdkFlowstarterAgents,
  type PreviewIntent,
  type PullRequestPublisher,
  type SafeGitWorktreeManager,
  type SiteValidator,
} from '../src/index';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const PROJECT_ID = '4f0e2a9c-3b1d-4f7a-8c22-9d1e5a7b3c40';
const PREVIEW_ID = 'ccb48228-2fca-4cae-b1ed-7fcf9ce6a48a';

const HEADLINE = 'I build websites with AI agents, supervised by people';

function headlineEdit(
  overrides: Partial<ApprovedPreviewEdit> = {},
): ApprovedPreviewEdit {
  return {
    index: 1,
    instruction: `Make the hero headline say ${HEADLINE}`,
    changedPaths: ['src/content/site-labels.md'],
    addedPhrases: [HEADLINE],
    appliedAt: '2026-09-11T18:30:00.000Z',
    ...overrides,
  };
}

function handleEdit(): ApprovedPreviewEdit {
  return {
    index: 2,
    instruction:
      'Add my Instagram handle darius.flowstarter to the contact section',
    changedPaths: ['src/content/site-labels.md'],
    addedPhrases: ['Follow along at @darius.flowstarter'],
    appliedAt: '2026-09-11T18:32:00.000Z',
  };
}

function intent(edits: ApprovedPreviewEdit[]): PreviewIntent {
  return {
    previewId: PREVIEW_ID,
    manifest: {
      ref: `funnel_previews:${PREVIEW_ID}`,
      artifactPath: `funnel/${PREVIEW_ID}/site.tar.gz`,
      templateSlug: 'creative-portfolio',
      fileCount: 69,
    },
    edits,
    brief: {
      businessName: 'Darius Mihai Popescu',
      niche: 'Creative & design',
      location: 'Remote',
    },
    capturedAt: '2026-09-11T18:52:18.000Z',
  };
}

describe('approvedPreviewFeedback', () => {
  it('quotes the client sentence and the exact text that must survive', () => {
    const feedback = approvedPreviewFeedback([headlineEdit(), handleEdit()]);

    expect(feedback).toContain('APPROVED PREVIEW CHANGES, trusted');
    expect(feedback).toContain(
      '1. The client asked: "Make the hero headline say ' +
        'I build websites with AI agents, supervised by people"',
    );
    expect(feedback).toContain(`     - ${HEADLINE}`);
    expect(feedback).toContain('2. The client asked:');
    expect(feedback).toContain('     - Follow along at @darius.flowstarter');
    expect(feedback).toContain('may not reword, shorten or drop it');
  });

  it('still names an edit whose text could not be captured', () => {
    const feedback = approvedPreviewFeedback([
      headlineEdit({ addedPhrases: [] }),
    ]);

    expect(feedback).toContain('Make the hero headline say');
    expect(feedback).not.toContain('which must survive');
  });

  it('is empty when the client changed nothing, so no paragraph is added', () => {
    expect(approvedPreviewFeedback([])).toBe('');
  });

  it('caps how many changes reach one prompt', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      headlineEdit({
        index: index + 1,
        addedPhrases: [`phrase number ${index}`],
      }),
    );
    const feedback = approvedPreviewFeedback(many);

    expect(feedback).toContain('phrase number 7');
    expect(feedback).not.toContain('phrase number 8');
  });
});

describe('FULL_SITE_CODING_SYSTEM_PROMPT', () => {
  it('gives the approved changes their own authority, not the operator-note one', () => {
    // The agent is told FEEDBACK is trusted, but it only knew two flavours of
    // it: a failed build and operator notes. A client's own approved edit is
    // neither, and "preserve this verbatim" is a different instruction from
    // "apply this note".
    expect(FULL_SITE_CODING_SYSTEM_PROMPT).toContain(
      'APPROVED PREVIEW CHANGES or DROPPED CLIENT CHANGES',
    );
    expect(FULL_SITE_CODING_SYSTEM_PROMPT).toContain('must appear verbatim');
    expect(FULL_SITE_CODING_SYSTEM_PROMPT).toContain(
      'never reword, shorten, translate or regenerate it',
    );
  });
});

describe('carriedApprovedEditsSummary', () => {
  it('lists the carried changes and the files they touched', () => {
    const summary = carriedApprovedEditsSummary(
      intent([headlineEdit(), handleEdit()]),
    );

    expect(summary).toContain(`funnel_previews:${PREVIEW_ID}`);
    expect(summary).toContain('carrying 2 free changes');
    expect(summary).toContain(`1. "Make the hero headline say ${HEADLINE}"`);
    expect(summary).toContain('(changed src/content/site-labels.md)');
  });

  it('says so plainly when the client made no free changes', () => {
    const summary = carriedApprovedEditsSummary(intent([]));

    expect(summary).toContain('The client made no free changes to it.');
  });

  it('uses the singular for one change', () => {
    expect(carriedApprovedEditsSummary(intent([headlineEdit()]))).toContain(
      'carrying 1 free change the client made',
    );
  });
});

describe('findDroppedApprovedEdits', () => {
  const site = (body: string) => [
    { path: 'src/pages/index.astro', content: body },
  ];

  it('passes when the approved text is in the built output', () => {
    expect(
      findDroppedApprovedEdits(site(`<h1>${HEADLINE}</h1>`), [headlineEdit()]),
    ).toEqual([]);
  });

  it('fails when the build regenerated the headline away', () => {
    const dropped = findDroppedApprovedEdits(
      site(
        '<h1>Websites for service businesses, built by AI and checked by a ' +
          'person before they ship.</h1>',
      ),
      [headlineEdit()],
    );

    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.index).toBe(1);
    expect(dropped[0]?.missingPhrases).toEqual([HEADLINE]);
  });

  it('forgives a build that re-wrapped or re-cased the sentence', () => {
    expect(
      findDroppedApprovedEdits(
        site(
          `<h1>\n  I Build Websites With AI Agents,\n  Supervised By People\n</h1>`,
        ),
        [headlineEdit()],
      ),
    ).toEqual([]);
  });

  it('does not fail an edit that kept one of its phrases', () => {
    const edit = headlineEdit({
      addedPhrases: [HEADLINE, 'A subheading nobody kept'],
    });

    expect(findDroppedApprovedEdits(site(HEADLINE), [edit])).toEqual([]);
  });

  it('ignores an edit whose text was never captured', () => {
    expect(
      findDroppedApprovedEdits(site('nothing relevant'), [
        headlineEdit({ addedPhrases: [] }),
      ]),
    ).toEqual([]);
  });

  it('reports every dropped change, not only the first', () => {
    const dropped = findDroppedApprovedEdits(site('an unrelated site'), [
      headlineEdit(),
      handleEdit(),
    ]);

    expect(dropped.map((entry) => entry.index)).toEqual([1, 2]);
  });

  it('searches the whole built tree, not one file', () => {
    expect(
      findDroppedApprovedEdits(
        [
          { path: 'src/pages/index.astro', content: 'unrelated' },
          { path: 'dist/index.html', content: `<h1>${HEADLINE}</h1>` },
        ],
        [headlineEdit()],
      ),
    ).toEqual([]);
  });
});

describe('normalizeApprovedPhrase', () => {
  it('collapses whitespace and folds case', () => {
    expect(normalizeApprovedPhrase('  Hello   \n World ')).toBe('hello world');
  });
});

describe('droppedApprovedEditsFeedback', () => {
  it('names the client sentence and the exact strings to restore', () => {
    const feedback = droppedApprovedEditsFeedback([
      {
        index: 1,
        instruction: 'Change the headline',
        missingPhrases: [HEADLINE],
      },
    ]);

    expect(feedback).toContain('DROPPED CLIENT CHANGES, trusted');
    expect(feedback).toContain('approved and paid to keep');
    expect(feedback).toContain(`     - ${HEADLINE}`);
    expect(feedback).toContain('change nothing else');
  });
});

describe('collectSiteTextFiles and collectBuiltSiteText', () => {
  it('reads the source and the built output and skips dependencies', async () => {
    const root = await deepTempDir('fs-collect');
    temporaryDirectories.push(root);
    await mkdir(join(root, 'src/pages'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });
    await mkdir(join(root, 'node_modules/astro'), { recursive: true });
    await writeFile(join(root, 'src/pages/index.astro'), HEADLINE, 'utf8');
    await writeFile(
      join(root, 'dist/index.html'),
      `<h1>${HEADLINE}</h1>`,
      'utf8',
    );
    await writeFile(join(root, 'dist/hero.png'), 'binary-ish', 'utf8');
    await writeFile(join(root, 'node_modules/astro/index.js'), 'noise', 'utf8');

    const files = await collectSiteTextFiles(root);
    const paths = files.map((file) => file.path).sort();

    expect(paths).toEqual(['dist/index.html', 'src/pages/index.astro']);
  });

  it('returns nothing for a directory that is not there', async () => {
    expect(await collectSiteTextFiles('/nope/not/a/site/root')).toEqual([]);
  });

  it('prefers the compiled output, so a stale seed cannot vouch for a build', async () => {
    const root = await deepTempDir('fs-built');
    temporaryDirectories.push(root);
    await mkdir(join(root, 'src/content'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(
      join(root, 'src/content/site-labels.md'),
      `heroHeadline: "${HEADLINE}"`,
      'utf8',
    );
    await writeFile(
      join(root, 'dist/index.html'),
      '<h1>regenerated</h1>',
      'utf8',
    );

    const built = await collectBuiltSiteText(root);

    expect(built.map((file) => file.path)).toEqual(['dist/index.html']);
    expect(findDroppedApprovedEdits(built, [headlineEdit()])).toHaveLength(1);
  });

  it('falls back to the tree when nothing was compiled', async () => {
    const root = await deepTempDir('fs-nodist');
    temporaryDirectories.push(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/index.astro'), HEADLINE, 'utf8');

    expect((await collectBuiltSiteText(root)).map((file) => file.path)).toEqual(
      ['src/index.astro'],
    );
  });
});

// ─── The worker, end to end ────────────────────────────────────────────────

interface Harness {
  events: FullSiteBuildEvent[];
  feedbacks: Array<string | undefined>;
  failures: Array<{ code: string; detail: string }>;
  handedToQa: boolean;
  /** Where the build materialized the approved preview. */
  siteRoot: string;
  run: () => Promise<void>;
}

/**
 * A full build wired to a fake everything, with one knob: what the expanding
 * agent writes into the site. That is exactly the thing the dropped-edit gate
 * is there to judge.
 */
async function harness(options: {
  previewIntent?: PreviewIntent | null;
  /** What the agent leaves behind on each pass, in order. */
  agentWrites: string[];
}): Promise<Harness> {
  const worktreeRoot = await deepTempDir('fs-approved-worker');
  temporaryDirectories.push(worktreeRoot);
  const events: FullSiteBuildEvent[] = [];
  const feedbacks: Array<string | undefined> = [];
  const failures: Array<{ code: string; detail: string }> = [];
  let handedToQa = false;
  let pass = 0;

  const store: FullSiteBuildJobStore = {
    claim: async (jobId) => ({
      id: jobId,
      projectId: PROJECT_ID,
      kind: 'FULL_SITE_BUILD',
      projectState: ProjectState.DEPOSIT_PAID,
      intake: validIntake(),
      brandConfig: validBrandConfig(),
      approvedPreviewFiles: [
        {
          path: 'src/content/site-labels.md',
          content: `heroHeadline: "${HEADLINE}"\n`,
          type: 'file',
        },
      ],
      requiredIntegrations: [],
      ...(options.previewIntent !== undefined
        ? { previewIntent: options.previewIntent }
        : {}),
    }),
    markAgentWorking: async () => {
      /* the lifecycle move is not what these cases are about */
    },
    markRebuildStarted: async () => {
      /* full builds never reach it */
    },
    markRebuilt: async () => {
      /* full builds never reach it */
    },
    markHumanQa: async () => {
      handedToQa = true;
    },
    markFailed: async (_jobId, error) => {
      failures.push(error);
    },
    appendEvent: async (_jobId, event) => {
      events.push(event);
    },
  };

  const worktrees = {
    discard: async () => {
      /* nothing to discard: each case gets a fresh temp dir */
    },
    create: async () => ({
      branch: `client/flowstarter-${PROJECT_ID}`,
      path: worktreeRoot,
    }),
    commit: async () => 'abc123def456',
  } as unknown as SafeGitWorktreeManager;

  const agents = {
    buildFullSite: async (input: {
      workspaceRoot: string;
      feedback?: string;
    }) => {
      feedbacks.push(input.feedback);
      const body =
        options.agentWrites[pass] ?? options.agentWrites.at(-1) ?? '';
      pass += 1;
      await mkdir(join(input.workspaceRoot, 'src/pages'), { recursive: true });
      await writeFile(
        join(input.workspaceRoot, 'src/pages/index.astro'),
        body,
        'utf8',
      );
      // Stand in for what the validator's `astro build` would leave behind:
      // the dropped-edit gate reads the compiled output, never the seed.
      await mkdir(join(input.workspaceRoot, 'dist'), { recursive: true });
      await writeFile(
        join(input.workspaceRoot, 'dist/index.html'),
        body,
        'utf8',
      );
      return { summary: 'Expanded', changedPaths: ['src/pages/index.astro'] };
    },
  } as unknown as PiSdkFlowstarterAgents;

  const validator: SiteValidator = {
    // The trusted build is green throughout: what is under test is the gate
    // that runs after it, not the gate itself.
    validate: async () => {
      /* always passes */
    },
  };
  const pullRequests: PullRequestPublisher = {
    create: async () => ({
      pullRequestUrl: 'https://github.com/flowstarter/sites/pull/7',
      stagingUrl: 'https://example.preview.flowstarter.net',
    }),
  };

  const worker = new FullSiteBuildWorker(
    store,
    worktrees,
    agents,
    validator,
    pullRequests,
  );

  return {
    events,
    feedbacks,
    failures,
    get handedToQa() {
      return handedToQa;
    },
    siteRoot: join(worktreeRoot, 'generated-sites', PROJECT_ID),
    run: () => worker.run('job-approved'),
  };
}

describe('FullSiteBuildWorker and the approved preview', () => {
  it('tells the build agent what the client approved, and logs it for the operator', async () => {
    const built = await harness({
      previewIntent: intent([headlineEdit(), handleEdit()]),
      agentWrites: [
        `<h1>${HEADLINE}</h1><p>Follow along at @darius.flowstarter</p>`,
      ],
    });
    await built.run();

    expect(built.feedbacks[0]).toContain('APPROVED PREVIEW CHANGES, trusted');
    expect(built.feedbacks[0]).toContain(HEADLINE);
    expect(built.feedbacks[0]).toContain('Follow along at @darius.flowstarter');

    const carried = built.events.find((event) =>
      event.body.includes('carrying 2 free changes'),
    );
    expect(carried?.kind).toBe('log');
    expect(carried?.payload?.['previewId']).toBe(PREVIEW_ID);
    expect(carried?.payload?.['carriedEdits']).toBe(2);
    expect(carried?.payload?.['instructions']).toEqual([
      `Make the hero headline say ${HEADLINE}`,
      'Add my Instagram handle darius.flowstarter to the contact section',
    ]);
    expect(built.handedToQa).toBe(true);
    expect(built.failures).toEqual([]);
  });

  it('asks the agents to restore a dropped change before giving up on it', async () => {
    const built = await harness({
      previewIntent: intent([headlineEdit()]),
      agentWrites: [
        '<h1>Websites for service businesses, built by AI.</h1>',
        `<h1>${HEADLINE}</h1>`,
      ],
    });
    await built.run();

    expect(built.feedbacks[1]).toContain('DROPPED CLIENT CHANGES, trusted');
    expect(built.feedbacks[1]).toContain(HEADLINE);
    expect(built.handedToQa).toBe(true);
    expect(built.failures).toEqual([]);
  });

  it('fails the job with its own code when the change is gone for good', async () => {
    const built = await harness({
      previewIntent: intent([headlineEdit()]),
      agentWrites: ['<h1>Websites for service businesses, built by AI.</h1>'],
    });

    await expect(built.run()).rejects.toThrow(/missing 1 change the client/);

    expect(built.failures).toHaveLength(1);
    expect(built.failures[0]?.code).toBe(APPROVED_EDIT_DROPPED);
    expect(built.failures[0]?.detail).toContain(HEADLINE);
    expect(built.handedToQa).toBe(false);
  });

  it('builds an operator-created project with no claimed preview exactly as before', async () => {
    const built = await harness({
      previewIntent: null,
      agentWrites: ['<h1>Whatever the agents decided</h1>'],
    });
    await built.run();

    expect(built.feedbacks[0]).toBeUndefined();
    expect(
      built.events.some((event) => event.body.includes('funnel_previews:')),
    ).toBe(false);
    expect(built.handedToQa).toBe(true);
    expect(built.failures).toEqual([]);
  });

  it('carries the approved changes into a repair pass too', async () => {
    const built = await harness({
      previewIntent: intent([headlineEdit()]),
      agentWrites: ['<h1>gone</h1>', `<h1>${HEADLINE}</h1>`],
    });
    await built.run();

    expect(built.feedbacks[1]).toContain('APPROVED PREVIEW CHANGES, trusted');
  });

  it('seeds the worktree from the approved manifest, which is where the edits live', async () => {
    const built = await harness({
      previewIntent: intent([headlineEdit()]),
      agentWrites: [`<h1>${HEADLINE}</h1>`],
    });
    await built.run();

    // Seeding is the strong half of the fix: the client's edited files are in
    // the tree before the agent is asked to preserve anything.
    expect(
      await readFile(
        join(built.siteRoot, 'src/content/site-labels.md'),
        'utf8',
      ),
    ).toContain(HEADLINE);
  });
});

function validIntake(): BusinessIntakePayload {
  return {
    projectId: PROJECT_ID,
    business: {
      name: 'Darius Mihai Popescu',
      niche: 'Creative & design',
      location: 'Remote',
    },
    socialMedia: [],
    locale: 'en-GB',
    submittedAt: '2026-09-11T18:00:00.000Z',
    consent: {
      publicProfileAnalysis: true,
      acceptedAt: '2026-09-11T18:00:00.000Z',
    },
  };
}

function validBrandConfig(): BrandConfig {
  return {
    projectId: PROJECT_ID,
    palette: {
      primary: '#123456',
      secondary: '#654321',
      accent: '#0f766e',
      background: '#ffffff',
      surface: '#f8fafc',
      text: '#0f172a',
    },
    typography: { headingFamily: 'Inter', bodyFamily: 'Inter' },
    voice: { tone: 'confident', keywords: ['precise'] },
    contrastAudit: [],
  } as unknown as BrandConfig;
}
