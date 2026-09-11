/**
 * The destination behind the locked sections of a generated preview.
 *
 * A preview is handed to the client as a standalone site, so whoever follows
 * the unlock overlay may well be signed out. This page is therefore public: it
 * reads the workspace server-side, states exactly what unlocking costs, and
 * only then hands off to the authenticated deposit Checkout endpoint, which
 * remains the single place where money and lifecycle state are decided.
 *
 * Every branch here mirrors an invariant that
 * `/api/flowstarter/projects/[id]/deposit-checkout` enforces, so the page
 * never offers a payment the API would refuse.
 */
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { depositAmountMinor } from '@flowstarter/agentic-codegen/src/flowstarter/state-machine';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  BOOKING_DEPOSIT_PERCENT,
  TIER_SETUP_FROM,
} from '../../components/discovery/discovery.logic';
import { UnlockCheckoutButton } from './UnlockCheckoutButton';

export const dynamic = 'force-dynamic';

/** Quoted, not invented: the same figure the pricing section advertises. */
const STARTER_SETUP_FROM = TIER_SETUP_FROM.starter;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formatMinor(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: currency.toUpperCase(),
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

export default async function UnlockPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  if (!UUID.test(workspaceId)) notFound();

  const supabase = createSupabaseServiceRoleClient();
  const { data: workspace } = await supabase
    .from('workspaces')
    .select(
      'id, client_business_name, project_state, final_value_minor, billing_currency, deposit_status'
    )
    .eq('id', workspaceId)
    .maybeSingle();
  // A preview generated in the funnel carries its own id and has no workspace
  // behind it yet. That link must still land somewhere real -- a 404 reads as
  // a broken site to someone who just clicked "unlock" on their own preview.
  if (!workspace) {
    return (
      <main className="ls-scope ls-section ls-section--pad ls-unlock-main">
        <div className="ls-mesh" aria-hidden />
        <div className="ls-grain" aria-hidden />
        <div className="ls-container ls-unlock">
          <p className="ls-eyebrow">Unlock your site</p>
          <h1 className="ls-display ls-unlock__title">
            <span className="line">This preview is yours.</span>
            <span className="line flourish mt-2">Let&apos;s finish it.</span>
          </h1>
          <p className="ls-body ls-body--lead ls-unlock__lead">
            The blurred sections are the rest of the site we already generated
            for you. Book the call and we agree the scope, the price and the
            date, then the same agents finish the build.
          </p>

          <ol className="ls-unlock__steps">
            <li className="ls-card ls-unlock__step">
              <span className="ls-unlock__step-n">01</span>
              <h2 className="ls-unlock__step-title">Book the call</h2>
              <p className="ls-unlock__step-body">
                A {BOOKING_DEPOSIT_PERCENT}% deposit holds the slot and comes
                off your setup fee. Setup starts at {STARTER_SETUP_FROM}.
              </p>
            </li>
            <li className="ls-card ls-unlock__step">
              <span className="ls-unlock__step-n">02</span>
              <h2 className="ls-unlock__step-title">Agree the scope</h2>
              <p className="ls-unlock__step-body">
                We price the real thing on the call. You see the final number
                before anything else is due.
              </p>
            </li>
            <li className="ls-card ls-unlock__step">
              <span className="ls-unlock__step-n">03</span>
              <h2 className="ls-unlock__step-title">We build it</h2>
              <p className="ls-unlock__step-body">
                20% starts the build, the balance is due when you approve the
                finished site. Both of us review it before it ships.
              </p>
            </li>
          </ol>

          <div className="ls-unlock__actions">
            <Link href="/?book=1" className="ls-cta-hero ls-unlock__cta">
              Book the call
            </Link>
            <Link href="/contact" className="ls-unlock__cta-ghost">
              Ask a question first
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const { userId } = await auth();
  const currency = workspace.billing_currency ?? 'eur';
  const quoteMinor = workspace.final_value_minor ?? 0;
  const depositMinor = quoteMinor > 0 ? depositAmountMinor(quoteMinor) : 0;
  const balanceMinor = quoteMinor - depositMinor;

  const alreadyPaid = workspace.deposit_status === 'paid';
  const quoteReady = quoteMinor > 0;
  const previewApproved =
    workspace.project_state === ProjectState.PREVIEW_READY;
  const payable = !alreadyPaid && quoteReady && previewApproved;

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-2xl flex-col justify-center px-5 py-16">
      <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-[var(--purple-primary)]">
        Unlock your site
      </p>
      <h1 className="mb-4 text-3xl font-bold leading-tight text-[var(--fs-ink)] sm:text-4xl">
        {workspace.client_business_name
          ? `Build the full site for ${workspace.client_business_name}`
          : 'Build your full site'}
      </h1>

      {alreadyPaid ? (
        <p className="text-base leading-relaxed text-[var(--fs-ink)]/75">
          Your deposit is already paid and the full build is underway. The
          blurred sections of your preview are being finished now. We will be in
          touch as soon as the complete site is ready to review.
        </p>
      ) : !quoteReady || !previewApproved ? (
        <>
          <p className="mb-6 text-base leading-relaxed text-[var(--fs-ink)]/75">
            The blurred sections are part of your full site. Before we can take
            a deposit we need to agree the final scope with you on the preview
            call, so the price you pay is the price we quoted.
          </p>
          <Link
            href="/contact"
            className="inline-flex w-fit items-center rounded-full bg-[var(--fs-ink)] px-6 py-3 text-sm font-semibold text-white transition-colors hover:opacity-90"
          >
            Book the preview call
          </Link>
        </>
      ) : (
        <>
          <p className="mb-7 text-base leading-relaxed text-[var(--fs-ink)]/75">
            Everything blurred in your preview gets built, reviewed by a human,
            and handed over. You pay a 20% deposit now to start the build; the
            balance is due when the finished site is approved.
          </p>

          <dl className="mb-8 divide-y divide-[var(--fs-ink)]/10 rounded-2xl border border-[var(--fs-ink)]/10 bg-white/60 px-5">
            <div className="flex items-baseline justify-between py-4">
              <dt className="text-sm text-[var(--fs-ink)]/70">
                Deposit due now (20%)
              </dt>
              <dd className="text-lg font-bold text-[var(--fs-ink)]">
                {formatMinor(depositMinor, currency)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between py-4">
              <dt className="text-sm text-[var(--fs-ink)]/70">
                Balance on approval (80%)
              </dt>
              <dd className="text-sm font-semibold text-[var(--fs-ink)]/80">
                {formatMinor(balanceMinor, currency)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between py-4">
              <dt className="text-sm text-[var(--fs-ink)]/70">Total quoted</dt>
              <dd className="text-sm font-semibold text-[var(--fs-ink)]/80">
                {formatMinor(quoteMinor, currency)}
              </dd>
            </div>
          </dl>

          {userId ? (
            <UnlockCheckoutButton
              workspaceId={workspaceId}
              amountLabel={formatMinor(depositMinor, currency)}
            />
          ) : (
            <Link
              href={`/login?redirect_url=${encodeURIComponent(
                `/unlock/${workspaceId}`
              )}`}
              className="inline-flex w-fit items-center rounded-full bg-[var(--fs-ink)] px-6 py-3 text-sm font-semibold text-white transition-colors hover:opacity-90"
            >
              Sign in to pay {formatMinor(depositMinor, currency)}
            </Link>
          )}
          <p className="mt-4 text-xs text-[var(--fs-ink)]/55">
            Secure payment by Stripe. Signing in confirms this project is yours
            before any charge is made.
          </p>
        </>
      )}
    </main>
  );
}
