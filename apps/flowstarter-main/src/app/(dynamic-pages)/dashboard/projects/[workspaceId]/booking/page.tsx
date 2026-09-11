/**
 * Per-tenant Cal.com booking settings.
 *
 * Intake seeds the URL; this page is where the client confirms it, changes it,
 * disconnects it, and picks up the two strings Cal.com's webhook settings ask
 * for. Everything below the authorization check reads with the service role,
 * which bypasses RLS, so `requireWorkspaceAccess` is the whole of the gate.
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireWorkspaceAccess } from '@/lib/api-auth';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { BookingSettingsForm } from '@/components/flowstarter/BookingSettingsForm';
import { loadCalConnection } from '@/lib/flowstarter/cal-integration';
import { workspaceDisplayName } from '../../../client-workspaces';

export const dynamic = 'force-dynamic';

export default async function ClientBookingPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) {
    if (access.response.status === 401) {
      redirect(`/login?next=/dashboard/projects/${workspaceId}/booking`);
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

  const connection = await loadCalConnection(supabase, workspaceId);
  if (!connection) notFound();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-5 py-12">
      <header className="flex flex-col gap-2">
        <Link
          href={`/dashboard/projects/${workspaceId}`}
          className="w-fit text-sm font-semibold text-[var(--purple-primary)] underline underline-offset-4"
        >
          ← Back to project
        </Link>
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--purple-primary)]">
          Booking
        </p>
        <h1 className="text-3xl font-bold leading-tight text-[var(--fs-ink)]">
          Cal.com for{' '}
          {workspaceDisplayName({
            name: workspace.name,
            clientBusinessName: workspace.client_business_name ?? null,
          })}
        </h1>
        <p className="text-sm text-[var(--fs-ink)]/70">
          Your booking calendar is per project. Previews show a blurred demo;
          the live Cal.com embed is wired on the full site after deposit. Add or
          update your link here anytime.
        </p>
        {connection.connected ? (
          <Link
            href={`/dashboard/projects/${workspaceId}/booking/list`}
            data-testid="booking-list-link"
            className="w-fit text-sm font-semibold text-[var(--purple-primary)] underline underline-offset-4"
          >
            See your bookings
          </Link>
        ) : null}
      </header>

      <section className="rounded-2xl border border-[var(--fs-glass-edge)] bg-[var(--fs-glass-bg)] px-6 py-6 shadow-[var(--fs-card-shadow)] backdrop-blur-xl">
        <BookingSettingsForm
          workspaceId={workspaceId}
          initialConnection={connection}
        />
      </section>

      {connection.embedSrc ? (
        <section
          className="overflow-hidden rounded-2xl border border-[var(--fs-glass-edge)] bg-white"
          data-testid="booking-embed-preview"
        >
          <p className="border-b border-[var(--fs-glass-edge)] px-4 py-3 text-xs font-semibold uppercase tracking-widest text-[var(--fs-ink)]/50">
            Preview
          </p>
          <iframe
            src={connection.embedSrc}
            title="Cal.com booking preview"
            className="block h-[640px] w-full border-0"
            loading="lazy"
          />
        </section>
      ) : null}
    </main>
  );
}
