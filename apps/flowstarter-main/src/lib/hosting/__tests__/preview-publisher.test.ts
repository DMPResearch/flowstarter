/**
 * Publishing a funnel preview to the previews host.
 *
 * The cases below are the ones that would cost real money or real trust:
 *
 *  - the previews agent's URL and secret are the ONLY ones it will use. A
 *    preview pushed to the customer host with the customer secret is the exact
 *    failure this whole separation exists to prevent, so it is asserted rather
 *    than assumed;
 *  - the hostname carries no trace of the business. A preview holds a real
 *    company's name and copy nobody approved; a guessable URL hands it to
 *    whoever wants it;
 *  - unconfigured means PENDING, never live. Reporting a site as live when no
 *    host exists sends a client a URL that 404s.
 *
 * Static imports throughout: vi.mock is hoisted above them, and the app's
 * tsconfig does not allow top-level await in tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { createFakeHostingSupabase } from './fake-hosting-supabase';
import { DryRunDeployAgentClient, type DeployAgentClient } from '../deploy';

vi.mock('server-only', () => ({}));

const db = createFakeHostingSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

import {
  PREVIEW_DOMAIN_SUFFIX,
  PreviewPublishError,
  funnelPreviewHostname,
  funnelPreviewSlug,
  hasRootIndexHtml,
  isFunnelPreviewSlug,
  previewsDeployAgentFromEnv,
  publishFunnelPreview,
  slugFromPreviewHostname,
  unpublishFunnelPreview,
} from '../preview-publisher';

const PREVIEW_ID = 'a1b2c3d4-1111-4111-8111-111111111111';

const FILES = [
  { path: 'index.html', content: '<head></head><h1>Calm Path Therapy</h1>' },
  { path: 'about/index.html', content: '<head></head><p>About</p>' },
  { path: 'assets/app.css', content: 'body{margin:0}' },
];

/**
 * The shape `readPreviewFiles` hands the publisher today: raw Astro source,
 * with no root `index.html` anywhere — its entry point is a `.astro` page,
 * not an HTML document a static Caddy could serve.
 */
const SOURCE_FILES = [
  {
    path: 'package.json',
    content: JSON.stringify({
      name: 'wellness-therapy',
      scripts: { dev: 'astro dev' },
    }),
  },
  { path: 'src/pages/index.astro', content: '<h1>Calm Path Therapy</h1>' },
];

/** A recording agent, so the suite can assert on exactly what was sent. */
function recordingAgent(behaviour: 'ok' | 'throw' = 'ok') {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const client: DeployAgentClient = {
    async push(args) {
      calls.push({ method: 'push', args: args as never });
      if (behaviour === 'throw') throw new Error('agent exploded');
      return { ok: true as const, sha256: 'abc', sizeBytes: 10 };
    },
    async remove(args) {
      calls.push({ method: 'remove', args: args as never });
      if (behaviour === 'throw') throw new Error('agent exploded');
      return { ok: true as const };
    },
  };
  return { calls, client };
}

function configured(client: DeployAgentClient) {
  return {
    deployAgentUrl: 'https://previews.host:8444',
    sharedSecret: 'previews-secret-token',
    client,
    configured: true,
  };
}

beforeEach(() => {
  db.reset();
});

