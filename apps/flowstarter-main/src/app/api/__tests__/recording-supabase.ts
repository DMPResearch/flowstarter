/**
 * A service-role stand-in that records every table it is asked for and hands
 * back nothing.
 *
 * The operator routes under `/api/admin/projects/[id]` and
 * `/api/team/projects/[id]` query with the service role, which bypasses RLS,
 * so `requireTeamAuth` running first is the whole boundary. The cases that
 * defend it assert a negative: a caller who is not an operator must not cause
 * a single query to be built. That is only observable if something counts, so
 * this counts.
 *
 * Deliberately dumber than `fake-site-supabase.ts` next to the client routes:
 * nothing here is meant to reach a query at all, so there is no filtering, no
 * constraint and no data to get wrong.
 *
 * Not a `.test.ts` file, so vitest does not collect it as a suite.
 */

export interface RecordingDb {
  /** Every table a handler touched, in order. Asserted to be empty a lot. */
  tables: string[];
  reset(): void;
  client: never;
}

export function createRecordingSupabase(): RecordingDb {
  const tables: string[] = [];

  function builder(table: string) {
    tables.push(table);
    const self: Record<string, unknown> = {};
    const chain = () => self;
    for (const method of [
      'select',
      'insert',
      'update',
      'upsert',
      'delete',
      'eq',
      'in',
      'is',
      'not',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
      'or',
      'order',
      'limit',
      'range',
    ]) {
      self[method] = chain;
    }
    self['maybeSingle'] = async () => ({ data: null, error: null });
    self['single'] = async () => ({ data: null, error: null });
    self['then'] = (
      onFulfilled: (value: { data: null; error: null }) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) =>
      Promise.resolve({ data: null, error: null }).then(
        onFulfilled,
        onRejected
      );
    return self;
  }

  const client = {
    from: builder,
    storage: {
      from: (bucket: string) => {
        tables.push(`storage:${bucket}`);
        return {
          async download() {
            return { data: null, error: { message: 'not found' } };
          },
          async createSignedUrl(path: string) {
            return {
              data: { signedUrl: `https://signed.test/${path}` },
              error: null,
            };
          },
        };
      },
    },
  };

  return {
    tables,
    reset() {
      tables.length = 0;
    },
    client: client as unknown as never,
  };
}
