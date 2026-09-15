'use client';

/**
 * Editor tab: opening a client's site in the Flowstarter editor, and shipping
 * what comes out of it.
 *
 * This is the operator half of "we should be able to build entire features
 * from the editor, while clients only make small changes and escalate the rest
 * to us". The client half already existed and is deliberately small. This one
 * is deliberately not: the session runs a real coding agent over a real
 * checkout of the site, and it may write whatever a coding agent can write.
 *
 * What the screen has to make unmissable is the other half of that sentence —
 * the gates still decide. So the card says, in order:
 *
 *   - where the worktree came from (a version number, not "the site"), because
 *     an operator who does not know their base is an operator who will
 *     overwrite a client's own edit;
 *   - that the session is a copy and nothing in it is live;
 *   - what happened the last time somebody pressed Ship, in the gate's own
 *     words, because that is the sentence they have to act on.
 *
 * "Open in editor" hands over with a one-minute sign-in ticket, so the editor
 * recognises the operator without a second login. The link is used once and
 * not stored anywhere: it is a credential.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import {
  ExternalLink,
  PanelLeft,
  Rocket,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { ShellCard } from '../../../components/TeamDashboardShell';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { compactRelative } from '@/lib/format-utils';
import {
  useCloseOperatorEditor,
  useOpenOperatorEditor,
  useOperatorEditor,
  useShipOperatorEditor,
  type OperatorEditorSessionView,
} from '@/hooks/useOperatorEditor';
import { BuildConversation } from './BuildConversation';
import type { Project } from './form-helpers';

const NEUTRAL_TONE =
  'border-[var(--fs-rule)] bg-transparent text-[var(--fs-ink-dim)]';
const STATUS_TONE: Record<string, string> = {
  opening: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  ready:
    'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  shipping:
    'border-indigo-500/25 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
  shipped: NEUTRAL_TONE,
  closed: NEUTRAL_TONE,
  failed: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300',
};
const STATUS_LABEL: Record<string, string> = {
  opening: 'Setting up',
  ready: 'Open',
  shipping: 'Shipping',
  shipped: 'Shipped',
  closed: 'Closed',
  failed: 'Did not ship',
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      data-testid="operator-session-status"
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
        STATUS_TONE[status] ?? NEUTRAL_TONE
      }`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function SessionRow({ session }: { session: OperatorEditorSessionView }) {
  return (
    <li
      data-testid="operator-session-history"
      className="flex flex-wrap items-center gap-2 border-t border-[var(--fs-rule)] py-2 text-sm"
    >
      <StatusPill status={session.status} />
      <span className="text-[var(--fs-ink-dim)]">{session.headline}</span>
      <span className="ml-auto text-xs text-[var(--fs-ink-dim)]">
        {compactRelative(session.createdAt)}
      </span>
    </li>
  );
}

export function EditorTab({ project }: { project: Project }) {
  const projectId = project.id;
  const { data, isLoading, error } = useOperatorEditor(projectId);
  const open = useOpenOperatorEditor(projectId);
  const ship = useShipOperatorEditor(projectId);
  const close = useCloseOperatorEditor(projectId);
  const [note, setNote] = useState('');

  const session = data?.open ?? null;
  const busy = open.isPending || ship.isPending || close.isPending;

  async function handleOpen() {
    try {
      const result = await open.mutateAsync();
      if (result.url) {
        // A new tab, and the URL is never rendered into the page: it carries a
        // one-minute sign-in ticket, and a ticket in the DOM is a ticket in a
        // screenshot.
        window.open(result.url, '_blank', 'noopener,noreferrer');
      }
      toast.success(
        result.joined
          ? 'Joined the session that was already open on this project.'
          : 'Session open. The editor is loading in a new tab.'
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not open the editor'
      );
    }
  }

  async function handleShip() {
    try {
      const result = await ship.mutateAsync({ note: note.trim() });
      setNote('');
      toast.success(
        result.dispatched
          ? `Shipping ${result.files} files. Every gate runs before this goes live.`
          : `Queued ${result.files} files. The worker could not be reached; the ` +
              'job is waiting and can be re-dispatched from the Pipeline tab.'
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not ship');
    }
  }

  async function handleClose() {
    try {
      await close.mutateAsync();
      toast.success('Session closed. Nothing was published.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not close');
    }
  }

  if (isLoading) {
    return (
      <div className="h-32 animate-pulse rounded-xl border border-[var(--ls-rule)] bg-[var(--ls-glass-bg)]" />
    );
  }
  if (error) {
    return (
      <p className="text-sm text-red-500">
        Could not load the editor session for this project.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <ShellCard>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--fs-ink)]">
          <PanelLeft className="h-4 w-4" aria-hidden />
          Flowstarter editor
        </h3>
        <p className="text-sm text-[var(--fs-ink-dim)]">
          Opens this client&rsquo;s site in a coding agent, on a fresh checkout
          of the version they have published. You can build anything in it
          &mdash; whole pages, new sections, an integration. Nothing you do
          there is live: shipping runs the same build and the same gates as
          every other change, and the gates decide what reaches the client.
        </p>

        {!data?.canOpen && (
          <p
            data-testid="operator-editor-blocked"
            className="mt-3 text-sm text-[var(--fs-ink-dim)]"
          >
            This project has no delivered site yet. The editor can be opened
            once the site is in human QA or live.
          </p>
        )}

        {data?.canOpen && !session && (
          <div className="mt-4">
            <Button
              data-testid="operator-editor-open"
              onClick={handleOpen}
              disabled={busy}
            >
              <ExternalLink className="mr-2 h-4 w-4" aria-hidden />
              {open.isPending ? 'Opening…' : 'Open in editor'}
            </Button>
            <p className="mt-2 text-xs text-[var(--fs-ink-dim)]">
              Cuts a worktree from version {data.currentVersion || 0} and signs
              you in for one minute.
            </p>
          </div>
        )}

        {session && (
          <div
            data-testid="operator-session"
            className="mt-4 rounded-lg border border-[var(--fs-rule)] p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={session.status} />
              <span className="text-xs text-[var(--fs-ink-dim)]">
                opened {compactRelative(session.createdAt)}
              </span>
            </div>
            <p data-testid="operator-session-headline" className="mt-2 text-sm">
              {session.headline}
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="outline"
                data-testid="operator-editor-reopen"
                onClick={handleOpen}
                disabled={busy}
              >
                <ExternalLink className="mr-2 h-4 w-4" aria-hidden />
                Open the editor
              </Button>
              <Button
                variant="outline"
                data-testid="operator-editor-close"
                onClick={handleClose}
                disabled={busy || session.status === 'shipping'}
              >
                <XCircle className="mr-2 h-4 w-4" aria-hidden />
                Close without shipping
              </Button>
            </div>

            {session.status === 'ready' && !session.stale && (
              <div className="mt-4 space-y-2">
                <Label htmlFor="operator-ship-note">
                  One line for the build record (optional)
                </Label>
                <Textarea
                  id="operator-ship-note"
                  data-testid="operator-ship-note"
                  rows={2}
                  maxLength={500}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Added the pricing page they asked for on the call."
                />
                <Button
                  data-testid="operator-editor-ship"
                  onClick={handleShip}
                  disabled={busy}
                >
                  <Rocket className="mr-2 h-4 w-4" aria-hidden />
                  {ship.isPending ? 'Shipping…' : 'Ship this'}
                </Button>
                <p className="flex items-start gap-1.5 text-xs text-[var(--fs-ink-dim)]">
                  <ShieldCheck
                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                    aria-hidden
                  />
                  Commits the worktree, then runs the build: it has to compile,
                  carry no placeholder copy or pictures, no empty images, and
                  nothing in its markup we did not allow. A gate that refuses
                  leaves the client&rsquo;s site exactly as it is and tells you
                  why here.
                </p>
              </div>
            )}

            {session.buildJobId && (
              <div className="mt-4">
                <BuildConversation
                  projectId={projectId}
                  jobId={session.buildJobId}
                  status={
                    session.status === 'shipping' ? 'running' : 'succeeded'
                  }
                />
              </div>
            )}
          </div>
        )}
      </ShellCard>

      {data && data.history.length > 0 && (
        <ShellCard>
          <h3 className="mb-2 text-sm font-semibold text-[var(--fs-ink)]">
            Earlier sessions
          </h3>
          <ul className="-mt-2">
            {data.history.map((entry) => (
              <SessionRow key={entry.id} session={entry} />
            ))}
          </ul>
        </ShellCard>
      )}
    </div>
  );
}