describe('preview slugs and hostnames', () => {
  it('mints an unguessable slug with no business in it', () => {
    const minted = Array.from({ length: 200 }, () => funnelPreviewSlug());
    // No collisions across 200 draws: 64 bits of entropy, not a counter.
    expect(new Set(minted).size).toBe(200);
    for (const slug of minted) {
      expect(slug).toMatch(/^p-[0-9a-f]{16}$/);
      expect(isFunnelPreviewSlug(slug)).toBe(true);
    }
  });

  it('builds the hostname under the pinned preview zone', () => {
    const slug = funnelPreviewSlug();
    expect(funnelPreviewHostname(slug)).toBe(
      `${slug}.${PREVIEW_DOMAIN_SUFFIX}`
    );
    expect(PREVIEW_DOMAIN_SUFFIX).toBe('preview.flowstarter.net');
  });

  it('refuses to build a hostname from anything but a minted slug', () => {
    expect(() => funnelPreviewHostname('calm-path-therapy')).toThrow(
      PreviewPublishError
    );
  });

  it('round-trips a hostname back to its slug, and rejects foreign ones', () => {
    const slug = funnelPreviewSlug();
    expect(slugFromPreviewHostname(`${slug}.${PREVIEW_DOMAIN_SUFFIX}`)).toBe(
      slug
    );
    expect(
      slugFromPreviewHostname('calm-path.preview.flowstarter.net')
    ).toBeNull();
    expect(slugFromPreviewHostname(`${slug}.evil.example.com`)).toBeNull();
  });
});

describe('previewsDeployAgentFromEnv', () => {
  it('uses the PREVIEWS variables and never the paid-site ones', () => {
    const agent = previewsDeployAgentFromEnv({
      FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL: 'https://previews:8444',
      FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET: 'previews-secret',
      // The paid-site pair, present and deliberately ignored.
      FLOWSTARTER_DEPLOY_AGENT_SECRET: 'paid-secret',
      DEPLOY_AGENT_SHARED_SECRET: 'paid-secret',
    } as unknown as NodeJS.ProcessEnv);
    expect(agent.configured).toBe(true);
    expect(agent.deployAgentUrl).toBe('https://previews:8444');
    expect(agent.sharedSecret).toBe('previews-secret');
  });

  it('does NOT fall back to the paid-site secret when previews is unset', () => {
    const agent = previewsDeployAgentFromEnv({
      FLOWSTARTER_DEPLOY_AGENT_SECRET: 'paid-secret',
      DEPLOY_AGENT_SHARED_SECRET: 'paid-secret',
    } as unknown as NodeJS.ProcessEnv);
    expect(agent.configured).toBe(false);
    expect(agent.sharedSecret).toBe('');
    expect(agent.client).toBeInstanceOf(DryRunDeployAgentClient);
  });

  it('is unconfigured when only one half is set', () => {
    expect(
      previewsDeployAgentFromEnv({
        FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL: 'https://previews:8444',
      } as unknown as NodeJS.ProcessEnv).configured
    ).toBe(false);
    expect(
      previewsDeployAgentFromEnv({
        FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET: 'x',
      } as unknown as NodeJS.ProcessEnv).configured
    ).toBe(false);
  });
});

