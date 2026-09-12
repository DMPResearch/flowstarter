'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Server,
  Cloud,
  CheckCircle2,
  AlertCircle,
  Clock,
  RotateCcw,
  Plus,
  ExternalLink,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ShellCard } from '../../../components/TeamDashboardShell';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import type { Project } from './form-helpers';

type HostingServer = {
  id: string;
  name: string;
  provider: string;
  location: string;
  server_type: string;
  status: string;
  ipv4: string | null;
  ipv6: string | null;
  site_capacity: number;
  sites_count: number;
};

type WorkspaceSiteState = {
  id: string;
  slug: string;
  name: string;
  hosting_server_id: string | null;
  site_directory: string | null;
  deploy_status: string;
  last_deployed_at: string | null;
  ssl_status: string;
  ssl_issued_at: string | null;
  cloudflare_zone_id: string | null;
};

type Deployment = {
  id: string;
  version: number;
  status: string;
  status_detail: string | null;
  artifact_url: string | null;
  artifact_sha256: string | null;
  started_at: string;
  finished_at: string | null;
  deployed_by: string | null;
  rolled_back_from_id: string | null;
};

type SiteResponse = {
  workspace: WorkspaceSiteState;
  server: HostingServer | null;
  siteDomain: string | null;
  deployments: Deployment[];
};

/** Same chip recipe as the pipeline board and the billing tab. */
const NEUTRAL_TONE =
  'border-[var(--fs-rule)] bg-transparent text-[var(--fs-ink-dim)]';

const DEPLOY_STATUS_TONE: Record<string, string> = {
  pending: NEUTRAL_TONE,
  deploying:
    'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  live: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  failed: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300',
  rolled_back:
    'border-orange-500/25 bg-orange-500/10 text-orange-700 dark:text-orange-300',
  archived: NEUTRAL_TONE,
};

