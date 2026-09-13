import { describe, expect, it } from 'vitest';
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

describe('generation prerequisites', () => {
  it('is satisfied when Pi (via either key), the MCP library and the previews host are all present', () => {
    expect(canRunPreviewGeneration(CONFIGURED)).toBe(true);
    expect(missingGenerationPrerequisites(CONFIGURED)).toEqual([]);
  });

  it('asks Daytona for a key only when an operator asked for Daytona', () => {
    const {
      OPENROUTER_API_KEY,
      FLOWSTARTER_MCP_URL,
      FLOWSTARTER_MCP_INTERNAL_TOKEN,
    } = CONFIGURED;
    expect(
      missingGenerationPrerequisites({
        OPENROUTER_API_KEY,
        FLOWSTARTER_MCP_URL,
        FLOWSTARTER_MCP_INTERNAL_TOKEN,
        FLOWSTARTER_PREVIEW_PUBLISHER: 'daytona',
        NODE_ENV: 'production',
      })
    ).toEqual(['DAYTONA_API_KEY']);
  });

  it('needs nothing at all from the publish step on a developer machine', () => {
    const {
      OPENROUTER_API_KEY,
      FLOWSTARTER_MCP_URL,
      FLOWSTARTER_MCP_INTERNAL_TOKEN,
    } = CONFIGURED;
    expect(
      canRunPreviewGeneration({
        OPENROUTER_API_KEY,
        FLOWSTARTER_MCP_URL,
        FLOWSTARTER_MCP_INTERNAL_TOKEN,
        NODE_ENV: 'development',
      })
    ).toBe(true);
  });

  it('accepts PI_API_KEY as an alternative to OPENROUTER_API_KEY', () => {
    const { OPENROUTER_API_KEY: _unused, ...rest } = CONFIGURED;
    expect(canRunPreviewGeneration({ ...rest, PI_API_KEY: 'pi-test' })).toBe(
      true
    );
  });

  it('names what is missing, exactly what a bare production env is missing', () => {
    // Only the model key is set, which is the shape production's environment
    // has been reported to have.
    const productionToday = {
      OPENROUTER_API_KEY: 'sk-or-test',
      NODE_ENV: 'production',
    };
    expect(missingGenerationPrerequisites(productionToday)).toEqual([
      'FLOWSTARTER_MCP_URL',
      'FLOWSTARTER_MCP_INTERNAL_TOKEN',
      'FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL',
      'FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET',
    ]);
    expect(canRunPreviewGeneration(productionToday)).toBe(false);
  });

  it('is not satisfied by an empty or whitespace-only value', () => {
    const blank = {
      ...CONFIGURED,
      FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET: '   ',
    };
    expect(canRunPreviewGeneration(blank)).toBe(false);
    expect(missingGenerationPrerequisites(blank)).toEqual([
      'FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET',
    ]);
  });

  it('reports every prerequisite, not just the missing ones, for callers that want the full picture', () => {
    const list = generationPrerequisites(CONFIGURED);
    expect(list).toHaveLength(3);
    expect(list.every((p) => p.present)).toBe(true);
    expect(list.map((p) => p.name)).toEqual([
      'PI_API_KEY or OPENROUTER_API_KEY',
      'FLOWSTARTER_MCP_URL',
      'FLOWSTARTER_MCP_INTERNAL_TOKEN',
    ]);
  });

  it('defaults to process.env when no environment is given', () => {
    const previous = { ...process.env };
    try {
      for (const key of Object.keys(CONFIGURED)) delete process.env[key];
      process.env.FLOWSTARTER_ENV = 'production';
      expect(canRunPreviewGeneration()).toBe(false);
    } finally {
      process.env = previous;
    }
  });
});