describe('publishFunnelPreview', () => {
  it('pushes to the previews endpoint with the previews secret', async () => {
    const agent = recordingAgent();
    const result = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: FILES,
      templateSlug: 'wellness-therapy',
      agent: configured(agent.client),
    });

    expect(result.status).toBe('live');
    expect(result.published).toBe(true);
    expect(agent.calls).toHaveLength(1);
    const push = agent.calls[0].args;
    expect(push.deployAgentUrl).toBe('https://previews.host:8444');
    expect(push.sharedSecret).toBe('previews-secret-token');
    expect(push.siteSlug).toBe(result.slug);
    expect(push.primaryDomain).toBe(result.hostname);
    // A preview has no custom domains; passing any would be inventing one.
    expect(push.additionalDomains).toEqual([]);
  });

  it('never derives the hostname from the business name', async () => {
    const agent = recordingAgent();
    const result = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: FILES,
      templateSlug: 'wellness-therapy',
      brandConfig: { business: { name: 'Calm Path Therapy' } },
      agent: configured(agent.client),
    });
    expect(result.hostname).toMatch(
      /^p-[0-9a-f]{16}\.preview\.flowstarter\.net$/
    );
    expect(result.hostname).not.toContain('calm');
    expect(result.hostname).not.toContain('therapy');
    expect(result.hostname).not.toContain(PREVIEW_ID);
  });

  it('stores the artifact under funnel/, outside every tenant prefix', async () => {
    const agent = recordingAgent();
    const result = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: FILES,
      agent: configured(agent.client),
    });
    expect(result.artifactPath).toBe(`funnel/${PREVIEW_ID}/site.tar.gz`);
    expect(result.artifactPath?.startsWith('tenant/')).toBe(false);
    expect(db.objects.has(result.artifactPath as string)).toBe(true);
  });

  it('noindexes every HTML file in the bytes the agent receives', async () => {
    const agent = recordingAgent();
    await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: FILES,
      agent: configured(agent.client),
    });
    const stored = db.objects.get(`funnel/${PREVIEW_ID}/site.tar.gz`);
    const tar = gunzipSync(Buffer.from(stored?.bytes as Uint8Array)).toString(
      'utf8'
    );
    // Both documents, not just the entry point.
    expect(tar.match(/name="robots"/g) ?? []).toHaveLength(2);
    expect(tar).toContain('noindex, nofollow, noarchive');
  });

  it('hands the agent a signed URL rather than the whole tarball', async () => {
    const agent = recordingAgent();
    await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: FILES,
      agent: configured(agent.client),
    });
    const artifact = agent.calls[0].args.artifact as { kind: string };
    expect(artifact.kind).toBe('url');
  });

  it('fails loudly rather than pushing bytes the agent would reject', async () => {
    // The agent's deploy endpoint only accepts `artifact_url`. With no signed
    // URL there is nothing to deploy, and a push that 400s would look like a
    // deploy attempt while telling nobody the real problem is Storage.
    db.storageAvailable = false;
    const agent = recordingAgent();
    const result = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: FILES,
      agent: configured(agent.client),
    });
    expect(agent.calls).toHaveLength(0);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('nothing to fetch');
    // The manifest is still in the row, so the claim still works.
    expect(db.rows('funnel_previews')[0].manifest).toBeTruthy();
  });

  it('records the row and the hostname before reporting live', async () => {
    const agent = recordingAgent();
    const result = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: FILES,
      templateSlug: 'wellness-therapy',
      agent: configured(agent.client),
    });
    const row = db.rows('funnel_previews')[0];
    expect(row.preview_id).toBe(PREVIEW_ID);
    expect(row.template_slug).toBe('wellness-therapy');
    expect(row.hostname).toBe(result.hostname);
    expect(row.deploy_status).toBe('live');
    expect(row.expires_at).toBeTypeOf('string');
  });

  it('gives the preview a TTL roughly a week out', async () => {
    const agent = recordingAgent();
    await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: FILES,
      agent: configured(agent.client),
    });
    const expiresAt = Date.parse(
      String(db.rows('funnel_previews')[0].expires_at)
    );
    const days = (expiresAt - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it('records PENDING, not live, when the previews agent is unconfigured', async () => {
    const result = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: FILES,
      agent: previewsDeployAgentFromEnv({} as unknown as NodeJS.ProcessEnv),
    });
    expect(result.status).toBe('pending');
    expect(result.published).toBe(false);
    expect(result.detail).toContain('not configured');
    expect(db.rows('funnel_previews')[0].deploy_status).toBe('pending');
    // The manifest is still durable — an unconfigured host must not cost the
    // visitor the claim.
    expect(db.rows('funnel_previews')[0].artifact_path).toBe(
      `funnel/${PREVIEW_ID}/site.tar.gz`
    );
  });

  it('records FAILED and keeps the manifest when the agent errors', async () => {
    const agent = recordingAgent('throw');
    const result = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: FILES,
      agent: configured(agent.client),
    });
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('agent exploded');
    const row = db.rows('funnel_previews')[0];
    expect(row.deploy_status).toBe('failed');
    expect(row.manifest).toBeTruthy();
  });

  it('keeps the same hostname when the same preview is republished', async () => {
    const first = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: FILES,
      agent: configured(recordingAgent().client),
    });
    const second = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: FILES,
      agent: configured(recordingAgent().client),
    });
    expect(second.hostname).toBe(first.hostname);
    expect(db.rows('funnel_previews')).toHaveLength(1);
  });

  it('refuses to publish nothing', async () => {
    await expect(
      publishFunnelPreview({ previewId: PREVIEW_ID, files: [] })
    ).rejects.toBeInstanceOf(PreviewPublishError);
  });
});

