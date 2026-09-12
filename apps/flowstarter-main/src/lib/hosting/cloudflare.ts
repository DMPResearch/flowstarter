/**
 * Cloudflare DNS API client (subset used by the hosting layer).
 *
 * Endpoints:
 *   - listZones    → GET    /zones
 *   - findZone     → GET    /zones?name={name}
 *   - listRecords  → GET    /zones/{zoneId}/dns_records
 *   - createRecord → POST   /zones/{zoneId}/dns_records
 *   - updateRecord → PATCH  /zones/{zoneId}/dns_records/{recordId}
 *   - deleteRecord → DELETE /zones/{zoneId}/dns_records/{recordId}
 *   - upsertRecord → idempotent helper (find by name+type, then create/update)
 *
 * Auth: `Authorization: Bearer <CLOUDFLARE_API_TOKEN>`. Token must have
 * Zone.Zone (read) and Zone.DNS (edit) scopes — NOT a global API key, NOT
 * the R2 access keys.
 *
 * Docs: https://developers.cloudflare.com/api/operations/dns-records-for-a-zone-list-dns-records
 */

const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';

export type CloudflareDnsType =
  | 'A'
  | 'AAAA'
  | 'CNAME'
  | 'TXT'
  | 'MX'
  | 'NS'
  | 'SRV';

export interface CloudflareDnsRecord {
  id: string;
  zone_id: string;
  zone_name: string;
  name: string; // FQDN, e.g. "shop.example.com"
  type: CloudflareDnsType;
  content: string; // IP, hostname, or value depending on type
  ttl: number; // 1 = automatic
  proxied: boolean;
  comment?: string | null;
  tags?: string[];
  created_on: string;
  modified_on: string;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  type: string;
  account: { id: string; name: string };
  name_servers: string[];
}

export interface CloudflareUpsertRecordInput {
  zoneId: string;
  type: CloudflareDnsType;
  name: string; // FQDN
  content: string;
  ttl?: number;
  proxied?: boolean;
  comment?: string;
}

export class CloudflareApiError extends Error {
  constructor(
    public status: number,
    public errors: Array<{ code: number; message: string }>,
    message?: string
  ) {
    super(
      message ??
        `Cloudflare API ${status}: ${errors.map((e) => e.message).join('; ')}`
    );
    this.name = 'CloudflareApiError';
  }
}

/**
 * A record with this name already exists and points somewhere else.
 *
 * Thrown instead of a PATCH. The zone holds live client sites and the
 * platform's own records, and "make this name point at my new box" is exactly
 * the operation that takes one of them down.
 */
export class CloudflareRecordConflictError extends Error {
  constructor(
    public readonly recordName: string,
    public readonly wanted: string,
    public readonly found: string,
    message?: string
  ) {
    super(
      message ??
        `DNS record ${recordName} already exists and points at ${found}, not ${wanted}. ` +
          'Refusing to overwrite it; point it by hand, or free the name first.'
    );
    this.name = 'CloudflareRecordConflictError';
  }
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: T;
  result_info?: { page: number; per_page: number; total_count: number };
}

export interface CloudflareClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class CloudflareClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: CloudflareClientOptions) {
    if (!opts.token) {
      throw new Error('CloudflareClient requires a token');
    }
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  async listZones(params?: { name?: string }): Promise<CloudflareZone[]> {
    const query = new URLSearchParams();
    if (params?.name) query.set('name', params.name);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.request<CloudflareZone[]>('GET', `/zones${suffix}`);
  }

  async findZoneByName(name: string): Promise<CloudflareZone | null> {
    const zones = await this.listZones({ name });
    return zones[0] ?? null;
  }

  async listRecords(
    zoneId: string,
    params?: { name?: string; type?: CloudflareDnsType }
  ): Promise<CloudflareDnsRecord[]> {
    const query = new URLSearchParams();
    if (params?.name) query.set('name', params.name);
    if (params?.type) query.set('type', params.type);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.request<CloudflareDnsRecord[]>(
      'GET',
      `/zones/${zoneId}/dns_records${suffix}`
    );
  }

