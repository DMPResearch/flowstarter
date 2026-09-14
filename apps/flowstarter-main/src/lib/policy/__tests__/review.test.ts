// @vitest-environment node
/**
 * The review queue's own contract, against a hand-rolled Postgrest double.
 *
 * Four properties this file exists to hold:
 *
 *   1. The gate can always refuse. `recordPolicyOutcome` never throws, so a
 *      database that is down cannot turn a refusal into an exception the route
 *      catches and shrugs at.
 *   2. The hold read fails CLOSED. `hasOpenPolicyReview` answers "yes, held"
 *      when it cannot answer at all, because the alternative is that a blip in
 *      the ledger is how a parked workspace gets built anyway.
 *   3. The submission is never written down. Not in the row, not in the event
 *      payload. The hash is the identifier.
 *   4. Two operators cannot both believe they resolved the same review.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => {
    throw new Error('supabaseUrl is required.');
  },
}));

import { categoryById, type PolicyVerdict } from '../acceptable-use';
import {
  POLICY_EVENT_KINDS,
  PolicyReviewError,
  hasOpenPolicyReview,
  listPolicyReviews,
  recordPolicyOutcome,
  resolvePolicyReview,
  type PolicyReviewClient,
} from '../review';

const WORKSPACE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const SECRET = 'we sell cocaine, MDMA and heroin, discreet shipping';

type Row = Record<string, unknown>;

interface Fake {
  client: PolicyReviewClient;
  rows: Record<string, Row[]>;
  /** Set to make the next matching operation answer with an error. */
  failOn: Set<string>;
  /** Set to make the client throw rather than answer. */
  throwOn: Set<string>;
}

/**
 * The narrowest thing that satisfies `PolicyReviewClient`.
 *
 * Hand-rolled rather than borrowed: this module talks to a table that is not
 * in the generated types and narrows its client structurally, so the double
 * has to match that narrow shape exactly. A richer fake would prove the fake
 * works and not that the module does.
 */
function makeFake(): Fake {
  const rows: Record<string, Row[]> = {
    policy_reviews: [],
    project_events: [],
  };
  const failOn = new Set<string>();
  const throwOn = new Set<string>();

  const client = {
    from(table: string) {
      const guard = (op: string) => {
        if (throwOn.has(`${table}.${op}`)) throw new Error('connection lost');
        return failOn.has(`${table}.${op}`) ? { code: 'PGRST000' } : null;
      };

      return {
        insert(values: Row) {
          const error = guard('insert');
          const id = `row-${(rows[table]?.length ?? 0) + 1}`;
          if (!error) (rows[table] ??= []).push({ id, ...values });
          const result = { data: null, error };
          return {
            select() {
              return {
                maybeSingle: async () => ({
                  data: error ? null : { id },
                  error,
                }),
              };
            },
            then<R>(onfulfilled: (value: typeof result) => R) {
              return Promise.resolve(onfulfilled(result));
            },
          };
        },

        select(_columns: string) {
          const error = guard('select');
          let matched = [...(rows[table] ?? [])];
          const builder = {
            eq(column: string, value: unknown) {
              matched = matched.filter((row) => row[column] === value);
              return builder;
            },
            order() {
              return builder;
            },
            limit(count: number) {
              matched = matched.slice(0, count);
              return builder;
            },
            maybeSingle: async () => ({
              data: error ? null : matched[0] ?? null,
              error,
            }),
            then<R>(
              onfulfilled: (value: {
                data: Row[] | null;
                error: { code?: string } | null;
              }) => R
            ) {
              return Promise.resolve(
                onfulfilled({ data: error ? null : matched, error })
              );
            },
          };
          return builder;
        },

        update(values: Row) {
          const error = guard('update');
          let matched = [...(rows[table] ?? [])];
          const builder = {
            eq(column: string, value: unknown) {
              matched = matched.filter((row) => row[column] === value);
              return builder;
            },
            select() {
              return {
                maybeSingle: async () => {
                  if (error) return { data: null, error };
                  const target = matched[0];
                  if (!target) return { data: null, error: null };
                  Object.assign(target, values);
                  return { data: { ...target }, error: null };
                },
              };
            },
          };
          return builder;
        },
      };
    },
  } as unknown as PolicyReviewClient;

  return { client, rows, failOn, throwOn };
}

