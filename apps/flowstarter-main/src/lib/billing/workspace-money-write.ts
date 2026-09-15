/**
 * The atomic half of applying a Stripe money-state transition to a
 * workspace.
 *
 * The Stripe webhook route reads a workspace's current money state, decides
 * — using the pure rules in `money-state.ts` — what a transition should
 * write, and used to write it through an unconditioned `update` filtered
 * only by workspace id. That leaves a gap `stripe-events.ts`'s ledger does
 * not close: the ledger deliberately allows two genuinely concurrent
 * deliveries of *different* events for the same Stripe object to both run
 * (see its module doc comment), and both would read the same pre-write
 * state, evaluate their rules against it, and then both write. Whichever
 * write reaches Postgres last wins, even when it is the chronologically
 * OLDER event — the newer state a moment earlier is silently regressed.
 *
 * `casUpdateWorkspaceMoneyState` closes that gap with a compare-and-set on
 * `workspaces.billing_version`: a column bumped on every successful write
 * here, so an update conditioned on the version this call's decision was
 * made against fails outright (updates zero rows) the instant a concurrent
 * write lands first. On that miss, this rereads the row and calls `decide`
 * again against what is now actually stored, instead of assuming its first
 * decision still holds. That reread-and-reevaluate is what makes two
 * events converge on the same result whichever order they finish in:
 * whichever writes first simply wins, and whichever writes second
 * re-derives its own transition against the state the first one actually
 * produced — which the existing pure rules (`paymentStatusAdvances`,
 * `carePlanTransitionAllowed`, `periodEndIsCurrent`) already know how to
 * refuse when it would be a regression.
 */
import 'server-only';
import type { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/** The workspace columns the money handlers decide on, plus the version
 * `casUpdateWorkspaceMoneyState`'s compare-and-set is conditioned on. */
export interface WorkspaceMoneyState {
  deposit_status: string | null;
  final_status: string | null;
  subscription_status: string | null;
  stripe_subscription_id: string | null;
  subscription_next_billing: string | null;
  /**
   * What has already gone back, so a `charge.refunded` delivered out of order
   * can be refused rather than regressing the total. Read through the same
   * compare-and-set as every other money column: a refund and a payment
   * landing in the same instant are exactly the race `billing_version` exists
   * for.
   */
  refunded_amount_minor: number | null;
  /** The agreed price, so a refund total can be called partial or full. */
  final_value_minor: number | null;
  setup_fee: number | null;
  billing_version: number;
}

/**
 * The workspace's current money state, or null when there is no such
 * workspace.
 *
 * A read error throws: deciding whether a payment may be applied from a row
 * we failed to load would be guessing, and guessing is what a 500 exists to
 * avoid.
 */
export async function loadWorkspaceMoneyState(
  supabase: ServiceClient,
  workspaceId: string
): Promise<WorkspaceMoneyState | null> {
  const { data, error } = await supabase
    .from('workspaces')
    .select(
      'deposit_status, final_status, subscription_status, stripe_subscription_id, subscription_next_billing, refunded_amount_minor, final_value_minor, setup_fee, billing_version'
    )
    .eq('id', workspaceId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `[Stripe] could not read workspace ${workspaceId}: ${error.message}`
    );
  }
  return (data as WorkspaceMoneyState | null) ?? null;
}

/**
 * Bounds the read-decide-write retry loop below at one retry. A genuine
 * concurrent write landing between this call's read and its own write is
 * real, but rereading and losing the race a second time in the same
 * delivery means something is holding this workspace's billing row under
 * sustained contention — not the ordinary two-events-at-once case this
 * exists to absorb. Throwing there, rather than looping, lets the route
 * answer 500 so Stripe redelivers instead of this call spinning on it.
 */
const MAX_WRITE_ATTEMPTS = 2;

/**
 * Compare-and-set update of one workspace's money-state columns. See the
 * module doc comment above for why this exists.
 *
 * `decide(state)` computes the columns to write, or `null` for "this
 * transition does not apply" — already applied, or superseded by state this
 * call did not know about. It is called once against `initial` (the state
 * the caller read before deciding to write) and, only if that write's
 * compare-and-set misses, once more against a fresh read.
 *
 * Resolves to whether a write actually landed, so a caller whose Stripe
 * outcome depends on that (e.g. "superseded" vs "processed") can read it
 * off, while a caller that considers the event handled either way (e.g. a
 * deposit invoice, which always enqueues the build regardless) can ignore
 * it.
 */
export async function casUpdateWorkspaceMoneyState(
  supabase: ServiceClient,
  workspaceId: string,
  what: string,
  initial: WorkspaceMoneyState,
  decide: (state: WorkspaceMoneyState) => Record<string, unknown> | null
): Promise<boolean> {
  let state = initial;
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const values = decide(state);
    if (!values) return false;

    const { data, error } = await supabase
      .from('workspaces')
      .update({ ...values, billing_version: state.billing_version + 1 })
      .match({ id: workspaceId, billing_version: state.billing_version })
      .select('id');
    if (error) {
      throw new Error(
        `[Stripe] ${what} failed for workspace ${workspaceId}: ${error.message}`
      );
    }
    if (data && data.length > 0) return true;

    // Lost the race: a concurrent write already advanced `billing_version`
    // out from under the state this decision was made against. Reread and
    // let `decide` run again against what is now actually stored.
    const fresh = await loadWorkspaceMoneyState(supabase, workspaceId);
    if (!fresh) {
      throw new Error(
        `[Stripe] ${what}: workspace ${workspaceId} disappeared mid-write`
      );
    }
    state = fresh;
  }
  throw new Error(
    `[Stripe] ${what} could not converge on workspace ${workspaceId} after retrying once on a billing-version conflict`
  );
}
