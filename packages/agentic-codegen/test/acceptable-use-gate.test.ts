/**
 * The acceptable-use gate on the BUILT site (`src/flowstarter/acceptable-use.ts`).
 *
 * Two halves, tested separately because they have different shapes:
 *
 *   1. The pure reader and the pure copy: `readableTextFromMarkup`,
 *      `collectBuiltTextForScan` and `describeProhibitedContent`. No worker,
 *      no store, just strings in and strings out.
 *   2. The gate wired into `FullSiteBuildWorker`, the last check before a
 *      site is committed and published. Driven through the same
 *      worker-construction harness `flowstarter-workflows.test.ts` uses (the
 *      seams: store, worktrees, agents, validator, pullRequests), with a
 *      `contentPolicy` scanner injected as the sixth, options argument. The
 *      fixture that reaches `store:human-qa` there is copied here verbatim
 *      (it already clears every earlier gate); only the scanner changes.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deepTempDir } from './helpers';
import {
  BUILT_TEXT_SCAN_MAX_CHARS,
  CONTENT_POLICY_UNAVAILABLE,
  FullSiteBuildWorker,
  PROHIBITED_CONTENT,
  ProjectState,
  collectBuiltTextForScan,
  describeProhibitedContent,
  readableTextFromMarkup,
  type BrandConfig,
  type BusinessIntakePayload,
  type ContentPolicyScanner,
  type ContentPolicyVerdict,
  type FullSiteBuildJobStore,
  type PiSdkFlowstarterAgents,
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

// ─── The pure parts ──────────────────────────────────────────────────────────

describe('readableTextFromMarkup', () => {
  it('drops script and style whole, but keeps alt, title, aria-label, content and href', () => {
    // The only prohibited words on this page are in an image's alt text and
    // in the href it links to -- nowhere in the visible copy. A reader that
    // only stripped tags and kept the text between them would report this
    // page as clean, and the site would ship.
    const markup = `
      <html>
        <head>
          <title>Home</title>
          <meta name="description" content="A friendly corner shop">
          <style>body { color: red; } .hero::before { content: "loud css"; }</style>
        </head>
        <body>
          <script>trackVisit('secret-tracker-id');</script>
          <!-- nothing to see here -->
          <a href="/gram-prices.html">
            <img src="/x.jpg" alt="cocaine, 1g, ships discreetly" />
          </a>
        </body>
      </html>
    `;

    const text = readableTextFromMarkup(markup);

    expect(text).toContain('cocaine, 1g, ships discreetly');
    expect(text).toContain('gram-prices.html');
    // The script and style bodies are dropped whole, not read as text.
    expect(text).not.toContain('trackVisit');
    expect(text).not.toContain('secret-tracker-id');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('loud css');
    // A comment is not copy either.
    expect(text).not.toContain('nothing to see here');
  });

  it('keeps the document title and meta description', () => {
    const markup =
      '<html><head><title>Cheap Pills Direct</title>' +
      '<meta name="description" content="No prescription needed"></head>' +
      '<body><p>Welcome</p></body></html>';

    const text = readableTextFromMarkup(markup);

    expect(text).toContain('Cheap Pills Direct');
    expect(text).toContain('No prescription needed');
  });
});

/**
 * The three defects the hand-written stripper had, each of which CodeQL named
 * on PR #158 and any of which a generated site could have hit by accident.
 *
 * They are kept as tests rather than as a note in the commit message because
 * the temptation, when this reader is next edited, will be to reach for a
 * regex again: it looks smaller. These say what that costs.
 */
