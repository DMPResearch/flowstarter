import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { TemplateCandidate, TemplateScaffold } from './types';

const MAX_SCAFFOLD_FILES = 1_000;
const MAX_SCAFFOLD_BYTES = 48 * 1024 * 1024;

export interface TemplateLibrary {
  search(query: string): Promise<TemplateCandidate[]>;
  getDetails(slug: string): Promise<Record<string, unknown>>;
  scaffold(slug: string): Promise<TemplateScaffold>;
  close(): Promise<void>;
}

export interface FlowstarterMcpTemplateLibraryOptions {
  endpoint: string;
  internalToken: string;
}

export class FlowstarterMcpTemplateLibrary implements TemplateLibrary {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private connected = false;
  /**
   * The in-flight connect attempt, shared by every concurrent caller.
   *
   * A caller that awaits `search()` and one that awaits `getDetails()` at
   * the same time (a model's session can issue more than one tool call in a
   * turn) both reach `call()` while `connected` is still false. Without
   * this, both would call `client.connect(transport)` on the SAME
   * transport — and the SDK marks a transport "started" the moment
   * `connect()` is invoked, before either attempt has had a chance to
   * succeed or fail, so the second call throws "already started!" even
   * when nothing is actually wrong yet. Routing every concurrent caller
   * through the one attempt already running means there is only ever one
   * real `connect()` call per transport, and every caller sees its honest
   * outcome (the server's own refusal, or success).
   */
  private connecting: Promise<void> | null = null;

  constructor(private readonly options: FlowstarterMcpTemplateLibraryOptions) {
    if (options.internalToken.length < 32) {
      throw new Error(
        'FLOWSTARTER_MCP_INTERNAL_TOKEN must contain at least 32 characters',
      );
    }
    const endpoint = new URL(options.endpoint);
    const loopback =
      endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1';
    if (
      endpoint.protocol !== 'https:' &&
      !(loopback && endpoint.protocol === 'http:')
    ) {
      throw new Error(
        'Template MCP endpoint must use HTTPS (HTTP is allowed only on loopback)',
      );
    }
    const fresh = this.freshConnection(endpoint);
    this.client = fresh.client;
    this.transport = fresh.transport;
  }

  /**
   * A brand new client/transport pair. Used once by the constructor and
   * again by `call()`'s failure path: the SDK's `StreamableHTTPClientTransport`
   * marks itself "started" the moment `client.connect()` is called on it,
   * even if that connect then fails (server down, refused, DNS). Retrying
   * `connect()` on the SAME transport after a failed attempt throws
   * `StreamableHTTPClientTransport already started!` instead of the original,
   * honest connection error — which is exactly what masked a real incident's
   * cause. Replacing both objects after a failed connect means the next
   * attempt starts clean.
   */
  private freshConnection(endpoint: URL): {
    client: Client;
    transport: StreamableHTTPClientTransport;
  } {
    return {
      client: new Client({
        name: 'flowstarter-build-worker',
        version: '1.0.0',
      }),
      transport: new StreamableHTTPClientTransport(endpoint),
    };
  }

  async search(query: string): Promise<TemplateCandidate[]> {
    const normalized = query.trim().slice(0, 300);
    if (!normalized)
      throw new TypeError('Template search query cannot be empty');
    let payload = await this.call('search_templates', { query: normalized });
    if (!isRecord(payload) || !Array.isArray(payload.templates)) {
      throw new Error('Template MCP returned an invalid search response');
    }
    // A low-cost model can over-specify its query and produce no lexical
    // matches. Fall back to the complete approved catalog through MCP; the
    // agent may still inspect and choose, but it can never invent a template.
    if (payload.templates.length === 0) {
      payload = await this.call('list_templates', {});
      if (!isRecord(payload) || !Array.isArray(payload.templates)) {
        throw new Error('Template MCP returned an invalid catalog response');
      }
    }
    return payload.templates.map(parseCandidate);
  }

  async getDetails(slug: string): Promise<Record<string, unknown>> {
    assertSlug(slug);
    const payload = await this.call('get_template_details', { slug });
    if (!isRecord(payload))
      throw new Error('Template MCP returned invalid template details');
    return payload;
  }

