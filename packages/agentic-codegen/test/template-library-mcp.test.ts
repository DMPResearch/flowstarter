/**
 * A production incident: `client.connect(transport)` failed because the MCP
 * server was down, but the SDK's `StreamableHTTPClientTransport` had already
 * marked itself "started" by that failed call. The next attempt — a caller's
 * retry loop reusing the same `FlowstarterMcpTemplateLibrary` instance —
 * called `connect()` again on the SAME transport and got
 * `StreamableHTTPClientTransport already started!` instead of the original,
 * honest connection-refused error, which is what actually masked the cause.
 *
 * `Client` and `StreamableHTTPClientTransport` are mocked so a failed
 * `connect()` can be simulated deterministically and the constructor calls
 * counted, without a real MCP server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeClient {
  connect: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
}

// A single valid candidate, so `search()` never falls through to its
// empty-result `list_templates` fallback and each `search()` call maps to
// exactly one `callTool` call — keeping the call counts below unambiguous.
const TEMPLATE_PAYLOAD = JSON.stringify({
  templates: [
    {
      slug: 'test-template',
      displayName: 'Test Template',
      description: 'A test template',
      category: 'general',
      fileCount: 10,
      totalLOC: 100,
    },
  ],
});

let clientInstances: FakeClient[] = [];
let transportInstances: Array<{ close: ReturnType<typeof vi.fn> }> = [];
let connectImpl: () => Promise<void> = async () => undefined;

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class Client implements FakeClient {
    connect = vi.fn(() => connectImpl());
    callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: TEMPLATE_PAYLOAD }],
      isError: false,
    }));
    constructor() {
      clientInstances.push(this);
    }
  }
  return { Client };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  class StreamableHTTPClientTransport {
    close = vi.fn(async () => undefined);
    constructor() {
      transportInstances.push(this);
    }
  }
  return { StreamableHTTPClientTransport };
});

import { FlowstarterMcpTemplateLibrary } from '../src/flowstarter/template-library-mcp';

const OPTIONS = {
  endpoint: 'http://127.0.0.1:4000/mcp',
  internalToken: 'a'.repeat(32),
};

beforeEach(() => {
  clientInstances = [];
  transportInstances = [];
  connectImpl = async () => undefined;
});

describe('FlowstarterMcpTemplateLibrary reconnect after a failed connect', () => {
  it('throws the ORIGINAL connection error, not "already started", on a first-attempt failure', async () => {
    connectImpl = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:4000');
    };
    const library = new FlowstarterMcpTemplateLibrary(OPTIONS);

    await expect(library.search('yoga studio')).rejects.toThrow(
      'connect ECONNREFUSED 127.0.0.1:4000',
    );
  });

  it('builds a fresh client/transport after a failed connect, so a second attempt does not hit "already started"', async () => {
    let attempt = 0;
    connectImpl = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:4000');
      // A second connect on the ORIGINAL (mocked) transport would still
      // "succeed" here since this fake never throws "already started" —
      // the real assertion is that a fresh client/transport pair exists.
    };
    const library = new FlowstarterMcpTemplateLibrary(OPTIONS);

    await expect(library.search('yoga studio')).rejects.toThrow(
      'connect ECONNREFUSED 127.0.0.1:4000',
    );
    expect(clientInstances).toHaveLength(2);
    expect(transportInstances).toHaveLength(2);

    // The second attempt succeeds and does not throw "already started".
    const result = await library.search('yoga studio');
    expect(result).toEqual([
      expect.objectContaining({ slug: 'test-template' }),
    ]);
    // It ran against the SECOND (fresh) client instance, not the one whose
    // connect failed.
    expect(clientInstances[1]?.connect).toHaveBeenCalledTimes(1);
    expect(clientInstances[1]?.callTool).toHaveBeenCalledTimes(1);
    expect(clientInstances[0]?.callTool).not.toHaveBeenCalled();
  });

  it('does not reconnect on a call after a successful connect', async () => {
    const library = new FlowstarterMcpTemplateLibrary(OPTIONS);
    await library.search('yoga studio');
    await library.search('another query');
    expect(clientInstances).toHaveLength(1);
    expect(clientInstances[0]?.connect).toHaveBeenCalledTimes(1);
    expect(clientInstances[0]?.callTool).toHaveBeenCalledTimes(2);
  });
});