describe('the reader does not repeat the stripper mistakes', () => {
  it('ends a script where the HTML spec ends it, not where a pattern does', () => {
    // The old pattern did not match `</script >`, so everything from the first
    // `<script` to the end of the document survived as "text": a page could
    // spend the classifier's whole window on a bundle, or hide its trade
    // behind a close tag the pattern missed.
    const markup = [
      '<html><body>',
      '<script>const secret = "we deliver cocaine";</script >',
      '<p>Coffee roasted in Cluj.</p>',
      '</body></html>',
    ].join('');

    const text = readableTextFromMarkup(markup);
    expect(text).toContain('Coffee roasted in Cluj.');
    expect(text).not.toContain('cocaine');
  });

  it('decodes a character reference exactly once', () => {
    // The old reader replaced `&amp;` before `&lt;`, so `&amp;lt;` came out as
    // `<`: the text handed to the classifier was not the text on the page.
    // parse5 decodes per the spec, once.
    const text = readableTextFromMarkup('<p>Tom &amp;amp; Jerry &amp;lt;3</p>');
    expect(text).toBe('Tom &amp; Jerry &lt;3');
  });

  it('reads a page full of unclosed script tags promptly', () => {
    // Polynomial backtracking on the old pattern: this input is a denial of
    // service reachable from a built site. parse5 is linear, so the bound here
    // is generous on purpose and still orders of magnitude under what the
    // pattern took.
    const markup = '<html><body>' + '<script'.repeat(20_000) + '</body></html>';
    const started = Date.now();
    readableTextFromMarkup(markup);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('still finds copy that only exists in an attribute', () => {
    // The reason the reader looks at attributes at all, restated against the
    // parsed tree: a page can say nothing on screen and everything in its alt
    // text and its links.
    const markup = [
      '<html><head><title>Botanicals</title>',
      '<meta name="description" content="Same day delivery, discreet packaging">',
      '</head><body>',
      '<img src="/a.png" alt="cocaine, one gram">',
      '<a href="/gram-prices.html">Menu</a>',
      '</body></html>',
    ].join('');

    const text = readableTextFromMarkup(markup);
    expect(text).toContain('Botanicals');
    expect(text).toContain('Same day delivery, discreet packaging');
    expect(text).toContain('cocaine, one gram');
    expect(text).toContain('/gram-prices.html');
  });
});

describe('collectBuiltTextForScan', () => {
  const PAGES = [
    { path: 'blog/2024/03/a-post.html', content: '<p>An old archive post</p>' },
    // Not a text extension: the reader must never spend its budget reading
    // image bytes as if they were copy.
    {
      path: 'assets/hero.png',
      content: 'not-really-binary-but-not-html-either',
    },
    { path: 'index.html', content: '<p>Welcome to the shop</p>' },
    { path: 'about.html', content: '<p>About the shop</p>' },
  ];

  it('reads index.html before deeper pages, each prefixed with its path', () => {
    const text = collectBuiltTextForScan(PAGES);

    expect(text).toContain('PAGE index.html: Welcome to the shop');
    expect(text).toContain('PAGE about.html: About the shop');
    expect(text).toContain(
      'PAGE blog/2024/03/a-post.html: An old archive post',
    );
    // The landing page comes first, then the rest in path order: a
    // prohibited business names itself on the page a visitor arrives at,
    // and the scan budget must be spent there before an archive post.
    const indexAt = text.indexOf('PAGE index.html:');
    const aboutAt = text.indexOf('PAGE about.html:');
    const blogAt = text.indexOf('PAGE blog/2024/03/a-post.html:');
    expect(indexAt).toBeGreaterThanOrEqual(0);
    expect(indexAt).toBeLessThan(aboutAt);
    expect(aboutAt).toBeLessThan(blogAt);
  });

  it('skips files with no text extension', () => {
    const text = collectBuiltTextForScan(PAGES);
    expect(text).not.toContain('hero.png');
    expect(text).not.toContain('not-really-binary-but-not-html-either');
  });

  it('respects the char cap', () => {
    const longPage = [
      { path: 'index.html', content: '<p>' + 'x'.repeat(500) + '</p>' },
    ];
    const capped = collectBuiltTextForScan(longPage, 40);
    expect(capped.length).toBeLessThanOrEqual(40);
    expect(capped.startsWith('PAGE index.html: ')).toBe(true);

    // The default cap is exported and used when no cap is given.
    expect(BUILT_TEXT_SCAN_MAX_CHARS).toBeGreaterThan(0);
  });
});

describe('describeProhibitedContent', () => {
  it('names the category and the evidence hash, and never quotes the site', () => {
    // The verdict carries the classifier's one sentence of evidence, never
    // the scanned text itself -- there is no field on this type for it, on
    // purpose (see acceptable-use.ts on `policy_reviews`). What this test
    // proves is that the description built from that verdict stays inside
    // the same discipline: the category, the classifier's sentence, and the
    // hash, and nothing else.
    const verdict: ContentPolicyVerdict = {
      decision: 'refuse',
      categoryId: 'illegal_drugs',
      categoryLabel: 'Illegal drugs and controlled substances',
      evidence: 'The page prices and ships a controlled substance.',
      evidenceHash: 'deadbeefcafef00d',
    };

    const description = describeProhibitedContent(verdict);

    expect(description).toContain('Illegal drugs and controlled substances');
    expect(description).toContain('deadbeefcafef00d');
    expect(description).toContain(
      'The page prices and ships a controlled substance.',
    );
    // Nothing beyond the verdict's own fields; in particular, no raw markup.
    expect(description).not.toContain('<');
  });
});

// ─── The gate wired into FullSiteBuildWorker ────────────────────────────────

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
    ],
    locale: 'en-RO',
    submittedAt: '2026-08-11T10:00:00.000Z',
    consent: {
      publicProfileAnalysis: true,
      acceptedAt: '2026-08-11T10:00:00.000Z',
    },
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

/**
 * The worker-construction harness, copied from the fixture in
 * `flowstarter-workflows.test.ts` that reaches `store:human-qa` on its own
 * (`moves a deposit-paid project through the full-build agents into human
 * QA`). That fixture already clears every gate ahead of the acceptable-use
 * check -- the placeholder-image, portrait and markup-policy gates -- so the
 * only thing this suite needs to vary is the `contentPolicy` scanner, passed
 * as the worker's sixth (options) argument.
 */
async function makeWorker(options: {
  contentPolicy?: ContentPolicyScanner;
  contentPolicyRequired?: boolean;
}) {
  const projectId = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
  const worktreeRoot = await deepTempDir('flowstarter-acceptable-use-gate');
  temporaryDirectories.push(worktreeRoot);

  const calls: string[] = [];
  const events: Array<{ kind: string; body: string }> = [];
  const store: FullSiteBuildJobStore = {
    appendEvent: async (_jobId, event) => {
      events.push({ kind: event.kind, body: event.body });
    },
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
      calls.push(`store:failed:${error.code}`);
    },
  };

  const worktrees = {
    create: async (id: string) => {
      calls.push('git:create-worktree');
      return {
        branch: `client/flowstarter-${id}`,
        path: worktreeRoot,
      };
    },
    commit: async () => {
      calls.push('git:commit');
      return 'abc123def456';
    },
  } as unknown as SafeGitWorktreeManager;

  const agents = {
    buildFullSite: async (input: { workspaceRoot: string }) => {
      calls.push('agent:full-site-builder');
      await mkdir(join(input.workspaceRoot, 'src/pages'), { recursive: true });
      // The copy a business that sells a prohibited good would actually
      // ship: nothing here is a phrase this design matches against, it only
      // exists so the scanner (mocked per test below) has a built page to
      // have been handed.
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
      expect(
        await readFile(join(workspaceRoot, 'src/pages/about.astro'), 'utf8'),
      ).toContain('Human-ready full site');
    },
  };

  let published = false;
  const pullRequests: PullRequestPublisher = {
    create: async (input) => {
      published = true;
      calls.push('publisher:pr-staging');
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
    options,
  );

  return {
    worker,
    calls,
    events,
    wasPublished: () => published,
  };
}

describe('the acceptable-use gate on the built site', () => {
  it('fails the job with PROHIBITED_CONTENT and never commits or publishes', async () => {
    const scanner: ContentPolicyScanner = async () => ({
      decision: 'refuse',
      categoryId: 'illegal_drugs',
      categoryLabel: 'Illegal drugs and controlled substances',
      evidence: 'The built site sells a controlled substance on its home page.',
      evidenceHash: 'hash-of-the-scanned-text',
    });

    const { worker, calls, wasPublished } = await makeWorker({
      contentPolicy: scanner,
    });

    await expect(worker.run('job-1')).rejects.toMatchObject({
      code: PROHIBITED_CONTENT,
    });

    expect(calls).toContain('store:failed:' + PROHIBITED_CONTENT);
    // The gate runs after the build compiles, so the agent and the validator
    // still ran; what must not have happened is anything after the gate.
    expect(calls).not.toContain('git:commit');
    expect(calls).not.toContain('publisher:pr-staging');
    expect(calls).not.toContain('store:human-qa');
    expect(wasPublished()).toBe(false);
  });

  it('lets a clean build publish as before', async () => {
    const scanner: ContentPolicyScanner = async () => ({
      decision: 'allow',
      categoryId: 'none',
      categoryLabel: 'No policy category',
      evidence: 'Nothing in this submission falls under the policy.',
      evidenceHash: 'hash-of-the-scanned-text',
    });

    const { worker, calls, wasPublished } = await makeWorker({
      contentPolicy: scanner,
    });

    await worker.run('job-1');

    expect(calls).toContain('git:commit');
    expect(calls).toContain('publisher:pr-staging');
    expect(calls).toContain('store:human-qa');
    expect(wasPublished()).toBe(true);
  });

  it('fails closed with CONTENT_POLICY_UNAVAILABLE when no scanner is wired and one is required', async () => {
    const { worker, calls, wasPublished } = await makeWorker({
      contentPolicyRequired: true,
      // No `contentPolicy`: the environment (production) requires a scan
      // that cannot run here, and the build must not ship unchecked.
    });

    await expect(worker.run('job-1')).rejects.toMatchObject({
      code: CONTENT_POLICY_UNAVAILABLE,
    });

    expect(calls).toContain('store:failed:' + CONTENT_POLICY_UNAVAILABLE);
    expect(calls).not.toContain('git:commit');
    expect(calls).not.toContain('publisher:pr-staging');
    expect(wasPublished()).toBe(false);
  });

  it('publishes unchecked when no scanner is wired and none is required', async () => {
    // A developer environment with no classifier configured must still be
    // able to run the funnel end to end; only an environment that opts into
    // `contentPolicyRequired` fails closed on a missing scanner.
    const { worker, calls, events, wasPublished } = await makeWorker({});

    await worker.run('job-1');

    expect(calls).toContain('git:commit');
    expect(calls).toContain('publisher:pr-staging');
    expect(calls).toContain('store:human-qa');
    expect(wasPublished()).toBe(true);
    // Publishing unchecked is a documented degrade, not a silent one.
    expect(events.some((event) => event.body.includes('not configured'))).toBe(
      true,
    );
  });
});
