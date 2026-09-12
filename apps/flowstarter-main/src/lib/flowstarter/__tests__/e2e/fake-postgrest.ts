/**
 * A minimal in-memory PostgREST, good enough for the deposit -> build flow.
 *
 * The point of this fixture is that the code under test talks to it through a
 * real `supabase-js` client over real HTTP — the query builder, the header
 * negotiation and the error mapping are all exercised for real. Only the
 * storage engine is fake.
 *
 * It implements exactly the surface the flow uses: `select` with `eq`/`in`
 * filters, `insert` and `update` with `Prefer: return=representation`, the
 * `application/vnd.pgrst.object+json` single-row negotiation, and the unique
 * constraints that make deposit redelivery idempotent.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Row = Record<string, unknown>;

/**
 * Unique indexes from `20260810121819_flowstarter_agent_workflow.sql` that the
 * idempotency of the deposit path depends on.
 */
interface UniqueIndex {
  columns: string[];
  /** Partial-index predicate, e.g. `kind = 'FULL_SITE_BUILD'`. */
  where?: (row: Row) => boolean;
}

const UNIQUE_INDEXES: Record<string, UniqueIndex[]> = {
  flowstarter_agent_jobs: [
    {
      columns: ['workspace_id'],
      where: (row) => row['kind'] === 'FULL_SITE_BUILD',
    },
    {
      columns: ['stripe_event_id'],
      where: (row) => row['stripe_event_id'] != null,
    },
  ],
  workspaces: [
    {
      columns: ['deposit_payment_intent_id'],
      where: (row) => row['deposit_payment_intent_id'] != null,
    },
  ],
  // `20260912163000_stripe_events.sql`: the event id is the primary key, and
  // that primary key is the whole of webhook deduplication. Without it here a
  // redelivery would insert a second row and be processed twice, which is the
  // defect the ledger exists to prevent.
  stripe_events: [{ columns: ['id'] }],
};

/**
 * Column defaults from the migration. Without these an inserted job comes back
 * with `attempt_count: undefined`, and the worker's claim check silently
 * refuses it — a fixture artefact that looks exactly like a product bug.
 */
const COLUMN_DEFAULTS: Record<string, () => Row> = {
  flowstarter_agent_jobs: () => ({
    status: 'queued',
    attempt_count: 0,
    payload: {},
    stripe_event_id: null,
    stripe_payment_intent_id: null,
    worktree_branch: null,
    worktree_path: null,
    pull_request_url: null,
    error_code: null,
    error_detail: null,
    started_at: null,
    finished_at: null,
  }),
  flowstarter_project_artifacts: () => ({
    intake_payload: {},
    scrape_manifest: {},
    preview_manifest: {},
    brand_config: null,
  }),
  workspaces: () => ({
    project_state: 'INTAKE',
    billing_currency: 'eur',
    deposit_percent: 20,
    balance_percent: 80,
  }),
};

export interface FakePostgrest {
  url: string;
  tables: Map<string, Row[]>;
  rows(table: string): Row[];
  find(table: string, match: Row): Row | undefined;
  seed(table: string, rows: Row[]): void;
  close(): Promise<void>;
}

/** `eq.PREVIEW_READY` / `in.("A","B")` -> a predicate over one column. */
function parseFilter(column: string, raw: string): (row: Row) => boolean {
  if (raw.startsWith('eq.')) {
    const expected = raw.slice(3);
    return (row) => {
      const actual = row[column];
      if (actual === null || actual === undefined) return expected === 'null';
      return String(actual) === expected;
    };
  }
  // The Stripe event ledger's ordering lookup excludes the event being
  // processed right now: `neq.evt_...`.
  if (raw.startsWith('neq.')) {
    const expected = raw.slice(4);
    return (row) => {
      const actual = row[column];
      if (actual === null || actual === undefined) return expected !== 'null';
      return String(actual) !== expected;
    };
  }
  if (raw.startsWith('in.')) {
    const inner = raw.slice(3).replace(/^\(/, '').replace(/\)$/, '');
    const values = inner
      .split(',')
      .map((value) => value.trim().replace(/^"|"$/g, ''));
    return (row) => values.includes(String(row[column]));
  }
  if (raw.startsWith('is.')) {
    const expected = raw.slice(3);
    return (row) =>
      expected === 'null'
        ? row[column] == null
        : String(row[column]) === expected;
  }
  throw new Error(`fake-postgrest: unsupported filter ${column}=${raw}`);
}

