'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PlugZap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n, type TranslationKeys } from '@/lib/i18n';

type ConnectErrorCode =
  | 'config_missing'
  | 'config_invalid'
  | 'secret_unavailable'
  | 'health_check_failed'
  | 'hetzner_api_failed'
  | 'server_not_ready'
  | 'db_error';

// Maps the route's error `code` to a safe, localized message — never surfaces
// the raw backend message, which can include env var names or upstream detail.
const ERROR_KEY_BY_CODE: Record<ConnectErrorCode, TranslationKeys> = {
  config_missing: 'admin.hosting.connectExisting.error.configMissing',
  config_invalid: 'admin.hosting.connectExisting.error.configMissing',
  secret_unavailable: 'admin.hosting.connectExisting.error.secretUnavailable',
  health_check_failed: 'admin.hosting.connectExisting.error.healthCheckFailed',
  hetzner_api_failed: 'admin.hosting.connectExisting.error.hetznerApiFailed',
  server_not_ready: 'admin.hosting.connectExisting.error.serverNotReady',
  db_error: 'admin.hosting.connectExisting.error.dbError',
};

function isConnectErrorCode(code: unknown): code is ConnectErrorCode {
  return typeof code === 'string' && code in ERROR_KEY_BY_CODE;
}

export function ConnectExistingHostingServer() {
  const { t } = useI18n();
  const qc = useQueryClient();

  const connect = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/admin/hosting/servers/connect', {
        method: 'POST',
      });
      const body = await res
        .json()
        .catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        const key = isConnectErrorCode(body?.code)
          ? ERROR_KEY_BY_CODE[body.code]
          : 'admin.hosting.connectExisting.error.generic';
        throw new Error(t(key));
      }
      return body;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-hosting-servers'] });
      toast.success(t('admin.hosting.connectExisting.success'));
    },
    onError: (e) => {
      toast.error(
        e instanceof Error
          ? e.message
          : t('admin.hosting.connectExisting.error.generic')
      );
    },
  });

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => connect.mutate()}
      disabled={connect.isPending}
    >
      <PlugZap className="w-4 h-4" />
      {connect.isPending
        ? t('admin.hosting.connectExisting.pending')
        : t('admin.hosting.connectExisting.button')}
    </Button>
  );
}
