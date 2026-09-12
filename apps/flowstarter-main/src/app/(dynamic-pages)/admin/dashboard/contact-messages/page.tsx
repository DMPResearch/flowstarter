'use client';

/**
 * MVP readiness review, "Lead capture": "/contact is a dead letter box...
 * Nothing ever reads it. The admin 'Custom inquiries' page reads
 * `/api/admin/custom-inquiries`, a different table." This is the listing
 * that makes `contact_submissions` reachable by a human, next to the
 * existing custom-inquiries page, reading `/api/admin/contact-submissions`.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { useTranslations } from '@/lib/i18n';
import { compactRelative } from '@/lib/format-utils';
import { TeamDashboardShell } from '../components/TeamDashboardShell';

interface ContactSubmission {
  id: string;
  created_at: string;
  name: string;
  email: string;
  subject: string;
  message: string;
  read_at: string | null;
  responded_at: string | null;
  notes: string | null;
}

interface ContactSubmissionsResponse {
  submissions: ContactSubmission[];
  total: number;
  page: number;
  pageSize: number;
}

function ReadBadge({ readAt }: { readAt: string | null }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5 ${
        readAt
          ? 'border-[var(--ls-rule)] bg-transparent text-[var(--ls-ink-dim)]'
          : 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
      }`}
    >
      {readAt ? 'Read' : 'Unread'}
    </span>
  );
}

export default function ContactMessagesPage() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [page, setPage] = useState<number>(1);

  const { data, isLoading, error } = useQuery<ContactSubmissionsResponse>({
    queryKey: ['contact-submissions', page],
    queryFn: async () => {
      const res = await fetch(`/api/admin/contact-submissions?page=${page}`);
      if (!res.ok) throw new Error('Failed to load messages');
      return res.json();
    },
  });

  const submissions = data?.submissions ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const unreadCount = submissions.filter((s) => !s.read_at).length;

  async function markRead(id: string) {
    await fetch(`/api/admin/contact-submissions/${id}/read`, {
      method: 'POST',
    });
    queryClient.invalidateQueries({ queryKey: ['contact-submissions'] });
  }

  return (
    <TeamDashboardShell
      title={t('admin.nav.contactMessages')}
      icon={<Inbox className="h-5 w-5" aria-hidden />}
    >
      <section className="ls-card">
        {isLoading && (
          <p className="text-sm text-[var(--ls-ink-faint)]">
            Loading messages…
          </p>
        )}
        {error && (
          <p className="text-sm text-rose-600 dark:text-rose-400">
            Could not load messages.
          </p>
        )}
        {!isLoading && !error && submissions.length === 0 && (
          <p className="text-sm text-[var(--ls-ink-faint)]">No messages yet.</p>
        )}

        {submissions.length > 0 && (
          <>
            <p className="mb-4 text-[13px] text-[var(--ls-ink-faint)]">
              {total} message{total === 1 ? '' : 's'} · {unreadCount} unread on
              this page
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--ls-rule)] text-[11px] uppercase tracking-[0.12em] text-[var(--ls-ink-faint)]">
                    <th className="py-2 pr-4 font-medium">When</th>
                    <th className="py-2 pr-4 font-medium">From</th>
                    <th className="py-2 pr-4 font-medium">Subject</th>
                    <th className="py-2 pr-4 font-medium">Message</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {submissions.map((s) => {
                    const truncated =
                      s.message.length > 80
                        ? `${s.message.slice(0, 77)}…`
                        : s.message;
                    return (
                      <tr
                        key={s.id}
                        className="border-b border-[var(--ls-rule)]/60 align-top"
                      >
                        <td className="py-3 pr-4 whitespace-nowrap text-[var(--ls-ink-faint)]">
                          {compactRelative(s.created_at)}
                        </td>
                        <td className="py-3 pr-4">
                          <div className="font-medium text-[var(--ls-ink)]">
                            {s.name}
                          </div>
                          <div className="text-[12px] text-[var(--ls-ink-faint)]">
                            <a
                              href={`mailto:${s.email}`}
                              className="text-[var(--ls-accent)] hover:underline"
                            >
                              {s.email}
                            </a>
                          </div>
                        </td>
                        <td className="py-3 pr-4">{s.subject}</td>
                        <td className="py-3 pr-4 text-[var(--ls-ink-dim)]">
                          {truncated}
                        </td>
                        <td className="py-3 pr-4">
                          <ReadBadge readAt={s.read_at} />
                        </td>
                        <td className="py-3 pr-4 whitespace-nowrap">
                          {!s.read_at && (
                            <button
                              type="button"
                              onClick={() => markRead(s.id)}
                              className="text-[12px] font-medium text-[var(--ls-accent)] hover:underline"
                            >
                              Mark read
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-end gap-3 text-[12px]">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="rounded-md border border-[var(--ls-rule)] px-2 py-1 disabled:opacity-50"
                >
                  ← Prev
                </button>
                <span className="text-[var(--ls-ink-faint)]">
                  Page {page} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="rounded-md border border-[var(--ls-rule)] px-2 py-1 disabled:opacity-50"
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </TeamDashboardShell>
  );
}
