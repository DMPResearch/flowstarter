'use client';

import { useAuth } from '@clerk/nextjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type DiscoveryData,
  type DemoSite,
  type GeneratedSiteCopy,
  type Tier,
  type ToneId,
  DEMO_STATE_KEY,
  MAX_DEMO_EDITS,
  buildDemoSite,
  previewCtaLabel,
  recommendTier,
} from '../discovery.logic';
import {
  KEEP_EXPLORING_LABEL,
  agentForPhase,
  depositCtaLabel,
  depositQuote,
  previewMeaningMessage,
  previewReadyMessage,
} from '../concierge.shared';
import {
  claimIntakeChatPayload,
  describeWithIntakeAnswers,
} from '../intake-chat.shared';
import { withQuickDefaults } from '../quick-defaults';
import { usePreviewProgress } from '../usePreviewProgress';
import { formatPreviewExpiry } from '@/components/flowstarter/site-link';
import { DemoSiteFrame } from './DemoSiteFrame';
import { BrandStrip, type BrandStripProps } from './BrandStrip';
import { ProfilePictureConsent } from './ProfilePictureConsent';
import { DerivedSiteSkeleton } from './IntakePreviewPane';
import {
  ChatBubble,
  ConciergePanes,
  ConversationLog,
  NowLine,
  SITE_PANE_HEIGHT_CLASS,
  useElapsedSeconds,
  useSiteViewport,
  type NowState,
} from './ConciergePanes';

/**
 * Step 8 — the generation stage of the concierge conversation.
 *
 * The visitor does not change screens between the info agent and this: the
 * same two panes stay up, the same conversation keeps running. What changes is
 * who is talking. The info agent stops asking, and the build agents start
 * reporting — each pipeline phase arrives as a message signed by the
 * specialist that owns it, while the site itself assembles on the right, from
 * a page-shaped skeleton to the base template to the personalized site.
 *
 * The offer is stated twice, in plain words, because a preview that is mistaken
 * for a finished site is a refund conversation later: this is a preview of the
 * full site, a 20% deposit has it built, the balance falls due on completion.
 *
 * Primary path: the in-sandbox autonomous Agent-SDK pipeline
 * (/api/discovery/preview/live) builds a real personalized site in a Daytona
 * sandbox; we embed its live URL and give the visitor up to 15 plain-English
 * prompts, applied by the agent in the same sandbox (HMR updates the preview).
 * If the live pipeline is unavailable or fails, the funnel says so out loud and
 * offers the choice — try again, or take the deterministic JSON preview.
 */

// Two free changes before the deposit ask — enough to see the team edit the
// site live, few enough that the preview never becomes the product. Must
// match LIVE_EDIT_CAP in lib/discovery/live-jobs.ts (server-enforced).
const LIVE_EDIT_CAP = 2;

/**
 * Render a friendly fake hostname for the iframe chrome bar
 * (e.g. "acmebakery.preview"). Makes the demo feel like a real site
 * the visitor owns, hides the raw daytonaproxy01.net host.
 */
function previewHostLabel(businessName: string | undefined): string {
  const slug = (businessName || 'yoursite')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24);
  return `${slug || 'yoursite'}.preview`;
}

interface DemoState {
  demoId: string | null;
  site: DemoSite;
  editsUsed: number;
}

function fallbackSite(data: DiscoveryData): DemoSite {
  const firstSentence =
    data.description.trim().split(/[.!?]/)[0]?.trim() ||
    'Work worth showing off, online at last';
  const copy: GeneratedSiteCopy = {
    hero: {
      headline: firstSentence.slice(0, 60),
      subhead: data.targetAudience.trim()
        ? `Made for ${data.targetAudience.trim()}.`
        : data.description.trim().slice(0, 140),
      primaryCta: previewCtaLabel(data.goal),
    },
    services: {
      sectionTitle: 'What we do',
      items: [
        { title: 'Tailored to you', description: 'Built around your offer.' },
        {
          title: 'Yours to edit',
          description: 'Change anything in plain words.',
        },
        { title: 'Live fast', description: 'Online in weeks, not months.' },
      ],
    },
    about: {
      sectionTitle: 'About',
      paragraph:
        data.description.trim() ||
        'A short, honest description of the business goes here.',
    },
    finalCta: {
      headline: 'Ready when you are',
      subhead: 'Let’s build something you’ll be proud of.',
      button: previewCtaLabel(data.goal),
    },
  };
  return buildDemoSite(
    {
      businessName: data.businessName,
      fullName: data.fullName,
      industry: data.industry,
      targetAudience: data.targetAudience,
      brandTone: (data.brandTone || '') as ToneId | '',
    },
    copy
  );
}

type Mode = 'loading' | 'live' | 'json';
interface ChatTurn {
  role: 'you' | 'agent';
  text: string;
}

/**
 * Shared by both the JSON-fallback and the live-preview POST: the info-agent
 * step's answers ride in on `description`, the only free-prose field the
 * generator takes. Without this the conversation would only reach the
 * generator after a claim, and the preview shown right now would ignore
 * what the visitor just told us.
 */
