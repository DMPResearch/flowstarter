'use client';

/**
 * "Connect LinkedIn or Instagram so the preview can use your photo."
 *
 * The one place in the funnel where the client's own face is asked for rather
 * than taken. `portrait-source.ts` is the rule behind it: scraping behind a
 * login is not acceptable, so the two sources that can produce a real,
 * full-size portrait are the two where the person presses the button
 * themselves. This panel is that button, and nothing else.
 *
 * Three decisions worth stating.
 *
 * A BUTTON THAT CANNOT WORK MUST NOT LOOK LIKE ONE THAT CAN. The deployment
 * may hold credentials for neither provider, one, or both, and only the server
 * knows which. So the panel asks `/api/connect/availability` before it draws
 * anything clickable, both buttons stay disabled while that is in flight, and
 * a request that fails is read as "unavailable" rather than as "probably
 * fine". A disabled button that says why is a worse offer and a better
 * experience than a click that returns a 500.
 *
 * IT IS SKIPPABLE AND IT SAYS SO. This is the only optional question in the
 * quick phase. Somebody who has no LinkedIn, does not want their face on the
 * site, or simply does not feel like signing in mid-intake must reach the
 * preview at exactly the same speed as somebody who connects. The Skip lives
 * in the conversation next to the confirm button; see `IntakeConversation`.
 *
 * THE ROUND TRIP IS A FULL PAGE REDIRECT, NOT A POPUP. The wizard's draft
 * lives in sessionStorage, so leaving the page and coming back costs nothing,
 * and a redirect works inside an in-app browser where a popup is blocked or
 * silently orphaned. `DiscoveryWizard` reads the outcome back off the URL.
 *
 * The component decides nothing about the picture itself. Whether what comes
 * back is usable, and where it may be placed, is `portrait-source.ts`'s
 * verdict on the server side; this draws the offer and reports the answer.
 */
import { useEffect, useState } from 'react';

import type { DiscoveryData } from '../discovery.logic';

const KEY = 'landing.discovery.connect.';

/** The two providers, in the order `PORTRAIT_SOURCE_ORDER` prefers them. */
const PROVIDERS = ['linkedin', 'instagram'] as const;

type Provider = (typeof PROVIDERS)[number];

/** One entry of `GET /api/connect/availability`. */
interface ProviderAvailability {
  provider: Provider;
  available: boolean;
  missing: string[];
}

export interface ConnectPortraitProps {
  data: DiscoveryData;
  /** The wizard's own setter, same shape the other two panels take. */
  update: <K extends keyof DiscoveryData>(
    key: K,
    value: DiscoveryData[K]
  ) => void;
  t: (key: string) => string;
  /** Injected in tests so nothing here touches the network or navigates. */
  fetchImpl?: typeof fetch;
  navigate?: (url: string) => void;
}

/**
 * A namespace for the funnel assets a connected portrait is filed under.
 *
 * `crypto.randomUUID` where there is one, and a v4 assembled from
 * `Math.random` where there is not, which covers an older in-app browser and a
 * non-secure origin. The weaker fallback is deliberate and safe: this id is a
 * NAMESPACE, NOT A SECRET. The security of the round trip is the signed state
 * the start route mints and the callback verifies, so guessing this buys an
 * attacker a folder name and nothing else.
 */
function mintPreviewId(): string {
  const random = globalThis.crypto;
  if (random && typeof random.randomUUID === 'function') {
    return random.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    const digit = char === 'x' ? value : (value % 4) + 8;
    return digit.toString(16);
  });
}

/**
 * The sentence for what came back, resolved in one place so the panel and the
 * brief cannot disagree about what an outcome means.
 *
 * `connected` and `cancelled` have their own lines because they are the two
 * ordinary endings and neither of them is a failure. Anything that names a
 * reason `portrait-source.ts` knows gets that reason's own sentence, which is
 * the whole point of `PortraitSourceReason` being a closed set. Everything
 * else falls to one honest generic line rather than to a code the visitor
 * cannot act on.
 */
function outcomeKey(
  provider: Provider,
  outcome: string,
  t: (key: string) => string
): string {
  if (outcome === 'connected') return `${KEY}connected`;
  if (outcome === 'cancelled') return `${KEY}cancelled`;
  // Instagram's personal-account wall is terminal and provider specific, so it
  // gets the line that explains the way in rather than a bare reason.
  if (provider === 'instagram' && outcome === 'personal_account') {
    return `${KEY}instagramPersonal`;
  }
  const reasonKey = `portrait.reason.${outcome}`;
  return t(reasonKey) === reasonKey ? `${KEY}failed` : reasonKey;
}

