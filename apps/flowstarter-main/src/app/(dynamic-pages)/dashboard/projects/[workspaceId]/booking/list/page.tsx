/**
 * Every booking made through this workspace's calendar.
 *
 * Same gate as the rest of a client's project: `requireWorkspaceAccess` runs
 * before a single row is read, a signed-out caller is sent to sign in, and
 * anyone else gets the same 404 the API returns, so the page never confirms
 * that a workspace id is real.
 *
 * Below that, the service role reads `workspace_bookings` filtered by this one
 * workspace. The rows only ever get there through the signed Cal.com webhook.
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireWorkspaceAccess } from '@/lib/api-auth';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { BookingsList } from '@/components/flowstarter/BookingsList';
import { listWorkspaceBookings } from '@/lib/flowstarter/bookings-data';
import { summariseBookings } from '@/lib/flowstarter/bookings';
import { loadCalConnection } from '@/lib/flowstarter/cal-integration';
import { workspaceDisplayName } from '../../../../client-workspaces';

export const dynamic = 'force-dynamic';

export default async function ClientBookingsListPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) {
    if (access.response.status === 401) {
      redirect(`/login?next=/dashboard/projects/${workspaceId}/booking/list`);
    }
    notFound();
  }

  const supabase = createSupabaseServiceRoleClient();
  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, name, client_business_name')
    .eq('id', workspaceId)
    .maybeSingle();
  if (!workspace) notFound();

  const now = new Date();
  const [bookings, connection] = await Promise.all([
    listWorkspaceBookings(supabase, workspaceId),
    loadCalConnection(supabase, workspaceId),
  ]);
  const summary = summariseBookings(bookings, now);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-5 py-12">
      <header className="flex flex-col gap-2">
        <Link
          href={`/dashboard/projects/${workspaceId}/booking`}
          className="w-fit text-sm font-semibold text-[var(--purple-primary)] underline underline-offset-4"
        >
          ← Booking settings
        </Link>
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--purple-primary)]">
          Bookings
        </p>
        <h1 className="text-3xl font-bold leading-tight text-[var(--fs-ink)]">
          Bookings for{' '}
          {workspaceDisplayName({
            name: workspace.name,
            clientBusinessName: workspace.client_business_name ?? null,
          })}
        </h1>
        <p
          className="text-sm text-[var(--fs-ink)]/70"
          data-testid="bookings-summary"
        >
          {summary.upcoming} coming up. {summary.last30Days} in the last 30
          days.
        </p>
      </header>

      {/* Connected with nothing recorded is almost always a webhook that was
          never added in Cal.com, so say where the instructions are rather
          than leaving an empty page to be interpreted. */}
      {connection?.connected && bookings.length === 0 ? (
        <p
          className="rounded-2xl border border-[var(--fs-glass-edge)] bg-white/60 px-5 py-4 text-sm text-[var(--fs-ink)]/70"
          data-testid="bookings-webhook-hint"
        >
          Your calendar is connected. Bookings only appear here once you have
          added the webhook in Cal.com, which takes about a minute. The steps
          are on the{' '}
          <Link
            href={`/dashboard/projects/${workspaceId}/booking`}
            className="font-semibold text-[var(--purple-primary)] underline underline-offset-4"
          >
            booking settings page
          </Link>
          .
        </p>
      ) : null}

      <BookingsList bookings={bookings} now={now} />
    </main>
  );
}