describe('hasRootIndexHtml', () => {
  it('is true only for a root index.html, not a nested one or Astro source', () => {
    expect(hasRootIndexHtml(FILES)).toBe(true);
    expect(hasRootIndexHtml(SOURCE_FILES)).toBe(false);
    expect(
      hasRootIndexHtml([{ path: 'about/index.html', content: '<p>About</p>' }])
    ).toBe(false);
  });
});

describe('publishFunnelPreview refuses to deploy source-only archives', () => {
  it('never pushes raw Astro source to the previews agent', async () => {
    const agent = recordingAgent();
    const result = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: SOURCE_FILES,
      agent: configured(agent.client),
    });
    expect(result.status).toBe('failed');
    expect(result.published).toBe(false);
    expect(result.detail).toContain('no compiled dist/ output');
    expect(result.artifactPath).toBeNull();
    // The bug this guards against: no tar, no upload, no push — a source
    // manifest never reaches the deploy-agent under any artifact shape.
    expect(agent.calls).toHaveLength(0);
    expect(db.objects.size).toBe(0);
  });

  it('still leaves the preview claimable from its source manifest', async () => {
    const agent = recordingAgent();
    await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: SOURCE_FILES,
      agent: configured(agent.client),
    });
    const row = db.rows('funnel_previews')[0];
    expect(row.deploy_status).toBe('failed');
    expect(row.artifact_path).toBeNull();
    const manifest = row.manifest as { files: typeof SOURCE_FILES };
    expect(manifest.files).toEqual(SOURCE_FILES);
  });

  it('also refuses builtFiles with no root index.html', async () => {
    const agent = recordingAgent();
    const result = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: SOURCE_FILES,
      builtFiles: [{ path: 'assets/app.css', content: 'body{margin:0}' }],
      agent: configured(agent.client),
    });
    expect(result.status).toBe('failed');
    expect(agent.calls).toHaveLength(0);
  });
});

describe('publishFunnelPreview deploys the compiled dist/ output', () => {
  it('tars and pushes builtFiles, not the source files', async () => {
    const agent = recordingAgent();
    const result = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: SOURCE_FILES,
      builtFiles: FILES,
      agent: configured(agent.client),
    });
    expect(result.status).toBe('live');
    expect(agent.calls).toHaveLength(1);
    const stored = db.objects.get(result.artifactPath as string);
    const tar = gunzipSync(Buffer.from(stored?.bytes as Uint8Array)).toString(
      'utf8'
    );
    expect(tar).toContain('Calm Path Therapy');
    expect(tar).not.toContain('astro dev');
  });

  it('keeps the claim manifest on the source files, not the compiled ones', async () => {
    const agent = recordingAgent();
    await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: SOURCE_FILES,
      builtFiles: FILES,
      agent: configured(agent.client),
    });
    const row = db.rows('funnel_previews')[0];
    const manifest = row.manifest as { files: typeof SOURCE_FILES };
    expect(manifest.files).toEqual(SOURCE_FILES);
  });

  it('preserves a compiled binary asset byte-for-byte', async () => {
    const raw = Uint8Array.from([0xff, 0xd8, 0x00, 0x00, 0x10, 0xff]);
    const agent = recordingAgent();
    const result = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: SOURCE_FILES,
      builtFiles: [
        ...FILES,
        {
          path: 'assets/hero.jpg',
          content: Buffer.from(raw).toString('base64'),
          encoding: 'base64' as const,
        },
      ],
      agent: configured(agent.client),
    });
    const stored = db.objects.get(result.artifactPath as string);
    const bytes = Buffer.from(stored?.bytes as Uint8Array);
    const tar =
      bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
    expect(tar.indexOf(Buffer.from(raw))).toBeGreaterThan(0);
  });

  it('falls back to files when builtFiles is omitted, for callers that already deploy compiled output', async () => {
    const agent = recordingAgent();
    const result = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: FILES,
      agent: configured(agent.client),
    });
    expect(result.status).toBe('live');
    expect(agent.calls).toHaveLength(1);
  });
});