const buttonBase =
  'rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-all';
const buttonReady = `${buttonBase} border-[var(--fs-rule)] text-[var(--fs-ink)] hover:border-[var(--purple-primary)]/50 hover:bg-[var(--purple-primary)]/[0.06]`;
const buttonBlocked = `${buttonBase} cursor-not-allowed border-dashed border-[var(--fs-rule)] text-[var(--fs-ink-faint)] opacity-60`;

export function ConnectPortrait({
  data,
  update,
  t,
  fetchImpl,
  navigate,
}: ConnectPortraitProps) {
  /** null while the answer is in flight. Both buttons are disabled until it lands. */
  const [availability, setAvailability] = useState<Record<
    Provider,
    boolean
  > | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    let live = true;
    const request = fetchImpl ?? fetch;
    void (async () => {
      try {
        const response = await request('/api/connect/availability');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as {
          providers?: ProviderAvailability[];
        };
        if (!live) return;
        const read = (provider: Provider) =>
          Boolean(
            body.providers?.find((entry) => entry.provider === provider)
              ?.available
          );
        setAvailability({
          linkedin: read('linkedin'),
          instagram: read('instagram'),
        });
      } catch {
        // A question we cannot answer is answered "no". Offering a button that
        // will fail is worse than offering one that says it is not ready.
        if (live) setAvailability({ linkedin: false, instagram: false });
      }
    })();
    return () => {
      live = false;
    };
  }, [fetchImpl]);

  const outcome = data.portraitConnect;

  const start = (provider: Provider) => {
    // Minted once and reused, so a visitor who tries LinkedIn, changes their
    // mind and tries Instagram files both attempts under the same namespace.
    const previewId = data.portraitPreviewId ?? mintPreviewId();
    if (!data.portraitPreviewId) update('portraitPreviewId', previewId);
    const returnTo = encodeURIComponent(
      `${window.location.pathname}${window.location.search}`
    );
    setLeaving(true);
    const go =
      navigate ??
      ((url: string) => {
        window.location.href = url;
      });
    go(
      `/api/connect/${provider}/start?previewId=${previewId}&returnTo=${returnTo}`
    );
  };

  if (outcome) {
    return (
      <div
        data-testid="connect-outcome"
        data-outcome={outcome.outcome}
        data-provider={outcome.provider}
        className="text-sm leading-snug text-[var(--fs-ink)]"
      >
        {t(outcomeKey(outcome.provider, outcome.outcome, t))}
      </div>
    );
  }

  const anyBlocked =
    availability !== null && PROVIDERS.some((p) => !availability[p]);

  return (
    <div data-testid="connect-portrait" className="space-y-2.5">
      <p className="text-sm font-semibold text-[var(--fs-ink)]">
        {t(`${KEY}title`)}
      </p>
      <p className="text-[12px] leading-snug text-[var(--fs-ink-faint)]">
        {t(`${KEY}note`)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {PROVIDERS.map((provider) => {
          const available = availability?.[provider] ?? false;
          // Disabled while the availability answer is still in flight too: a
          // button whose consequence is unknown is not a button yet. It keeps
          // its ordinary label until then, because "not available" is an
          // answer and we have not had one.
          const blocked = !available || leaving;
          const named = available || availability === null;
          return (
            <button
              key={provider}
              type="button"
              data-testid={`connect-${provider}`}
              data-available={String(available)}
              disabled={blocked}
              aria-disabled={blocked}
              onClick={() => start(provider)}
              className={available && !leaving ? buttonReady : buttonBlocked}
            >
              {named ? t(`${KEY}${provider}`) : t(`${KEY}unavailable`)}
            </button>
          );
        })}
      </div>
      {leaving ? (
        <p
          data-testid="connect-busy"
          className="text-[12px] text-[var(--fs-ink-faint)]"
        >
          {t(`${KEY}busy`)}
        </p>
      ) : null}
      {anyBlocked ? (
        <p
          data-testid="connect-unavailable-note"
          className="text-[12px] leading-snug text-[var(--fs-ink-faint)]"
        >
          {t(`${KEY}unavailableNote`)}
        </p>
      ) : null}
    </div>
  );
}
