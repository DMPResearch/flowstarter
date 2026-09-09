/**
 * A small in-memory stand-in for the service-role Supabase client.
 *
 * The operator project routes all run with the service-role key, which
 * bypasses RLS, so the only thing standing between one tenant's rows and
 * another is the filter the handler writes by hand. This fake keeps the
 * filters honest: `.eq()` / `.in()` really narrow the rows, so a handler that
 * forgets `workspace_id` reads or writes the other workspace's data and the
 * test sees it.
 *
 * Faithful enough for these handlers, and no further:
 *   - select / insert / update / delete, with eq, in, order, limit
 *   - `.select('id', { count: 'exact', head: true })` for the count syncs
 *   - single() / maybeSingle() / await-as-list
 *   - injected failures and injected null-data, per table and per operation
 *
 * Lives under __tests__ so it is not measured as production code.
 */

export type Row = Record<string, unknown>;
export type FakeError = { message: string; code?: string };

/** Seeded rows, keyed by table name. */
export const tables: Record<string, Row[]> = {};

/**
 * Failures to return instead of data, keyed `table:op`
 * (`workspaces:select`, `commerce_products:insert`, ...).
 */
export const failures: Record<string, FakeError | undefined> = {};

/**
 * Keys (`table:op`) whose result should be `{ data: null, error: null }` —
 * the "driver returned nothing and did not say why" case the handlers guard
 * against with `?? []` and `if (!data)`.
 */
export const nullData = new Set<string>();

let idCounter = 0;

export function resetFakeSupabase(): void {
  for (const key of Object.keys(tables)) delete tables[key];
  for (const key of Object.keys(failures)) delete failures[key];
  nullData.clear();
  idCounter = 0;
}

export function seed(table: string, ...rows: Row[]): Row[] {
  tables[table] = tables[table] ?? [];
  tables[table].push(...rows);
  return tables[table];
}

export function rowsOf(table: string): Row[] {
  return tables[table] ?? [];
}

type Op = 'select' | 'insert' | 'update' | 'delete';

class FakeBuilder implements PromiseLike<unknown> {
  private op: Op = 'select';
  private predicates: Array<(row: Row) => boolean> = [];
  private values: Row = {};
  private orderKey: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private wantCount = false;
  private headOnly = false;

  constructor(private readonly table: string) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }) {
    if (options?.count) this.wantCount = true;
    if (options?.head) this.headOnly = true;
    return this;
  }

  insert(values: Row) {
    this.op = 'insert';
    this.values = values;
    return this;
  }

  update(values: Row) {
    this.op = 'update';
    this.values = values;
    return this;
  }

  delete() {
    this.op = 'delete';
    return this;
  }

  eq(column: string, value: unknown) {
    this.predicates.push((row) => row[column] === value);
    return this;
  }

  in(column: string, values: unknown[]) {
    this.predicates.push((row) => values.includes(row[column]));
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderKey = column;
    this.orderAsc = options?.ascending !== false;
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private get key(): string {
    return `${this.table}:${this.op}`;
  }

  private get failure(): FakeError | undefined {
    return failures[this.key];
  }

  private run(): Row[] {
    tables[this.table] = tables[this.table] ?? [];
    const rows = tables[this.table];

    if (this.op === 'insert') {
      const inserted: Row = {
        id: `generated-${++idCounter}`,
        created_at: `2026-09-09T10:00:${String(idCounter).padStart(
          2,
          '0'
        )}.000Z`,
        ...this.values,
      };
      rows.push(inserted);
      return [inserted];
    }

    let matched = rows.filter((row) => this.predicates.every((p) => p(row)));

    if (this.op === 'update') {
      for (const row of matched) Object.assign(row, this.values);
      return matched;
    }

    if (this.op === 'delete') {
      tables[this.table] = rows.filter((row) => !matched.includes(row));
      return matched;
    }

    if (this.orderKey) {
      const key = this.orderKey;
      matched = [...matched].sort((a, b) => {
        const cmp = String(a[key] ?? '').localeCompare(String(b[key] ?? ''));
        return this.orderAsc ? cmp : -cmp;
      });
    }
    return this.limitN === null ? matched : matched.slice(0, this.limitN);
  }

  async maybeSingle() {
    if (this.failure) return { data: null, error: this.failure };
    if (nullData.has(this.key)) return { data: null, error: null };
    return { data: this.run()[0] ?? null, error: null };
  }

  async single() {
    if (this.failure) return { data: null, error: this.failure };
    if (nullData.has(this.key)) return { data: null, error: null };
    const rows = this.run();
    // Matches supabase-js: zero (or many) rows is an error, not an empty body.
    return rows.length === 1
      ? { data: rows[0], error: null }
      : {
          data: null,
          error: {
            code: 'PGRST116',
            message: 'JSON object requested, multiple (or no) rows returned',
          },
        };
  }

  then<T1, T2 = never>(
    onFulfilled?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    if (this.failure) {
      return Promise.resolve({
        data: null,
        error: this.failure,
        count: null,
      }).then(onFulfilled, onRejected);
    }
    if (nullData.has(this.key)) {
      return Promise.resolve({ data: null, error: null, count: null }).then(
        onFulfilled,
        onRejected
      );
    }
    const rows = this.run();
    return Promise.resolve({
      data: this.headOnly ? null : rows,
      error: null,
      count: this.wantCount ? rows.length : null,
    }).then(onFulfilled, onRejected);
  }
}

/** The object the handlers see in place of a real Supabase client. */
export function createFakeSupabase() {
  return { from: (table: string) => new FakeBuilder(table) };
}
