/**
 * The publish step, wired end to end with the deploy call stubbed.
 *
 * What is asserted here is the shape of the step, not the shape of a tarball:
 * that the platform publisher builds before it deploys, hands the funnel the
 * platform URL rather than a sandbox one, keeps a workspace copy for the edit
 * loop, tears that copy down and nothing else, and refuses to report a
 * preview as live when the host did not serve it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFunnelPreviewPublisher } from '../funnel-preview-publisher';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const publishFunnelPreview = vi.fn();
vi.mock('@/lib/hosting/preview-publisher', () => ({
  publishFunnelPreview: (...args: unknown[]) => publishFunnelPreview(...args),
}));

const STUB_ASTRO = `#!/bin/sh
test "$1" = "build" || exit 3
mkdir -p dist
printf '<!doctype html><h1>Built</h1>' > dist/index.html
`;

const PREVIEW_ID = 'c0ffee00-0000-4000-8000-000000000001';
const scratch: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fs-pub-ws-'));
  scratch.push(root);
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"site"}');
  await writeFile(join(root, 'node_modules', '.bin', 'astro'), STUB_ASTRO);
  await chmod(join(root, 'node_modules', '.bin', 'astro'), 0o755);
  await mkdir(join(root, 'src', 'pages'), { recursive: true });
  await writeFile(join(root, 'src', 'pages', 'index.astro'), '<h1>Source</h1>');
  return root;
}

function hooks() {
  return {
    phases: [] as string[],
    workspaces: [] as string[],
    hosted: [] as Array<{ status: string; url?: string }>,
  };
}

function wire(record: ReturnType<typeof hooks>) {
  return {
    onPhase: (phase: string) => record.phases.push(phase),
    onWorkspace: (root: string) => record.workspaces.push(root),
    onHosted: (hosted: { status: string; url?: string }) =>
      record.hosted.push(hosted),
  };
}

const publishInput = (root: string) => ({
  projectId: PREVIEW_ID,
  workspaceRoot: root,
  template: { slug: 'nowhere' } as never,
  brandConfig: { palette: {} } as never,
});

beforeEach(() => {
  publishFunnelPreview.mockReset();
});

afterEach(async () => {
  while (scratch.length) {
    await rm(scratch.pop() as string, { recursive: true, force: true });
  }
});

describe('the platform publisher', () => {
  it('builds, deploys, and hands the funnel the platform URL', async () => {
    publishFunnelPreview.mockResolvedValue({
      status: 'live',
      url: 'https://p-0123456789abcdef.preview.flowstarter.dev',
      hostname: 'p-0123456789abcdef.preview.flowstarter.dev',
      expiresAt: '2026-09-27T00:00:00.000Z',
      detail: null,
    });
    const record = hooks();
    const publisher = createFunnelPreviewPublisher({
      previewId: PREVIEW_ID,
      hooks: wire(record),
      decision: {
        publisher: 'platform',
        reason: 'platform-host-configured',
        missing: [],
      },
    });

    const root = await workspace();
    const published = await publisher.publisher.publish(publishInput(root));
    scratch.push(record.workspaces[0] as string);

    expect(published.previewUrl).toBe(
      'https://p-0123456789abcdef.preview.flowstarter.dev'
    );
    expect(published.artifactUrl).toContain('platform://');
    // The SOURCE is what is returned for the claim; the compiled output is
    // what went to the host. A claim rebuilt from dist/ has nothing left to
    // personalize.
    expect(
      published.files.some((f) => f.path === 'src/pages/index.astro')
    ).toBe(true);
    const call = publishFunnelPreview.mock.calls[0]?.[0];
    expect(
      call.builtFiles.some((f: { path: string }) => f.path === 'index.html')
    ).toBe(true);
    expect(
      call.files.some((f: { path: string }) => f.path === 'index.html')
    ).toBe(false);
    expect(record.phases).toEqual([
      'Building your site',
      'Publishing your live preview',
    ]);
    expect(record.hosted[0]?.status).toBe('live');
  });

  it('keeps a workspace copy for the edit loop, and tears down only that', async () => {
    publishFunnelPreview.mockResolvedValue({
      status: 'live',
      url: 'https://p-0123456789abcdef.preview.flowstarter.dev',
      hostname: 'p-0123456789abcdef.preview.flowstarter.dev',
      expiresAt: '2026-09-27T00:00:00.000Z',
      detail: null,
    });
    const record = hooks();
    const publisher = createFunnelPreviewPublisher({
      previewId: PREVIEW_ID,
      hooks: wire(record),
      decision: {
        publisher: 'platform',
        reason: 'platform-host-configured',
        missing: [],
      },
    });
    const root = await workspace();
    const published = await publisher.publisher.publish(publishInput(root));

    const copy = record.workspaces[0] as string;
    expect(existsSync(copy)).toBe(true);
    expect(copy).not.toBe(root);

    await published.teardown?.();
    expect(existsSync(copy)).toBe(false);
    // The hosted site is temporary by its own 14-day expiry, not by this
    // job's 45-minute reaper: a visitor who closes the tab keeps their link.
    expect(publishFunnelPreview).toHaveBeenCalledTimes(1);
  });

  it('fails the step rather than reporting a URL that does not answer', async () => {
    publishFunnelPreview.mockResolvedValue({
      status: 'pending',
      url: 'https://p-0123456789abcdef.preview.flowstarter.dev',
      hostname: 'p-0123456789abcdef.preview.flowstarter.dev',
      expiresAt: '2026-09-27T00:00:00.000Z',
      detail: 'previews deploy-agent is not configured',
    });
    const record = hooks();
    const publisher = createFunnelPreviewPublisher({
      previewId: PREVIEW_ID,
      hooks: wire(record),
      decision: {
        publisher: 'platform',
        reason: 'platform-host-configured',
        missing: [],
      },
    });
    const root = await workspace();
    await expect(
      publisher.publisher.publish(publishInput(root))
    ).rejects.toThrow(/did not serve this preview/);
    scratch.push(record.workspaces[0] as string);
    expect(record.hosted[0]?.status).toBe('pending');
  });

  it('redeploys the rebuilt site after a free edit', async () => {
    publishFunnelPreview.mockResolvedValue({
      status: 'live',
      url: 'https://p-0123456789abcdef.preview.flowstarter.dev',
      hostname: 'p-0123456789abcdef.preview.flowstarter.dev',
      expiresAt: '2026-09-27T00:00:00.000Z',
      detail: null,
    });
    const record = hooks();
    const publisher = createFunnelPreviewPublisher({
      previewId: PREVIEW_ID,
      hooks: wire(record),
      decision: {
        publisher: 'platform',
        reason: 'platform-host-configured',
        missing: [],
      },
    });
    const root = await workspace();
    await publisher.publisher.publish(publishInput(root));
    const copy = record.workspaces[0] as string;
    scratch.push(copy);

    await writeFile(
      join(copy, 'node_modules', '.bin', 'astro'),
      STUB_ASTRO.replace('<h1>Built</h1>', '<h1>Edited</h1>')
    );
    await chmod(join(copy, 'node_modules', '.bin', 'astro'), 0o755);
    await publisher.republish?.();

    expect(publishFunnelPreview).toHaveBeenCalledTimes(2);
    const second = publishFunnelPreview.mock.calls[1]?.[0];
    expect(
      second.builtFiles.find((f: { path: string }) => f.path === 'index.html')
        ?.content
    ).toContain('Edited');
  });
});

describe('the local static publisher', () => {
  it('serves the build from this process, with no child to orphan', async () => {
    const record = hooks();
    const publisher = createFunnelPreviewPublisher({
      previewId: PREVIEW_ID,
      hooks: wire(record),
      decision: {
        publisher: 'local-static',
        reason: 'development-without-platform-host',
        missing: [],
      },
    });
    const root = await workspace();
    const published = await publisher.publisher.publish(publishInput(root));
    const copy = record.workspaces[0] as string;

    expect(published.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(published.artifactUrl).toContain('local://');
    const served = await fetch(published.previewUrl, {
      signal: AbortSignal.timeout(4_000),
    });
    expect(await served.text()).toContain('Built');
    // Nothing was pushed to a host: there is no host on a developer machine.
    expect(publishFunnelPreview).not.toHaveBeenCalled();

    await published.teardown?.();
    expect(existsSync(copy)).toBe(false);
    await expect(
      fetch(published.previewUrl, { signal: AbortSignal.timeout(2_000) })
    ).rejects.toThrow();
  });

  it('swaps the rebuilt bytes in on the same URL after a free edit', async () => {
    const record = hooks();
    const publisher = createFunnelPreviewPublisher({
      previewId: PREVIEW_ID,
      hooks: wire(record),
      decision: {
        publisher: 'local-static',
        reason: 'development-without-platform-host',
        missing: [],
      },
    });
    const root = await workspace();
    const published = await publisher.publisher.publish(publishInput(root));
    const copy = record.workspaces[0] as string;

    await writeFile(
      join(copy, 'node_modules', '.bin', 'astro'),
      STUB_ASTRO.replace('<h1>Built</h1>', '<h1>Edited</h1>')
    );
    await chmod(join(copy, 'node_modules', '.bin', 'astro'), 0o755);
    await publisher.republish?.();

    const served = await fetch(published.previewUrl, {
      signal: AbortSignal.timeout(4_000),
    });
    expect(await served.text()).toContain('Edited');
    await published.teardown?.();
  });
});

describe('the publisher factory', () => {
  it('reads the rule when no decision is handed to it', () => {
    const built = createFunnelPreviewPublisher({
      previewId: PREVIEW_ID,
      hooks: wire(hooks()),
      env: { NODE_ENV: 'development' },
    });
    expect(built.decision.publisher).toBe('local-static');
  });

  it('gives the Daytona publisher no republish, because its sandbox needs none', () => {
    const built = createFunnelPreviewPublisher({
      previewId: PREVIEW_ID,
      hooks: wire(hooks()),
      env: { FLOWSTARTER_PREVIEW_PUBLISHER: 'daytona', DAYTONA_API_KEY: 'x' },
    });
    expect(built.decision.publisher).toBe('daytona');
    expect(built.republish).toBeUndefined();
  });
});
