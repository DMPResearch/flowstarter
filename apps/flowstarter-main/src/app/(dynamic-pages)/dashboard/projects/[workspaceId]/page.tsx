/**
 * A client's own project, and nothing else.
 *
 * Everything below the authorization check is read with the service role,
 * which bypasses RLS — so `requireWorkspaceAccess` is the only thing standing
 * between a client and another tenant's project. It runs first, before a
 * single row is fetched, and a caller who is not a member gets `notFound()`:
 * the same 404 the API returns, so the page does not confirm the id is real.
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireWorkspaceAccess } from '@/lib/api-auth';
import { editCreditPosition } from '@/lib/flowstarter/edit-credits';
import { loadSiteOverviewCounts } from '@/lib/flowstarter/site-overview-data';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { OpenAsks } from '@/components/flowstarter/OpenAsks';
import { SiteOverview } from '@/components/flowstarter/SiteOverview';
import { siteOverviewTiles } from '@/components/flowstarter/site-overview';
import { ProjectThread } from '@/components/flowstarter/ProjectThread';
import { messagesFromPayload } from '@/components/flowstarter/project-messages';
import { projectStateFrom } from '@/components/flowstarter/project-progress';
import {
  formatMinor,
  paymentPosition,
  projectPayments,
} from '@/components/flowstarter/project-payment';
import { resolveSiteLink } from '@/components/flowstarter/site-link';
import { workspaceDisplayName } from '../../client-workspaces';

export const dynamic = 'force-dynamic';

export default async function ClientProjectPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) {
    // A signed-out caller should be asked to sign in; everything else — wrong
    // tenant, malformed id — is a 404, which tells a prober nothing.
    if (access.response.status === 401) {
      redirect(`/login?next=/dashboard/projects/${workspaceId}`);
    }
    notFound();
  }

  const supabase = createSupabaseServiceRoleClient();
  const { data: workspace } = await supabase
    .from('workspaces')
    .select(
      `id, slug, name, client_business_name, project_state, deploy_status,
       final_value_minor, setup_fee, billing_currency, deposit_status,
       final_status, final_invoice_url, tier_name, cal_com_url`
    )
    .eq('id', workspaceId)
    .maybeSingle();
  if (!workspace) notFound();

  // One clock for the page: the month the credits are counted in and the reset
  // date the client is quoted have to be the same month.
  const now = new Date();
  const [{ data: hosts }, { data: messageRows }, counts] = await Promise.all([
    supabase
      .from('workspace_hosts')
      .select('hostname, is_primary')
      .eq('workspace_id', workspaceId),
    supabase
      .from('project_messages')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true }),
    // Every query inside is filtered by this workspace id, which is the one
    // `requireWorkspaceAccess` authorized above.
    loadSiteOverviewCounts(supabase, workspaceId, now),
  ]);

  // Same normaliser the thread uses on the API's camelCase payload, so a raw
  // row and a fetched message render identically.
  const messages = messagesFromPayload(messageRows ?? []);
  const state = projectStateFrom(workspace.project_state);
  const payments = projectPayments(workspace, workspaceId);
  const position = paymentPosition(payments);
  const site = resolveSiteLink({
    slug: workspace.slug,
    deployStatus: workspace.deploy_status,
    hosts: hosts ?? [],
  });

  // Credits are spent on the proposal, not the apply, so the number that ran
  // the client's allowance down is the proposed count, not the applied one.
  const tiles = siteOverviewTiles({
    live: site !== null,
    siteHref: site?.href,
    tier: workspace.tier_name,
    credits: editCreditPosition({
      tier: workspace.tier_name,
      usedThisMonth: counts.edits.proposedThisMonth,
      now,
    }),
    enquiries: counts.enquiries,
    edits: { appliedThisMonth: counts.edits.appliedThisMonth },
    booking: {
      connected: Boolean(workspace.cal_com_url?.trim()),
      href: `/dashboard/projects/${workspaceId}/booking`,
    },
    store: counts.store,
    editorHref: `/dashboard/projects/${workspaceId}/editor`,
  });

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-5 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--purple-primary)]">
          Your project
        </p>
        <h1 className="text-3xl font-bold leading-tight text-[var(--fs-ink)]">
          {workspaceDisplayName({
            name: workspace.name,
            clientBusinessName: workspace.client_business_name ?? null,
          })}
        </h1>
        {site ? (
          <a
            href={site.href}
            target="_blank"
            rel="noreferrer noopener"
            data-testid="site-link"
            className="w-fit text-sm font-semibold text-[var(--fs-ink)] underline underline-offset-4"
          >
            {site.label} · {site.hostname}
          </a>
        ) : null}
        {/* The editor authorizes itself; this link is a shortcut, not a gate. */}
        <Link
          href={`/dashboard/projects/${workspaceId}/editor`}
          data-testid="site-editor-link"
          className="w-fit text-sm font-semibold text-[var(--purple-primary)] underline underline-offset-4"
        >
          Edit your site
        </Link>
        <Link
          href={`/dashboard/projects/${workspaceId}/booking`}
          data-testid="booking-settings-link"
          className="w-fit text-sm font-semibold text-[var(--purple-primary)] underline underline-offset-4"
        >
          Cal.com booking
        </Link>
      </header>

      <SiteOverview state={state} tiles={tiles} />

      {position.length > 0 ? (
        <section
          data-testid={
            payments.due
              ? `payment-cta-${payments.due.kind}`
              : 'payment-position'
          }
          className="flex flex-col gap-4 rounded-2xl border border-[var(--fs-glass-edge)] bg-[var(--fs-glass-bg)] px-6 py-6 shadow-[var(--fs-card-shadow)] backdrop-blur-xl"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-bold text-[var(--fs-ink)]">
              {payments.due
                ? payments.due.kind === 'deposit'
                  ? 'Start the build'
                  : 'Settle the balance'
                : 'Payments'}
            </h2>
            <p className="text-sm text-[var(--fs-ink-faint)]">
              Total quoted{' '}
              <span className="font-semibold text-[var(--fs-ink-dim)]">
                {formatMinor(payments.quoteMinor, payments.currency)}
              </span>
            </p>
          </div>
          {payments.due ? (
            <p className="max-w-2xl text-sm leading-relaxed text-[var(--fs-ink-dim)]">
              {payments.due.explainer}
            </p>
          ) : null}
          <dl className="flex flex-col gap-2">
            {position.map((line) => (
              <div
                key={line.key}
                data-testid={`payment-line-${line.key}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl border border-[var(--fs-rule)] px-4 py-3"
              >
                <dt className="text-sm font-semibold text-[var(--fs-ink)]">
                  {line.label}
                </dt>
                <dd className="text-sm font-bold text-[var(--fs-ink)]">
                  {formatMinor(line.amountMinor, payments.currency)}
                </dd>
                <dd>
                  <span
                    className={[
                      'rounded-full border px-2 py-0.5 text-[11px] font-semibold',
                      line.status === 'paid'
                        ? 'border-emerald-600/25 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300'
                        : line.status === 'due'
                        ? 'border-[var(--purple-primary)]/25 bg-[var(--purple-primary)]/10 text-[var(--purple-primary)]'
                        : 'border-[var(--fs-rule)] bg-[var(--fs-ink)]/5 text-[var(--fs-ink-faint)]',
                    ].join(' ')}
                  >
                    {line.status === 'paid'
                      ? 'Paid'
                      : line.status === 'due'
                      ? 'Due now'
                      : 'Not yet due'}
                  </span>
                </dd>
                <dd className="basis-full text-sm text-[var(--fs-ink-faint)] sm:basis-auto">
                  {line.note}
                </dd>
              </div>
            ))}
          </dl>
          {payments.due ? (
            <Link
              href={payments.due.href}
              className="inline-flex w-fit items-center rounded-lg bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-[var(--purple-primary-lightest)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[linear-gradient(135deg,var(--landing-btn-hover-from),var(--landing-btn-hover-via))] active:translate-y-0"
            >
              {payments.due.label}
            </Link>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-2xl border border-[var(--fs-glass-edge)] bg-[var(--fs-glass-bg)] px-6 py-6 shadow-[var(--fs-card-shadow)] backdrop-blur-xl">
        {/* `workspaceId` is what turns each ask into an upload control; the
            uploader posts to /api/client/assets/[workspaceId], which runs the
            same access check this page did. */}
        <OpenAsks messages={messages} workspaceId={workspaceId} />
      </section>

      <section className="flex flex-col gap-4 rounded-2xl border border-[var(--fs-glass-edge)] bg-[var(--fs-glass-bg)] px-6 py-6 shadow-[var(--fs-card-shadow)] backdrop-blur-xl">
        <h2 className="text-base font-bold text-[var(--fs-ink)]">Messages</h2>
        <ProjectThread
          workspaceId={workspaceId}
          initialMessages={messages}
          viewerSide="client"
          replyPlaceholder="Reply to us here…"
        />
      </section>
    </main>
  );
}
