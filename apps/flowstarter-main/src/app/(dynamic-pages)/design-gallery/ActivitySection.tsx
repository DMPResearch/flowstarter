'use client';

/**
 * The agent activity timeline, in every state it has, on fixture events.
 *
 * `AgentActivityPanel` is a client component that reads the dictionary, so it
 * needs an `I18nProvider` the way the admin embeds in `AdminSection.tsx` need
 * theirs. It needs nothing else -- no query client, no sidebar, no admin
 * chrome -- so this wrapper is the lighter one rather than a copy of
 * `AdminEmbed` with three quarters of it unused.
 *
 * The four panels below are fed events, not steps. What is being reviewed in
 * a screenshot of this page is the collapse rule folding a burst into a count,
 * the phrasing rule turning `section.services` into "the services section",
 * and the summary rule counting pages and gates -- none of which would be
 * exercised by a fixture that wrote the sentences out.
 */
import type { AgentActivityEvent } from '@flowstarter/agentic-codegen/src/flowstarter/activity';
import { MeshBackdrop } from '@flowstarter/flow-design-system/components/backgrounds/MeshBackdrop';
import { AgentActivityPanel } from '@/components/flowstarter/AgentActivityPanel';
import { I18nProvider, useTranslations } from '@/lib/i18n';
import en from '@/locales/en';
import {
  galleryActivityFailed,
  galleryActivityFinished,
  galleryActivityRunning,
} from './fixtures';

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-widest text-[var(--fs-ink-faint)]">
      {children}
    </p>
  );
}

function Case({
  caption,
  events,
  headline,
  status,
  detail = false,
  defaultOpen,
}: {
  caption: string;
  events: AgentActivityEvent[];
  headline: string;
  status?: 'running' | 'done' | 'failed';
  detail?: boolean;
  defaultOpen?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Caption>{caption}</Caption>
      <AgentActivityPanel
        events={events}
        headline={headline}
        {...(status ? { status } : {})}
        {...(detail ? { detail: true } : {})}
        {...(defaultOpen === undefined ? {} : { defaultOpen })}
        surface="card"
      />
    </div>
  );
}

/**
 * Inside the provider, so the headlines come out of the dictionary the
 * product reads rather than being typed here. The captions above each panel
 * are the gallery's own labels, like the section titles in `page.tsx`.
 */
function Cases() {
  const { t } = useTranslations();
  return (
    <div className="relative z-10 mx-auto grid w-full max-w-6xl gap-6 p-6 md:grid-cols-2">
      <Case
        caption="Running, as a client sees it"
        events={galleryActivityRunning}
        headline={t('agentActivity.headline.build')}
      />
      <Case
        caption="Running, as an operator sees it"
        events={galleryActivityRunning}
        headline={t('agentActivity.headline.build')}
        detail
      />
      <Case
        caption="Finished, folded to its summary"
        events={galleryActivityFinished}
        headline={t('agentActivity.headline.buildDone')}
      />
      <Case
        caption="Finished, opened"
        events={galleryActivityFinished}
        headline={t('agentActivity.headline.buildDone')}
        defaultOpen
      />
      <Case
        caption="Stopped at a gate"
        events={galleryActivityFailed}
        headline={t('agentActivity.headline.stopped')}
      />
      <Case
        caption="Stopped at a gate, with the operator verdict"
        events={galleryActivityFailed}
        headline={t('agentActivity.headline.stopped')}
        detail
      />
    </div>
  );
}

export function AgentActivityGallery() {
  return (
    <I18nProvider initialLocale="en" initialMessages={{ en }}>
      {/* The same wrapper the client dashboard section uses, and for the same
          reason: `MeshBackdrop` is fixed and opaque, and without a transformed
          ancestor it escapes this box and paints over the page above it. */}
      <div
        className="relative overflow-hidden"
        style={{ transform: 'translateZ(0)' }}
      >
        <MeshBackdrop variant="app" />
        <Cases />
      </div>
    </I18nProvider>
  );
}
