/**
 * A tiny in-memory stand-in for the service-role Supabase client, shared by
 * the messaging unit tests and the messaging route tests.
 *
 * It implements only the builder surface `lib/flowstarter/messaging.ts` uses —
 * `select`/`insert`/`update` with `eq`, `order`, `limit`, `maybeSingle`, and an
 * awaitable builder — plus per-table error injection, which is how the
 * "email failed but the message survived" and "events are best effort" cases
 * are exercised. It is not a database: it exists so the tests assert on what
 * was written, in which order, and to which table.
 *
 * Not a `.test.ts` file, so vitest does not collect it as a suite.
 */

export type Row = Record<string, unknown>;

export interface FakeDb {
  tables: Record<string, Row[]>;
  /** Tables whose next query resolves as a Postgrest error. */
  failing: Set<string>;
  rows(table: string): Row[];
  seed(table: string, rows: Row[]): void;
  reset(): void;
  client: { from(table: string): unknown };
}

export function createFakeSupabase(): FakeDb {
  const tables: Record<string, Row[]> = {};
  const failing = new Set<string>();
  let sequence = 0;

  const rows = (table: string): Row[] => (tables[table] ??= []);

  function builder(table: string) {
    let mode: 'select' | 'insert' | 'update' = 'select';
    const filters: Array<[string, unknown]> = [];
    let payload: Row[] = [];
    let orderColumn: string | undefined;
    let ascending = true;
    let limit: number | undefined;

    function selected(): Row[] {
      let out = rows(table).filter((row) =>
        filters.every(([column, value]) => {
          if (column.endsWith('__notnull')) {
            const real = column.slice(0, -'__notnull'.length);
            return row[real] !== null && row[real] !== undefined;
          }
          return Array.isArray(value)
            ? value.includes(row[column])
            : row[column] === value;
        })
      );
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

    /**
     * Postgrest hands back fresh JSON on every read, so a row a caller is
     * holding never changes under it when somebody else writes. Copying here
     * keeps that true, which is what makes a stale-row test mean anything.
     */
    const detach = (out: Row[]): Row[] => out.map((row) => ({ ...row }));

    function resolve(): { data: Row[] | null; error: unknown } {
      if (failing.has(table)) {
        return { data: null, error: { message: `fake: ${table} unavailable` } };
      }
      if (mode === 'insert') {
        sequence += 1;
        const inserted = payload.map((values, index) => ({
          id: `row-${sequence}-${index}`,
          // Monotonic, so `order('created_at')` is meaningful without sleeping.
          created_at: new Date(
            1_700_000_000_000 + sequence * 1_000
          ).toISOString(),
          ...values,
        }));
        rows(table).push(...inserted);
        return { data: detach(inserted), error: null };
      }
      if (mode === 'update') {
        const target = selected();
        for (const row of target) Object.assign(row, payload[0]);
        return { data: detach(target), error: null };
      }
      return { data: detach(selected()), error: null };
    }

    const self = {
      select() {
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
      /** `in('status', [...])`: the same filter list, matched by membership. */
      in(column: string, values: unknown[]) {
        filters.push([column, values]);
        return self;
      },
      not(column: string, operator: string, value: unknown) {
        // Only `not(column, 'is', null)` is used, and it means "has a value".
        if (operator === 'is' && value === null) {
          filters.push([`${column}__notnull`, true]);
        }
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

  return {
    tables,
    failing,
    rows,
    seed(table, seedRows) {
      rows(table).push(...seedRows);
    },
    reset() {
      for (const key of Object.keys(tables)) delete tables[key];
      failing.clear();
      sequence = 0;
    },
    client: { from: builder },
  };
}
