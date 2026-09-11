'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Server,
  Plus,
  Cpu,
  Globe2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Trash2,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { TeamDashboardShell } from '../components/TeamDashboardShell';
import { ConnectExistingHostingServer } from './ConnectExistingHostingServer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type HostingServer = {
  id: string;
  name: string;
  provider: string;
  hetzner_server_id: string | null;
  ipv4: string | null;
  ipv6: string | null;
  location: string;
  server_type: string;
  status: string;
  status_detail: string | null;
  site_capacity: number;
  sites_count: number;
  cloud_init_version: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  decommissioned_at: string | null;
};

const STATUS_TONE: Record<string, string> = {
  active:
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
  provisioning:
    'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  draining:
    'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400',
  decommissioned:
    'bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-400',
  error: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400',
};

const LOCATION_LABELS: Record<string, string> = {
  fsn1: 'Falkenstein, DE',
  nbg1: 'Nuremberg, DE',
  hel1: 'Helsinki, FI',
  ash: 'Ashburn, US',
  hil: 'Hillsboro, US',
};

function StatusIcon({ status }: { status: string }) {
  if (status === 'active') return <CheckCircle2 className="w-3 h-3" />;
  if (status === 'error') return <AlertCircle className="w-3 h-3" />;
  if (status === 'provisioning')
    return <Clock className="w-3 h-3 animate-pulse" />;
  return <Server className="w-3 h-3" />;
}