function matchers(params: URLSearchParams): Array<(row: Row) => boolean> {
  const predicates: Array<(row: Row) => boolean> = [];
  params.forEach((value, key) => {
    if (key === 'select' || key === 'order' || key === 'limit') return;
    predicates.push(parseFilter(key, value));
  });
  return predicates;
}

/** `order=version.desc` + `limit=1`, the only shapes the flow asks for. */
function paginate(rows: Row[], params: URLSearchParams): Row[] {
  let result = rows;
  const order = params.get('order');
  if (order) {
    const [column, ...modifiers] = order.split('.');
    const descending = modifiers.includes('desc');
    result = [...result].sort((a, b) => {
      const left = a[column as string];
      const right = b[column as string];
      if (left === right) return 0;
      const ascending = (left as number) < (right as number) ? -1 : 1;
      return descending ? -ascending : ascending;
    });
  }
  const limit = params.get('limit');
  if (limit) result = result.slice(0, Number(limit));
  return result;
}

function conflictingIndex(
  table: string,
  candidate: Row,
  existing: Row[]
): UniqueIndex | null {
  for (const index of UNIQUE_INDEXES[table] ?? []) {
    if (index.where && !index.where(candidate)) continue;
    const clash = existing.some((row) => {
      if (index.where && !index.where(row)) return false;
      return index.columns.every((column) => row[column] === candidate[column]);
    });
    if (clash) return index;
  }
  return null;
}

export async function startFakePostgrest(): Promise<FakePostgrest> {
  const tables = new Map<string, Row[]>();
  const rowsOf = (table: string): Row[] => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table) as Row[];
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const table = url.pathname.replace(/^\/rest\/v1\//, '');
      const wantsObject = (req.headers.accept ?? '').includes(
        'application/vnd.pgrst.object+json'
      );

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');

      const send = (status: number, payload: unknown) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
        });
        res.end(text);
      };

      /** PostgREST's single-row negotiation, including the PGRST116 miss. */
      const respond = (status: number, matched: Row[]) => {
        if (!wantsObject) return send(status, matched);
        if (matched.length === 1) return send(status, matched[0]);
        return send(406, {
          code: 'PGRST116',
          message:
            matched.length === 0
              ? 'JSON object requested, multiple (or no) rows returned'
              : 'JSON object requested, multiple rows returned',
          details: `Results contain ${matched.length} rows`,
          hint: null,
        });
      };

      const store = rowsOf(table);
      const predicates = matchers(url.searchParams);
      const selected = store.filter((row) => predicates.every((p) => p(row)));

      if (req.method === 'GET') {
        // `order`/`limit` matter to the deploy path: the next deployment
        // version is "the highest one so far, plus one", and without the limit
        // a second deploy asks for a single row, gets two, and PostgREST's
        // object negotiation turns that into "no previous deploy" — resetting
        // the version counter to 1 forever.
        return respond(200, paginate(selected, url.searchParams));
      }

      if (req.method === 'POST') {
        const parsed = JSON.parse(body || '{}') as Row | Row[];
        const inserted: Row[] = [];
        for (const candidate of Array.isArray(parsed) ? parsed : [parsed]) {
          const row: Row = {
            id: crypto.randomUUID(),
            ...(COLUMN_DEFAULTS[table]?.() ?? {}),
            ...candidate,
          };
          const clash = conflictingIndex(table, row, store);
          if (clash) {
            return send(409, {
              code: '23505',
              message: `duplicate key value violates unique constraint on (${clash.columns.join(
                ', '
              )})`,
              details: null,
              hint: null,
            });
          }
          store.push(row);
          inserted.push(row);
        }
        return respond(201, inserted);
      }

      if (req.method === 'PATCH') {
        const patch = JSON.parse(body || '{}') as Row;
        for (const row of selected) Object.assign(row, patch);
        return respond(200, selected);
      }

      return send(405, {
        message: `fake-postgrest: ${req.method} not supported`,
      });
    })().catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          message:
            error instanceof Error ? error.message : 'fake-postgrest error',
        })
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    tables,
    rows: rowsOf,
    find: (table, match) =>
      rowsOf(table).find((row) =>
        Object.entries(match).every(([key, value]) => row[key] === value)
      ),
    seed: (table, seedRows) => rowsOf(table).push(...seedRows),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
