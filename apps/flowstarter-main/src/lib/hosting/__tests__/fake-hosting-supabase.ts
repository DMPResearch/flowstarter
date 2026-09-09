/**
 * An in-memory stand-in for the service-role client, with Storage.
 *
 * Implements only the surface the hosting modules use: `upsert` with
 * `onConflict`, `select` with `eq`/`is`/`lte`/`neq`/`order`/`limit`, `update`
 * with `eq`, `insert`, and a `storage.from(bucket)` with
 * `upload`/`download`/`remove`/`createSignedUrl`.
 *
 * It is not a database. It exists so the suites can assert on what was
 * written, to which table, and which bytes landed under which object path —
 * the things that would silently break the durable preview record.
 *
 * Not a `.test.ts` file, so vitest does not collect it as a suite.
 */

export type Row = Record<string, unknown>;

export interface FakeStorageObject {
  bytes: Uint8Array;
  contentType?: string;
}

export interface FakeHostingDb {
  tables: Record<string, Row[]>;
  objects: Map<string, FakeStorageObject>;
  /**
   * Tables whose queries resolve as a Postgrest error. Either the whole table
   * (`'workspaces'`) or one operation on it (`'funnel_previews:update'`), which
   * is what the read-then-write helpers need: they load a row and only the
   * write is supposed to fail.
   */
  failing: Set<string>;
  /** True to make every storage call fail. */
  storageBroken: boolean;
  /** Set to false to simulate a client with no Storage wired at all. */
  storageAvailable: boolean;
  rows(table: string): Row[];
  seed(table: string, rows: Row[]): void;
  reset(): void;
  client: unknown;
}

/**
 * Canonical v4-shaped uuids, in sequence. `storage-paths.ts` validates the
 * version and variant nibbles, so `row-1` would not survive contact with the
 * code under test.
 */
let uuidSeq = 0;
function nextUuid(): string {
  uuidSeq += 1;
  const tail = uuidSeq.toString(16).padStart(12, '0');
  return `0f4e1088-8d8f-4f18-83b1-${tail}`;
}

