'use client';

/**
 * The agent's activity timeline, wired to this app's dictionary.
 *
 * The design system draws it and `@flowstarter/agentic-codegen` decides what
 * the steps are; this is the seam between them. Every surface that shows the
 * agent working mounts this one component -- the funnel preview, the client
 * dashboard while a build runs, the editor while a change is applied, the
 * operator board -- so a change to the phrasing or the collapse rule lands on
 * all four at once, which is the whole reason it is not four components.
 *
 * `detail` is the only thing that differs between a client's copy and an
 * operator's. With it off, file paths and raw gate verdicts never leave the
 * server; with it on they are shown, because an operator is the person who
 * has to go and look at the file.
 */
import type { AgentActivityEvent } from '@flowstarter/agentic-codegen/src/flowstarter/activity';
import {
  AgentActivity,
  type AgentActivityProps,
} from '@flowstarter/flow-design-system';
import { useMemo } from 'react';
import { useOptionalI18n } from '@/lib/i18n';
import en from '@/locales/en';
import {
  activityFailureLine,
  activityStatus,
  activitySteps,
  activitySummaryLine,
  activityTranslate,
  type ActivityTranslate,
} from '@/lib/flowstarter/activity/steps';

export interface AgentActivityPanelProps
  extends Pick<
    AgentActivityProps,
    'surface' | 'dense' | 'defaultOpen' | 'footer' | 'className'
  > {
  /** Oldest first, exactly as they arrived. This component does not sort. */
  events: readonly AgentActivityEvent[];
  /** The header line. A dictionary key, so each surface names its own work. */
  headline: string;
  /**
   * What the work is about: a business name, a page, the change that was
   * asked for. Left out when the headline already says it.
   */
  topic?: string;
  /**
   * Overrides the status read from the events. The funnel knows its preview
   * failed before a `failed` event can reach it, so it may say so.
   */
  status?: AgentActivityProps['status'];
  /** Show file paths and gate verdicts. Operators only. */
  detail?: boolean;
  /**
   * The dictionary, when the surface threads one down rather than mounting a
   * provider. The discovery wizard passes `t` as a prop the whole way; the
   * dashboard, the editor and the operator board have a provider. Leave it
   * unset and the provider is used.
   */
  t?: (key: string, vars?: Record<string, string | number>) => string;
}

/**
 * The dictionary this component and its callers read, from three sources in
 * order: the prop a surface threaded down, the provider above, and the
 * English catalogue.
 *
 * The last is not a fallback anyone should rely on. It is there because this
 * timeline is mounted on four surfaces, two of which thread `t` as a prop
 * rather than mounting a provider, and a progress panel must never be the
 * reason a page throws. English is this catalogue's base layer in any case:
 * `ro.ts` overrides a handful of keys and falls through to `en` for the rest.
 */
export function useActivityTranslate(
  provided?: (key: string, vars?: Record<string, string | number>) => string
): ActivityTranslate {
  const context = useOptionalI18n();
  return useMemo(() => {
    if (provided) return activityTranslate(provided);
    if (context) return activityTranslate(context.t);
    return activityTranslate(
      (key: string, vars?: Record<string, string | number>) => {
        let template: string = (en as Record<string, string>)[key] ?? key;
        for (const [name, value] of Object.entries(vars ?? {})) {
          template = template.replace(
            new RegExp(`\\{${name}\\}`, 'g'),
            String(value)
          );
        }
        return template;
      }
    );
  }, [provided, context]);
}

export function AgentActivityPanel({
  events,
  headline,
  topic,
  status,
  detail = false,
  t: translateProp,
  ...rest
}: AgentActivityPanelProps) {
  const t = useActivityTranslate(translateProp);

  const resolved = status ?? activityStatus(events);
  const steps = useMemo(
    () => activitySteps(events, t, { detail, status: resolved }),
    [events, t, detail, resolved]
  );
  const summary = useMemo(() => activitySummaryLine(events, t), [events, t]);
  const failure = useMemo(
    () => (resolved === 'failed' ? activityFailureLine(events, t) : ''),
    [events, t, resolved]
  );

  // No events, nothing to say. A surface that wants a placeholder draws its
  // own; this one will not invent a first step to have something on screen.
  if (steps.length === 0) return null;

  return (
    <AgentActivity
      status={resolved}
      headline={headline}
      {...(topic ? { topic } : {})}
      steps={steps}
      summary={summary}
      {...(failure ? { failure } : {})}
      labels={{
        region: t('agentActivity.region'),
        expand: t('agentActivity.expand'),
        collapse: t('agentActivity.collapse'),
      }}
      {...rest}
    />
  );
}