function previewPayload(raw: DiscoveryData) {
  // The four answers, plus everything the intake stopped asking, derived by
  // rule from the visitor's own sentence. The generator needs an industry
  // and a page budget whether or not anybody was asked for one, and a
  // defensible guess beats a blank that the page-set rule reads as zero.
  const data = withQuickDefaults(raw);
  return {
    businessName: data.businessName,
    fullName: data.fullName,
    // The intake asks "Where should I send your preview once it's ready?" and
    // this is the request that knows when it is ready. Dropping it here is
    // what made that question a lie.
    email: data.email,
    description: describeWithIntakeAnswers(data),
    industry: data.industry,
    targetAudience: data.targetAudience,
    goal: data.goal,
    brandTone: data.brandTone,
    // Collected two steps earlier and previously dropped here, which left
    // every generated site with placeholder social links.
    instagramUrl: data.instagramUrl,
    linkedinUrl: data.linkedinUrl,
    // A site they already have. The brief type has carried
    // `existingWebsiteUrl` since it was written with nothing ever setting it.
    websiteUrl: data.websiteUrl ?? '',
    // What someone actually buys. The generator's services section is written
    // from this rather than inferred from the description.
    offer: data.offer ?? '',
    // The palette and the voice the brand step derived, passed through rather
    // than re-derived: the visitor has already been shown these swatches, and
    // deriving them twice could disagree with what they saw.
    ...(data.brandPalette ? { palette: data.brandPalette } : {}),
    ...(data.brandVoice
      ? {
          tone: {
            adjectives: data.brandVoice.adjectives,
            voice: data.brandVoice.voice,
          },
        }
      : {}),
    // The page-count answer decides how many pages the generator may build.
    // Dropping it here is what gave a "Under 5" brief a seven-page site.
    ...(data.pageCount ? { pageCount: data.pageCount } : {}),
    calComUrl: data.calComUrl,
    customIntegrations: data.customIntegrations,
  };
}

