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
import { notifyClientBuildNeedsReview } from '@/lib/flowstarter/build-failure-notice';
import { editCreditPosition } from '@/lib/flowstarter/edit-credits';
import { loadBriefSnapshot } from '@/lib/flowstarter/brief-data';
import { loadSiteOverviewCounts } from '@/lib/flowstarter/site-overview-data';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { OpenAsks } from '@/components/flowstarter/OpenAsks';
import { SiteOverview } from '@/components/flowstarter/SiteOverview';
import { siteOverviewTiles } from '@/components/flowstarter/site-overview';
import { ProjectThread } from '@/components/flowstarter/ProjectThread';
import { messagesFromPayload } from '@/components/flowstarter/project-messages';
import { clientBuildSignal } from '@/components/flowstarter/project-build-signal';
import { projectStateFrom } from '@/components/flowstarter/project-progress';
import {
  formatMinor,
  paymentPosition,
  projectPayments,
} from '@/components/flowstarter/project-payment';
import {
  resolvePreviewLink,
  resolveSiteLink,
} from '@/components/flowstarter/site-link';
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
  const [
    { data: hosts },
    { data: messageRows },
    { data: buildRows },
    counts,
    { data: previewRow },
    brief,
  ] = await Promise.all([
    supabase
      .from('workspace_hosts')
      .select('hostname, is_primary')
      .eq('workspace_id', workspaceId),
    supabase
      .from('project_messages')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true }),
    // `project_state` alone cannot tell a client whether their build is
    // moving: the worker rolls a failed build back to DEPOSIT_PAID so a
    // retry can claim it, and the page then reads that as "about to start".
    supabase
      .from('flowstarter_agent_jobs')
      .select(
        'id, kind, status, created_at, run_after, started_at, finished_at'
      )
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(10),
    // Every query inside is filtered by this workspace id, which is the one
    // `requireWorkspaceAccess` authorized above.
    loadSiteOverviewCounts(supabase, workspaceId, now),
    // The temporary preview this workspace was claimed from, if there was
    // one. Shown separately from the site, with the date it stops working,
    // because that is the whole difference between the two links.
    supabase
      .from('funnel_previews')
      .select('hostname, expires_at, deploy_status')
      .eq('claimed_workspace_id', workspaceId)
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // The brief, read through the same loader the brief page uses, so the
    // tile below and that page cannot disagree about what is outstanding.
    loadBriefSnapshot(workspaceId),
  ]);
  // The brief is the second input the signal needs: a FULL_SITE_BUILD that the
  // worker is deliberately holding back until the brief is ready must not be
  // reported to the client as a stalled build. Same two conditions the worker
  // claims on, `ready_at` or an operator override, so the page and the queue
  // cannot disagree about why nothing is happening.
  const buildSignal = clientBuildSignal(buildRows ?? [], now, {
    briefReady: Boolean(brief.brief.readyAt || brief.brief.overrideAt),
  });

  // The client is reading the bad news; this is the same news in their inbox,
  // once per job id. `notifyClientOnce` owns the dedupe and cannot throw, so
  // awaiting it here cannot stop the page rendering. A stalled build is not
  // emailed about: it may still be a queue that is merely slow, and the words
  // on this page already say so.
  if (buildSignal?.attention === 'failed') {
    await notifyClientBuildNeedsReview({
      supabase,
      workspaceId,
      jobId: buildSignal.jobId,
    });
  }

  // Same normaliser the thread uses on the API's camelCase payload, so a raw
  // row and a fetched message render identically.
  const messages = messagesFromPayload(messageRows ?? []);
  const state = projectStateFrom(workspace.project_state);
  const payments = projectPayments(workspace, workspaceId);
  const position = paymentPosition(payments, buildSignal);
  const site = resolveSiteLink({
    slug: workspace.slug,
    deployStatus: workspace.deploy_status,
    hosts: hosts ?? [],
  });
  const preview = resolvePreviewLink({
    hostname: previewRow?.hostname ?? null,
    expiresAt: previewRow?.expires_at ?? null,
    deployStatus: previewRow?.deploy_status ?? null,
    now,
  });

  // Credits are spent on the proposal, not the apply, so the number that ran
  // the client's allowance down is the proposed count, not the applied one.
  const tiles = siteOverviewTiles({
    // The same snapshot the brief page renders, from the same loader, so the
    // tile and the page can never disagree about what is still outstanding.
    brief: {
      href: `/dashboard/projects/${workspaceId}/brief`,
      readiness: brief.readiness,
    },
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
      // Straight to the list when there is something to read, to the connect
      // screen when there is not.
      href: counts.bookings.total
        ? `/dashboard/projects/${workspaceId}/booking/list`
        : `/dashboard/projects/${workspaceId}/booking`,
      upcoming: counts.bookings.upcoming,
      nextAt: counts.bookings.nextAt,
      last30Days: counts.bookings.last30Days,
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
        {preview ? (
          <div
            data-testid="preview-link"
            className="flex w-fit flex-col gap-0.5"
          >
            {preview.expired ? null : (
              <a
                href={preview.href}
                target="_blank"
                rel="noreferrer noopener"
                data-testid="preview-link-href"
                className="w-fit text-sm font-semibold text-[var(--fs-ink-dim)] underline underline-offset-4"
              >
                {preview.label} · {preview.hostname}
              </a>
            )}
            <p className="text-xs text-[var(--fs-ink-faint)]">
              {preview.expiryNote}
            </p>
          </div>
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

      <SiteOverview state={state} tiles={tiles} buildSignal={buildSignal} />

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