  async createRecord(
    zoneId: string,
    body: Omit<CloudflareUpsertRecordInput, 'zoneId'>
  ): Promise<CloudflareDnsRecord> {
    return this.request<CloudflareDnsRecord>(
      'POST',
      `/zones/${zoneId}/dns_records`,
      {
        type: body.type,
        name: body.name,
        content: body.content,
        ttl: body.ttl ?? 1,
        proxied: body.proxied ?? false,
        comment: body.comment,
      }
    );
  }

  async updateRecord(
    zoneId: string,
    recordId: string,
    body: Partial<Omit<CloudflareUpsertRecordInput, 'zoneId'>>
  ): Promise<CloudflareDnsRecord> {
    return this.request<CloudflareDnsRecord>(
      'PATCH',
      `/zones/${zoneId}/dns_records/${recordId}`,
      body
    );
  }

  async deleteRecord(
    zoneId: string,
    recordId: string
  ): Promise<{ id: string }> {
    return this.request<{ id: string }>(
      'DELETE',
      `/zones/${zoneId}/dns_records/${recordId}`
    );
  }

  /**
   * Idempotent: if a record with the same (name, type) exists in the zone,
   * patch it to match the input. Otherwise create.
   */
  async upsertRecord(
    input: CloudflareUpsertRecordInput
  ): Promise<CloudflareDnsRecord> {
    const existing = await this.listRecords(input.zoneId, {
      name: input.name,
      type: input.type,
    });
    const match = existing[0];
    if (!match) {
      return this.createRecord(input.zoneId, {
        type: input.type,
        name: input.name,
        content: input.content,
        ttl: input.ttl,
        proxied: input.proxied,
        comment: input.comment,
      });
    }
    if (
      match.content === input.content &&
      match.proxied === (input.proxied ?? false) &&
      match.ttl === (input.ttl ?? 1)
    ) {
      return match;
    }
    return this.updateRecord(input.zoneId, match.id, {
      type: input.type,
      name: input.name,
      content: input.content,
      ttl: input.ttl,
      proxied: input.proxied,
      comment: input.comment,
    });
  }

  /**
   * The same idea as {@link upsertRecord}, minus the half that overwrites.
   *
   * A final site name is a per-site A record in a zone that already serves
   * real traffic: `lebadusul.flowstarter.net` is a client's live site, and the
   * apex, `www` and the mail records belong to the platform. `upsertRecord`
   * would happily point any of them at a freshly provisioned box, and the only
   * warning would be a 200. So the paid deploy uses this instead:
   *
   *   - no record        → create it
   *   - record, same IP  → leave it alone (a redeploy must be idempotent)
   *   - record, other IP → refuse, and say whose it is
   *
   * Wildcards are refused outright. One site, one name; a `*` record would
   * hand every unclaimed subdomain of the platform to one customer's box.
   */
  async claimRecord(
    input: CloudflareUpsertRecordInput
  ): Promise<{ record: CloudflareDnsRecord; created: boolean }> {
    if (input.name.includes('*')) {
      throw new CloudflareRecordConflictError(
        input.name,
        input.content,
        input.content,
        `Refusing to write the wildcard record "${input.name}". A site gets its own name, never a wildcard.`
      );
    }
    const existing = await this.listRecords(input.zoneId, {
      name: input.name,
      type: input.type,
    });
    const match = existing.find(
      (record) => record.name.toLowerCase() === input.name.toLowerCase()
    );
    if (!match) {
      const record = await this.createRecord(input.zoneId, {
        type: input.type,
        name: input.name,
        content: input.content,
        ttl: input.ttl,
        proxied: input.proxied,
        comment: input.comment,
      });
      return { record, created: true };
    }
    if (match.content !== input.content) {
      throw new CloudflareRecordConflictError(
        input.name,
        input.content,
        match.content
      );
    }
    return { record: match, created: false };
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data: CloudflareEnvelope<T> | undefined = undefined;
    if (text.length > 0) {
      try {
        data = JSON.parse(text) as CloudflareEnvelope<T>;
      } catch {
        // non-JSON
      }
    }

    if (!res.ok || !data || data.success === false) {
      throw new CloudflareApiError(
        res.status,
        data?.errors ?? [{ code: 0, message: text || res.statusText }]
      );
    }

    return data.result;
  }
}

export function cloudflareFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CloudflareClient {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw new Error('CLOUDFLARE_API_TOKEN is not set in env');
  }
  return new CloudflareClient({ token });
}