function verdict(over: Partial<PolicyVerdict> = {}): PolicyVerdict {
  return {
    decision: 'review',
    category: categoryById('illegal_drugs')!,
    confidence: 0.62,
    rule: 'prohibited_uncertain',
    tier: 'llm',
    needsHuman: true,
    ...over,
  };
}

const classification = {
  evidence: 'The offer line names a controlled substance and a price.',
  evidenceHash: 'a1b2c3d4e5f60718',
  promptVersion: '2026-09-14.1',
};

let fake: Fake;

beforeEach(() => {
  fake = makeFake();
  // Restored first: `vi.spyOn` on an already-spied console returns the SAME
  // spy, and its call history would otherwise leak from one test into the
  // next, which is how a "nothing was logged" assertion passes or fails on
  // the previous test's behaviour.
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('recording an outcome', () => {
  it('writes nothing at all when the verdict allows', async () => {
    const result = await recordPolicyOutcome({
      surface: 'preview',
      verdict: verdict({ decision: 'allow' }),
      classification,
      workspaceId: WORKSPACE,
      db: fake.client,
    });
    expect(result).toEqual({ reviewId: null, recorded: false });
    expect(fake.rows.policy_reviews).toHaveLength(0);
    expect(fake.rows.project_events).toHaveLength(0);
  });

  it('opens a hold, with the category, the rule and the hash', async () => {
    const result = await recordPolicyOutcome({
      surface: 'brief',
      verdict: verdict(),
      classification,
      workspaceId: WORKSPACE,
      actor: 'user_client_a',
      db: fake.client,
    });

    expect(result.recorded).toBe(true);
    const row = fake.rows.policy_reviews[0];
    expect(row).toMatchObject({
      workspace_id: WORKSPACE,
      surface: 'brief',
      decision: 'review',
      category_id: 'illegal_drugs',
      rule: 'prohibited_uncertain',
      tier: 'llm',
      status: 'open',
      evidence_hash: 'a1b2c3d4e5f60718',
      prompt_version: '2026-09-14.1',
    });
    // An open row is the hold. A resolved one would not be.
    expect(row.resolved_at).toBeNull();
  });

  it('closes a refusal immediately, because no person has to decide it', async () => {
    await recordPolicyOutcome({
      surface: 'preview',
      verdict: verdict({ decision: 'refuse', confidence: 0.96 }),
      classification,
      db: fake.client,
    });
    const row = fake.rows.policy_reviews[0];
    expect(row.status).toBe('refused');
    expect(row.resolved_by).toBe('system');
    expect(row.resolved_at).toEqual(expect.any(String));
  });

  it('puts the hold on the timeline, and never the submission', async () => {
    await recordPolicyOutcome({
      surface: 'brief',
      verdict: verdict(),
      classification: { ...classification, evidence: SECRET },
      workspaceId: WORKSPACE,
      db: fake.client,
    });
    const event = fake.rows.project_events[0];
    expect(event.kind).toBe(POLICY_EVENT_KINDS.held);
    const payload = event.payload as Record<string, unknown>;
    expect(payload.categoryLabel).toBe(
      'Illegal drugs and controlled substances'
    );
    expect(payload.evidenceHash).toBe('a1b2c3d4e5f60718');
    // The classifier's own sentence is operator-facing and goes on the card.
    // The visitor's words never appear, here or anywhere.
    expect(payload.evidence).toBe(SECRET);
  });

  it('names the refusal differently on the timeline', async () => {
    await recordPolicyOutcome({
      surface: 'claim',
      verdict: verdict({ decision: 'refuse' }),
      classification,
      workspaceId: WORKSPACE,
      db: fake.client,
    });
    expect(fake.rows.project_events[0].kind).toBe(POLICY_EVENT_KINDS.refused);
  });

  it('writes no event when there is no workspace to write it against', async () => {
    // The quick intake and the guest checkout are both anonymous. The row is
    // still written; there is simply no timeline yet to put it on.
    await recordPolicyOutcome({
      surface: 'preview',
      verdict: verdict({ decision: 'refuse' }),
      classification,
      db: fake.client,
    });
    expect(fake.rows.policy_reviews).toHaveLength(1);
    expect(fake.rows.project_events).toHaveLength(0);
  });

  it('logs the category and the hash, never the text', async () => {
    const warn = vi.mocked(console.warn);
    await recordPolicyOutcome({
      surface: 'preview',
      verdict: verdict({ decision: 'refuse' }),
      classification: { ...classification, evidence: SECRET },
      db: fake.client,
    });
    const line = warn.mock.calls.map((call) => String(call[0])).join(' ');
    expect(line).toContain('illegal_drugs');
    expect(line).toContain('a1b2c3d4e5f60718');
    expect(line).not.toContain(SECRET);
  });

  it('still reports the hold when the row cannot be written', async () => {
    // The verdict is what stops the flow. A gate that could not refuse because
    // its audit table was down would be a database blip with the authority to
    // open the door.
    fake.failOn.add('policy_reviews.insert');
    const result = await recordPolicyOutcome({
      surface: 'brief',
      verdict: verdict(),
      classification,
      workspaceId: WORKSPACE,
      db: fake.client,
    });
    expect(result.recorded).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  it('does not throw when the service-role client cannot even be built', async () => {
    // The regression this pins. `policyDb()` used to be called OUTSIDE the
    // try, so an environment where `createSupabaseServiceRoleClient` throws
    // (a missing SUPABASE_URL is the obvious one) turned every held verdict
    // into a 500 at the route instead of a hold. A fail-closed gate that
    // cannot refuse while its ledger is down is not fail-closed at all.
    //
    // No `db` passed, so the function builds its own, and this suite's mock of
    // `@/supabase-clients/server` makes that throw.
    await expect(
      recordPolicyOutcome({
        surface: 'preview',
        verdict: verdict({ decision: 'refuse' }),
        classification,
        workspaceId: WORKSPACE,
      })
    ).resolves.toEqual({ reviewId: null, recorded: false });
  });

  it('does not throw when the client itself throws', async () => {
    fake.throwOn.add('policy_reviews.insert');
    await expect(
      recordPolicyOutcome({
        surface: 'brief',
        verdict: verdict(),
        classification,
        workspaceId: WORKSPACE,
        db: fake.client,
      })
    ).resolves.toMatchObject({ recorded: false });
  });

  it('treats a duplicate open row as the index doing its job', async () => {
    // The partial unique index exists so a client hammering save gets one
    // review rather than forty. Hitting it is not an error worth logging.
    const client = {
      from: () => ({
        insert: () => ({
          select: () => ({
            maybeSingle: async () => ({ data: null, error: { code: '23505' } }),
          }),
          then: (onfulfilled: (v: unknown) => unknown) =>
            Promise.resolve(onfulfilled({ data: null, error: null })),
        }),
      }),
    } as unknown as PolicyReviewClient;

    const result = await recordPolicyOutcome({
      surface: 'brief',
      verdict: verdict(),
      classification,
      db: client,
    });
    expect(result.recorded).toBe(false);
    expect(console.error).not.toHaveBeenCalledWith(
      '[policy] could not write the review row',
      expect.anything()
    );
  });
});

describe('reading the queue', () => {
  beforeEach(async () => {
    await recordPolicyOutcome({
      surface: 'brief',
      verdict: verdict(),
      classification,
      workspaceId: WORKSPACE,
      db: fake.client,
    });
  });

  it('returns the rows for this workspace, mapped out of snake case', async () => {
    const rows = await listPolicyReviews(WORKSPACE, fake.client);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: WORKSPACE,
      surface: 'brief',
      categoryId: 'illegal_drugs',
      evidenceHash: 'a1b2c3d4e5f60718',
      status: 'open',
    });
  });

  it('returns nothing rather than throwing when the read fails', async () => {
    fake.failOn.add('policy_reviews.select');
    await expect(listPolicyReviews(WORKSPACE, fake.client)).resolves.toEqual(
      []
    );
  });

  it('sees the open hold', async () => {
    await expect(hasOpenPolicyReview(WORKSPACE, fake.client)).resolves.toBe(
      true
    );
  });

  it('sees no hold on a workspace that has none', async () => {
    await expect(
      hasOpenPolicyReview('11111111-1111-4111-8111-111111111111', fake.client)
    ).resolves.toBe(false);
  });

  it('fails CLOSED when it cannot tell', async () => {
    // The whole point. A read error must read as "held", or an outage becomes
    // the way a parked workspace gets built.
    fake.failOn.add('policy_reviews.select');
    await expect(hasOpenPolicyReview(WORKSPACE, fake.client)).resolves.toBe(
      true
    );
  });

  it('fails closed when the client throws too', async () => {
    fake.throwOn.add('policy_reviews.select');
    await expect(hasOpenPolicyReview(WORKSPACE, fake.client)).resolves.toBe(
      true
    );
  });
});

describe('resolving one', () => {
  beforeEach(async () => {
    await recordPolicyOutcome({
      surface: 'brief',
      verdict: verdict(),
      classification,
      workspaceId: WORKSPACE,
      db: fake.client,
    });
  });

  it('approves, records who and why, and puts it on the timeline', async () => {
    const row = await resolvePolicyReview({
      reviewId: 'row-1',
      workspaceId: WORKSPACE,
      status: 'approved',
      actor: 'user_operator',
      note: 'Called the pharmacy, licence RO-1234 checks out.',
      db: fake.client,
    });

    expect(row.status).toBe('approved');
    expect(row.resolvedBy).toBe('user_operator');
    expect(row.resolutionNote).toContain('RO-1234');
    const event = fake.rows.project_events.at(-1)!;
    expect(event.kind).toBe(POLICY_EVENT_KINDS.approved);
    expect(event.actor).toBe('user_operator');
  });

  it('refuses, with its own event kind', async () => {
    const row = await resolvePolicyReview({
      reviewId: 'row-1',
      workspaceId: WORKSPACE,
      status: 'refused',
      actor: 'user_operator',
      db: fake.client,
    });
    expect(row.status).toBe('refused');
    expect(row.resolutionNote).toBeNull();
    expect(fake.rows.project_events.at(-1)!.kind).toBe(
      POLICY_EVENT_KINDS.rejected
    );
  });

  it('refuses to resolve a review that is not open any more', async () => {
    await resolvePolicyReview({
      reviewId: 'row-1',
      workspaceId: WORKSPACE,
      status: 'approved',
      actor: 'user_operator',
      note: 'Checked the licence.',
      db: fake.client,
    });

    // Compare-and-set on `status = open`. Two operators clicking at once must
    // not both believe they were the one who decided it.
    await expect(
      resolvePolicyReview({
        reviewId: 'row-1',
        workspaceId: WORKSPACE,
        status: 'refused',
        actor: 'user_other_operator',
        db: fake.client,
      })
    ).rejects.toMatchObject({
      name: 'PolicyReviewError',
      code: 'POLICY_REVIEW_STALE',
      status: 409,
    });
  });

  it('will not resolve a review that belongs to another workspace', async () => {
    await expect(
      resolvePolicyReview({
        reviewId: 'row-1',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        status: 'approved',
        actor: 'user_operator',
        note: 'Checked the licence.',
        db: fake.client,
      })
    ).rejects.toBeInstanceOf(PolicyReviewError);
  });

  it('reports a write failure as a 500, not as a stale review', async () => {
    fake.failOn.add('policy_reviews.update');
    await expect(
      resolvePolicyReview({
        reviewId: 'row-1',
        workspaceId: WORKSPACE,
        status: 'approved',
        actor: 'user_operator',
        note: 'Checked the licence.',
        db: fake.client,
      })
    ).rejects.toMatchObject({ code: 'DB_ERROR', status: 500 });
  });

  it('does not fail the operator when the timeline write fails', async () => {
    fake.failOn.add('project_events.insert');
    await expect(
      resolvePolicyReview({
        reviewId: 'row-1',
        workspaceId: WORKSPACE,
        status: 'approved',
        actor: 'user_operator',
        note: 'Checked the licence.',
        db: fake.client,
      })
    ).resolves.toMatchObject({ status: 'approved' });
    expect(console.error).toHaveBeenCalled();
  });
});
