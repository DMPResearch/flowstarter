import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import {
  canRunPreviewGeneration,
  generationPrerequisites,
  missingGenerationPrerequisites,
} from '../generation-availability';

const CONFIGURED = {
  OPENROUTER_API_KEY: 'sk-or-test',
  FLOWSTARTER_MCP_URL: 'https://mcp.example.internal',
  FLOWSTARTER_MCP_INTERNAL_TOKEN: 'token',
  // The publish step's requirement is no longer a fixed env var: it is
  // whatever the publisher this process resolved to needs. The default
  // publisher is the platform, so that is the previews deploy-agent.
  FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL: 'https://fs-sites-01.example/previews',
  FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET: 'shhh',
  NODE_ENV: 'production',
};

// The MCP prerequisite is now a real network probe (`GET /health` at the
// configured URL's root) rather than a mere "is the string set" check. Every
// test above this line that only cares about the OTHER prerequisites stubs
// `fetch` to answer healthy, so it exercises the shape of the check that
// existed before this file's async/health-probe change without actually
// touching the network.
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generation prerequisites', () => {
  it('is satisfied when Pi (via either key), the MCP library and the previews host are all present', async () => {
    expect(await canRunPreviewGeneration(CONFIGURED)).toBe(true);
    expect(await missingGenerationPrerequisites(CONFIGURED)).toEqual([]);
  });

  it('asks Daytona for a key only when an operator asked for Daytona', async () => {
    const {
      OPENROUTER_API_KEY,
      FLOWSTARTER_MCP_URL,
      FLOWSTARTER_MCP_INTERNAL_TOKEN,
    } = CONFIGURED;
    expect(
      await missingGenerationPrerequisites({
        OPENROUTER_API_KEY,
        FLOWSTARTER_MCP_URL,
        FLOWSTARTER_MCP_INTERNAL_TOKEN,
        FLOWSTARTER_PREVIEW_PUBLISHER: 'daytona',
        NODE_ENV: 'production',
      })
    ).toEqual(['DAYTONA_API_KEY']);
  });

  it('needs nothing at all from the publish step on a developer machine', async () => {
    const {
      OPENROUTER_API_KEY,
      FLOWSTARTER_MCP_URL,
      FLOWSTARTER_MCP_INTERNAL_TOKEN,
    } = CONFIGURED;
    expect(
      await canRunPreviewGeneration({
        OPENROUTER_API_KEY,
        FLOWSTARTER_MCP_URL,
        FLOWSTARTER_MCP_INTERNAL_TOKEN,
        NODE_ENV: 'development',
      })
    ).toBe(true);
  });

  it('accepts PI_API_KEY as an alternative to OPENROUTER_API_KEY', async () => {
    const { OPENROUTER_API_KEY: _unused, ...rest } = CONFIGURED;
    expect(
      await canRunPreviewGeneration({ ...rest, PI_API_KEY: 'pi-test' })
    ).toBe(true);
  });

  it('names what is missing, exactly what a bare production env is missing', async () => {
    // Only the model key is set, which is the shape production's environment
    // has been reported to have.
    const productionToday = {
      OPENROUTER_API_KEY: 'sk-or-test',
      NODE_ENV: 'production',
    };
    expect(await missingGenerationPrerequisites(productionToday)).toEqual([
      'FLOWSTARTER_MCP_URL',
      'FLOWSTARTER_MCP_INTERNAL_TOKEN',
      'FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL',
      'FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET',
    ]);
    expect(await canRunPreviewGeneration(productionToday)).toBe(false);
  });

  it('is not satisfied by an empty or whitespace-only value', async () => {
    const blank = {
      ...CONFIGURED,
      FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET: '   ',
    };
    expect(await canRunPreviewGeneration(blank)).toBe(false);
    expect(await missingGenerationPrerequisites(blank)).toEqual([
      'FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET',
    ]);
  });

  it('reports every prerequisite, not just the missing ones, for callers that want the full picture', async () => {
    const list = await generationPrerequisites(CONFIGURED);
    expect(list).toHaveLength(3);
    expect(list.every((p) => p.present)).toBe(true);
    expect(list.map((p) => p.name)).toEqual([
      'PI_API_KEY or OPENROUTER_API_KEY',
      'FLOWSTARTER_MCP_URL',
      'FLOWSTARTER_MCP_INTERNAL_TOKEN',
    ]);
  });

  it('defaults to process.env when no environment is given', async () => {
    const previous = { ...process.env };
    try {
      for (const key of Object.keys(CONFIGURED)) delete process.env[key];
      process.env.FLOWSTARTER_ENV = 'production';
      expect(await canRunPreviewGeneration()).toBe(false);
    } finally {
      process.env = previous;
    }
  });

  describe('the MCP health probe', () => {
    it("probes /health at the configured URL's root, not the MCP path itself", async () => {
      await generationPrerequisites({
        ...CONFIGURED,
        FLOWSTARTER_MCP_URL: 'https://mcp.example.internal/mcp?token=x',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://mcp.example.internal/health',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('reports "template library not answering" when the configured URL is unreachable', async () => {
      // A port nothing listens on: guaranteed connection-refused rather than
      // a mocked failure, so this also proves the probe is a real fetch.
      vi.unstubAllGlobals();
      const deadUrl = 'http://127.0.0.1:1';
      const missing = await missingGenerationPrerequisites({
        ...CONFIGURED,
        FLOWSTARTER_MCP_URL: deadUrl,
      });
      expect(missing).toContain(`template library not answering at ${deadUrl}`);
      expect(
        await canRunPreviewGeneration({
          ...CONFIGURED,
          FLOWSTARTER_MCP_URL: deadUrl,
        })
      ).toBe(false);
    });

    it('reports "template library not answering" when the probe times out', async () => {
      fetchMock.mockImplementation(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(
                new DOMException('The operation was aborted', 'AbortError')
              )
            );
          })
      );
      const missing = await missingGenerationPrerequisites({
        ...CONFIGURED,
        FLOWSTARTER_MCP_HEALTH_TIMEOUT_MS: '10',
      });
      expect(missing).toContain(
        `template library not answering at ${CONFIGURED.FLOWSTARTER_MCP_URL}`
      );
    });

    it('reports "template library not answering" on a non-2xx health response', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
      const missing = await missingGenerationPrerequisites(CONFIGURED);
      expect(missing).toContain(
        `template library not answering at ${CONFIGURED.FLOWSTARTER_MCP_URL}`
      );
    });

    it('is satisfied when a real stub server answers 200 on /health', async () => {
      vi.unstubAllGlobals();
      const server: Server = createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"status":"healthy"}');
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      try {
        const port = (server.address() as AddressInfo).port;
        const url = `http://127.0.0.1:${port}/mcp`;
        const missing = await missingGenerationPrerequisites({
          ...CONFIGURED,
          FLOWSTARTER_MCP_URL: url,
        });
        expect(missing).toEqual([]);
        expect(
          await canRunPreviewGeneration({
            ...CONFIGURED,
            FLOWSTARTER_MCP_URL: url,
          })
        ).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('skips the network probe entirely when FLOWSTARTER_MCP_URL is unset', async () => {
      const { FLOWSTARTER_MCP_URL: _unused, ...rest } = CONFIGURED;
      const missing = await missingGenerationPrerequisites(rest);
      expect(missing).toEqual(['FLOWSTARTER_MCP_URL']);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