describe('FLOWSTARTER_PREVIEW_ARTIFACT_TRANSPORT=bytes', () => {
  const ORIGINAL = process.env.FLOWSTARTER_PREVIEW_ARTIFACT_TRANSPORT;
  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.FLOWSTARTER_PREVIEW_ARTIFACT_TRANSPORT;
    } else {
      process.env.FLOWSTARTER_PREVIEW_ARTIFACT_TRANSPORT = ORIGINAL;
    }
  });

  it('sends the built tarball as bytes instead of a signed URL', async () => {
    process.env.FLOWSTARTER_PREVIEW_ARTIFACT_TRANSPORT = 'bytes';
    const agent = recordingAgent();
    const result = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: SOURCE_FILES,
      builtFiles: FILES,
      agent: configured(agent.client),
    });
    expect(result.status).toBe('live');
    const artifact = agent.calls[0].args.artifact as {
      kind: string;
      bytes: ArrayBuffer;
    };
    expect(artifact.kind).toBe('bytes');
    expect(artifact.bytes.byteLength).toBeGreaterThan(0);
    // Storage is still written, even though the deploy skipped signing it.
    expect(result.artifactPath).toBe(`funnel/${PREVIEW_ID}/site.tar.gz`);
    expect(db.objects.has(result.artifactPath as string)).toBe(true);
  });

  it('still defaults to a signed URL when unset', async () => {
    delete process.env.FLOWSTARTER_PREVIEW_ARTIFACT_TRANSPORT;
    const agent = recordingAgent();
    await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: SOURCE_FILES,
      builtFiles: FILES,
      agent: configured(agent.client),
    });
    const artifact = agent.calls[0].args.artifact as { kind: string };
    expect(artifact.kind).toBe('url');
  });
});

describe('unpublishFunnelPreview', () => {
  it('removes by slug through the previews agent', async () => {
    const publishAgent = recordingAgent();
    const published = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: FILES,
      agent: configured(publishAgent.client),
    });

    const removeAgent = recordingAgent();
    const result = await unpublishFunnelPreview({
      previewId: PREVIEW_ID,
      agent: configured(removeAgent.client),
    });

    expect(result.removed).toBe(true);
    expect(removeAgent.calls[0].method).toBe('remove');
    expect(removeAgent.calls[0].args.siteSlug).toBe(published.slug);
    expect(removeAgent.calls[0].args.sharedSecret).toBe(
      'previews-secret-token'
    );
    expect(db.rows('funnel_previews')[0].deploy_status).toBe('removed');
  });

  it('is a no-op that still marks removed when nothing was hosted', async () => {
    db.seed('funnel_previews', [
      {
        preview_id: PREVIEW_ID,
        hostname: null,
        deploy_status: 'pending',
        expires_at: new Date(Date.now() + 1000).toISOString(),
        claimed_workspace_id: null,
      },
    ]);
    const agent = recordingAgent();
    const result = await unpublishFunnelPreview({
      previewId: PREVIEW_ID,
      agent: configured(agent.client),
    });
    expect(result.removed).toBe(true);
    expect(agent.calls).toHaveLength(0);
    expect(db.rows('funnel_previews')[0].deploy_status).toBe('removed');
  });

  it('reports failure rather than claiming a site is gone', async () => {
    const published = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: FILES,
      agent: configured(recordingAgent().client),
    });
    expect(published.status).toBe('live');

    const result = await unpublishFunnelPreview({
      previewId: PREVIEW_ID,
      agent: configured(recordingAgent('throw').client),
    });
    expect(result.removed).toBe(false);
    expect(result.detail).toContain('agent exploded');
    expect(db.rows('funnel_previews')[0].deploy_status).toBe('live');
  });
});