export default function HostingPage() {
  const qc = useQueryClient();
  const [showProvision, setShowProvision] = useState(false);
  const [name, setName] = useState('');
  const [location, setLocation] = useState<string>('fsn1');
  const [serverType, setServerType] = useState<string>('cpx22');
  const [siteCapacity, setSiteCapacity] = useState<string>('50');
  const [notes, setNotes] = useState<string>('');

  const serversQuery = useQuery({
    queryKey: ['team-hosting-servers'],
    queryFn: async (): Promise<{ servers: HostingServer[] }> => {
      const res = await fetch('/api/admin/hosting/servers');
      if (!res.ok) throw new Error('Failed to load servers');
      return res.json();
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      // Poll while any server is still provisioning so the UI reflects state.
      const provisioning = data?.servers.some(
        (s) => s.status === 'provisioning'
      );
      return provisioning ? 5000 : false;
    },
  });

  const provision = useMutation({
    mutationFn: async (vars: {
      name: string;
      location: string;
      server_type: string;
      site_capacity: number;
      notes: string;
    }) => {
      const res = await fetch('/api/admin/hosting/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vars),
      });
      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({ error: 'Provisioning failed' }));
        throw new Error(err.error || 'Provisioning failed');
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-hosting-servers'] });
      toast.success('Server provisioning started');
      setShowProvision(false);
      setName('');
      setNotes('');
      setSiteCapacity('50');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });

  const decommission = useMutation({
    mutationFn: async (vars: { id: string; force?: boolean }) => {
      const url = `/api/admin/hosting/servers/${vars.id}${
        vars.force ? '?force=true' : ''
      }`;
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed' }));
        throw new Error(err.error || 'Failed');
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-hosting-servers'] });
      toast.success('Server decommissioned');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });

  const servers = serversQuery.data?.servers ?? [];
  const stats = useMemo(() => {
    const active = servers.filter((s) => s.status === 'active');
    const totalCapacity = active.reduce((acc, s) => acc + s.site_capacity, 0);
    const totalUsed = active.reduce((acc, s) => acc + s.sites_count, 0);
    return {
      total: servers.length,
      active: active.length,
      provisioning: servers.filter((s) => s.status === 'provisioning').length,
      capacityUsed: totalUsed,
      capacityTotal: totalCapacity,
    };
  }, [servers]);

  const submitProvision = () => {
    const trimmed = name.trim().toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(trimmed)) {
      toast.error(
        'Name must be lowercase letters, numbers, dashes (2–40 chars). e.g. caddy-fra-01'
      );
      return;
    }
    const cap = Number(siteCapacity);
    if (!Number.isFinite(cap) || cap < 1) {
      toast.error('Site capacity must be a positive number');
      return;
    }
    provision.mutate({
      name: trimmed,
      location,
      server_type: serverType,
      site_capacity: cap,
      notes: notes.trim(),
    });
  };

  return (
    <TeamDashboardShell
      title="Hosting"
      subtitle="Hetzner Caddy fleet that hosts client sites"
      icon={<Server className="w-5 h-5" />}
      actions={
        <>
          <ConnectExistingHostingServer />
          <Button onClick={() => setShowProvision(true)} size="sm">
            <Plus className="w-4 h-4" /> Provision server
          </Button>
        </>
      }
    >
      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard
          label="Active servers"
          value={stats.active}
          icon={<Server className="w-4 h-4" />}
        />
        <StatCard
          label="Provisioning"
          value={stats.provisioning}
          icon={<Clock className="w-4 h-4" />}
          accent={stats.provisioning > 0 ? 'amber' : undefined}
        />
        <StatCard
          label="Sites hosted"
          value={`${stats.capacityUsed}/${stats.capacityTotal}`}
          icon={<Globe2 className="w-4 h-4" />}
        />
        <StatCard
          label="Total servers"
          value={stats.total}
          icon={<Cpu className="w-4 h-4" />}
        />
      </div>

      {serversQuery.isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-20 rounded-xl border animate-pulse"
              style={{
                background: 'var(--fs-glass-bg)',
                borderColor: 'var(--fs-glass-edge)',
              }}
            />
          ))}
        </div>
      ) : serversQuery.error ? (
        <p className="text-sm text-red-500">Failed to load servers.</p>
      ) : servers.length === 0 ? (
        <div
          className="rounded-[var(--fs-radius-2xl)] border p-12 text-center"
          style={{
            background: 'var(--fs-glass-bg)',
            borderColor: 'var(--fs-glass-edge)',
            boxShadow: 'var(--fs-card-shadow)',
          }}
        >
          <Server className="mx-auto mb-3 h-8 w-8 text-[var(--fs-ink-faint)]" />
          <p className="text-sm font-medium text-[var(--fs-ink)] mb-1">
            No hosting servers yet
          </p>
          <p className="text-xs text-[var(--fs-ink-faint)] mb-4 max-w-sm mx-auto">
            Provision a Hetzner Caddy host to start hosting client sites. One
            shared server hosts dozens of sites as Caddy vhosts.
          </p>
          <Button onClick={() => setShowProvision(true)} size="sm">
            <Plus className="w-4 h-4" /> Provision your first server
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map((s) => (
            <ServerRow
              key={s.id}
              server={s}
              onDecommission={(force) =>
                decommission.mutate({ id: s.id, force })
              }
              isDecommissioning={
                decommission.isPending && decommission.variables?.id === s.id
              }
            />
          ))}
        </div>
      )}

      {/* Provision dialog */}
      <Dialog open={showProvision} onOpenChange={setShowProvision}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Provision Hetzner server</DialogTitle>
            <DialogDescription>
              Creates a real Hetzner Cloud server with Caddy + Docker installed
              via cloud-init. Billing starts as soon as the server boots.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="srv-name">Name</Label>
              <Input
                id="srv-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="caddy-fra-01"
                className="mt-1"
              />
              <p className="mt-1 text-[0.65rem] text-[var(--fs-ink-faint)]">
                Lowercase letters, numbers, dashes (2–40 chars)
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Location</Label>
                <Select value={location} onValueChange={setLocation}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(LOCATION_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {k} · {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Server type</Label>
                <Select value={serverType} onValueChange={setServerType}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cpx22">
                      cpx22 · AMD · 2 vCPU / 4 GB · Flowstarter default
                    </SelectItem>
                    <SelectItem value="cpx21">
                      cpx21 · AMD · 3 vCPU / 4 GB
                    </SelectItem>
                    <SelectItem value="cpx31">
                      cpx31 · AMD · 4 vCPU / 8 GB
                    </SelectItem>
                    <SelectItem value="cx22">
                      cx22 · Intel · 2 vCPU / 4 GB
                    </SelectItem>
                    <SelectItem value="cx32">
                      cx32 · Intel · 4 vCPU / 8 GB
                    </SelectItem>
                    <SelectItem value="cx42">
                      cx42 · Intel · 8 vCPU / 16 GB
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label htmlFor="srv-cap">Site capacity</Label>
              <Input
                id="srv-cap"
                type="number"
                min={1}
                value={siteCapacity}
                onChange={(e) => setSiteCapacity(e.target.value)}
                className="mt-1"
              />
              <p className="mt-1 text-[0.65rem] text-[var(--fs-ink-faint)]">
                Maximum sites this server will host before allocation routes
                elsewhere.
              </p>
            </div>

            <div>
              <Label htmlFor="srv-notes">Notes (optional)</Label>
              <Input
                id="srv-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Pilot client batch, Q2 2026"
                className="mt-1"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowProvision(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={submitProvision}
              disabled={provision.isPending}
            >
              {provision.isPending ? 'Provisioning…' : 'Provision'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TeamDashboardShell>
  );
}

function StatCard({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string | number;
  icon?: React.ReactNode;
  accent?: 'amber';
}) {
  return (
    <div
      className="rounded-xl border p-3"
      style={{
        background: 'var(--fs-glass-bg)',
        borderColor: 'var(--fs-glass-edge)',
        boxShadow: 'var(--fs-card-shadow)',
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
          {label}
        </span>
        <span
          className={
            accent === 'amber' ? 'text-amber-500' : 'text-[var(--fs-ink-faint)]'
          }
        >
          {icon}
        </span>
      </div>
      <p className="mt-1 text-xl font-semibold text-[var(--fs-ink)]">{value}</p>
    </div>
  );
}

function ServerRow({
  server,
  onDecommission,
  isDecommissioning,
}: {
  server: HostingServer;
  onDecommission: (force: boolean) => void;
  isDecommissioning: boolean;
}) {
  return (
    <div
      className="rounded-xl border p-4 backdrop-blur-2xl backdrop-saturate-150"
      style={{
        background: 'var(--fs-glass-bg)',
        borderColor: 'var(--fs-glass-edge)',
        boxShadow: 'var(--fs-card-shadow)',
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold text-[var(--fs-ink)]">
              {server.name}
            </h3>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider ${
                STATUS_TONE[server.status] ?? STATUS_TONE.provisioning
              }`}
            >
              <StatusIcon status={server.status} />
              {server.status}
            </span>
          </div>
          <p className="text-xs text-[var(--fs-ink-faint)]">
            {server.provider} · {server.server_type} ·{' '}
            {LOCATION_LABELS[server.location] ?? server.location}
            {server.hetzner_server_id && (
              <>
                {' '}
                · ID{' '}
                <span className="font-mono">{server.hetzner_server_id}</span>
              </>
            )}
          </p>
          {server.status_detail && (
            <p className="mt-1 text-xs text-red-500">{server.status_detail}</p>
          )}
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-[0.7rem] text-[var(--fs-ink-dim)]">
            <span>
              Sites:{' '}
              <strong className="text-[var(--fs-ink)]">
                {server.sites_count}/{server.site_capacity}
              </strong>
            </span>
            {server.ipv4 && (
              <span className="font-mono truncate">{server.ipv4}</span>
            )}
            <span>
              Created{' '}
              {formatDistanceToNow(new Date(server.created_at), {
                addSuffix: true,
              })}
            </span>
            <span>cloud-init v{server.cloud_init_version}</span>
          </div>
        </div>

        {server.status !== 'decommissioned' && (
          <button
            onClick={() => {
              const force = server.sites_count > 0;
              const message = force
                ? `Decommission "${server.name}" with ${server.sites_count} active sites? This forces deletion, sites will go down.`
                : `Decommission "${server.name}"? This deletes the Hetzner server.`;
              if (confirm(message)) onDecommission(force);
            }}
            disabled={isDecommissioning}
            className="text-[var(--fs-ink-faint)] hover:text-red-500 disabled:opacity-50 transition-colors"
            title="Decommission"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