export function PreviewStep({
  data,
  t,
  brand,
}: {
  data: DiscoveryData;
  t: (key: string) => string;
  /**
   * The colours and the voice, derived while the visitor answered the fourth
   * question. Shown here rather than only in the intake pane because the
   * intake pane is on screen for about a second after the links land: this is
   * where the visitor actually waits, and seeing their own colours while the
   * build runs is the whole argument for having read their profile at all.
   */
  brand?: Omit<BrandStripProps, 't'>;
}) {
  const [mode, setMode] = useState<Mode>('loading');
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [liveDemoId, setLiveDemoId] = useState<string | null>(null);
  const [iframeNonce, setIframeNonce] = useState(0);
  const [personalizing, setPersonalizing] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);

  // Real-time build progress over SSE (falls back to polling only if the
  // stream errors or is unavailable — see usePreviewProgress).
  const progress = usePreviewProgress(liveDemoId);

  // Conversational editor (live mode).
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [editPrompt, setEditPrompt] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editsLeft, setEditsLeft] = useState(LIVE_EDIT_CAP);

  // JSON-fallback demo + its inline editor.
  const [demo, setDemo] = useState<DemoState | null>(null);
  const [prompt, setPrompt] = useState('');
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Honesty about the build: a failed pipeline is said out loud and the
  // visitor picks what happens next. Nothing falls back behind their back.
  const [buildFailure, setBuildFailure] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // Set when the environment cannot run generation at all (route responded
  // `reason: 'not-configured'`, checked before a job ever started). Distinct
  // from `steppedDown`: there is no simpler preview to fall back to here,
  // the visitor's build genuinely has to be made by hand, so the intake ends
  // instead of quietly substituting the JSON demo.
  const [deferred, setDeferred] = useState(false);
  // Set when the live pipeline was never available (budget, config, skip) and
  // the deterministic preview stood in for it.
  const [steppedDown, setSteppedDown] = useState(false);

  // The offer, and the quiet way past it.
  const [offerSnoozed, setOfferSnoozed] = useState(false);
  // The deposit ask waits until the visitor has seen editing in action: it
  // reveals after both free changes are spent, or when they ask for it
  // themselves. Deterministic — a counter and a click, no model involved.
  const [offerRevealed, setOfferRevealed] = useState(false);

  // A fresh frame starts invisible and fades in once it has painted.
  useEffect(() => {
    setFrameLoaded(false);
  }, [iframeNonce, liveUrl]);

  // The live site is laid out at desktop width and scaled to the pane, so
  // what the visitor sees is the page as a laptop would show it.
  const viewport = useSiteViewport();

  // Shared by the mount effect below (on a failed/skip POST) and by the
  // visitor's own choice after a failure: whichever path a preview takes,
  // this is the one place that decides what "no live preview" falls back to.
  const loadJsonFallback = useCallback(async () => {
    setBuildFailure(null);
    if (typeof window !== 'undefined') {
      try {
        const raw = window.sessionStorage.getItem(DEMO_STATE_KEY);
        if (raw) {
          const saved = JSON.parse(raw) as DemoState;
          if (saved?.site) {
            setDemo(saved);
            setMode('json');
            return;
          }
        }
      } catch {
        /* ignore */
      }
    }
    try {
      const res = await fetch('/api/discovery/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(previewPayload(data)),
      });
      const json = (await res.json().catch(() => ({}))) as {
        site?: DemoSite;
        demoId?: string | null;
        skip?: boolean;
      };
      if (res.ok && json.site) {
        setDemo({
          demoId: json.demoId ?? null,
          site: json.site,
          editsUsed: 0,
        });
      } else {
        setDemo({ demoId: null, site: fallbackSite(data), editsUsed: 0 });
        setNotice(t('landing.discovery.preview.editorUnavailable'));
      }
    } catch {
      setDemo({ demoId: null, site: fallbackSite(data), editsUsed: 0 });
      setNotice(t('landing.discovery.preview.editorUnavailable'));
    } finally {
      setMode('json');
    }
  }, [data, t]);

  const shownBaseRef = useRef(false);
  const resolvedRef = useRef(false);

  // The honest ending when generation cannot run here at all: no build to
  // retry, no simpler preview to swap in, so the one thing left to do is
  // make sure the interest is not lost. Same endpoint and payload shape the
  // non-conversational wizard already uses for `/api/discovery/lead`, best
  // effort like every lead capture in this app: the visitor sees the ending
  // message either way.
  const captureDeferredLead = useCallback(async () => {
    try {
      const tier = (data.selectedTier as Tier | '') || recommendTier(data).tier;
      await fetch('/api/discovery/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          selectedTier: tier,
          source: 'preview-unavailable',
        }),
      });
    } catch {
      /* best-effort: the visitor still sees the honest ending either way */
    }
  }, [data]);

  const startLive = useCallback(
    async (isCancelled: () => boolean) => {
      try {
        const res = await fetch('/api/discovery/preview/live', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(previewPayload(data)),
        });
        const json = (await res.json().catch(() => ({}))) as {
          demoId?: string;
          skip?: boolean;
          reason?: string;
        };
        if (isCancelled()) return;
        if (json.reason === 'not-configured') {
          // Not a failed build and not a "simpler preview instead" moment:
          // the pipeline never had a chance to run in this environment, so
          // the intake ends here, honestly, with the lead captured.
          setDeferred(true);
          void captureDeferredLead();
          return;
        }
        if (json.skip || !json.demoId) {
          // The pipeline was never started (budget, or an explicit skip).
          // That is not a build that failed, but the visitor is still told
          // the preview they get is the simpler one.
          setSteppedDown(true);
          void loadJsonFallback();
          return;
        }
        setLiveDemoId(json.demoId);
      } catch {
        if (!isCancelled()) {
          setSteppedDown(true);
          void loadJsonFallback();
        }
      }
    },
    [data, loadJsonFallback, captureDeferredLead]
  );

  useEffect(() => {
    let cancelled = false;

    // Defer the kickoff one macrotask so React Strict Mode's
    // mount → unmount → remount cancels the throwaway first run *before*
    // it POSTs. Exactly one live job is ever created (dev and prod alike);
    // the surviving mount is the one whose demoId feeds usePreviewProgress,
    // which takes it from there over SSE.
    const startTimer = setTimeout(() => {
      if (!cancelled) void startLive(() => cancelled);
    }, 30);
    return () => {
      cancelled = true;
      clearTimeout(startTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Offered after a failure: same brief, a second attempt at the real build. */
  const retryLive = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    setBuildFailure(null);
    shownBaseRef.current = false;
    resolvedRef.current = false;
    setLiveUrl(null);
    setPersonalizing(false);
    setChat([]);
    setLiveDemoId(null);
    try {
      await startLive(() => false);
    } finally {
      setRetrying(false);
    }
  }, [retrying, startLive]);

  // Drives the live-preview state machine off the SSE-backed progress hook
  // instead of a manual poll loop: show the base template the moment the
  // build reports ready, hand over once personalization lands, or say so if
  // the build fails. shownBaseRef/resolvedRef make each transition fire
  // exactly once, same as the old loop's early `return`s.
  useEffect(() => {
    if (!liveDemoId) return;

    // First time it's ready: show the base template live immediately.
    if (
      progress.status === 'ready' &&
      progress.previewUrl &&
      !shownBaseRef.current
    ) {
      shownBaseRef.current = true;
      setLiveUrl(progress.previewUrl);
      setMode('live');
      setPersonalizing(!progress.personalized);
      setChat([
        {
          role: 'agent',
          text: progress.personalized
            ? `Your site is live. You have ${LIVE_EDIT_CAP} changes on me: tell me what to adjust and watch it happen.`
            : 'Here’s your starting point, personalizing it for your business now…',
        },
      ]);
    }

    // Personalization hot-swapped in: refresh the iframe, hand over.
    if (shownBaseRef.current && progress.personalized && !resolvedRef.current) {
      resolvedRef.current = true;
      setPersonalizing(false);
      setIframeNonce((n) => n + 1);
      setChat([
        {
          role: 'agent',
          text: `Your personalized site is live. You have ${LIVE_EDIT_CAP} changes on me: tell me what to adjust and watch it happen.`,
        },
      ]);
      return;
    }

    if (progress.status === 'failed' && !resolvedRef.current) {
      resolvedRef.current = true;
      setBuildFailure(progress.error ?? 'Generation failed');
      return;
    }

    if (
      shownBaseRef.current &&
      progress.phase &&
      /personalization unavailable/i.test(progress.phase) &&
      !resolvedRef.current
    ) {
      // Fail-soft: base template stays as a real, relevant demo.
      resolvedRef.current = true;
      setPersonalizing(false);
    }
  }, [progress, liveDemoId]);

  useEffect(() => {
    if (!demo || typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem(DEMO_STATE_KEY, JSON.stringify(demo));
    } catch {
      /* best-effort */
    }
  }, [demo]);

  // ---- Claim: the preview becomes a workspace this visitor owns ----
  //
  // Until this runs the preview is entirely ephemeral (a demo id, a sandbox,
  // nothing persisted), and the deposit flow can never see it. Claiming
  // creates the workspace, saves the generated manifest as its build
  // artifacts, and makes the signed-in visitor a member of it, which is
  // exactly what /unlock/[workspaceId] and the deposit Checkout check for.
  const { isSignedIn, isLoaded: authLoaded } = useAuth();
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  /**
   * The answer to the claim page's one picture question, defaulted to yes.
   *
   * Held here rather than in `DiscoveryData` because it is not an intake
   * answer: it is a consent given at the moment of claiming, and it is sent
   * with that request and nowhere else. The checkbox is only rendered when
   * there is a fetched picture to ask about, so the default is never sent for
   * a preview that has none.
   */
  const [useProfilePicture, setUseProfilePicture] = useState(true);

  const previewId = liveDemoId ?? demo?.demoId ?? null;

  const submitClaim = useCallback(async () => {
    if (!previewId) return;
    setClaimBusy(true);
    setClaimError(null);
    try {
      const res = await fetch('/api/flowstarter/projects/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          previewId,
          // The tier is a name, not a price: the server maps it to the
          // published setup fee so the browser cannot quote itself.
          ...(data.selectedTier ? { tier: data.selectedTier } : {}),
          businessName: data.businessName,
          fullName: data.fullName,
          email: data.email,
          description: data.description,
          industry: data.industry,
          targetAudience: data.targetAudience,
          goal: data.goal,
          brandTone: data.brandTone,
          // Scope answers, so the server can re-run the standard-vs-custom
          // routing classifier on the answers themselves. The wizard's own
          // copy of the verdict is deliberately not sent.
          ...(data.pageCount ? { pageCount: data.pageCount } : {}),
          ...(data.timeline ? { timeline: data.timeline } : {}),
          ...(data.commerceMode ? { commerceMode: data.commerceMode } : {}),
          catalogSize: data.catalogSize,
          calComUrl: data.calComUrl,
          customIntegrations: data.customIntegrations,
          // The intake conversation: the highest-value evidence we hold. The
          // server files it as corpus documents against the new workspace so
          // the generator may cite the client's own words.
          ...(claimIntakeChatPayload(data)
            ? { intakeChat: claimIntakeChatPayload(data) }
            : {}),
          // The one picture question. Sent only when there is a fetched
          // picture to ask about, so a preview with none cannot accidentally
          // confirm rights over something else: the server defaults the field
          // to false and confirms nothing without it.
          ...(data.brandPicture ? { useProfilePicture } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        unlockUrl?: string;
        error?: string;
      };
      if (!res.ok || !json.unlockUrl) {
        setClaimError(json.error ?? 'We could not save your site. Try again.');
        return;
      }
      window.location.assign(json.unlockUrl);
    } catch {
      setClaimError('We could not save your site. Try again.');
    } finally {
      setClaimBusy(false);
    }
  }, [previewId, data, useProfilePicture]);

  /**
   * The signed-out path: straight to Stripe, no account first.
   *
   * A sign-up form between a decided buyer and their card lost people who had
   * already said yes. The workspace, the account and the credentials email are
   * all created by the deposit webhook once the money is real, so nothing the
   * visitor typed is lost by leaving now. The tier is sent by NAME; the amount
   * is computed server-side from the published price table.
   */
  const startGuestCheckout = useCallback(async () => {
    if (!previewId) return;
    setClaimBusy(true);
    setClaimError(null);
    try {
      const res = await fetch(
        `/api/discovery/preview/${previewId}/guest-deposit-checkout`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(data.selectedTier ? { tier: data.selectedTier } : {}),
            ...(data.subscription ? { subscription: data.subscription } : {}),
            ...(data.billingCadence
              ? { billingCadence: data.billingCadence }
              : {}),
            // The address they gave at step 1. It becomes the Stripe customer
            // email and, after payment, their sign-in identifier.
            email: data.email,
            fullName: data.fullName,
            businessName: data.businessName,
            // Stashed server-side onto the durable preview so the webhook's
            // claim files the same citable conversation a signed-in claim does.
            ...(claimIntakeChatPayload(data)
              ? { intakeChat: claimIntakeChatPayload(data) }
              : {}),
          }),
        }
      );
      const json = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !json.url) {
        setClaimError(json.error ?? 'We could not open checkout. Try again.');
        return;
      }
      window.location.assign(json.url);
    } catch {
      setClaimError('We could not open checkout. Try again.');
    } finally {
      setClaimBusy(false);
    }
  }, [previewId, data]);

  function claimSite() {
    // Clerk not settled yet: acting now would take the guest path for somebody
    // who is actually signed in. The button is disabled in that window anyway.
    if (claimBusy || !previewId || !authLoaded) return;
    if (!isSignedIn) {
      void startGuestCheckout();
      return;
    }
    // Already signed in: claim first, then the authenticated deposit Checkout,
    // exactly as before.
    void submitClaim();
  }

  // ---- Live conversational editor ----
  async function sendEdit() {
    const instruction = editPrompt.trim();
    if (!instruction || !liveDemoId || editBusy || editsLeft <= 0) return;
    setEditPrompt('');
    setEditBusy(true);
    setChat((c) => [
      ...c,
      { role: 'you', text: instruction },
      { role: 'agent', text: 'Working on it…' },
    ]);
    const setLastAgent = (text: string) =>
      setChat((c) => {
        const next = [...c];
        for (let i = next.length - 1; i >= 0; i--) {
          const turn = next[i];
          if (turn && turn.role === 'agent') {
            next[i] = { role: 'agent', text };
            break;
          }
        }
        return next;
      });

    try {
      const res = await fetch('/api/discovery/preview/live/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ demoId: liveDemoId, instruction }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        accepted?: boolean;
        limitReached?: boolean;
        editsLeft?: number;
        error?: string;
      };
      if (json.limitReached) {
        setEditsLeft(0);
        setOfferRevealed(true);
        setLastAgent("That was your last change. Let's make this real.");
        setEditBusy(false);
        return;
      }
      if (!json.accepted) {
        setLastAgent(
          json.error ?? "I couldn't start that edit. Try rephrasing."
        );
        setEditBusy(false);
        return;
      }

      // Poll edit status.
      const started = Date.now();
      while (Date.now() - started < 12 * 60_000) {
        await new Promise((r) => setTimeout(r, 3500));
        let s: {
          editStatus?: string;
          editPhase?: string;
          editError?: string;
          editsLeft?: number;
        } = {};
        try {
          const r = await fetch(
            `/api/discovery/preview/live/edit?demoId=${encodeURIComponent(
              liveDemoId
            )}`
          );
          s = (await r.json().catch(() => ({}))) as typeof s;
        } catch {
          continue;
        }
        if (s.editPhase) setLastAgent(s.editPhase);
        if (s.editStatus === 'done') {
          if (typeof s.editsLeft === 'number') setEditsLeft(s.editsLeft);
          // Both free changes spent: the visitor has seen editing in action,
          // so this is the moment the deposit ask appears.
          if (s.editsLeft === 0) {
            setOfferRevealed(true);
            setLastAgent('Done, that second change is in. Take a look.');
          } else {
            setLastAgent('Done, updating your live preview.');
          }
          setIframeNonce((n) => n + 1);
          break;
        }
        if (s.editStatus === 'failed') {
          setLastAgent(
            s.editError
              ? `That didn't work: ${s.editError}`
              : "That didn't work."
          );
          break;
        }
      }
    } catch {
      setLastAgent('Something went wrong applying that. Try again.');
    } finally {
      setEditBusy(false);
    }
  }

  // ---- JSON-fallback inline editor ----
  const jsonEditsLeft = demo ? MAX_DEMO_EDITS - demo.editsUsed : MAX_DEMO_EDITS;
  const canEdit = !!demo?.demoId && jsonEditsLeft > 0 && !editing;

  async function runEdit() {
    if (!demo || !prompt.trim() || !canEdit) return;
    const instruction = prompt.trim();
    setEditing(true);
    setNotice(null);
    try {
      const res = await fetch('/api/discovery/preview/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          demoId: demo.demoId,
          instruction,
          site: demo.site,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        site?: DemoSite;
        editsUsed?: number;
        limitReached?: boolean;
        error?: string;
      };
      if (json.limitReached) {
        setDemo((d) => (d ? { ...d, editsUsed: MAX_DEMO_EDITS } : d));
        setNotice(t('landing.discovery.preview.limitReached'));
      } else if (json.site) {
        setDemo((d) =>
          d
            ? {
                ...d,
                site: json.site as DemoSite,
                editsUsed:
                  typeof json.editsUsed === 'number'
                    ? json.editsUsed
                    : d.editsUsed + (json.error ? 0 : 1),
              }
            : d
        );
        if (json.error) setNotice(t('landing.discovery.preview.editFailed'));
        else setPrompt('');
      } else {
        setNotice(t('landing.discovery.preview.editFailed'));
      }
    } catch {
      setNotice(t('landing.discovery.preview.editFailed'));
    } finally {
      setEditing(false);
    }
  }

  /* ─────────────────────── The stage, as one status ────────────────────── */

  const previewShown = (mode === 'live' && !!liveUrl) || mode === 'json';
  const finished = previewShown && !personalizing;
  // Live mode holds the deposit ask back until the visitor has tried their
  // two changes (or asked for it); the JSON fallback has no live editing to
  // show off, so its offer appears as before.
  const offerReady = mode !== 'live' || offerRevealed;
  const elapsed = useElapsedSeconds(!finished && !buildFailure && !deferred);

  const nowState: NowState = deferred
    ? 'done'
    : buildFailure
    ? 'failed'
    : finished
    ? 'done'
    : 'working';
  const nowLabel = deferred
    ? t('landing.discovery.preview.deferredNow')
    : buildFailure
    ? 'The build stopped'
    : finished
    ? 'Your preview is ready'
    : progress.phase ??
      (mode === 'json'
        ? 'Putting your preview together'
        : 'Getting your build started');

  // The offer, in the numbers of the tier this visitor confirmed. Falls back
  // to the deterministic recommendation if they somehow reached here without
  // confirming one, so the sentence is never quoted without a figure.
  const quotedTier: Tier | '' =
    (data.selectedTier as Tier | '') || recommendTier(data).tier;
  const quote = depositQuote(quotedTier);

  const earlier = data.intakeChat ?? [];

  /* ───────────────────────────── The panes ─────────────────────────────── */

  const conversation = (
    <ConversationLog
      label="Your build, as it happens"
      scrollSignal={earlier.length + progress.phases.length + chat.length}
    >
      {earlier.length > 0 && (
        <p className="pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--fs-ink-faint)]">
          Earlier, with your info agent
        </p>
      )}
      {earlier.map((entry, index) =>
        entry.role === 'client' ? (
          <ChatBubble key={`earlier-${index}`} tone="you">
            {entry.text}
          </ChatBubble>
        ) : (
          <ChatBubble
            key={`earlier-${index}`}
            tone="earlier"
            author="Info agent"
          >
            {entry.text}
          </ChatBubble>
        )
      )}

      {/* Said before a single phase runs: what this is, and what it costs. */}
      <ChatBubble tone="offer" author="Your team of agents">
        {previewMeaningMessage(quote)}
      </ChatBubble>

      {steppedDown && (
        <ChatBubble tone="alert" author="Your team of agents">
          The live build was not available just now, so this is the simpler
          preview, written from your answers. It is a real draft, but it is not
          the generated site.
        </ChatBubble>
      )}

      {/* The pipeline's own phases, verbatim, signed by the agent that owns
          each one. The last one is the one in progress. */}
      {progress.phases.map((entry, index) => {
        const isCurrent =
          index === progress.phases.length - 1 && !finished && !buildFailure;
        return (
          <ChatBubble
            key={entry.index}
            tone="agent"
            author={agentForPhase(entry.phase)}
            meta={`${entry.at}s`}
            state={isCurrent ? 'working' : 'done'}
          >
            <span
              className={
                isCurrent
                  ? 'font-semibold text-[var(--fs-ink)]'
                  : 'text-[var(--fs-ink-faint)]'
              }
            >
              {entry.phase}
              {isCurrent ? '…' : ''}
            </span>
          </ChatBubble>
        );
      })}

      {deferred && (
        <ChatBubble tone="alert" author="Your team of agents">
          <span className="block">
            {t('landing.discovery.preview.deferredMessage')}
          </span>
        </ChatBubble>
      )}

      {buildFailure && (
        <ChatBubble tone="alert" author="Your team of agents">
          <span className="block">
            That build did not finish: {buildFailure}. Nothing is lost, and you
            have not paid anything.
          </span>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void retryLive()}
              disabled={retrying}
              className="rounded-lg bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
            >
              {retrying ? 'Starting again…' : 'Try the build again'}
            </button>
            <button
              type="button"
              onClick={() => void loadJsonFallback()}
              className="rounded-lg border border-[var(--fs-rule)] px-3 py-1.5 text-[12px] font-semibold text-[var(--fs-ink)] hover:border-[var(--purple-primary)]/40"
            >
              Show me the simpler preview instead
            </button>
          </div>
        </ChatBubble>
      )}

      {/* The editor's own progress reads as conversation, though the box it
          is typed into lives under the site on the right. */}
      {chat.map((m, i) =>
        m.role === 'you' ? (
          <ChatBubble key={`chat-${i}`} tone="you">
            {m.text}
          </ChatBubble>
        ) : (
          <ChatBubble key={`chat-${i}`} tone="agent" author="Site builder">
            {m.text}
          </ChatBubble>
        )
      )}

      {/* Before the ask: an open invitation to spend the two free changes.
          The visitor who is already sold can pull the offer forward. */}
      {finished && previewId && !offerReady && !editBusy && (
        <ChatBubble tone="agent" author="Your team of agents">
          <span className="block">
            That is a page of your full site, and it is editable: ask for up to{' '}
            {LIVE_EDIT_CAP} changes in the box under the preview and watch the
            team apply them.
          </span>
          <button
            type="button"
            onClick={() => setOfferRevealed(true)}
            className="mt-2 text-[12px] font-semibold text-[var(--purple-primary)] underline underline-offset-2"
          >
            Happy already? Show me how to reserve the full site
          </button>
        </ChatBubble>
      )}

      {/* The last message in the conversation: the offer, with a button. */}
      {finished && previewId && offerReady && (
        <ChatBubble tone="offer" author="Your team of agents">
          <span className="block">{previewReadyMessage(quote)}</span>
          {offerSnoozed ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[12px] text-[var(--fs-ink-faint)]">
                No rush, the preview stays here while you look around.
              </span>
              <button
                type="button"
                onClick={() => setOfferSnoozed(false)}
                className="text-[12px] font-semibold text-[var(--purple-primary)] underline underline-offset-2"
              >
                Show me the deposit again
              </button>
            </div>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              <ProfilePictureConsent
                picture={data.brandPicture}
                onChange={setUseProfilePicture}
                t={t}
              />
              <button
                type="button"
                onClick={claimSite}
                disabled={claimBusy || !authLoaded}
                className="rounded-lg bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
              >
                {claimBusy
                  ? isSignedIn
                    ? 'Saving your site…'
                    : 'Opening secure checkout…'
                  : depositCtaLabel(quote)}
              </button>
              <button
                type="button"
                onClick={() => setOfferSnoozed(true)}
                className="self-start text-[12px] font-medium text-[var(--fs-ink-faint)] underline underline-offset-2 hover:text-[var(--fs-ink)]"
              >
                {KEEP_EXPLORING_LABEL}
              </button>
              {claimError && (
                <p className="text-[12px] font-medium text-amber-600 dark:text-amber-400">
                  {claimError}
                </p>
              )}
            </div>
          )}
        </ChatBubble>
      )}
      {brand ? <BrandStrip {...brand} t={t} /> : null}
    </ConversationLog>
  );

  const sitePane = (
    <div className="space-y-2.5">
      <div className="overflow-hidden rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)]/40">
        <div className="flex items-center gap-1.5 border-b border-[var(--fs-rule)] px-3 py-2">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-green-400/70" />
          <span className="ml-3 truncate rounded bg-black/5 px-2 py-0.5 text-[11px] text-[var(--fs-ink-faint)] dark:bg-white/10">
            {previewHostLabel(data.businessName)}
          </span>
          {personalizing ? (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-[var(--purple-primary)]">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--purple-primary)] border-t-transparent" />
              Personalizing for {data.businessName || 'your business'}…
            </span>
          ) : liveUrl ? (
            <a
              href={liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold text-[var(--purple-primary)] hover:bg-[var(--purple-primary)]/10 transition-colors"
            >
              Open in new tab
              <svg
                className="h-3 w-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
            </a>
          ) : (
            <span className="ml-auto shrink-0 text-[11px] font-semibold text-[var(--fs-ink-faint)]">
              {t('landing.discovery.preview.paneTitle')}
            </span>
          )}
        </div>

        {mode === 'json' && demo ? (
          <DemoSiteFrame site={demo.site} />
        ) : liveUrl ? (
          <div
            ref={viewport.ref}
            data-testid="concierge-site-viewport"
            data-scale={viewport.scale.toFixed(3)}
            className={`relative w-full overflow-hidden bg-white ${SITE_PANE_HEIGHT_CLASS}`}
          >
            <iframe
              key={iframeNonce}
              src={
                iframeNonce > 0
                  ? `${liveUrl}${
                      liveUrl.includes('?') ? '&' : '?'
                    }r=${iframeNonce}`
                  : liveUrl
              }
              title="Live site preview"
              onLoad={() => setFrameLoaded(true)}
              style={viewport.frameStyle}
              className={[
                'block border-0 bg-white transition-opacity duration-700',
                frameLoaded ? 'opacity-100' : 'opacity-0',
              ].join(' ')}
              sandbox="allow-scripts allow-same-origin"
              loading="lazy"
            />
            {!frameLoaded && (
              <div className="pointer-events-none absolute inset-0" aria-hidden>
                <DerivedSiteSkeleton
                  data={data}
                  t={t}
                  testId="concierge-skeleton"
                />
              </div>
            )}
          </div>
        ) : (
          // The same skeleton the visitor watched fill in while they answered,
          // now standing in for the site until the real one lands in its
          // place. A generic pulse here would have thrown away the one piece
          // of continuity between the conversation and the build.
          <div
            className={`relative w-full overflow-hidden ${SITE_PANE_HEIGHT_CLASS}`}
          >
            <DerivedSiteSkeleton
              data={data}
              t={t}
              testId="concierge-skeleton"
            />
            <p className="absolute inset-x-0 bottom-0 bg-[var(--fs-bg-elevated)]/85 px-3 py-2 text-[11px] leading-snug text-[var(--fs-ink-faint)] backdrop-blur-sm">
              {t('landing.discovery.preview.paneSkeleton')}
            </p>
          </div>
        )}
      </div>

      {/* The shareable copy, and the date it stops working.
          The iframe above renders a sandbox that dies with the session; this
          is the hosted preview, and it is temporary by rule rather than by
          accident. Showing the link without the date would be the half of the
          promise that flatters us. */}
      {progress.hostedPreviewUrl && (
        <div
          data-testid="hosted-preview"
          className="flex flex-col gap-1 rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)]/40 px-3 py-2"
        >
          <a
            href={progress.hostedPreviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-fit text-[12px] font-semibold text-[var(--purple-primary)] underline underline-offset-4"
          >
            {progress.hostedPreviewUrl.replace(/^https?:\/\//, '')}
          </a>
          {progress.hostedPreviewExpiresAt ? (
            <p
              data-testid="hosted-preview-expiry"
              className="text-[11px] text-[var(--fs-ink-faint)]"
            >
              {t('site.preview.worksUntil').replace(
                '{date}',
                formatPreviewExpiry(progress.hostedPreviewExpiresAt)
              )}
            </p>
          ) : null}
        </div>
      )}

      {/* Ask for a change — under the site, answered on the left. */}
      {mode === 'live' && liveUrl && (
        <div className="rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)]/40">
          <div className="flex items-center justify-between border-b border-[var(--fs-rule)] px-3 py-2">
            <p className="text-[12px] font-semibold text-[var(--fs-ink)]">
              {t('landing.discovery.preview.askForChange')}
            </p>
            <span
              className={[
                'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                editsLeft <= 1
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  : 'bg-[var(--purple-primary)]/12 text-[var(--purple-primary)]',
              ].join(' ')}
            >
              {editsLeft}/{LIVE_EDIT_CAP} changes left
            </span>
          </div>
          <div className="flex gap-2 p-3">
            <input
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') sendEdit();
              }}
              disabled={editBusy || editsLeft <= 0}
              aria-label="Ask for a change"
              placeholder={
                editsLeft <= 0
                  ? 'No prompts left, ready to make it real?'
                  : 'e.g. make the hero warmer and add a pricing section'
              }
              className="w-full rounded-lg border border-[var(--fs-rule)] bg-white px-3 py-2 text-sm text-[var(--fs-ink)] placeholder:text-[var(--fs-ink-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--purple-primary)]/30 disabled:opacity-50 dark:bg-white/[0.03]"
            />
            <button
              type="button"
              onClick={sendEdit}
              disabled={editBusy || editsLeft <= 0 || !editPrompt.trim()}
              className="shrink-0 rounded-lg bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {editBusy ? 'Editing…' : 'Send'}
            </button>
          </div>
        </div>
      )}

      {mode === 'json' && demo?.demoId && (
        <div className="rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)]/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[12px] font-semibold text-[var(--fs-ink)]">
              {t('landing.discovery.preview.editorTitle')}
            </p>
            <span
              className={[
                'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                jsonEditsLeft <= 3
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  : 'bg-[var(--purple-primary)]/12 text-[var(--purple-primary)]',
              ].join(' ')}
            >
              {jsonEditsLeft}/{MAX_DEMO_EDITS}{' '}
              {t('landing.discovery.preview.editsLeft')}
            </span>
          </div>
          <div className="flex gap-2">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runEdit();
              }}
              disabled={!canEdit}
              placeholder={t('landing.discovery.preview.editorPlaceholder')}
              className="w-full rounded-lg border border-[var(--fs-rule)] bg-white px-3 py-2 text-sm text-[var(--fs-ink)] placeholder:text-[var(--fs-ink-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--purple-primary)]/30 disabled:opacity-50 dark:bg-white/[0.03]"
            />
            <button
              type="button"
              onClick={runEdit}
              disabled={!canEdit || !prompt.trim()}
              className="shrink-0 rounded-lg bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {editing
                ? t('landing.discovery.preview.applying')
                : t('landing.discovery.preview.apply')}
            </button>
          </div>
          {notice && (
            <p className="mt-2 text-[12px] text-[var(--fs-ink-faint)]">
              {notice}
            </p>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      <ConciergePanes
        now={
          <NowLine label={nowLabel} state={nowState} elapsedSeconds={elapsed} />
        }
        site={sitePane}
        conversation={conversation}
      />

      <p className="text-[12px] leading-snug text-[var(--fs-ink-faint)]">
        {t('landing.discovery.preview.disclaimer')}
      </p>
    </div>
  );
}
