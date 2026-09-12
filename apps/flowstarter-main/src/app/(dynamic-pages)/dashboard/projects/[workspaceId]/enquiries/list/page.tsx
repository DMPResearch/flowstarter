/**
 * Every enquiry sent through this workspace's contact form.
 *
 * The same gate as the rest of a client's project, and the same reason for it:
 * the reads below run as the service role, so `requireWorkspaceAccess` is the
 * whole of the isolation. The rows themselves only ever get here through the
 * public capture endpoint, which resolves the workspace from a token and writes
 * through `withTenant`.
 *
 * Spam is loaded but not shown. `listWorkspaceLeads` is asked twice rather than
 * once with a filter applied in the browser, so the page never has to decide
 * what spam is.
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireWorkspaceAccess } from '@/lib/api-auth';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { LeadsList } from '@/components/flowstarter/LeadsList';
import { listWorkspaceLeads } from '@/lib/flowstarter/lead-capture';
import { workspaceDisplayName } from '../../../../client-workspaces';

export const dynamic = 'force-dynamic';

export default async function ClientEnquiriesListPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) {
    if (access.response.status === 401) {
      redirect(`/login?next=/dashboard/projects/${workspaceId}/enquiries/list`);
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

  const all = await listWorkspaceLeads(supabase, workspaceId, {
    includeSpam: true,
  });
  const leads = all.filter((lead) => lead.status !== 'spam');
  const spam = all.filter((lead) => lead.status === 'spam');

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-5 py-12">
      <header className="flex flex-col gap-2">
        <Link
          href={`/dashboard/projects/${workspaceId}/enquiries`}
          className="w-fit text-sm font-semibold text-[var(--purple-primary)] underline underline-offset-4"
        >
          ← Contact form settings
        </Link>
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--purple-primary)]">
          Enquiries
        </p>
        <h1 className="text-3xl font-bold leading-tight text-[var(--fs-ink)]">
          Enquiries for{' '}
          {workspaceDisplayName({
            name: workspace.name,
            clientBusinessName: workspace.client_business_name ?? null,
          })}
        </h1>
        <p
          className="text-sm text-[var(--fs-ink)]/70"
          data-testid="enquiries-summary"
        >
          {leads.length === 1 ? '1 message' : `${leads.length} messages`}.
          Newest first.
        </p>
      </header>

      <LeadsList leads={leads} spam={spam} />
    </main>
  );
}
