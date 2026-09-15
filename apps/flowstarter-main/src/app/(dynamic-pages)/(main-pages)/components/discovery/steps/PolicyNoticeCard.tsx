'use client';

/**
 * A policy notice, rendered.
 *
 * Every word comes from `@/lib/policy/copy` through the server: the title, the
 * sentence, what happens next, the two link labels, and the language all five
 * are written in. This component owns the card they sit in and nothing else,
 * which is why it takes no `t` and has no locale keys.
 *
 * Shared by the two surfaces that can now stop a visitor -- the intake
 * conversation (`IntakeGraphConversation`) and the routing gate
 * (`ScopeGateStep`) -- because they are showing the same verdict from the same
 * gate and a second, slightly different refusal card is how two screens come
 * to disagree about what the policy said.
 *
 * It renders nothing at all when there is no notice, deliberately. Inventing a
 * refusal sentence in the browser is how a screen ends up asserting something
 * the gate never decided; if the server did not say why, this says nothing
 * rather than guessing.
 */
import type { PolicyNotice } from '@/lib/policy/copy';

/** The card, shared with `ScopeGateStep`'s other faces so the widths match. */
export const POLICY_CARD =
  'rounded-2xl border border-[var(--fs-rule)] bg-[var(--fs-surface)] p-6 sm:p-7';

export function PolicyNoticeCard({
  policy,
  testId,
}: {
  policy?: PolicyNotice | null;
  /** Lets a walk-through test tell the refusal from the hold on screen. */
  testId?: string;
}) {
  if (!policy) return null;
  return (
    <div
      className={POLICY_CARD}
      role="status"
      aria-live="polite"
      data-testid={testId ?? 'policy-notice'}
      data-policy-decision={policy.decision}
      data-policy-locale={policy.locale}
    >
      <h3 className="text-lg font-bold text-[var(--fs-ink)]">{policy.title}</h3>
      <p className="mt-2 text-sm text-[var(--fs-ink)]">{policy.message}</p>
      <p className="mt-3 text-sm text-[var(--fs-ink-faint)]">{policy.next}</p>
      <div className="mt-4 flex flex-wrap gap-3 text-[12px] font-semibold">
        <a className="underline" href={policy.termsHref}>
          {policy.termsLabel}
        </a>
        <a className="underline" href={policy.contactHref}>
          {policy.contactLabel}
        </a>
      </div>
    </div>
  );
}