describe('re-publishing preserves the stashed manifest', () => {
  it('keeps manifest.intake when the publisher refreshes files', async () => {
    const mod = await import('../preview-publisher');
    const fp = await import('../funnel-previews');
    const previewId = '11111111-2222-4333-8444-555555555555';
    const rows = new Map<string, Record<string, unknown>>();
    rows.set(previewId, {
      preview_id: previewId,
      template_slug: 'wellness-therapy',
      template_version: '1',
      brand_config: { tone: 'calm' },
      manifest: {
        files: [{ path: 'old.txt', content: 'old', type: 'file' }],
        intake: { projectId: previewId, businessName: 'Rowan & Vale' },
        previewUrl: 'http://127.0.0.1:1',
      },
      artifact_path: null,
      hostname: null,
      deploy_status: 'pending',
      deployment_error: null,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      claimed_workspace_id: null,
    });
    const saved: Record<string, unknown>[] = [];
    const fakeSupabase = {
      from: () => ({
        upsert: (row: Record<string, unknown>) => {
          saved.push(row);
          rows.set(String(row.preview_id), {
            ...rows.get(String(row.preview_id)),
            ...row,
          });
          return Promise.resolve({ error: null });
        },
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: rows.get(previewId), error: null }),
          }),
        }),
      }),
      storage: {
        from: () => ({
          upload: () => Promise.resolve({ error: null }),
        }),
      },
    };
    await mod.publishFunnelPreview({
      previewId,
      files: [
        {
          path: 'index.html',
          content: '<html><head></head><body>n</body></html>',
        },
      ],
      supabase: fakeSupabase as never,
    });
    const written = saved.find((r) => 'manifest' in r) as {
      manifest: Record<string, unknown>;
    };
    expect(written).toBeTruthy();
    expect(
      (written.manifest.intake as { businessName?: string })?.businessName
    ).toBe('Rowan & Vale');
    expect(Array.isArray(written.manifest.files)).toBe(true);
    expect((written.manifest.files as Array<{ path: string }>)[0].path).toBe(
      'index.html'
    );
    // Loud regression pin: the bug was manifest === { files } exactly.
    expect(Object.keys(written.manifest)).toEqual(
      expect.arrayContaining(['files', 'intake', 'previewUrl'])
    );
  });
});

describe('a dry run with no Storage at all', () => {
  it('hands the tarball bytes to the client instead of a storage URL', async () => {
    // Storage is what turns a preview into something the agent can fetch. With
    // none, the dry run still has to record what would have gone out — the
    // size of the tarball is the whole point of exercising it.
    db.storageAvailable = false;
    const agent = recordingAgent();
    const result = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: FILES,
      agent: {
        deployAgentUrl: '',
        sharedSecret: '',
        client: agent.client,
        configured: false,
      },
      supabase: db.client as never,
    });

    expect(result.status).toBe('pending');
    expect(result.published).toBe(false);
    expect(result.artifactPath).toBeNull();

    const artifact = agent.calls[0]!.args.artifact as {
      kind: string;
      bytes: ArrayBuffer;
    };
    expect(artifact.kind).toBe('bytes');
    expect(artifact.bytes).toBeInstanceOf(ArrayBuffer);
    expect(artifact.bytes.byteLength).toBeGreaterThan(0);
    expect(agent.calls[0]!.args.deployAgentUrl).toBe('dry-run://previews');
  });
});
