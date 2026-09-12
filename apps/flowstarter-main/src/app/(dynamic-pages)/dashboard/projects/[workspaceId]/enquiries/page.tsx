/**
 * Per-tenant contact form settings.
 *
 * The client's site posts enquiries to Flowstarter with a public token that
 * says which workspace they belong to. This page is where that token is shown,
 * where the snippet for a form we did not build is copied from, and where it is
 * rotated.
 *
 * Same gate as the rest of a client's project: `requireWorkspaceAccess` runs
 * before a row is read, a signed-out caller is sent to sign in, and anybody
 * else gets the 404 the API gives, so the page never confirms a workspace id
 * is real. Everything under it reads with the service role, which bypasses RLS,
 * so that check is the whole of the gate.
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireWorkspaceAccess } from '@/lib/api-auth';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { LeadCaptureSettings } from '@/components/flowstarter/LeadCaptureSettings';
import {
  ensureLeadCaptureToken,
  leadCaptureEndpoint,
} from '@/lib/flowstarter/lead-capture';
import { siteRootDomain } from '@/lib/hosting/site-hostnames';
import { workspaceDisplayName } from '../../../client-workspaces';

export const dynamic = 'force-dynamic';

export default async function ClientEnquiriesPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) {
    if (access.response.status === 401) {
      redirect(`/login?next=/dashboard/projects/${workspaceId}/enquiries`);
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

  const capture = await ensureLeadCaptureToken(supabase, workspaceId);
  if (!capture) notFound();

  const endpoint = leadCaptureEndpoint(siteRootDomain(), capture.token);

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
          Enquiries
        </p>
        <h1 className="text-3xl font-bold leading-tight text-[var(--fs-ink)]">
          Contact form for{' '}
          {workspaceDisplayName({
            name: workspace.name,
            clientBusinessName: workspace.client_business_name ?? null,
          })}
        </h1>
        <p className="text-sm text-[var(--fs-ink)]/70">
          Messages sent through the contact form on your site land here, and you
          get an email for each one. Previews cannot send: the form starts
          working when your site goes live.
        </p>
        <Link
          href={`/dashboard/projects/${workspaceId}/enquiries/list`}
          data-testid="enquiries-list-link"
          className="w-fit text-sm font-semibold text-[var(--purple-primary)] underline underline-offset-4"
        >
          See your enquiries
        </Link>
      </header>

      <section className="rounded-2xl border border-[var(--fs-glass-edge)] bg-[var(--fs-glass-bg)] px-6 py-6 shadow-[var(--fs-card-shadow)] backdrop-blur-xl">
        <LeadCaptureSettings
          workspaceId={workspaceId}
          initialToken={capture.token}
          endpoint={endpoint}
        />
      </section>
    </main>
  );
}
