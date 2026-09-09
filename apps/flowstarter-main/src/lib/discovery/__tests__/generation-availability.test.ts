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
  DAYTONA_API_KEY: 'daytona-test',
};

describe('generation prerequisites', () => {
  it('is satisfied when Pi (via either key), the MCP library and Daytona are all present', () => {
    expect(canRunPreviewGeneration(CONFIGURED)).toBe(true);
    expect(missingGenerationPrerequisites(CONFIGURED)).toEqual([]);
  });

  it('accepts PI_API_KEY as an alternative to OPENROUTER_API_KEY', () => {
    const { OPENROUTER_API_KEY: _unused, ...rest } = CONFIGURED;
    expect(canRunPreviewGeneration({ ...rest, PI_API_KEY: 'pi-test' })).toBe(
      true
    );
  });

  it('names what is missing, exactly what Netlify is missing today', () => {
    // No DAYTONA_API_KEY, no FLOWSTARTER_* — only the model key is set, which
    // is the shape production's environment has been reported to have.
    const netlifyToday = { OPENROUTER_API_KEY: 'sk-or-test' };
    expect(missingGenerationPrerequisites(netlifyToday)).toEqual([
      'FLOWSTARTER_MCP_URL',
      'FLOWSTARTER_MCP_INTERNAL_TOKEN',
      'DAYTONA_API_KEY',
    ]);
    expect(canRunPreviewGeneration(netlifyToday)).toBe(false);
  });

  it('is not satisfied by an empty or whitespace-only value', () => {
    const blank = { ...CONFIGURED, DAYTONA_API_KEY: '   ' };
    expect(canRunPreviewGeneration(blank)).toBe(false);
    expect(missingGenerationPrerequisites(blank)).toEqual(['DAYTONA_API_KEY']);
  });

  it('reports every prerequisite, not just the missing ones, for callers that want the full picture', () => {
    const list = generationPrerequisites(CONFIGURED);
    expect(list).toHaveLength(4);
    expect(list.every((p) => p.present)).toBe(true);
    expect(list.map((p) => p.name)).toEqual([
      'PI_API_KEY or OPENROUTER_API_KEY',
      'FLOWSTARTER_MCP_URL',
      'FLOWSTARTER_MCP_INTERNAL_TOKEN',
      'DAYTONA_API_KEY',
    ]);
  });

  it('defaults to process.env when no environment is given', () => {
    const previous = { ...process.env };
    try {
      for (const key of Object.keys(CONFIGURED)) delete process.env[key];
      expect(canRunPreviewGeneration()).toBe(false);
    } finally {
      process.env = previous;
    }
  });
});
