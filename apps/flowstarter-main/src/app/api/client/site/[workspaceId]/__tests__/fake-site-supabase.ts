/**
 * An in-memory stand-in for the service-role client, with the three things the
 * client-site routes actually depend on and a plain object literal does not
 * have: `(workspace_id, version)` uniqueness on `site_versions`, `head`+`count`
 * selects (which is how the daily cap counts), and a Storage surface.
 *
 * The uniqueness matters because `saveSiteVersion` allocates a version number
 * by reading the maximum and inserting under the constraint — a fake that
 * never raised 23505 would let a version allocator that silently overwrites
 * pass. The query log matters because the strongest thing the isolation cases
 * assert is a *negative*: a non-member's request must not read a single row of
 * the workspace's data, which is only observable if something counted.
 *
 * Not a `.test.ts` file, so vitest does not collect it as a suite.
 */

export type Row = Record<string, unknown>;

export interface QueryRecord {
  table: string;
  mode: 'select' | 'insert' | 'update' | 'delete';
}

/**
 * One query that will not go the way the happy path assumes.
 *
 * Postgrest reports a failure two ways and the handlers have to survive both:
 * a resolved `{ data: null, error }`, and a rejected promise when the
 * connection itself goes. `throws` picks the second. Each plan fires once, so
 * a test can fail one write and still watch the read after it succeed.
 */
export interface QueryFailure {
  table: string;
  mode?: QueryRecord['mode'];
  /** Returned as the query's `error`. */
  error?: unknown;
  /** Returned as the query's `data`. Defaults to null. */
  data?: Row[] | null;
  /** Rejected with, instead of returned. */
  throws?: unknown;
}

export interface FakeSiteDb {
  tables: Record<string, Row[]>;
  /** Every query that was resolved, in order. Asserted to be short a lot. */
  queries: QueryRecord[];
  /** Every object downloaded from storage. */
  downloads: string[];
  objects: Map<string, Buffer>;
  rows(table: string): Row[];
  seed(table: string, rows: Row[]): void;
  /** Arms one failing query. See `QueryFailure`. */
  failQuery(failure: QueryFailure): void;
  reset(): void;
  client: never;
}

/** Tables with a unique constraint, as `[table, columns]`. */
const UNIQUE: Array<[string, string[]]> = [
  ['site_versions', ['workspace_id', 'version']],
];

