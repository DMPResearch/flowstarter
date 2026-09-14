'use client';

/**
 * The build timeline, on the client's own dashboard.
 *
 * `SiteOverview` and the project page are server components, so this is the
 * seam: the smallest possible client island that can hold a poll. It owns no
 * copy, no layout and no rule beyond "ask, and hand the answer to the panel" —
 * which step is shown and how it is worded belongs to `AgentActivityPanel` and
 * the dictionary behind it.
 *
 * `detail` is never passed. The route already strips it, so this is the second
 * of two locks on the same door: a client is told the services section was
 * edited, not which file it lives in.
 *
 * Nothing is rendered until there is something to say. The hook resolves a
 * missing timeline to `null` and the panel renders `null` for an empty one, so
 * a project whose build has not written a step yet shows the stepper alone,
 * exactly as it did before this component existed.
 */
import { AgentActivityPanel, useActivityTranslate } from './AgentActivityPanel';
import { useClientBuildActivity } from '@/hooks/useClientBuildActivity';

export function ClientBuildActivity({
  workspaceId,
  live,
}: {
  workspaceId: string;
  /** Polls while true. The page decides, from the project's own state. */
  live: boolean;
}) {
  // The same three-source dictionary the panel itself reads, so this island
  // is safe to mount inside a page test that has no provider above it.
  const t = useActivityTranslate();
  const { data } = useClientBuildActivity(workspaceId, { live });

  if (!data || data.events.length === 0) return null;

  const headline =
    data.status === 'failed'
      ? t('agentActivity.headline.stopped')
      : data.status === 'done'
      ? t('agentActivity.headline.buildDone')
      : t('agentActivity.headline.build');

  return (
    <AgentActivityPanel
      events={data.events}
      headline={headline}
      status={data.status}
      surface="card"
      defaultOpen
    />
  );
}

export default ClientBuildActivity;
