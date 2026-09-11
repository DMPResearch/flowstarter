'use client';

import { useEffect, useMemo, useState } from 'react';
import { Inbox, CheckCircle2 } from 'lucide-react';
import { GlassSurface } from '@flowstarter/flow-design-system';
import { Button } from '@/components/ui/unified-button';
import { timeAgo } from '@/lib/format-utils';

interface OperatorRequest {
  id: string;
  email: string;
  message: string;
  created_at: string | null;
  responded_at: string | null;
  notes: string | null;
}

export function OperatorRequestsList() {
  const [items, setItems] = useState<OperatorRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [handlingId, setHandlingId] = useState<string | null>(null);
  const [responses, setResponses] = useState<Record<string, string>>({});

  const pendingItems = useMemo(
    () => items.filter((item) => !item.responded_at),
    [items]
  );

  const load = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/support-operator-requests', {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = (await res.json()) as { requests?: OperatorRequest[] };
      setItems(data.requests ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleRequest = async (id: string) => {
    const response = (responses[id] ?? '').trim();
    if (!response) return;
    setHandlingId(id);
    try {
      const res = await fetch(`/api/support-operator-requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response }),
      });
      if (!res.ok) return;
      setItems((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                responded_at: new Date().toISOString(),
                notes: response,
              }
            : item
        )
      );
    } finally {
      setHandlingId(null);
    }
  };

  return (
    <div
      className="mb-8 rounded-[var(--fs-radius-2xl)] border p-4 backdrop-blur-xl"
      style={{
        background: 'var(--fs-glass-bg)',
        borderColor: 'var(--fs-glass-edge)',
        boxShadow: 'var(--fs-card-shadow)',
      }}
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--fs-ink)]">
          Operator Requests
        </h3>
        <span className="text-xs text-[var(--fs-ink-faint)]">
          {pendingItems.length} pending
        </span>
      </div>

      {loading ? (
        <p className="text-xs text-[var(--fs-ink-faint)]">
          Loading operator queue…
        </p>
      ) : items.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-[var(--fs-ink-faint)]">
          <Inbox className="h-4 w-4" />
          No operator requests yet.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const sessionLabel = item.email
              .replace('support+', '')
              .replace('@flowstarter.net', '');
            const disabled = Boolean(item.responded_at);
            return (
              <GlassSurface key={item.id} variant="card" className="p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-[var(--fs-ink)]">
                    Session {sessionLabel.slice(0, 14)}...
                  </p>
                  <span className="text-[11px] text-[var(--fs-ink-faint)]">
                    {timeAgo(item.created_at) || 'unknown'}
                  </span>
                </div>
                <p className="mb-2 line-clamp-3 text-xs text-[var(--fs-ink-dim)]">
                  {item.message}
                </p>
                <textarea
                  value={responses[item.id] ?? item.notes ?? ''}
                  onChange={(e) =>
                    setResponses((prev) => ({
                      ...prev,
                      [item.id]: e.target.value,
                    }))
                  }
                  disabled={disabled}
                  placeholder="Write operator response that will be pushed to chat"
                  className="mb-2 min-h-20 w-full rounded-lg border border-[var(--fs-rule)] bg-white p-2 text-xs text-[var(--fs-ink)] outline-none focus:ring-2 focus:ring-[var(--purple)]/20 disabled:opacity-60 dark:bg-white/[0.02]"
                />
                <div className="flex items-center justify-between">
                  {disabled ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Handled and sent to chat
                    </span>
                  ) : (
                    <span className="text-[11px] text-[var(--fs-ink-faint)]">
                      This reply is delivered to the user chat.
                    </span>
                  )}
                  <Button
                    type="button"
                    className="h-8 px-3 py-1 text-xs"
                    disabled={
                      disabled ||
                      handlingId === item.id ||
                      !(responses[item.id] ?? '').trim()
                    }
                    onClick={() => void handleRequest(item.id)}
                  >
                    {handlingId === item.id ? 'Sending…' : 'Mark handled'}
                  </Button>
                </div>
              </GlassSurface>
            );
          })}
        </div>
      )}
    </div>
  );
}
