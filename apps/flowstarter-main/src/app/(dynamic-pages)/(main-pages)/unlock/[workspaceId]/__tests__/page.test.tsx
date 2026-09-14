/**
 * The unlock page's copy must never quote a deposit split it did not
 * compute. On 2026-09-14 the "no workspace yet" branch still advertised a
 * page-local `BOOKING_DEPOSIT_PERCENT` (10%) a few lines above a checkout
 * that actually charges `depositAmountMinor`'s 20%. These tests render the
 * page's copy against a known quote and check every percentage and amount
 * shown against the pricing rule in
 * `@flowstarter/agentic-codegen/src/flowstarter/state-machine`, the same
 * function the deposit Checkout endpoint uses, so a future edit that quotes
 * a number the rule did not produce fails here first.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEPOSIT_PERCENT,
  balanceAmountMinor,
  depositAmountMinor,
} from '@flowstarter/agentic-codegen/src/flowstarter/state-machine';
// Static import: vi.mock is hoisted above it, and the app's test tsconfig
// does not allow top-level await.
import UnlockPage from '../page';

vi.mock('server-only', () => ({}));

function formatMinor(minor: number, currency = 'eur'): string {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: currency.toUpperCase(),
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

const state: {
  userId: string | null;
  workspace: Record<string, unknown> | null;
} = { userId: 'user_client', workspace: null };

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: state.userId }),
}));

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: state.workspace, error: null }),
      };
      return builder;
    },
  }),
}));

const WORKSPACE_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345678';

async function renderPage() {
  const element = (await UnlockPage({
    params: Promise.resolve({ workspaceId: WORKSPACE_ID }),
  })) as React.ReactElement;
  return render(element);
}

beforeEach(() => {
  state.userId = 'user_client';
  state.workspace = null;
});

describe('UnlockPage deposit copy', () => {
  it('states the shipped 20% split for a preview with no workspace yet, not a stale booking-deposit figure', async () => {
    state.workspace = null;
    await renderPage();

    // The real rule, not a page-local guess.
    expect(DEPOSIT_PERCENT).toBe(20);
    expect(
      screen.getByText(
        new RegExp(`A ${DEPOSIT_PERCENT}% deposit starts the build`)
      )
    ).toBeInTheDocument();

    // The old "holds the slot" / 10% booking-deposit wording must be gone.
    expect(screen.queryByText(/holds the slot/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/10% deposit/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/preview call/i)).not.toBeInTheDocument();
  });

  it('quotes the deposit and balance for a real quote using the pricing rule, not a hardcoded percentage', async () => {
    const quoteMinor = 250_000; // €2,500.00
    state.workspace = {
      id: WORKSPACE_ID,
      client_business_name: 'Acme Roofing',
      project_state: 'PREVIEW_READY',
      final_value_minor: quoteMinor,
      billing_currency: 'eur',
      deposit_status: null,
    };

    await renderPage();

    const expectedDepositMinor = depositAmountMinor(quoteMinor);
    const expectedBalanceMinor = balanceAmountMinor(quoteMinor);
    const expectedBalancePercent = 100 - DEPOSIT_PERCENT;

    // Sanity: the known quote maps to the numbers this test then looks for,
    // so the assertions below are checked against the rule's real output.
    expect(expectedDepositMinor).toBe(50_000);
    expect(expectedBalanceMinor).toBe(200_000);

    expect(
      screen.getByText(`Deposit due now (${DEPOSIT_PERCENT}%)`)
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Balance on approval (${expectedBalancePercent}%)`)
    ).toBeInTheDocument();
    expect(
      screen.getByText(formatMinor(expectedDepositMinor))
    ).toBeInTheDocument();
    expect(
      screen.getByText(formatMinor(expectedBalanceMinor))
    ).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`pay a ${DEPOSIT_PERCENT}% deposit now`))
    ).toBeInTheDocument();

    // No leftover "preview call" framing on the payable branch either.
    expect(screen.queryByText(/preview call/i)).not.toBeInTheDocument();
  });

  it('never shows a deposit percentage the pricing rule did not produce', async () => {
    const quoteMinor = 99_999; // an odd amount, to catch rounding drift
    state.workspace = {
      id: WORKSPACE_ID,
      client_business_name: null,
      project_state: 'PREVIEW_READY',
      final_value_minor: quoteMinor,
      billing_currency: 'eur',
      deposit_status: null,
    };

    await renderPage();

    const expectedDepositMinor = depositAmountMinor(quoteMinor);
    expect(
      screen.getByText(formatMinor(expectedDepositMinor))
    ).toBeInTheDocument();
  });
});