function compare(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number')
    return left - right;
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createFakeSiteSupabase(): FakeSiteDb {
  const tables: Record<string, Row[]> = {};
  const queries: QueryRecord[] = [];
  const downloads: string[] = [];
  const objects = new Map<string, Buffer>();
  const failures: QueryFailure[] = [];
  let sequence = 0;

  /** The armed failure for this query, consumed if there is one. */
  function takeFailure(
    table: string,
    mode: QueryRecord['mode']
  ): QueryFailure | undefined {
    const index = failures.findIndex(
      (failure) =>
        failure.table === table && (!failure.mode || failure.mode === mode)
    );
    if (index < 0) return undefined;
    return failures.splice(index, 1)[0];
  }

  const rows = (table: string): Row[] => (tables[table] ??= []);

  function uniqueViolation(table: string, values: Row): boolean {
    const constraint = UNIQUE.find(([name]) => name === table);
    if (!constraint) return false;
    const [, columns] = constraint;
    return rows(table).some((existing) =>
      columns.every((column) => existing[column] === values[column])
    );
  }

  function builder(table: string) {
    let mode: QueryRecord['mode'] = 'select';
    const eqFilters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    const gteFilters: Array<[string, string]> = [];
    const notNull: string[] = [];
    let payload: Row[] = [];
    let orderColumn: string | undefined;
    let ascending = true;
    let limit: number | undefined;
    let headOnly = false;
    let wantCount = false;

    function matches(row: Row): boolean {
      return (
        eqFilters.every(([column, value]) => row[column] === value) &&
        inFilters.every(([column, values]) => values.includes(row[column])) &&
        gteFilters.every(
          ([column, value]) => String(row[column] ?? '') >= value
        ) &&
        notNull.every((column) => row[column] != null)
      );
    }

    function selected(): Row[] {
      let out = rows(table).filter(matches);
      if (orderColumn) {
        const column = orderColumn;
        out = [...out].sort(
          (a, b) => compare(a[column], b[column]) * (ascending ? 1 : -1)
        );
      }
      if (limit !== undefined) out = out.slice(0, limit);
      return out;
    }

    function resolve(): { data: Row[] | null; error: unknown; count?: number } {
      queries.push({ table, mode });
      const failure = takeFailure(table, mode);
      if (failure) {
        if ('throws' in failure) throw failure.throws;
        return { data: failure.data ?? null, error: failure.error ?? null };
      }
      if (mode === 'insert') {
        for (const values of payload) {
          if (uniqueViolation(table, values)) {
            return {
              data: null,
              error: {
                code: '23505',
                message: `duplicate key value violates unique constraint on ${table}`,
              },
            };
          }
        }
        sequence += 1;
        const inserted = payload.map((values, index) => ({
          id: `${table}-${sequence}-${index}`,
          created_at: new Date(
            1_800_000_000_000 + sequence * 1_000
          ).toISOString(),
          published_at: null,
          summary: null,
          ...values,
        }));
        rows(table).push(...inserted);
        return { data: inserted, error: null };
      }
      if (mode === 'update') {
        const target = rows(table).filter(matches);
        for (const row of target) Object.assign(row, payload[0]);
        return { data: target, error: null };
      }
      const out = selected();
      return {
        data: headOnly ? null : out,
        error: null,
        ...(wantCount ? { count: out.length } : {}),
      };
    }

    const self = {
      select(_columns?: string, options?: { count?: string; head?: boolean }) {
        if (options?.head) headOnly = true;
        if (options?.count) wantCount = true;
        return self;
      },
      insert(values: Row | Row[]) {
        mode = 'insert';
        payload = Array.isArray(values) ? values : [values];
        return self;
      },
      update(values: Row) {
        mode = 'update';
        payload = [values];
        return self;
      },
      eq(column: string, value: unknown) {
        eqFilters.push([column, value]);
        return self;
      },
      in(column: string, values: unknown[]) {
        inFilters.push([column, values]);
        return self;
      },
      gte(column: string, value: string) {
        gteFilters.push([column, value]);
        return self;
      },
      not(column: string, _operator: string, _value: unknown) {
        notNull.push(column);
        return self;
      },
      order(column: string, options?: { ascending?: boolean }) {
        orderColumn = column;
        ascending = options?.ascending !== false;
        return self;
      },
      limit(count: number) {
        limit = count;
        return self;
      },
      maybeSingle() {
        const result = resolve();
        return Promise.resolve({
          data: result.data?.[0] ?? null,
          error: result.error,
        });
      },
      single() {
        return self.maybeSingle();
      },
      then(
        onFulfilled: (value: {
          data: Row[] | null;
          error: unknown;
          count?: number;
        }) => unknown,
        onRejected?: (reason: unknown) => unknown
      ) {
        return Promise.resolve(resolve()).then(onFulfilled, onRejected);
      },
    };
    return self;
  }

  const storage = {
    from(bucket: string) {
      return {
        async download(path: string) {
          downloads.push(`${bucket}/${path}`);
          const bytes = objects.get(path);
          if (!bytes) {
            return { data: null, error: { message: 'not found' } };
          }
          return {
            data: {
              arrayBuffer: async () =>
                bytes.buffer.slice(
                  bytes.byteOffset,
                  bytes.byteOffset + bytes.byteLength
                ),
            },
            error: null,
          };
        },
        async createSignedUrl(path: string, ttl: number) {
          return {
            data: { signedUrl: `https://signed.test/${path}?ttl=${ttl}` },
            error: null,
          };
        },
      };
    },
  };

  const client = { from: builder, storage };

  return {
    tables,
    queries,
    downloads,
    objects,
    rows,
    seed(table: string, seeded: Row[]) {
      rows(table).push(...seeded.map((row) => ({ ...row })));
    },
    failQuery(failure: QueryFailure) {
      failures.push(failure);
    },
    reset() {
      for (const key of Object.keys(tables)) delete tables[key];
      queries.length = 0;
      downloads.length = 0;
      failures.length = 0;
      objects.clear();
      sequence = 0;
    },
    client: client as unknown as never,
  };
}
