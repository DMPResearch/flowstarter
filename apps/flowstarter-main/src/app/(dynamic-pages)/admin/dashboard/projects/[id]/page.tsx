'use client';

import { use } from 'react';
import { FolderOpen } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTeamProject } from '@/hooks/useTeamProjects';
import { OverviewTab } from './components/OverviewTab';
import { ConciergeTab } from './components/ConciergeTab';
import { CommerceTab } from './components/CommerceTab';
import { CommerceProductsTab } from './components/CommerceProductsTab';
import { HostingTab } from './components/HostingTab';
import { BillingTab } from './components/BillingTab';
import { PipelineTab } from './components/PipelineTab';
import { ChangesTab } from './components/ChangesTab';
import { EditorTab } from './components/EditorTab';
import { TeamDashboardShell } from '../../components/TeamDashboardShell';

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data: project, isLoading, error } = useTeamProject(id);

  const clientLine =
    project?.client_business_name ||
    project?.client_name ||
    project?.client_email ||
    'Unassigned';

  if (error) {
    return (
      <TeamDashboardShell
        title="Project"
        subtitle="This workspace could not be loaded."
        showBackButton
        backHref="/admin/dashboard/projects"
        backLabel="Projects"
      >
        <p className="text-sm text-red-500">Could not load project.</p>
      </TeamDashboardShell>
    );
  }

  return (
    <TeamDashboardShell
      title={isLoading ? 'Loading…' : project?.name || 'Untitled project'}
      subtitle={isLoading ? undefined : clientLine}
      icon={<FolderOpen className="h-5 w-5" aria-hidden />}
      showBackButton
      backHref="/admin/dashboard/projects"
      backLabel="Projects"
    >
      {isLoading || !project ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-32 animate-pulse rounded-xl border border-[var(--ls-rule)] bg-[var(--ls-glass-bg)]"
            />
          ))}
        </div>
      ) : (
        <section className="ls-card overflow-hidden !p-0">
          <Tabs defaultValue="overview" className="w-full">
            <div className="border-b border-[var(--ls-rule)] px-4 py-3 sm:px-5">
              <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4 lg:grid-cols-9">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="concierge">Delivery</TabsTrigger>
                <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
                <TabsTrigger value="changes">Changes</TabsTrigger>
                <TabsTrigger value="editor">Editor</TabsTrigger>
                <TabsTrigger value="billing">Billing</TabsTrigger>
                <TabsTrigger value="hosting">Hosting</TabsTrigger>
                <TabsTrigger value="commerce">Commerce</TabsTrigger>
                <TabsTrigger value="products">Products</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="overview" className="m-0 p-5 sm:p-6">
              <OverviewTab project={project} />
            </TabsContent>
            <TabsContent value="concierge" className="m-0 p-5 sm:p-6">
              <ConciergeTab project={project} />
            </TabsContent>
            <TabsContent value="pipeline" className="m-0 p-5 sm:p-6">
              <PipelineTab project={project} />
            </TabsContent>
            <TabsContent value="changes" className="m-0 p-5 sm:p-6">
              <ChangesTab project={project} />
            </TabsContent>
            <TabsContent value="editor" className="m-0 p-5 sm:p-6">
              <EditorTab project={project} />
            </TabsContent>
            <TabsContent value="billing" className="m-0 p-5 sm:p-6">
              <BillingTab project={project} />
            </TabsContent>
            <TabsContent value="hosting" className="m-0 p-5 sm:p-6">
              <HostingTab project={project} />
            </TabsContent>
            <TabsContent value="commerce" className="m-0 p-5 sm:p-6">
              <CommerceTab project={project} />
            </TabsContent>
            <TabsContent value="products" className="m-0 p-5 sm:p-6">
              <CommerceProductsTab project={project} />
            </TabsContent>
          </Tabs>
        </section>
      )}
    </TeamDashboardShell>
  );
}