export function createFakeHostingSupabase(): FakeHostingDb {
  const state = {
    tables: {} as Record<string, Row[]>,
    objects: new Map<string, FakeStorageObject>(),
    failing: new Set<string>(),
    storageBroken: false,
    storageAvailable: true,
  };

  const rows = (table: string): Row[] => (state.tables[table] ??= []);

  function builder(table: string) {
    let mode: 'select' | 'insert' | 'update' | 'upsert' = 'select';
    const filters: Array<{ column: string; value: unknown; op: string }> = [];
    let payload: Row[] = [];
    let conflictColumn: string | null = null;
    let orderColumn: string | undefined;
    let ascending = true;
    let take: number | undefined;
    let counting = false;

    function matches(row: Row): boolean {
      return filters.every(({ column, value, op }) => {
        const actual = row[column];
        if (op === 'eq') return actual === value;
        if (op === 'is') return actual === value;
        if (op === 'neq') return actual !== value;
        if (op === 'lte') return String(actual) <= String(value);
        if (op === 'gte') return String(actual) >= String(value);
        return true;
      });
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
      if (take !== undefined) out = out.slice(0, take);
      return out;
    }

    function settle(): {
      data: Row[] | null;
      error: unknown;
      count?: number | null;
    } {
      if (state.failing.has(table) || state.failing.has(`${table}:${mode}`)) {
        return {
          data: null,
          error: { message: `fake: ${table} unavailable` },
          ...(counting ? { count: null } : {}),
        };
      }
      if (mode === 'insert') {
        // The database mints ids; code under test reads them back off the
        // insert (`.select('id').maybeSingle()`), so the fake has to too.
        const inserted = payload.map((values) => ({
          ...(values.id === undefined ? { id: nextUuid() } : {}),
          ...values,
        }));
        rows(table).push(...inserted);
        return { data: inserted, error: null };
      }
      if (mode === 'upsert') {
        const key = conflictColumn ?? 'id';
        for (const values of payload) {
          const index = rows(table).findIndex(
            (row) => row[key] === values[key]
          );
          if (index >= 0) {
            rows(table)[index] = { ...rows(table)[index], ...values };
          } else {
            rows(table).push({ ...values });
          }
        }
        return { data: payload, error: null };
      }
      if (mode === 'update') {
        const target = rows(table).filter(matches);
        for (const row of target) Object.assign(row, payload[0]);
        return { data: target, error: null };
      }
      const out = selected();
      return {
        data: out,
        error: null,
        ...(counting ? { count: out.length } : {}),
      };
    }

    const self = {
      select(
        _columns?: string,
        options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }
      ) {
        // `select('id', { count: 'exact', head: true })` is how the allocator
        // re-derives a server's site count, and it reads `count` off the
        // result rather than `data` — so the fake has to answer with one.
        if (options?.count) counting = true;
        return self;
      },
      insert(values: Row | Row[]) {
        mode = 'insert';
        payload = Array.isArray(values) ? values : [values];
        return self;
      },
      upsert(values: Row | Row[], options?: { onConflict?: string }) {
        mode = 'upsert';
        conflictColumn = options?.onConflict ?? null;
        payload = Array.isArray(values) ? values : [values];
        return self;
      },
      update(values: Row) {
        mode = 'update';
        payload = [values];
        return self;
      },
      eq(column: string, value: unknown) {
        filters.push({ column, value, op: 'eq' });
        return self;
      },
      is(column: string, value: unknown) {
        filters.push({ column, value, op: 'is' });
        return self;
      },
      neq(column: string, value: unknown) {
        filters.push({ column, value, op: 'neq' });
        return self;
      },
      lte(column: string, value: unknown) {
        filters.push({ column, value, op: 'lte' });
        return self;
      },
      order(column: string, options?: { ascending?: boolean }) {
        orderColumn = column;
        ascending = options?.ascending !== false;
        return self;
      },
      limit(count: number) {
        take = count;
        return self;
      },
      maybeSingle() {
        const { data, error, count } = settle();
        return Promise.resolve({
          data: data?.[0] ?? null,
          error,
          ...(counting ? { count } : {}),
        });
      },
      single() {
        return self.maybeSingle();
      },
      then<T>(
        onFulfilled: (value: {
          data: Row[] | null;
          error: unknown;
          count?: number | null;
        }) => T,
        onRejected?: (reason: unknown) => T
      ) {
        return Promise.resolve(settle()).then(onFulfilled, onRejected);
      },
    };
    return self;
  }

  const storageApi = {
    from() {
      return {
        async upload(
          path: string,
          body: Uint8Array | ArrayBuffer | Buffer,
          options?: { contentType?: string }
        ) {
          if (state.storageBroken) {
            return { error: { message: 'fake: storage unavailable' } };
          }
          const bytes =
            body instanceof Uint8Array
              ? new Uint8Array(body)
              : new Uint8Array(body as ArrayBuffer);
          state.objects.set(path, {
            bytes,
            ...(options?.contentType
              ? { contentType: options.contentType }
              : {}),
          });
          return { error: null };
        },
        async download(path: string) {
          if (state.storageBroken) {
            return { data: null, error: { message: 'fake: storage broken' } };
          }
          const object = state.objects.get(path);
          if (!object) {
            return { data: null, error: { message: 'fake: not found' } };
          }
          return {
            data: {
              arrayBuffer: async () => {
                const copy = new ArrayBuffer(object.bytes.byteLength);
                new Uint8Array(copy).set(object.bytes);
                return copy;
              },
            } as unknown as Blob,
            error: null,
          };
        },
        async remove(paths: string[]) {
          if (state.storageBroken) {
            return { error: { message: 'fake: storage broken' } };
          }
          for (const path of paths) state.objects.delete(path);
          return { error: null };
        },
        async createSignedUrl(path: string, expiresIn: number) {
          if (state.storageBroken || !state.objects.has(path)) {
            return { data: null, error: { message: 'fake: cannot sign' } };
          }
          return {
            data: {
              signedUrl: `https://storage.test/${path}?token=fake&exp=${expiresIn}`,
            },
            error: null,
          };
        },
      };
    },
  };

  const client = {
    from: builder,
    get storage() {
      return state.storageAvailable ? storageApi : undefined;
    },
  };

  return {
    get tables() {
      return state.tables;
    },
    get objects() {
      return state.objects;
    },
    get failing() {
      return state.failing;
    },
    get storageBroken() {
      return state.storageBroken;
    },
    set storageBroken(value: boolean) {
      state.storageBroken = value;
    },
    get storageAvailable() {
      return state.storageAvailable;
    },
    set storageAvailable(value: boolean) {
      state.storageAvailable = value;
    },
    rows,
    seed(table: string, seedRows: Row[]) {
      state.tables[table] = seedRows.map((row) => ({ ...row }));
    },
    reset() {
      state.tables = {};
      state.objects.clear();
      state.failing.clear();
      state.storageBroken = false;
      state.storageAvailable = true;
    },
    client,
  } as FakeHostingDb;
}
