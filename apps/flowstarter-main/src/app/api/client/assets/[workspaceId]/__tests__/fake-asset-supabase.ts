/**
 * An in-memory stand-in for the service-role client, with the two things the
 * asset routes actually depend on and the shared `fake-supabase` helper does
 * not have: a Storage surface, and the partial unique index on
 * (workspace_id, sha256).
 *
 * The unique index matters because dedupe is the database's job here — the
 * upload path inserts and handles 23505 rather than checking first — so a fake
 * that never raised 23505 would let a broken route pass. Storage matters
 * because the strongest thing the isolation tests assert is a *negative*: a
 * non-member's request must not reach `upload()` at all, which is only
 * observable if the fake counts the calls.
 *
 * Not a `.test.ts` file, so vitest does not collect it as a suite.
 */

export type Row = Record<string, unknown>;

export interface StorageCall {
  bucket: string;
  path: string;
  bytes: number;
  contentType?: string;
}

/**
 * One query that will not go the way the happy path assumes.
 *
 * Postgrest reports a failure two ways and the routes have to survive both: a
 * resolved `{ data: null, error }`, and a rejected promise when the connection
 * itself goes. `throws` picks the second. Each plan fires once, so a test can
 * fail the insert and still watch the read that follows it succeed.
 */
export interface QueryFailure {
  table: string;
  mode?: 'select' | 'insert' | 'update';
  /** Returned as the query's `error`. */
  error?: unknown;
  /** Returned as the query's `data`. Defaults to null. */
  data?: Row[] | null;
  /** Rejected with, instead of returned. */
  throws?: unknown;
  /** Let this many matching queries through first. */
  skip?: number;
}

/** Storage failures, which stay set until `reset()`. */
export interface StorageFailures {
  upload?: unknown;
  sign?: unknown;
  /** `createSignedUrl` rejecting rather than reporting an error. */
  signThrows?: unknown;
}

export interface FakeAssetDb {
  tables: Record<string, Row[]>;
  /** Every upload that reached storage, in order. Asserted to be empty a lot. */
  uploads: StorageCall[];
  /** Every path that was signed for display. */
  signed: Array<{ bucket: string; path: string; ttl: number }>;
  rows(table: string): Row[];
  seed(table: string, rows: Row[]): void;
  /** Arms one failing query. See `QueryFailure`. */
  failQuery(failure: QueryFailure): void;
  /** Arms the storage surface to fail until the next `reset()`. */
  failStorage(failures: StorageFailures): void;
  reset(): void;
  client: unknown;
}

/** Tables with a unique constraint, as `[table, columns]`. */
const UNIQUE: Array<[string, string[]]> = [
  ['assets', ['workspace_id', 'sha256']],
];

export function createFakeAssetSupabase(): FakeAssetDb {
  const tables: Record<string, Row[]> = {};
  const uploads: StorageCall[] = [];
  const signed: Array<{ bucket: string; path: string; ttl: number }> = [];
  const failures: QueryFailure[] = [];
  let storageFailures: StorageFailures = {};
  let sequence = 0;

  /** The armed failure for this query, consumed if there is one. */
  function takeFailure(
    table: string,
    mode: 'select' | 'insert' | 'update'
  ): QueryFailure | undefined {
    const index = failures.findIndex(
      (failure) =>
        failure.table === table && (!failure.mode || failure.mode === mode)
    );
    if (index < 0) return undefined;
    const failure = failures[index] as QueryFailure;
    if (failure.skip && failure.skip > 0) {
      failure.skip -= 1;
      return undefined;
    }
    failures.splice(index, 1);
    return failure;
  }

  const rows = (table: string): Row[] => (tables[table] ??= []);

  function uniqueViolation(table: string, values: Row): boolean {
    const constraint = UNIQUE.find(([name]) => name === table);
    if (!constraint) return false;
    const [, columns] = constraint;
    // Partial index: rows whose sha256 is null never collide.
    if (columns.some((column) => values[column] == null)) return false;
    return rows(table).some((existing) =>
      columns.every((column) => existing[column] === values[column])
    );
  }

  function builder(table: string) {
    let mode: 'select' | 'insert' | 'update' = 'select';
    const filters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    let payload: Row[] = [];
    let orderColumn: string | undefined;
    let ascending = true;
    let limit: number | undefined;

    function matches(row: Row): boolean {
      return (
        filters.every(([column, value]) => row[column] === value) &&
        inFilters.every(([column, values]) => values.includes(row[column]))
      );
    }

    function selected(): Row[] {
      let out = rows(table).filter(matches);
      if (orderColumn) {
        const column = orderColumn;
        out = [...out].sort((a, b) => {
          const left = String(a[column] ?? '');
          const right = String(b[column] ?? '');
          return (
            (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1)
          );
        });
      }
      if (limit !== undefined) out = out.slice(0, limit);
      return out;
    }

    function resolve(): { data: Row[] | null; error: unknown } {
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
            1_700_000_000_000 + sequence * 1_000
          ).toISOString(),
          selected: false,
          rights_confirmed_at: null,
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
      return { data: selected(), error: null };
    }

    const self = {
      select() {
        // After insert/update this is Postgrest's "return the rows", not a
        // new query — the mode must survive it.
        if (mode === 'select') mode = 'select';
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
        filters.push([column, value]);
        return self;
      },
      in(column: string, values: unknown[]) {
        inFilters.push([column, values]);
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
        const { data, error } = resolve();
        return Promise.resolve({ data: data?.[0] ?? null, error });
      },
      single() {
        return self.maybeSingle();
      },
      then(
        onFulfilled: (value: { data: Row[] | null; error: unknown }) => unknown,
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
        async upload(
          path: string,
          bytes: Buffer | Uint8Array,
          options?: { contentType?: string }
        ) {
          if (storageFailures.upload) {
            return { data: null, error: storageFailures.upload };
          }
          uploads.push({
            bucket,
            path,
            bytes: bytes.byteLength,
            ...(options?.contentType
              ? { contentType: options.contentType }
              : {}),
          });
          return { data: { path }, error: null };
        },
        async createSignedUrl(path: string, ttl: number) {
          signed.push({ bucket, path, ttl });
          if (storageFailures.signThrows) throw storageFailures.signThrows;
          if (storageFailures.sign) {
            return { data: null, error: storageFailures.sign };
          }
          return {
            data: {
              signedUrl: `https://storage.test/${bucket}/${path}?token=signed&expires=${ttl}`,
            },
            error: null,
          };
        },
      };
    },
  };

  return {
    tables,
    uploads,
    signed,
    rows,
    seed(table, seedRows) {
      rows(table).push(...seedRows);
    },
    failQuery(failure) {
      failures.push(failure);
    },
    failStorage(next) {
      storageFailures = { ...storageFailures, ...next };
    },
    reset() {
      for (const key of Object.keys(tables)) delete tables[key];
      uploads.length = 0;
      signed.length = 0;
      failures.length = 0;
      storageFailures = {};
      sequence = 0;
    },
    client: { from: builder, storage },
  };
}
