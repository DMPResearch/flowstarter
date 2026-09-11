/**
 * A client editing their own site.
 *
 * `requireWorkspaceAccess` runs before anything is read, and everything under
 * it is a service-role query that bypasses RLS — so that check is the whole
 * tenant boundary, exactly as on the project page next door. A caller who is
 * not a member gets the same 404 the API gives, which tells a prober nothing
 * about whether the workspace exists.
 *
 * The policy is evaluated here as well as on every route. The copy on this
 * page is the *mirror*; the routes are the boundary. A client whose plan has
 * lapsed still sees the editor, still sees their site, and is told in the
 * policy's own words why the controls will not run — which is the difference
 * between a paused feature and a broken one.
 */
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { requireWorkspaceAccess } from '@/lib/api-auth';
import {
  editCreditPosition,
  startOfUtcMonth,
} from '@/lib/flowstarter/edit-credits';
import {
  DAILY_EDIT_CAP,
  MAX_INSTRUCTION_CHARS,
  SiteEditorError,
  countProposalsSince,
  countProposalsToday,
  decideEditorAction,
  listEditableTargets,
  listSiteVersions,
  loadWorkspaceSite,
} from '@/lib/flowstarter/site-editor';
import { findBuiltIndex } from '@/lib/flowstarter/site-preview';
import { SiteEditor } from '@/components/flowstarter/editor/SiteEditor';
import type { EditorState } from '@/components/flowstarter/editor/editor-client';

export const dynamic = 'force-dynamic';

export default async function ClientSiteEditorPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) {
    if (access.response.status === 401) {
      redirect(`/login?next=/dashboard/projects/${workspaceId}/editor`);
    }
    notFound();
  }

  let site;
  try {
    site = await loadWorkspaceSite(access.workspaceId);
  } catch (error) {
    // A project whose site has not been generated yet is not an error worth a
    // stack trace; it simply has nothing to edit.
    if (error instanceof SiteEditorError && error.status === 404) {
      return <NothingToEdit workspaceId={workspaceId} />;
    }
    throw error;
  }

  const editorAccess = {
    actorId: access.userId,
    role: access.via === 'team' ? ('operator' as const) : ('client' as const),
    subscriptionStatus: site.subscriptionStatus,
  };

  // One clock for the page, for the same reason the edit route uses one: the
  // day window, the month window and the reset date the client is quoted all
  // have to come from the same instant.
  const now = new Date();
  const [versions, used, usedThisMonth] = await Promise.all([
    listSiteVersions(access.workspaceId),
    countProposalsToday(access.workspaceId, now),
    countProposalsSince(access.workspaceId, startOfUtcMonth(now)),
  ]);

  const initial: EditorState = {
    site: {
      name: site.workspaceName,
      version: site.version,
      templateSlug: site.templateSlug,
      rendersBuiltHtml: Boolean(findBuiltIndex(site.files)),
    },
    targets: listEditableTargets(site.files).map((target) => ({
      id: target.id,
      key: target.key,
      section: target.section,
      content: target.content,
      file: target.file,
      line: target.line,
    })),
    versions,
    allowance: {
      used,
      cap: DAILY_EDIT_CAP,
      maxInstructionChars: MAX_INSTRUCTION_CHARS,
      credits: editCreditPosition({
        tier: site.tierName,
        usedThisMonth,
        now,
      }),
    },
    policy: {
      content: decideEditorAction(editorAccess, 'content'),
      image: decideEditorAction(editorAccess, 'image'),
      structural: decideEditorAction(editorAccess, 'layout'),
    },
  };

  return <SiteEditor workspaceId={workspaceId} initial={initial} />;
}

function NothingToEdit({ workspaceId }: { workspaceId: string }) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 py-16">
      <h1 className="text-2xl font-bold text-[var(--fs-ink)]">
        Your site is not ready to edit yet
      </h1>
      <p className="text-sm leading-relaxed text-[var(--fs-ink)]/70">
        Once we have built your site, this is where you will change the words
        and the pictures on it yourself.
      </p>
      <Link
        href={`/dashboard/projects/${workspaceId}`}
        className="w-fit rounded-full bg-[var(--fs-ink)] px-5 py-2.5 text-sm font-semibold text-white"
      >
        Back to your project
      </Link>
    </main>
  );
}