  async scaffold(slug: string): Promise<TemplateScaffold> {
    assertSlug(slug);
    const payload = await this.call('scaffold_template', { slug });
    if (!isRecord(payload) || !isRecord(payload.scaffold)) {
      const detail =
        isRecord(payload) && typeof payload.error === 'string'
          ? `: ${payload.error}`
          : '';
      throw new Error(`Template MCP could not scaffold ${slug}${detail}`);
    }

    const scaffold = payload.scaffold;
    if (!isRecord(scaffold.template) || !Array.isArray(scaffold.files)) {
      throw new Error('Template MCP returned an invalid scaffold payload');
    }
    if (
      scaffold.files.length === 0 ||
      scaffold.files.length > MAX_SCAFFOLD_FILES
    ) {
      throw new Error(
        'Template scaffold file count is outside the allowed range',
      );
    }

    let totalBytes = 0;
    const files = scaffold.files.map((file, index) => {
      if (
        !isRecord(file) ||
        typeof file.path !== 'string' ||
        typeof file.content !== 'string'
      ) {
        throw new Error(`Template scaffold file ${index} is invalid`);
      }
      assertSafeScaffoldPath(file.path);
      const binary = file.encoding === 'base64';
      if (binary && !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) {
        throw new Error(`Template scaffold file ${index} is not valid base64`);
      }
      totalBytes += binary
        ? Math.floor((file.content.length * 3) / 4)
        : Buffer.byteLength(file.content, 'utf8');
      if (totalBytes > MAX_SCAFFOLD_BYTES)
        throw new Error('Template scaffold exceeds size limit');
      return binary
        ? {
            path: file.path,
            content: file.content,
            encoding: 'base64' as const,
            type: 'file' as const,
          }
        : { path: file.path, content: file.content, type: 'file' as const };
    });

    const template = scaffold.template;
    if (!isRecord(template.metadata) || !isRecord(template.config)) {
      throw new Error('Template scaffold metadata is invalid');
    }
    const metadata = parseCandidate(template.metadata);
    if (metadata.slug !== slug)
      throw new Error('Template scaffold slug does not match the selection');

    return {
      template: {
        metadata: {
          ...metadata,
          features: stringArray(template.metadata.features),
        },
        config: template.config,
      },
      files,
    };
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.transport.close();
    this.connected = false;
  }

  /**
   * Connects exactly once per transport, no matter how many callers ask at
   * once. See `connecting` above for why that matters.
   */
  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (!this.connecting) {
      this.connecting = this.client
        .connect(this.transport)
        .then(() => {
          this.connected = true;
        })
        .catch((error: unknown) => {
          // The transport is now internally "started" even though connect
          // failed. Replace it (and the client) so the NEXT attempt —
          // whether a caller's own retry, a fresh call on this same
          // instance, or one of the concurrent callers that was waiting on
          // this very attempt — hits a clean transport instead of "already
          // started!", and re-throw the real error rather than swallowing
          // it.
          const fresh = this.freshConnection(new URL(this.options.endpoint));
          this.client = fresh.client;
          this.transport = fresh.transport;
          throw error;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    await this.connecting;
  }

  private async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    await this.ensureConnected();
    let result: Awaited<ReturnType<Client['callTool']>>;
    try {
      result = await this.client.callTool({
        name,
        arguments: { ...args, _internalToken: this.options.internalToken },
      });
    } catch (error) {
      // A tool call can fail even after a previously-successful connect —
      // the server restarted, the connection dropped mid-session. Left
      // alone, `connected` would stay true forever and every later call
      // would skip `connect()` entirely and keep retrying the same dead
      // transport, turning "the server is down" into a repeating,
      // unrelated-looking transport error instead of ever giving the next
      // attempt a clean transport to fail (or succeed) honestly on. So this
      // counts as a failed attempt too: the connection is presumed broken,
      // and the next call starts fresh.
      this.connected = false;
      const fresh = this.freshConnection(new URL(this.options.endpoint));
      this.client = fresh.client;
      this.transport = fresh.transport;
      throw error;
    }
    const blocks = Array.isArray(result.content) ? result.content : [];
    const text = blocks
      .filter(
        (block: unknown): block is { type: 'text'; text: string } =>
          isRecord(block) &&
          block.type === 'text' &&
          typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('\n');
    if (result.isError)
      throw new Error(
        `Template MCP tool ${name} failed: ${text.slice(0, 500)}`,
      );
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Template MCP tool ${name} returned invalid JSON`);
    }
  }
}

function parseCandidate(value: unknown): TemplateCandidate {
  if (!isRecord(value)) throw new Error('Template candidate must be an object');
  const stats = isRecord(value.stats) ? value.stats : {};
  const candidate: TemplateCandidate = {
    slug: requireString(value.slug, 'slug'),
    displayName: requireString(value.displayName, 'displayName'),
    description: requireString(value.description, 'description'),
    category: requireString(value.category, 'category'),
    useCase: stringArray(value.useCase),
    fileCount: requireNonNegativeNumber(
      value.fileCount ?? stats.fileCount,
      'fileCount',
    ),
    totalLOC: requireNonNegativeNumber(
      value.totalLOC ?? stats.totalLOC,
      'totalLOC',
    ),
  };
  assertSlug(candidate.slug);
  return candidate;
}

function assertSlug(slug: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new TypeError('Invalid template slug');
}

export function assertSafeScaffoldPath(relativePath: string): void {
  const segments = relativePath.split('/');
  if (
    relativePath.length === 0 ||
    relativePath.length > 300 ||
    relativePath.includes('\\') ||
    relativePath.startsWith('/') ||
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    ) ||
    segments.some(
      (segment) => segment === '.env' || segment.startsWith('.env.'),
    ) ||
    relativePath === '.git' ||
    relativePath.startsWith('.git/') ||
    relativePath === 'node_modules' ||
    relativePath.startsWith('node_modules/')
  ) {
    throw new Error(`Unsafe template scaffold path: ${relativePath}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 2_000
  ) {
    throw new Error(`Invalid template field ${field}`);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid template field ${field}`);
  }
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .slice(0, 100);
}
