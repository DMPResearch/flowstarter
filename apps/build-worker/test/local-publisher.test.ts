import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, artifactTokenFromPath } from '../src/artifacts';
import { LocalPublishError, LocalSitePublisher } from '../src/local-publisher';
import { CommandSiteValidator } from '../src/validator';

const execFileAsync = promisify(execFile);

const PROJECT_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

let scratch = '';
let siteRoot = '';
let artifactsRoot = '';

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'fs-local-publisher-'));
  siteRoot = join(scratch, 'site');
  artifactsRoot = join(scratch, 'artifacts');
  await mkdir(join(siteRoot, 'dist/book'), { recursive: true });
  await writeFile(
    join(siteRoot, 'dist/index.html'),
    '<h1>Calm Path</h1>',
    'utf8',
  );
  await writeFile(
    join(siteRoot, 'dist/book/index.html'),
    '<main><div class="book-page__calendar">placeholder</div></main>',
    'utf8',
  );
  // Debris that must never reach a client's host.
  await mkdir(join(siteRoot, 'node_modules/left-pad'), { recursive: true });
  await writeFile(
    join(siteRoot, 'node_modules/left-pad/index.js'),
    'x',
    'utf8',
  );
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

interface Call {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

function publisher(opts: {
  calls: Call[];
  respond?: () => Response;
  onProgress?: (message: string) => void;
}): LocalSitePublisher {
  return new LocalSitePublisher({
    store: new ArtifactStore({
      root: artifactsRoot,
      baseUrl: 'http://127.0.0.1:8787',
    }),
    flowstarterMainUrl: 'http://127.0.0.1:3000',
    sharedSecret: 's'.repeat(48),
    outputDir: 'dist',
    stagingUrlTemplate: 'http://localhost:8788/{projectId}/',
    onProgress: opts.onProgress,
    fetchImpl: (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      opts.calls.push({
        url: String(input),
        authorization:
          (init?.headers as Record<string, string>)?.authorization ?? null,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return (
        opts.respond?.() ??
        Response.json({
          deployment: { deploymentId: 'dep_1', status: 'live' },
          siteUrl: 'http://localhost:8788/calm-path/',
        })
      );
    }) as typeof globalThis.fetch,
  });
}

/** Untars the stored artifact so the assertions are about real bytes. */
async function extractOnlyArtifact(): Promise<string> {
  const names = await readdir(artifactsRoot);
  const tarball = names.find((name) => name.endsWith('.tar.gz'));
  expect(tarball).toBeDefined();
  const out = join(scratch, 'extracted');
  await mkdir(out, { recursive: true });
  await execFileAsync('tar', [
    '-xzf',
    join(artifactsRoot, tarball!),
    '-C',
    out,
  ]);
  return out;
}

describe('LocalSitePublisher', () => {
  it('packages the build output, stores it and asks flowstarter-main to deploy it', async () => {
    const calls: Call[] = [];
    const result = await publisher({ calls }).create({
      projectId: PROJECT_ID,
      branch: `client/flowstarter-${PROJECT_ID}`,
      worktreePath: join(scratch, 'worktree'),
      commitSha: 'a'.repeat(40),
      siteRoot,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'http://127.0.0.1:3000/api/internal/build/deploy',
    );
    expect(calls[0]!.authorization).toBe(`Bearer ${'s'.repeat(48)}`);
    expect(calls[0]!.body).toMatchObject({
      workspaceId: PROJECT_ID,
      commitSha: 'a'.repeat(40),
    });
    expect(String(calls[0]!.body['artifactUrl'])).toMatch(
      /^http:\/\/127\.0\.0\.1:8787\/artifacts\/[0-9a-f-]+\.tar\.gz$/,
    );
    expect(String(calls[0]!.body['artifactSha256'])).toMatch(/^[0-9a-f]{64}$/);

    // The URL a human opens comes from the deploy, not from a template guess.
    expect(result.stagingUrl).toBe('http://localhost:8788/calm-path/');
    expect(result.pullRequestUrl).toBe(String(calls[0]!.body['artifactUrl']));

    const extracted = await extractOnlyArtifact();
    expect(await readFile(join(extracted, 'index.html'), 'utf8')).toContain(
      'Calm Path',
    );
    await expect(
      readFile(join(extracted, 'node_modules/left-pad/index.js'), 'utf8'),
    ).rejects.toThrow();
  });

  // The artifact URL's random path segment is a bearer credential — anyone
  // who reads it can fetch the (possibly unpaid-for) site. Progress logs are
  // the kind of thing that ends up in a CI log or an operator's terminal
  // scrollback, so they must carry an id and a hash, never the URL itself.
  it('never logs the artifact URL, only its size and hash', async () => {
    const calls: Call[] = [];
    const messages: string[] = [];
    await publisher({ calls, onProgress: (m) => messages.push(m) }).create({
      projectId: PROJECT_ID,
      branch: `client/flowstarter-${PROJECT_ID}`,
      worktreePath: join(scratch, 'worktree'),
      commitSha: 'a'.repeat(40),
      siteRoot,
    });

    const artifactUrl = String(calls[0]!.body['artifactUrl']);
    const artifactSha256 = String(calls[0]!.body['artifactSha256']);
    const joined = messages.join('\n');
    expect(joined).not.toContain(artifactUrl);
    expect(joined).not.toContain('http://127.0.0.1:8787');
    expect(joined).toContain(artifactSha256);
    expect(joined).toContain(PROJECT_ID);
  });

  it('upgrades the built booking page to the tenant live embed', async () => {
    const calls: Call[] = [];
    await publisher({ calls }).create({
      projectId: PROJECT_ID,
      branch: `client/flowstarter-${PROJECT_ID}`,
      worktreePath: join(scratch, 'worktree'),
      commitSha: 'a'.repeat(40),
      siteRoot,
      calComUrl: 'https://cal.com/acme/intro',
    });

    const extracted = await extractOnlyArtifact();
    const booking = await readFile(join(extracted, 'book/index.html'), 'utf8');
    expect(booking).toContain('data-flowstarter-cal-embed="true"');
    expect(booking).toContain('cal.com/acme/intro/embed');
    expect(booking).not.toContain('data-flowstarter-cal-preview');
  });

  it('strips a leaked preview demo from the packaged output when there is no booking link', async () => {
    // The approved-preview seed the worker started from already carried the
    // blurred demo — the shape that shipped on a paid site once, because
    // nothing downstream ever ran to take it back out.
    await writeFile(
      join(siteRoot, 'dist/book/index.html'),
      '<main><div class="flowstarter-cal-preview" data-flowstarter-cal-preview="true">' +
        '<!-- flowstarter:cal-preview — blurred demo; injectCalCom() replaces this on the full site -->' +
        '<div style="filter:blur(7px)">calendar</div></div></main>',
      'utf8',
    );

    const calls: Call[] = [];
    await publisher({ calls }).create({
      projectId: PROJECT_ID,
      branch: `client/flowstarter-${PROJECT_ID}`,
      worktreePath: join(scratch, 'worktree'),
      commitSha: 'a'.repeat(40),
      siteRoot,
      calComUrl: null,
    });

    const extracted = await extractOnlyArtifact();
    const booking = await readFile(join(extracted, 'book/index.html'), 'utf8');
    expect(booking).not.toContain('data-flowstarter-cal-preview');
    expect(booking).not.toContain('flowstarter:cal-preview');
    expect(booking).not.toContain('filter:blur');
    expect(booking).not.toContain('data-flowstarter-cal-embed');
  });

  it('falls back to the staging template when the deploy reports no URL', async () => {
    const calls: Call[] = [];
    const result = await publisher({
      calls,
      respond: () => Response.json({ deployment: { status: 'live' } }),
    }).create({
      projectId: PROJECT_ID,
      branch: `client/flowstarter-${PROJECT_ID}`,
      worktreePath: join(scratch, 'worktree'),
      commitSha: 'a'.repeat(40),
      siteRoot,
    });
    expect(result.stagingUrl).toBe(`http://localhost:8788/${PROJECT_ID}/`);
  });

  it('fails the build when the deploy is refused, rather than reporting HUMAN_QA', async () => {
    await expect(
      publisher({
        calls: [],
        respond: () =>
          new Response('workspace has no hosting_server_id', { status: 409 }),
      }).create({
        projectId: PROJECT_ID,
        branch: `client/flowstarter-${PROJECT_ID}`,
        worktreePath: join(scratch, 'worktree'),
        commitSha: 'a'.repeat(40),
        siteRoot,
      }),
    ).rejects.toBeInstanceOf(LocalPublishError);
  });

  it('fails the build when the deploy finished in any state but live', async () => {
    await expect(
      publisher({
        calls: [],
        respond: () =>
          Response.json({
            deployment: { status: 'failed', detail: 'deploy-agent 502' },
          }),
      }).create({
        projectId: PROJECT_ID,
        branch: `client/flowstarter-${PROJECT_ID}`,
        worktreePath: join(scratch, 'worktree'),
        commitSha: 'a'.repeat(40),
        siteRoot,
      }),
    ).rejects.toThrow(/deploy-agent 502/);
  });
});

/**
 * The bug this covers: `LocalSitePublisher` falls back to packaging the site
 * root itself when `dist/` does not exist (`resolveSiteOutputDir`), which is
 * correct for a manifest that is already plain HTML but disastrous for a raw
 * Astro source tree that was never built -- the deploy-agent then serves
 * `package.json`/`src/` instead of a site and 404s at `/`. The fix ensures a
 * `SITE_REBUILD` (and every other job kind) always runs the real
 * `CommandSiteValidator` first, so `dist/` exists by the time this publisher
 * ever sees the workspace. This proves that chain end to end, on a fixture
 * that starts as raw source with no `dist/` at all.
 */
describe('LocalSitePublisher after a real validator run', () => {
  it('packages dist/index.html from a rebuild once the validator has actually built the site', async () => {
    // A raw, unbuilt workspace: only a manifest and a source file, the exact
    // shape a SITE_REBUILD worktree has before validation runs. No dist/.
    const rawSiteRoot = join(scratch, 'raw-site');
    await mkdir(join(rawSiteRoot, 'src'), { recursive: true });
    await writeFile(
      join(rawSiteRoot, 'package.json'),
      JSON.stringify({ name: 'calm-path', private: true }),
      'utf8',
    );
    await writeFile(
      join(rawSiteRoot, 'src', 'index.astro'),
      '<h1>Calm Path (unbuilt)</h1>',
      'utf8',
    );

    // The trusted build gate, standing in for `pnpm install && pnpm run
    // build` with a deterministic command so the test stays hermetic --
    // the same style `validator.test.ts` uses. It writes the one thing that
    // matters here: a real dist/index.html.
    const validator = new CommandSiteValidator({
      commands: [
        {
          bin: 'node',
          args: [
            '-e',
            'require("fs").mkdirSync("dist",{recursive:true});' +
              'require("fs").writeFileSync("dist/index.html","<h1>Calm Path</h1>");',
          ],
        },
      ],
      timeoutMs: 10_000,
    });
    await validator.validate(rawSiteRoot, 'full');

    const calls: Call[] = [];
    await publisher({ calls }).create({
      projectId: PROJECT_ID,
      branch: `client/flowstarter-${PROJECT_ID}`,
      worktreePath: join(scratch, 'worktree'),
      commitSha: 'a'.repeat(40),
      siteRoot: rawSiteRoot,
    });

    const extracted = await extractOnlyArtifact();
    expect(await readFile(join(extracted, 'index.html'), 'utf8')).toContain(
      'Calm Path',
    );
    // Only dist/ was packaged, never the raw source or the manifest that
    // would have shipped had the validator been skipped (the bug).
    await expect(
      readFile(join(extracted, 'package.json'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(join(extracted, 'src/index.astro'), 'utf8'),
    ).rejects.toThrow();
  });

  it('would package the raw source tree if the validator never ran -- the shape of the bug this closes', async () => {
    // No validator runs here at all: this documents the fallback in
    // `resolveSiteOutputDir` that makes skipping the real build dangerous,
    // it does not endorse skipping it. Production and staging can never
    // reach this path (`FLOWSTARTER_BUILD_SKIP_VALIDATION` is refused
    // there); this fixture is the raw-source shape a NoopSiteValidator run
    // would leave behind.
    const rawSiteRoot = join(scratch, 'unbuilt-site');
    await mkdir(join(rawSiteRoot, 'src'), { recursive: true });
    await writeFile(
      join(rawSiteRoot, 'package.json'),
      JSON.stringify({ name: 'calm-path', private: true }),
      'utf8',
    );
    await writeFile(
      join(rawSiteRoot, 'src', 'index.astro'),
      '<h1>Calm Path (unbuilt)</h1>',
      'utf8',
    );

    const calls: Call[] = [];
    await publisher({ calls }).create({
      projectId: PROJECT_ID,
      branch: `client/flowstarter-${PROJECT_ID}`,
      worktreePath: join(scratch, 'worktree'),
      commitSha: 'a'.repeat(40),
      siteRoot: rawSiteRoot,
    });

    const extracted = await extractOnlyArtifact();
    // Raw source shipped instead of a built site: no index.html at the
    // root, only the unbuilt manifest and sources -- the deploy-agent has
    // nothing to serve at `/` and 404s, exactly as reported.
    await expect(
      readFile(join(extracted, 'index.html'), 'utf8'),
    ).rejects.toThrow();
    expect(await readFile(join(extracted, 'package.json'), 'utf8')).toContain(
      'calm-path',
    );
  });
});

describe('ArtifactStore', () => {
  it('mints an unguessable name and reads it back', async () => {
    const store = new ArtifactStore({
      root: artifactsRoot,
      baseUrl: 'http://127.0.0.1:8787/',
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const stored = await store.put(PROJECT_ID, bytes);

    expect(stored.token).toMatch(new RegExp(`^${PROJECT_ID}-[0-9a-f]{32}$`));
    expect(stored.url).toBe(
      `http://127.0.0.1:8787/artifacts/${stored.token}.tar.gz`,
    );
    expect(stored.sizeBytes).toBe(4);
    expect(Buffer.from((await store.read(stored.token))!)).toEqual(
      Buffer.from(bytes),
    );
  });

  it('answers null for an unknown or traversing token instead of touching the filesystem', async () => {
    const store = new ArtifactStore({
      root: artifactsRoot,
      baseUrl: 'http://127.0.0.1:8787',
    });
    expect(await store.read('../../etc/passwd')).toBeNull();
    expect(await store.read(`${PROJECT_ID}-${'0'.repeat(32)}`)).toBeNull();
  });
});

describe('artifactTokenFromPath', () => {
  it('only matches the artifact route with a well-formed token', () => {
    const token = `${PROJECT_ID}-${'a'.repeat(32)}`;
    expect(artifactTokenFromPath(`/artifacts/${token}.tar.gz`)).toBe(token);
    expect(artifactTokenFromPath(`/artifacts/${token}`)).toBeNull();
    expect(
      artifactTokenFromPath('/artifacts/../../etc/passwd.tar.gz'),
    ).toBeNull();
    expect(artifactTokenFromPath('/health')).toBeNull();
  });
});