const SERVER_STATUS_TONE: Record<string, string> = {
  active: 'text-emerald-600 dark:text-emerald-400',
  provisioning: 'text-amber-600 dark:text-amber-400',
  draining: 'text-orange-600 dark:text-orange-400',
  decommissioned: 'text-slate-500',
  error: 'text-red-600 dark:text-red-400',
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase leading-5 tracking-wide ${
        DEPLOY_STATUS_TONE[status] ?? NEUTRAL_TONE
      }`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function HostingTab({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [showAllocate, setShowAllocate] = useState(false);
  const [pickedServerId, setPickedServerId] = useState<string>('');

  const siteQuery = useQuery({
    queryKey: ['team-project-site', project.id],
    queryFn: async (): Promise<SiteResponse> => {
      const res = await fetch(`/api/admin/projects/${project.id}/site`);
      if (!res.ok) throw new Error('Failed to load site state');
      return res.json();
    },
  });

  const serversQuery = useQuery({
    enabled: showAllocate,
    queryKey: ['team-hosting-servers'],
    queryFn: async (): Promise<{ servers: HostingServer[] }> => {
      const res = await fetch('/api/admin/hosting/servers');
      if (!res.ok) throw new Error('Failed to load servers');
      return res.json();
    },
  });

  const allocate = useMutation({
    mutationFn: async (vars: { server_id?: string }) => {
      const res = await fetch(`/api/admin/projects/${project.id}/site`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vars),
      });
      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({ error: 'Failed to allocate site' }));
        throw new Error(err.error || 'Failed');
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-project-site', project.id] });
      qc.invalidateQueries({ queryKey: ['team-hosting-servers'] });
      qc.invalidateQueries({ queryKey: ['team-project', project.id] });
      toast.success('Project allocated');
      setShowAllocate(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });

  const data = siteQuery.data;

  if (siteQuery.isLoading) {
    return (
      <ShellCard>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-14 rounded-lg animate-pulse bg-white/40 dark:bg-white/5"
            />
          ))}
        </div>
      </ShellCard>
    );
  }

  if (siteQuery.error || !data) {
    return (
      <ShellCard>
        <p className="text-sm text-red-500">
          Failed to load hosting state. Try again.
        </p>
      </ShellCard>
    );
  }

  const workspace = data.workspace;
  const server = data.server;
  const deployments = data.deployments;
  const siteDomain = data.siteDomain;

  // Not allocated yet — show allocate panel.
  if (!workspace.hosting_server_id) {
    return (
      <ShellCard>
        <div className="space-y-4">
          <div className="rounded-lg border border-dashed border-[var(--fs-rule)] p-8 text-center">
            <Server className="mx-auto mb-2 h-8 w-8 text-[var(--fs-ink-faint)]" />
            <p className="text-sm font-medium text-[var(--fs-ink)] mb-1">
              Not allocated to a hosting server yet
            </p>
            <p className="text-xs text-[var(--fs-ink-faint)] mb-4">
              Pin this project to a Hetzner Caddy host so you can deploy and
              attach a domain. Slug:{' '}
              <span className="font-mono">{workspace.slug}</span>
            </p>
            {!showAllocate ? (
              <Button size="sm" onClick={() => setShowAllocate(true)}>
                <Plus className="w-4 h-4" /> Allocate to server
              </Button>
            ) : (
              <div className="text-left max-w-md mx-auto space-y-3">
                <div>
                  <Label>Server</Label>
                  <Select
                    value={pickedServerId}
                    onValueChange={setPickedServerId}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Auto-pick least-loaded" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">Auto-pick least-loaded</SelectItem>
                      {(serversQuery.data?.servers ?? [])
                        .filter((s) => s.status === 'active')
                        .map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name} · {s.location} · {s.sites_count}/
                            {s.site_capacity}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowAllocate(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={allocate.isPending}
                    onClick={() =>
                      allocate.mutate({
                        server_id: pickedServerId || undefined,
                      })
                    }
                  >
                    {allocate.isPending ? 'Allocating…' : 'Allocate'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </ShellCard>
    );
  }

  return (
    <div className="space-y-4">
      {/* Workspace overview */}
      <ShellCard>
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h3 className="text-sm font-semibold text-[var(--fs-ink)]">Site</h3>
            <p className="text-xs text-[var(--fs-ink-faint)]">
              Allocated to {server?.name ?? 'an unknown server'}
            </p>
          </div>
          <StatusPill status={workspace.deploy_status} />
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <div>
            <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
              Project slug
            </dt>
            <dd className="font-mono text-[var(--fs-ink-dim)]">
              {workspace.slug}
            </dd>
          </div>
          <div>
            <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
              Site directory
            </dt>
            <dd className="font-mono text-xs text-[var(--fs-ink-dim)] truncate">
              {workspace.site_directory ?? '–'}
            </dd>
          </div>
          <div>
            <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
              Site domain
            </dt>
            <dd>
              {siteDomain ? (
                <a
                  href={`https://${siteDomain}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[var(--purple)] hover:underline"
                >
                  {siteDomain}
                  <ExternalLink className="w-3 h-3" />
                </a>
              ) : (
                '–'
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
              SSL
            </dt>
            <dd className="text-xs">
              {workspace.ssl_status === 'issued' ? (
                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="w-3 h-3" /> issued
                </span>
              ) : workspace.ssl_status === 'failed' ? (
                <span className="inline-flex items-center gap-1 text-red-500">
                  <AlertCircle className="w-3 h-3" /> failed
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[var(--fs-ink-faint)]">
                  <Clock className="w-3 h-3" /> {workspace.ssl_status}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
              Last deployed
            </dt>
            <dd className="text-xs text-[var(--fs-ink-dim)]">
              {workspace.last_deployed_at
                ? formatDistanceToNow(new Date(workspace.last_deployed_at), {
                    addSuffix: true,
                  })
                : 'Never'}
            </dd>
          </div>
        </dl>
      </ShellCard>

      {/* Server */}
      {server && (
        <ShellCard>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-[var(--fs-ink)]">
              Hosting server
            </h3>
            <span
              className={`text-[0.65rem] uppercase tracking-wide font-semibold ${
                SERVER_STATUS_TONE[server.status] ?? ''
              }`}
            >
              {server.status}
            </span>
          </div>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 text-sm">
            <div>
              <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
                Name
              </dt>
              <dd className="font-mono text-xs text-[var(--fs-ink-dim)]">
                {server.name}
              </dd>
            </div>
            <div>
              <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
                Provider · Type
              </dt>
              <dd className="text-xs text-[var(--fs-ink-dim)]">
                {server.provider} · {server.server_type}
              </dd>
            </div>
            <div>
              <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
                Location
              </dt>
              <dd className="text-xs text-[var(--fs-ink-dim)]">
                {server.location}
              </dd>
            </div>
            <div>
              <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
                Capacity
              </dt>
              <dd className="text-xs text-[var(--fs-ink-dim)]">
                {server.sites_count} / {server.site_capacity} sites
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
                IPv4
              </dt>
              <dd className="font-mono text-xs text-[var(--fs-ink-dim)]">
                {server.ipv4 ?? '–'}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
                IPv6
              </dt>
              <dd className="font-mono text-xs text-[var(--fs-ink-dim)] truncate">
                {server.ipv6 ?? '–'}
              </dd>
            </div>
          </dl>
        </ShellCard>
      )}

      {/* Deploy history */}
      <ShellCard>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-[var(--fs-ink)]">
            Deploy history
          </h3>
          <span className="text-[0.65rem] text-[var(--fs-ink-faint)]">
            {deployments.length}{' '}
            {deployments.length === 1 ? 'deploy' : 'deploys'}
          </span>
        </div>

        {deployments.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--fs-rule)] p-6 text-center">
            <Cloud className="mx-auto mb-2 h-7 w-7 text-[var(--fs-ink-faint)]" />
            <p className="text-xs text-[var(--fs-ink-faint)]">
              No deploys yet. The deploy endpoint ships in the next slice.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-[var(--fs-rule)] overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-white/40 dark:bg-white/[0.03]">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium text-[var(--fs-ink-faint)]">
                    Version
                  </th>
                  <th className="px-3 py-2 font-medium text-[var(--fs-ink-faint)]">
                    Status
                  </th>
                  <th className="px-3 py-2 font-medium text-[var(--fs-ink-faint)]">
                    Started
                  </th>
                  <th className="px-3 py-2 font-medium text-[var(--fs-ink-faint)]">
                    Detail
                  </th>
                </tr>
              </thead>
              <tbody>
                {deployments.map((d) => (
                  <tr key={d.id} className="border-t border-[var(--fs-rule)]">
                    <td className="px-3 py-2 font-mono text-xs text-[var(--fs-ink-dim)]">
                      v{d.version}
                      {d.rolled_back_from_id && (
                        <RotateCcw
                          className="ml-1 inline w-3 h-3 text-orange-500"
                          aria-label="rollback"
                        />
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill status={d.status} />
                    </td>
                    <td className="px-3 py-2 text-xs text-[var(--fs-ink-faint)]">
                      {formatDistanceToNow(new Date(d.started_at), {
                        addSuffix: true,
                      })}
                    </td>
                    <td className="px-3 py-2 text-xs text-[var(--fs-ink-dim)] truncate max-w-[20rem]">
                      {d.status_detail ?? '–'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ShellCard>
    </div>
  );
}
