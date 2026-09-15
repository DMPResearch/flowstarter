'use client';

/**
 * The in-depth brief, as a form the client fills in after the deposit.
 *
 * This is the one surface where a client says what their business actually
 * does. Everything the build writes about them comes from here, so the form's
 * job is to make each ask concrete and to be honest about what is still
 * outstanding rather than to look finished.
 *
 * Three things it deliberately does not do:
 *
 *  - It does not decide readiness. `evaluateBriefReadiness` is a pure rule and
 *    the server is the only thing that runs it; what arrives in `readiness` is
 *    displayed, never recomputed here, so the checklist a client reads and the
 *    gate the build worker obeys can never disagree.
 *  - It does not upload anything itself. `AssetUploader` already owns sending
 *    files and recording the rights statement over them, and a second uploader
 *    would mean a second, weaker version of that evidence.
 *  - It does not nag mid-typing. The offer's character count is a quiet hint
 *    until the field is left, because a red message under a sentence somebody
 *    is still writing is a message about their typing speed.
 *
 * Copy is hardcoded English, which is the convention on the client dashboard.
 */
import { useCallback, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ImageOff,
  Info,
  Plus,
  Trash2,
} from 'lucide-react';
import { GlassSurface } from '@flowstarter/flow-design-system/components/surfaces/GlassSurface';
import {
  MIN_OFFER_CHARS,
  MIN_PHOTO_LONG_EDGE,
  isUndersizedPhoto,
  type BriefReadiness,
} from '@/lib/flowstarter/brief-readiness';
import type { PortraitSizeFloors } from '@/lib/flowstarter/portrait-config';
import { cn } from '@/lib/utils';
import { AssetUploader } from './AssetUploader';
import { CURRENT_RIGHTS_STATEMENT_VERSION } from './rights-statement';
import { SourcedPortrait } from './SourcedPortrait';
import {
  MAX_TONE_WORDS,
  MIN_STORY_CHARS,
  PERSON_FIELD_CAPS,
  PERSON_LINK_KINDS,
  type BriefPerson,
  type PersonActivity,
  type PersonLink,
  type PersonLinkKind,
  type PersonSourcedBio,
} from '@flowstarter/agentic-codegen/src/flowstarter/person';

// ───────────────────────────────────────────────────────────────────────────
// The shape the API speaks
// ───────────────────────────────────────────────────────────────────────────

export interface BriefProjectView {
  name: string;
  line: string;
  link: string;
  screenshotAssetIds: string[];
}

export interface BriefView {
  offer: string;
  /** The client's own business name, or '' when they have not set one here. */
  businessName: string;
  projects: BriefProjectView[];
  noProjects: boolean;
  designReferenceAssetIds: string[];
  photoAssetIds: string[];
  portraitAssetId: string | null;
  readyAt: string | null;
  overrideAt: string | null;
  pageCount: string | null;
  /**
   * Who the client is, in their own words, or null when nobody has asked.
   *
   * Mirrors `BriefView['person']` in `lib/flowstarter/brief-data.ts` exactly,
   * because the two must never disagree about what "nobody asked" means: an
   * intake taken before this section existed and a client who was asked and
   * skipped every question are different inputs, and only the second is a
   * section this form may render as answered-but-empty. See
   * `packages/agentic-codegen/src/flowstarter/person.ts`.
   */
  person: BriefPerson | null;
}

/** The wizard's own answers, mirrored so this file needs no import from the
 * agentic-codegen package. */
type PageCountValue = 'lt-5' | '5-7' | '8-15' | '15+' | 'unsure';

/**
 * Same five answers and the same labels the intake asks with
 * (`landing.discovery.options.pages.*` / `PAGE_OPTIONS` in
 * `intake-script.ts`), so a client who saw the wizard's wording is not asked
 * the same question in different words on the brief.
 */
const PAGE_COUNT_OPTIONS: ReadonlyArray<{
  value: PageCountValue;
  label: string;
  sub: string;
}> = [
  { value: 'lt-5', label: 'Under 5', sub: 'Single landing or simple site' },
  { value: '5-7', label: '5 – 7', sub: 'Standard service site' },
  { value: '8-15', label: '8 – 15', sub: 'Multi-page or content-driven' },
  { value: '15+', label: '15+', sub: 'Large site, blog, locations' },
  { value: 'unsure', label: 'Not sure', sub: "We'll work it out on the call" },
];

/** One file, as `/api/client/brief/[workspaceId]` reports it. */
export interface BriefAssetView {
  id: string;
  kind: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  usable: boolean;
  url: string | null;
  /** Where the bytes came from: 'upload' for a file they sent, or the network we read. */
  source: string;
  /** The provider URL we downloaded it from, when we downloaded it. */
  sourceUrl: string | null;
  /** Null when we hold the file but may not publish it. */
  rightsConfirmedAt: string | null;
  /** What the picture shows, in the client's words or ours. */
  caption: string | null;
  /** Whose words those are. Null when nothing has been written yet. */
  captionSource: 'client' | 'auto' | null;
  /** What the automatic pass took the picture to be, when it ran. */
  autoCaptionKind: 'screenshot' | 'photo' | 'logo' | 'document' | null;
}

export interface BriefFormProps {
  workspaceId: string;
  initialBrief: BriefView;
  initialReadiness: BriefReadiness;
  initialAssets: BriefAssetView[];
  /**
   * What `derivedBriefPageCount` works out from this brief right now, computed
   * on the server so the client bundle never needs the page-set rule. Shown as
   * the pre-selected option whenever `initialBrief.pageCount` is null, i.e.
   * the client has never made an explicit choice.
   */
  derivedPageCount: string;
  /**
   * What the business is called right now, computed on the server from the
   * workspace's own `name` — the value `deriveBusinessName` produced at claim
   * time, or whatever the client has typed here since. Shown as the input's
   * value whenever `initialBrief.businessName` is empty, i.e. the client has
   * never corrected it on this form. The same "guess pre-fills, client
   * confirms or corrects it" pattern `derivedPageCount` already uses.
   */
  derivedBusinessName: string;
  /**
   * The size floors, read on the server.
   *
   * `portraitSizeFloors()` reads `process.env`, which in a client component is
   * inlined at build time from the browser-visible environment and will never
   * carry a server-only override. Threading the floors from the page is what
   * makes `FLOWSTARTER_PORTRAIT_MIN_EDGE` actually take effect on this form.
   */
  portraitFloors?: PortraitSizeFloors;
}

interface BriefResponse {
  brief: BriefView;
  readiness: BriefReadiness;
  assets: BriefAssetView[];
  error?: string;
}

/** Where a freshly uploaded file belongs. A project row is named by index. */
type UploadTarget = 'design' | 'photos' | number;

const EMPTY_PROJECT: BriefProjectView = {
  name: '',
  line: '',
  link: '',
  screenshotAssetIds: [],
};

/** Mirrors the schema the route enforces, so the form cannot offer a 400. */
const MAX_PROJECTS = 12;
const MAX_PHOTOS = 12;
const MAX_REFERENCES = 8;
const MAX_SCREENSHOTS = 6;

/**
 * The same rule the route applies to a link, run early so a client finds out
 * on blur rather than on save. The server still checks: this is a courtesy,
 * not a gate.
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function BriefForm({
  workspaceId,
  initialBrief,
  initialReadiness,
  initialAssets,
  derivedPageCount,
  derivedBusinessName,
  portraitFloors,
}: BriefFormProps) {
  const [offer, setOffer] = useState(initialBrief.offer);
  const [offerLeft, setOfferLeft] = useState(false);
  // Seeded with the derived value when the brief has not set one, rather than
  // falling back to it at render time the way the page-count radios do: a
  // free-text input has to be an ordinary controlled field once mounted, or
  // clearing it to type a correction only ever re-shows the fallback text
  // underneath whatever was just typed.
  const [businessName, setBusinessName] = useState(
    initialBrief.businessName || derivedBusinessName
  );
  const [projects, setProjects] = useState<BriefProjectView[]>(
    initialBrief.projects
  );
  const [noProjects, setNoProjects] = useState(initialBrief.noProjects);
  const [pageCount, setPageCount] = useState<string | null>(
    initialBrief.pageCount
  );
  const [referenceIds, setReferenceIds] = useState(
    initialBrief.designReferenceAssetIds
  );
  const [photoIds, setPhotoIds] = useState(initialBrief.photoAssetIds);
  const [portraitId, setPortraitId] = useState(initialBrief.portraitAssetId);
  const [assets, setAssets] = useState(initialAssets);
  const [readiness, setReadiness] = useState(initialReadiness);
  const [linkErrors, setLinkErrors] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Use this" is two requests in one gesture, so it gets its own flag: the
  // card has to look busy for both of them, not just for the save at the end.
  const [portraitBusy, setPortraitBusy] = useState(false);

  // Fixed at mount, like `derivedPageCount`. `initialBrief.person === null`
  // covers two different clients — an intake taken before this section
  // existed, and a services business the funnel never asked — and both get
  // the same treatment: no "About you" section at all. Eleven questions
  // about somebody's inner life on a plumber's brief is exactly the genre
  // mistake `brief-readiness.ts` already refuses to make for the readiness
  // gate; this form would be undoing that refusal if it grew the section
  // anyway. Nothing here ever creates a person section the funnel decided
  // there wasn't one, so this never needs to flip from false to true.
  const hasPerson = initialBrief.person !== null;
  const [person, setPerson] = useState<BriefPerson | null>(initialBrief.person);
  // Same quiet-hint pattern as `offerLeft`: a character count under a
  // sentence somebody is still writing is a comment on their typing speed,
  // not useful information.
  const [storyLeft, setStoryLeft] = useState(false);
  // The sourced-bio proposal is a single PUT, unlike a sourced photograph:
  // there is no rights confirmation to write first, so one flag covering the
  // request is enough.
  const [bioBusy, setBioBusy] = useState(false);

  // "Replace" has to put the client somewhere they can actually replace the
  // photo, which is the photos uploader a few lines further down.
  const photosUploader = useRef<HTMLDivElement | null>(null);

  const endpoint = `/api/client/brief/${workspaceId}`;

  // Best-effort refresh of the full asset list -- captions, urls, rights
  // state -- for the thumbnails and cards elsewhere on the page. Never the
  // thing that decides which ids belong to which project: a slow or failed
  // refresh here must not cost the client the attachment they just made.
  const refreshAssets = useCallback(async () => {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) return;
      const payload = (await response.json()) as BriefResponse;
      setAssets(payload.assets);
    } catch {
      // The files are stored either way; the next save or reload picks them up.
    }
  }, [endpoint]);

  /**
   * Files an uploader's write onto its target.
   *
   * `assetIds` are the ids the uploader that called this just wrote --
   * exactly the ones it uploaded, or exactly the ones it just confirmed the
   * rights over -- never a guess reconstructed by diffing a shared asset list
   * against what this form last saw. That diff used to be how this worked,
   * keyed off a ref of "every id we have ever seen", and it raced: a brief
   * has several uploaders open on one page (one per project, plus design
   * references, plus photos), each refreshing the same workspace-wide list
   * after its own write, and whichever refresh happened to land first claimed
   * every id the list had not shown it yet -- including ids that belonged to
   * a different, still-in-flight uploader. A screenshot could finish
   * uploading, get captioned and have its rights confirmed, and still never
   * reach its project's `screenshotAssetIds`, because some other row's
   * refresh saw it first and marked it "already known" before its own row's
   * refresh got a turn. Taking the ids directly from the write that produced
   * them removes the race by construction: there is nothing left to diff.
   */
  const adopt = useCallback(
    (target: UploadTarget, assetIds: string[]) => {
      if (assetIds.length > 0) {
        if (target === 'design') {
          setReferenceIds((current) =>
            Array.from(new Set([...current, ...assetIds])).slice(
              0,
              MAX_REFERENCES
            )
          );
        } else if (target === 'photos') {
          setPhotoIds((current) =>
            Array.from(new Set([...current, ...assetIds])).slice(0, MAX_PHOTOS)
          );
        } else {
          setProjects((current) =>
            current.map((project, index) =>
              index === target
                ? {
                    ...project,
                    screenshotAssetIds: Array.from(
                      new Set([...project.screenshotAssetIds, ...assetIds])
                    ).slice(0, MAX_SCREENSHOTS),
                  }
                : project
            )
          );
        }
      }
      void refreshAssets();
    },
    [refreshAssets]
  );

  const updateProject = useCallback(
    (index: number, patch: Partial<BriefProjectView>) => {
      setProjects((current) =>
        current.map((project, at) =>
          at === index ? { ...project, ...patch } : project
        )
      );
      setSaved(false);
    },
    []
  );

  // `current ? { ...current, ...patch } : current` rather than assuming
  // `person` is set: these handlers are only ever wired to inputs that exist
  // when `hasPerson` is true, but the state itself stays typed as
  // `BriefPerson | null` for the client whose brief has none, and a patch
  // function that crashed on that client's render would be worse than one
  // that quietly does nothing.
  const updatePerson = useCallback((patch: Partial<BriefPerson>) => {
    setPerson((current) => (current ? { ...current, ...patch } : current));
    setSaved(false);
  }, []);

  const updateActivity = useCallback((patch: Partial<PersonActivity>) => {
    setPerson((current) =>
      current
        ? { ...current, activity: { ...current.activity, ...patch } }
        : current
    );
    setSaved(false);
  }, []);

  const updateToneWord = useCallback((index: number, value: string) => {
    setPerson((current) => {
      if (!current) return current;
      // A fixed row of `MAX_TONE_WORDS` boxes needs a slot for each one, or
      // typing into the third box before the second has ever been touched
      // would silently write into the wrong index.
      const words = [...current.toneWords];
      while (words.length <= index) words.push('');
      words[index] = value;
      return { ...current, toneWords: words };
    });
    setSaved(false);
  }, []);

  const updateLink = useCallback(
    (kind: PersonLinkKind, patch: Partial<PersonLink>) => {
      setPerson((current) => {
        if (!current) return current;
        const existing = current.links.find((link) => link.kind === kind) ?? {
          kind,
          url: '',
          consented: false,
        };
        return {
          ...current,
          links: [
            ...current.links.filter((link) => link.kind !== kind),
            { ...existing, ...patch },
          ],
        };
      });
      setSaved(false);
    },
    []
  );

  /**
   * Saves the brief.
   *
   * `overrides` exists for one reason: "Use this" chooses a portrait and saves
   * it in the same gesture, and a `setPortraitId` a line earlier has not
   * reached this closure yet. Passing the id explicitly is the difference
   * between saving what the client just chose and saving what they had before.
   * `adoptSourcedBio` is the same trick for the bio proposal's "Use it" and
   * "Dismiss": the client's verdict travels on the very save that follows the
   * click, rather than waiting on a `person` that has not re-rendered yet.
   */
  const save = useCallback(
    async (
      overrides: {
        portraitAssetId?: string | null;
        adoptSourcedBio?: boolean;
      } = {}
    ) => {
      setSaving(true);
      setSaved(false);
      setError(null);
      try {
        const response = await fetch(endpoint, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offer,
            businessName,
            // Ticking "no past work" clears the list rather than hiding it: the
            // route refuses a body that says both, and a half-typed project the
            // client cannot see is not something to save on their behalf.
            projects: noProjects ? [] : projects,
            noProjects,
            designReferenceAssetIds: referenceIds,
            photoAssetIds: photoIds,
            portraitAssetId:
              overrides.portraitAssetId !== undefined
                ? overrides.portraitAssetId
                : portraitId,
            pageCount,
            // Absent entirely when there is no person section at all, so a
            // save on a services brief never sends a `person` key the route
            // would have to interpret. `sourcedBio` is never part of this:
            // the excerpt, its page and the instant we read it are the
            // server's record, and only the approval — `adoptSourcedBio`,
            // sent solely when a button was actually pressed — travels back.
            ...(person
              ? {
                  person: {
                    name: person.name,
                    headline: person.headline,
                    story: person.story,
                    howIWork: person.howIWork,
                    values: person.values,
                    feel: person.feel,
                    // An empty box is not a tone word the client chose; the
                    // schema does not filter blanks itself, so a slot nobody
                    // typed into must not be sent as one.
                    toneWords: person.toneWords.filter(
                      (word) => word.trim().length > 0
                    ),
                    // Same reasoning for a link row nobody filled in: an
                    // empty address with an unticked box beside it is an
                    // unused row, not an answer.
                    links: person.links.filter(
                      (link) => link.url.trim().length > 0
                    ),
                    proudestWork: person.proudestWork,
                    activity: person.activity,
                    ...(overrides.adoptSourcedBio !== undefined
                      ? { adoptSourcedBio: overrides.adoptSourcedBio }
                      : {}),
                  },
                }
              : {}),
          }),
        });
        const payload = (await response
          .json()
          .catch(() => ({}))) as Partial<BriefResponse>;
        if (!response.ok || !payload.brief || !payload.readiness) {
          setError(
            payload.error ?? 'We could not save that. Please try again.'
          );
          return;
        }
        // The server's answer replaces the form, so what a client sees after a
        // save is what is stored, not what they typed.
        setOffer(payload.brief.offer);
        setBusinessName(payload.brief.businessName);
        setProjects(payload.brief.projects);
        setNoProjects(payload.brief.noProjects);
        setReferenceIds(payload.brief.designReferenceAssetIds);
        setPhotoIds(payload.brief.photoAssetIds);
        setPortraitId(payload.brief.portraitAssetId);
        setPageCount(payload.brief.pageCount);
        if (hasPerson) setPerson(payload.brief.person);
        setReadiness(payload.readiness);
        setAssets(payload.assets ?? []);
        setLinkErrors({});
        setSaved(true);
      } catch {
        setError('We could not save that. Please try again.');
      } finally {
        setSaving(false);
      }
    },
    [
      businessName,
      endpoint,
      hasPerson,
      noProjects,
      offer,
      pageCount,
      person,
      photoIds,
      portraitId,
      projects,
      referenceIds,
    ]
  );

  /**
   * "Use it" or "Dismiss" on the bio proposal. Unlike the sourced photograph
   * below, there is no rights confirmation to write first: a sentence read
   * off a public LinkedIn headline needs the client's yes to be published,
   * not a separate confirmation that we are allowed to hold the bytes. So
   * this is one request, the save itself, with the verdict riding along as
   * `adoptSourcedBio`.
   */
  const decideSourcedBio = useCallback(
    async (adopt: boolean) => {
      setBioBusy(true);
      try {
        await save({ adoptSourcedBio: adopt });
      } finally {
        setBioBusy(false);
      }
    },
    [save]
  );

  /**
   * "Use this" on a sourced photograph: one gesture, two writes.
   *
   * The rights confirmation goes first and the brief is only saved if it
   * succeeded. The other order would leave a brief naming a portrait we are
   * not allowed to publish, which is the failure that reaches a client's site.
   * A refusal is surfaced through the form's own error line rather than
   * swallowed, because a client who taps a button and sees nothing happen will
   * tap it again.
   *
   * Named `adopt...` rather than `usePortrait` on purpose: a `const` whose
   * name starts with `use` is a React hook as far as the linter is concerned,
   * and calling one inside an `onUse` handler is an error. The rename is the
   * fix rather than a disable comment, because the rule is right about what
   * the name means.
   */
  const adoptSourcedPortrait = useCallback(
    async (asset: BriefAssetView) => {
      setPortraitBusy(true);
      setSaved(false);
      setError(null);
      try {
        if (!asset.rightsConfirmedAt) {
          const response = await fetch(
            `/api/client/assets/${workspaceId}/rights`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                assetIds: [asset.id],
                statementVersion: CURRENT_RIGHTS_STATEMENT_VERSION,
              }),
            }
          );
          const payload = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          if (!response.ok) {
            setError(payload.error ?? 'We could not record that confirmation.');
            return;
          }
        }
        setPortraitId(asset.id);
        await save({ portraitAssetId: asset.id });
      } catch {
        setError('We could not record that confirmation. Please try again.');
      } finally {
        setPortraitBusy(false);
      }
    },
    [save, workspaceId]
  );

  /**
   * "Replace": stop offering this one, and put the client in front of the
   * uploader. It deliberately does not delete the asset. Changing your mind
   * about which photograph represents you is not a reason to destroy a file,
   * and an unconfirmed asset is already unpublishable by construction.
   */
  const replacePortrait = useCallback((asset: BriefAssetView) => {
    setPortraitId((current) => (current === asset.id ? null : current));
    setSaved(false);
    const node = photosUploader.current;
    if (!node) return;
    // jsdom has no layout, so `scrollIntoView` is simply absent there.
    if (typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    node.querySelector<HTMLInputElement>('input[type="file"]')?.focus();
  }, []);

  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const photos = photoIds
    .map((id) => assetById.get(id))
    .filter((asset): asset is BriefAssetView => Boolean(asset));
  // The first photograph that is not a file the client sent us: one we went
  // and found on a page of theirs. It gets offered back rather than quietly
  // used, which is the whole of the difference between the two.
  const sourcedPortrait =
    photos.find((asset) => asset.source !== 'upload') ?? null;
  const offerChars = offer.replace(/\s+/g, ' ').trim().length;
  // Same collapsed-length rule `MIN_STORY_CHARS` is measured against
  // everywhere else it matters (`person.ts`'s `proseLength`, and the
  // readiness rule this hint is a preview of), so a client who clears the
  // quiet-hint threshold here clears it on the server too.
  const storyChars = (person?.story ?? '').replace(/\s+/g, ' ').trim().length;
  const blocking = readiness.missing.filter(
    (entry) => entry.severity === 'blocking'
  );
  const degrades = readiness.missing.filter(
    (entry) => entry.severity !== 'blocking'
  );

  return (
    <div className="flex flex-col gap-5" data-testid="brief-form">
      {/* ── 0. What it's called ────────────────────────────────────────── */}
      <GlassSurface as="section" variant="card">
        <div className="flex flex-col gap-3">
          <SectionHeading
            title="What it's called"
            hint="The name we introduce your site with. We started from what you told us; change it any time and your workspace picks up the correction."
          />
          <input
            type="text"
            data-testid="brief-business-name"
            aria-label="Business name"
            value={businessName}
            maxLength={200}
            onChange={(event) => {
              setBusinessName(event.target.value);
              setSaved(false);
            }}
            className="w-full rounded-lg border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)] px-4 py-2.5 text-sm font-semibold text-[var(--fs-ink)] outline-none transition-colors focus:border-[var(--purple-primary)]"
          />
        </div>
      </GlassSurface>

      {/* ── 1. What you offer ──────────────────────────────────────────── */}
      <GlassSurface as="section" variant="card">
        <div className="flex flex-col gap-3">
          <SectionHeading
            title="What you offer"
            hint="In your own words: what you sell, who it is for, and what someone gets. We will not publish it word for word. We need it so your site says true things."
          />
          <textarea
            data-testid="brief-offer"
            aria-label="What you offer"
            value={offer}
            rows={6}
            maxLength={2000}
            onChange={(event) => {
              setOffer(event.target.value);
              setSaved(false);
            }}
            onBlur={() => setOfferLeft(true)}
            className="w-full rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)] px-4 py-3 text-sm leading-relaxed text-[var(--fs-ink)] outline-none transition-colors focus:border-[var(--purple-primary)]"
          />
          <p
            data-testid="brief-offer-count"
            className={cn(
              'text-xs',
              offerLeft && offerChars < MIN_OFFER_CHARS
                ? 'font-medium text-[var(--fs-ink)]'
                : 'text-[var(--fs-ink-faint)]'
            )}
          >
            {offerChars >= MIN_OFFER_CHARS
              ? `${offerChars} characters. That is plenty to write from.`
              : `${offerChars} of about ${MIN_OFFER_CHARS} characters. Two or three sentences is plenty.`}
          </p>
        </div>
      </GlassSurface>

      {/* ── 2. How many pages ──────────────────────────────────────────── */}
      <GlassSurface as="section" variant="card">
        <div className="flex flex-col gap-3">
          <SectionHeading
            title="How many pages"
            hint="Roughly how big the site should be. We start from what your other answers add up to; pick a different size if you want more or less."
          />
          <div
            data-testid="brief-page-count"
            role="radiogroup"
            aria-label="How many pages"
            className="flex flex-wrap gap-2"
          >
            {PAGE_COUNT_OPTIONS.map((option) => {
              const selected = (pageCount ?? derivedPageCount) === option.value;
              return (
                <label
                  key={option.value}
                  data-testid="brief-page-count-option"
                  data-selected={selected}
                  className={cn(
                    'flex w-40 cursor-pointer flex-col gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors',
                    selected
                      ? 'border-[var(--purple-primary)] bg-[var(--purple-primary-lightest)]'
                      : 'border-[var(--fs-rule)] hover:border-[var(--purple-primary)]/40'
                  )}
                >
                  <input
                    type="radio"
                    name="brief-page-count"
                    value={option.value}
                    checked={selected}
                    onChange={() => {
                      setPageCount(option.value);
                      setSaved(false);
                    }}
                    // A radio's native `change` event only fires when the
                    // checked option actually changes. The pre-selected
                    // option is already `checked` from the derived default,
                    // so clicking it to *confirm* that default is a click
                    // with no checked-state change behind it, and `onChange`
                    // alone never sees it: `pageCount` stayed null forever,
                    // which is indistinguishable from "never looked at this"
                    // even after the client deliberately chose it. `onClick`
                    // fires on every click regardless, so it is what actually
                    // makes confirming the default expressible; pairing it
                    // with `onChange` keeps keyboard (arrow-key) selection of
                    // a *different* option working exactly as before.
                    onClick={() => {
                      setPageCount(option.value);
                      setSaved(false);
                    }}
                    className="sr-only"
                  />
                  <span className="text-sm font-semibold text-[var(--fs-ink)]">
                    {option.label}
                  </span>
                  <span className="text-xs text-[var(--fs-ink-dim)]">
                    {option.sub}
                  </span>
                </label>
              );
            })}
          </div>
          {pageCount === null ? (
            <p
              data-testid="brief-page-count-derived"
              className="text-xs text-[var(--fs-ink-faint)]"
            >
              Pre-selected: what your brief adds up to. Pick a different size
              any time.
            </p>
          ) : null}
        </div>
      </GlassSurface>

      {/* ── 3. Products or projects ────────────────────────────────────── */}
      <GlassSurface as="section" variant="card">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionHeading
              title="Products or projects"
              hint="A name, one line about each, a link if there is one, and a screenshot or two."
            />
            <span
              data-testid="brief-project-count"
              className="shrink-0 rounded-full border border-[var(--fs-rule)] px-3 py-1 text-xs font-semibold text-[var(--fs-ink-dim)]"
            >
              {projects.length === 1 ? '1 listed' : `${projects.length} listed`}
            </span>
          </div>

          <label className="flex items-start gap-2 text-sm text-[var(--fs-ink)]">
            <input
              type="checkbox"
              data-testid="brief-no-projects"
              checked={noProjects}
              onChange={(event) => {
                setNoProjects(event.target.checked);
                setSaved(false);
              }}
              className="mt-0.5 size-4 shrink-0 rounded border-[var(--fs-rule)] accent-[var(--purple-primary)]"
            />
            <span>
              I have no past work to show yet. Leave the work section off my
              site rather than filling it with examples that are not mine.
            </span>
          </label>

          <div
            data-testid="brief-project-list"
            aria-hidden={noProjects ? 'true' : undefined}
            className={cn(
              'flex flex-col gap-4',
              noProjects && 'pointer-events-none opacity-40'
            )}
          >
            {projects.map((project, index) => (
              <div
                key={index}
                data-testid="brief-project-row"
                className="flex flex-col gap-3 rounded-xl border border-[var(--fs-rule)] px-4 py-4"
              >
                <div className="flex items-start gap-3">
                  <input
                    type="text"
                    aria-label={`Project ${index + 1} name`}
                    data-testid="brief-project-name"
                    value={project.name}
                    maxLength={80}
                    disabled={noProjects}
                    placeholder="Name"
                    onChange={(event) =>
                      updateProject(index, { name: event.target.value })
                    }
                    className="w-full rounded-lg border border-[var(--fs-rule)] bg-transparent px-3 py-2 text-sm font-semibold text-[var(--fs-ink)] outline-none focus:border-[var(--purple-primary)]"
                  />
                  <button
                    type="button"
                    data-testid="brief-remove-project"
                    aria-label={`Remove project ${index + 1}`}
                    disabled={noProjects}
                    onClick={() => {
                      setProjects((current) =>
                        current.filter((_, at) => at !== index)
                      );
                      setLinkErrors({});
                      setSaved(false);
                    }}
                    className="shrink-0 rounded-lg border border-[var(--fs-rule)] p-2 text-[var(--fs-ink-dim)] transition-colors hover:border-[var(--purple-primary)]/40"
                  >
                    <Trash2 size={15} strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>

                <input
                  type="text"
                  aria-label={`Project ${index + 1} description`}
                  data-testid="brief-project-line"
                  value={project.line}
                  maxLength={200}
                  disabled={noProjects}
                  placeholder="One line about it"
                  onChange={(event) =>
                    updateProject(index, { line: event.target.value })
                  }
                  className="w-full rounded-lg border border-[var(--fs-rule)] bg-transparent px-3 py-2 text-sm text-[var(--fs-ink)] outline-none focus:border-[var(--purple-primary)]"
                />

                <input
                  type="url"
                  aria-label={`Project ${index + 1} link`}
                  data-testid="brief-project-link"
                  value={project.link}
                  maxLength={500}
                  disabled={noProjects}
                  placeholder="https://"
                  onChange={(event) =>
                    updateProject(index, { link: event.target.value })
                  }
                  onBlur={(event) => {
                    const value = event.target.value.trim();
                    setLinkErrors((current) => {
                      const next = { ...current };
                      if (value.length > 0 && !isHttpsUrl(value)) {
                        next[index] =
                          'That is not a full web address. It needs to start with https://';
                      } else {
                        delete next[index];
                      }
                      return next;
                    });
                  }}
                  className="w-full rounded-lg border border-[var(--fs-rule)] bg-transparent px-3 py-2 text-sm text-[var(--fs-ink)] outline-none focus:border-[var(--purple-primary)]"
                />
                {linkErrors[index] ? (
                  <p
                    role="alert"
                    data-testid="brief-link-error"
                    className="text-xs font-medium text-[var(--fs-ink)]"
                  >
                    {linkErrors[index]}
                  </p>
                ) : null}

                <Thumbnails
                  assets={project.screenshotAssetIds
                    .map((id) => assetById.get(id))
                    .filter((asset): asset is BriefAssetView => Boolean(asset))}
                  label="Screenshots"
                />

                {noProjects ? null : (
                  <AssetUploader
                    workspaceId={workspaceId}
                    slot="section"
                    askKey="brief_project_screenshots"
                    label="Add a screenshot"
                    onSufficiency={(_sufficiency, assetIds) =>
                      adopt(index, assetIds)
                    }
                    // A screenshot is filed against a project by what it
                    // shows, and nothing else here says which project that
                    // is. Two of them went on the wrong case study once for
                    // exactly this reason, so the caption is part of sending
                    // them rather than a nicety afterwards.
                    requireCaption
                    captionPrompt={
                      project.name.trim().length > 0
                        ? `Say what each screenshot shows, and name ${project.name.trim()} in it if it belongs to that project.`
                        : 'Say what each screenshot shows, and name the project it belongs to.'
                    }
                  />
                )}
              </div>
            ))}

            <button
              type="button"
              data-testid="brief-add-project"
              disabled={noProjects || projects.length >= MAX_PROJECTS}
              onClick={() => {
                setProjects((current) => [...current, { ...EMPTY_PROJECT }]);
                setSaved(false);
              }}
              className="inline-flex w-fit items-center gap-2 rounded-lg border border-[var(--fs-rule)] px-4 py-2 text-xs font-semibold text-[var(--fs-ink)] transition-colors hover:border-[var(--purple-primary)]/40 disabled:pointer-events-none disabled:opacity-40"
            >
              <Plus size={14} strokeWidth={2.25} aria-hidden="true" />
              Add a project
            </button>
          </div>
        </div>
      </GlassSurface>

      {/* ── 4. Design references ───────────────────────────────────────── */}
      <GlassSurface as="section" variant="card">
        <div className="flex flex-col gap-3">
          <SectionHeading
            title="Design references"
            hint="One or two screenshots of sites you like, so we aim at the look you have in mind rather than the one we would have guessed. These are references only and never appear on your site."
          />
          <Thumbnails
            assets={referenceIds
              .map((id) => assetById.get(id))
              .filter((asset): asset is BriefAssetView => Boolean(asset))}
            label="References you sent"
          />
          <AssetUploader
            workspaceId={workspaceId}
            slot="section"
            askKey="brief_design_reference"
            label="Add a reference"
            onSufficiency={(_sufficiency, assetIds) =>
              adopt('design', assetIds)
            }
          />
        </div>
      </GlassSurface>

      {/* ── 5. Photos for your site ────────────────────────────────────── */}
      <GlassSurface as="section" variant="card">
        <div className="flex flex-col gap-3">
          <SectionHeading
            title="Photos for your site"
            hint={`The place you work, the thing you make, or you at work. At least ${MIN_PHOTO_LONG_EDGE} pixels on the long edge, straight off a recent phone is fine, and no heavy filters.`}
          />

          {sourcedPortrait ? (
            <SourcedPortrait
              asset={sourcedPortrait}
              chosen={portraitId === sourcedPortrait.id}
              busy={portraitBusy}
              floors={portraitFloors}
              onUse={() => void adoptSourcedPortrait(sourcedPortrait)}
              onReplace={() => replacePortrait(sourcedPortrait)}
            />
          ) : null}

          {photos.length > 0 ? (
            <ul className="flex flex-wrap gap-3" aria-label="Your photos">
              {photos.map((asset) => (
                <li
                  key={asset.id}
                  data-testid="brief-photo"
                  className="flex w-28 flex-col gap-2"
                >
                  <Thumbnail asset={asset} />
                  <AssetCaption asset={asset} />
                  {isUndersizedPhoto(asset) ? (
                    <span
                      data-testid="brief-undersized-warning"
                      className="inline-flex items-start gap-1 rounded-lg border border-[var(--fs-rule)] px-2 py-1 text-[11px] leading-snug text-[var(--fs-ink-dim)]"
                    >
                      <ImageOff
                        size={12}
                        strokeWidth={2}
                        aria-hidden="true"
                        className="mt-0.5 shrink-0"
                      />
                      Smaller than we asked for. We can still use it lower down
                      the page.
                    </span>
                  ) : null}
                  <label className="flex items-center gap-1.5 text-[11px] text-[var(--fs-ink-dim)]">
                    <input
                      type="radio"
                      name="brief-portrait"
                      data-testid="brief-portrait"
                      checked={portraitId === asset.id}
                      onChange={() => {
                        setPortraitId(asset.id);
                        setSaved(false);
                      }}
                      className="size-3.5 accent-[var(--purple-primary)]"
                    />
                    This is my portrait
                  </label>
                </li>
              ))}
            </ul>
          ) : null}

          <div ref={photosUploader}>
            <AssetUploader
              workspaceId={workspaceId}
              slot="hero"
              askKey="brief_photos"
              label="Add photos"
              onSufficiency={(_sufficiency, assetIds) =>
                adopt('photos', assetIds)
              }
            />
          </div>
        </div>
      </GlassSurface>

      {/* ── 6. About you ───────────────────────────────────────────────── */}
      {/*
        Rendered only when `initialBrief.person !== null`. A null person is
        not "unanswered", it is "never asked" -- either the intake predates
        this block, or the funnel classified the site as a services business
        rather than a portfolio. Showing eleven questions about somebody's
        inner life on a plumber's brief is exactly the genre mistake
        `brief-readiness.ts` refuses to make when it decides what blocks a
        build; this form would be undoing that refusal if it asked anyway.
        `hasPerson` is fixed at mount (see its declaration above), so this
        section cannot appear partway through a session -- there is no
        gesture on this form that turns a services brief into a portfolio.
      */}
      {hasPerson && person ? (
        <GlassSurface as="section" variant="card">
          <div className="flex flex-col gap-5">
            <SectionHeading
              title="About you"
              hint="A site with one subject writes well only when it knows who that subject is. Every answer here is optional, and every one is your own words: we quote you, we do not rewrite you."
            />

            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="flex flex-1 flex-col gap-1.5">
                <label
                  className="text-xs font-semibold text-[var(--fs-ink-dim)]"
                  htmlFor="brief-person-name"
                >
                  Your name
                </label>
                <input
                  id="brief-person-name"
                  type="text"
                  data-testid="brief-person-name"
                  value={person.name}
                  maxLength={PERSON_FIELD_CAPS.name}
                  onChange={(event) =>
                    updatePerson({ name: event.target.value })
                  }
                  className="w-full rounded-lg border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)] px-4 py-2.5 text-sm text-[var(--fs-ink)] outline-none transition-colors focus:border-[var(--purple-primary)]"
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <label
                  className="text-xs font-semibold text-[var(--fs-ink-dim)]"
                  htmlFor="brief-person-headline"
                >
                  One line about you
                </label>
                <input
                  id="brief-person-headline"
                  type="text"
                  data-testid="brief-person-headline"
                  value={person.headline}
                  maxLength={PERSON_FIELD_CAPS.headline}
                  placeholder="What you do, the way you'd introduce yourself"
                  onChange={(event) =>
                    updatePerson({ headline: event.target.value })
                  }
                  className="w-full rounded-lg border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)] px-4 py-2.5 text-sm text-[var(--fs-ink)] outline-none transition-colors focus:border-[var(--purple-primary)]"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <SectionHeading
                title="Who you are"
                hint="Who you are, in a sentence or two. This becomes your about page: we quote you here, we do not rewrite you."
              />
              <textarea
                data-testid="brief-person-story"
                aria-label="Who you are"
                value={person.story}
                rows={4}
                maxLength={PERSON_FIELD_CAPS.story}
                onChange={(event) =>
                  updatePerson({ story: event.target.value })
                }
                onBlur={() => setStoryLeft(true)}
                className="w-full rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)] px-4 py-3 text-sm leading-relaxed text-[var(--fs-ink)] outline-none transition-colors focus:border-[var(--purple-primary)]"
              />
              {/* Same quiet-hint rule the offer field uses: a red message
                  under a sentence somebody is still writing is a message
                  about their typing speed, not about their answer. */}
              <p
                data-testid="brief-person-story-count"
                className={cn(
                  'text-xs',
                  storyLeft && storyChars < MIN_STORY_CHARS
                    ? 'font-medium text-[var(--fs-ink)]'
                    : 'text-[var(--fs-ink-faint)]'
                )}
              >
                {storyChars >= MIN_STORY_CHARS
                  ? `${storyChars} characters. That is enough to write your about page from.`
                  : `${storyChars} of about ${MIN_STORY_CHARS} characters. A sentence or two is plenty.`}
              </p>
            </div>

            {person.sourcedBio ? (
              <SourcedBioCard
                bio={person.sourcedBio}
                busy={bioBusy}
                onUse={() => void decideSourcedBio(true)}
                onDismiss={() => void decideSourcedBio(false)}
              />
            ) : null}

            <div className="flex flex-col gap-1.5">
              <label
                className="text-xs font-semibold text-[var(--fs-ink-dim)]"
                htmlFor="brief-person-how-i-work"
              >
                How you work
              </label>
              <p className="text-xs leading-relaxed text-[var(--fs-ink-dim)]">
                How you work, the way you would tell a new client.
              </p>
              <textarea
                id="brief-person-how-i-work"
                data-testid="brief-person-how-i-work"
                aria-label="How you work"
                value={person.howIWork}
                rows={3}
                maxLength={PERSON_FIELD_CAPS.howIWork}
                onChange={(event) =>
                  updatePerson({ howIWork: event.target.value })
                }
                className="w-full rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)] px-4 py-3 text-sm leading-relaxed text-[var(--fs-ink)] outline-none transition-colors focus:border-[var(--purple-primary)]"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                className="text-xs font-semibold text-[var(--fs-ink-dim)]"
                htmlFor="brief-person-values"
              >
                What you stand for
              </label>
              <p className="text-xs leading-relaxed text-[var(--fs-ink-dim)]">
                What you stand for, in your own words.
              </p>
              <textarea
                id="brief-person-values"
                data-testid="brief-person-values"
                aria-label="What you stand for"
                value={person.values}
                rows={3}
                maxLength={PERSON_FIELD_CAPS.values}
                onChange={(event) =>
                  updatePerson({ values: event.target.value })
                }
                className="w-full rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)] px-4 py-3 text-sm leading-relaxed text-[var(--fs-ink)] outline-none transition-colors focus:border-[var(--purple-primary)]"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                className="text-xs font-semibold text-[var(--fs-ink-dim)]"
                htmlFor="brief-person-feel"
              >
                What you want a visitor to feel
              </label>
              <input
                id="brief-person-feel"
                type="text"
                data-testid="brief-person-feel"
                value={person.feel}
                maxLength={PERSON_FIELD_CAPS.feel}
                onChange={(event) => updatePerson({ feel: event.target.value })}
                className="w-full rounded-lg border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)] px-4 py-2.5 text-sm text-[var(--fs-ink)] outline-none transition-colors focus:border-[var(--purple-primary)]"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-[var(--fs-ink-dim)]">
                Three words
              </span>
              <p className="text-xs leading-relaxed text-[var(--fs-ink-dim)]">
                {`Up to ${MAX_TONE_WORDS} words the writing should hit. Every heading and every sentence is chosen to hit these.`}
              </p>
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: MAX_TONE_WORDS }, (_, index) => (
                  <input
                    key={index}
                    type="text"
                    aria-label={`Tone word ${index + 1}`}
                    data-testid="brief-person-tone-word"
                    value={person.toneWords[index] ?? ''}
                    maxLength={PERSON_FIELD_CAPS.toneWord}
                    onChange={(event) =>
                      updateToneWord(index, event.target.value)
                    }
                    className="w-32 rounded-lg border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)] px-3 py-2 text-sm text-[var(--fs-ink)] outline-none transition-colors focus:border-[var(--purple-primary)]"
                  />
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                className="text-xs font-semibold text-[var(--fs-ink-dim)]"
                htmlFor="brief-person-proudest-work"
              >
                Work you are proudest of
              </label>
              <p className="text-xs leading-relaxed text-[var(--fs-ink-dim)]">
                What you are proudest of, and why.
              </p>
              <textarea
                id="brief-person-proudest-work"
                data-testid="brief-person-proudest-work"
                aria-label="Work you are proudest of"
                value={person.proudestWork}
                rows={3}
                maxLength={PERSON_FIELD_CAPS.proudestWork}
                onChange={(event) =>
                  updatePerson({ proudestWork: event.target.value })
                }
                className="w-full rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)] px-4 py-3 text-sm leading-relaxed text-[var(--fs-ink)] outline-none transition-colors focus:border-[var(--purple-primary)]"
              />
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-[var(--fs-ink-dim)]">
                  Your profiles
                </span>
                <p className="text-xs leading-relaxed text-[var(--fs-ink-dim)]">
                  Your LinkedIn, Instagram, GitHub or your own site, entirely
                  optional. Tick the box next to a link only if you want us to
                  read that page: we will suggest a short bio and a photograph
                  from it, and show you both for approval before anything is
                  published.
                </p>
              </div>
              <div className="flex flex-col gap-3">
                {PERSON_LINK_KINDS.map((kind) => {
                  const link = person.links.find(
                    (entry) => entry.kind === kind
                  ) ?? { kind, url: '', consented: false };
                  return (
                    <div
                      key={kind}
                      data-testid="brief-person-link-row"
                      data-kind={kind}
                      className="flex flex-col gap-2 rounded-xl border border-[var(--fs-rule)] px-4 py-3"
                    >
                      <span className="text-xs font-semibold capitalize text-[var(--fs-ink)]">
                        {kind}
                      </span>
                      <input
                        type="url"
                        aria-label={`${kind} link`}
                        data-testid="brief-person-link-url"
                        value={link.url}
                        maxLength={PERSON_FIELD_CAPS.linkUrl}
                        placeholder="https://"
                        onChange={(event) =>
                          updateLink(kind, { url: event.target.value })
                        }
                        className="w-full rounded-lg border border-[var(--fs-rule)] bg-transparent px-3 py-2 text-sm text-[var(--fs-ink)] outline-none focus:border-[var(--purple-primary)]"
                      />
                      <label className="flex items-start gap-2 text-xs text-[var(--fs-ink-dim)]">
                        <input
                          type="checkbox"
                          aria-label={`Let us read your ${kind} page`}
                          data-testid="brief-person-link-consent"
                          checked={link.consented}
                          onChange={(event) =>
                            updateLink(kind, {
                              consented: event.target.checked,
                            })
                          }
                          className="mt-0.5 size-4 shrink-0 rounded border-[var(--fs-rule)] accent-[var(--purple-primary)]"
                        />
                        <span>
                          You may read this page to suggest a bio and a
                          photograph. We will show you both before anything goes
                          on your site.
                        </span>
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-3 rounded-xl border border-[var(--fs-rule)] px-4 py-4">
              <SectionHeading
                title="What you actually do"
                hint="This is what the services page is written from. A general answer here is a general page: the same page anyone in your line of work would get."
              />
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-xs font-semibold text-[var(--fs-ink-dim)]"
                  htmlFor="brief-person-activity-what"
                >
                  What you do
                </label>
                <textarea
                  id="brief-person-activity-what"
                  data-testid="brief-person-activity-what"
                  aria-label="What you do"
                  value={person.activity.what}
                  rows={2}
                  maxLength={PERSON_FIELD_CAPS.activityWhat}
                  placeholder="The way you'd say it if someone asked you at a party"
                  onChange={(event) =>
                    updateActivity({ what: event.target.value })
                  }
                  className="w-full rounded-lg border border-[var(--fs-rule)] bg-transparent px-3 py-2 text-sm text-[var(--fs-ink)] outline-none focus:border-[var(--purple-primary)]"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-xs font-semibold text-[var(--fs-ink-dim)]"
                  htmlFor="brief-person-activity-who"
                >
                  Who you do it for
                </label>
                <input
                  id="brief-person-activity-who"
                  type="text"
                  data-testid="brief-person-activity-who"
                  value={person.activity.who}
                  maxLength={PERSON_FIELD_CAPS.activityWho}
                  onChange={(event) =>
                    updateActivity({ who: event.target.value })
                  }
                  className="w-full rounded-lg border border-[var(--fs-rule)] bg-transparent px-3 py-2 text-sm text-[var(--fs-ink)] outline-none focus:border-[var(--purple-primary)]"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-xs font-semibold text-[var(--fs-ink-dim)]"
                  htmlFor="brief-person-activity-typical"
                >
                  A typical engagement
                </label>
                <textarea
                  id="brief-person-activity-typical"
                  data-testid="brief-person-activity-typical"
                  aria-label="A typical engagement"
                  value={person.activity.typical}
                  rows={2}
                  maxLength={PERSON_FIELD_CAPS.activityTypical}
                  placeholder="What a typical project, engagement or day looks like"
                  onChange={(event) =>
                    updateActivity({ typical: event.target.value })
                  }
                  className="w-full rounded-lg border border-[var(--fs-rule)] bg-transparent px-3 py-2 text-sm text-[var(--fs-ink)] outline-none focus:border-[var(--purple-primary)]"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-xs font-semibold text-[var(--fs-ink-dim)]"
                  htmlFor="brief-person-activity-known-for"
                >
                  What you are known for
                </label>
                <input
                  id="brief-person-activity-known-for"
                  type="text"
                  data-testid="brief-person-activity-known-for"
                  value={person.activity.knownFor}
                  maxLength={PERSON_FIELD_CAPS.activityKnownFor}
                  placeholder="What people ask you for most"
                  onChange={(event) =>
                    updateActivity({ knownFor: event.target.value })
                  }
                  className="w-full rounded-lg border border-[var(--fs-rule)] bg-transparent px-3 py-2 text-sm text-[var(--fs-ink)] outline-none focus:border-[var(--purple-primary)]"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-xs font-semibold text-[var(--fs-ink-dim)]"
                  htmlFor="brief-person-activity-years"
                >
                  How long you have done it
                </label>
                <input
                  id="brief-person-activity-years"
                  type="text"
                  data-testid="brief-person-activity-years"
                  value={person.activity.years}
                  maxLength={PERSON_FIELD_CAPS.activityYears}
                  onChange={(event) =>
                    updateActivity({ years: event.target.value })
                  }
                  className="w-full rounded-lg border border-[var(--fs-rule)] bg-transparent px-3 py-2 text-sm text-[var(--fs-ink)] outline-none focus:border-[var(--purple-primary)]"
                />
              </div>
            </div>
          </div>
        </GlassSurface>
      ) : null}

      {/* ── 7. What is still missing ───────────────────────────────────── */}
      <GlassSurface as="section" variant="card">
        <div className="flex flex-col gap-3">
          <SectionHeading title="What is still missing" />
          {readiness.ready ? (
            <p
              data-testid="brief-ready"
              className="inline-flex items-start gap-2 text-sm font-semibold text-[var(--fs-ink)]"
            >
              <CheckCircle2
                size={16}
                strokeWidth={2.25}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-[var(--purple-primary)]"
              />
              Your brief is complete. Your build starts from here, and we will
              tell you the moment there is something to look at.
            </p>
          ) : (
            <>
              <p
                data-testid="brief-progress"
                className="text-xs text-[var(--fs-ink-dim)]"
              >
                {Math.round(readiness.completeness * 100)}% complete. Your build
                starts once nothing below is outstanding.
              </p>
              <ul className="flex flex-col gap-2">
                {[...blocking, ...degrades].map((entry) => (
                  <li
                    key={entry.code}
                    data-testid="brief-missing-item"
                    data-severity={entry.severity}
                    className="flex items-start gap-2 text-sm leading-relaxed text-[var(--fs-ink-dim)]"
                  >
                    {entry.severity === 'blocking' ? (
                      <AlertCircle
                        size={15}
                        strokeWidth={2.25}
                        aria-hidden="true"
                        className="mt-1 shrink-0 text-[var(--purple-primary)]"
                      />
                    ) : (
                      <Info
                        size={15}
                        strokeWidth={2.25}
                        aria-hidden="true"
                        className="mt-1 shrink-0 text-[var(--fs-ink-faint)]"
                      />
                    )}
                    <span>{entry.message}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </GlassSurface>

      {/* ── Save ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="brief-save"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-lg bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-[var(--purple-primary-lightest)] transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0 disabled:pointer-events-none disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save your brief'}
        </button>
        {saved ? (
          <span
            data-testid="brief-saved"
            className="text-xs font-medium text-[var(--fs-ink-dim)]"
          >
            Saved.
          </span>
        ) : null}
        {error ? (
          <span
            role="alert"
            data-testid="brief-error"
            className="text-xs font-medium text-red-600 dark:text-red-400"
          >
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-base font-bold text-[var(--fs-ink)]">{title}</h2>
      {hint ? (
        <p className="text-xs leading-relaxed text-[var(--fs-ink-dim)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A bio excerpt read off one of the client's own pages, shown as a proposal
 * rather than a fact.
 *
 * The excerpt, the page it came from and when we read it are the same three
 * things whether or not the client has approved it yet; what changes is the
 * verdict underneath and which of the two actions is offered. Approving it
 * never rewrites this card into looking like the client's own typing, and it
 * never reaches into the story textarea above -- `story` is what the client
 * wrote, this is a suggestion sitting beside it, and collapsing that
 * distinction is the entire failure `sourcedBio` exists to prevent. See
 * `SourcedPortrait`, which this follows for shape: a found thing, offered
 * back, with the provenance never out of view.
 */
function SourcedBioCard({
  bio,
  busy,
  onUse,
  onDismiss,
}: {
  bio: PersonSourcedBio;
  busy: boolean;
  onUse: () => void;
  onDismiss: () => void;
}) {
  const adopted = bio.adoptedAt !== null;
  return (
    <div
      data-testid="brief-person-sourced-bio"
      data-adopted={adopted}
      className="flex flex-col gap-2 rounded-xl border border-[var(--fs-rule)] px-4 py-4"
    >
      <p className="text-xs font-semibold text-[var(--fs-ink)]">
        {adopted
          ? 'A bio you approved, read from one of your own pages.'
          : 'We found this on one of your own pages. Read it over before it goes anywhere.'}
      </p>
      <p
        data-testid="brief-person-sourced-bio-excerpt"
        className="rounded-lg bg-[var(--fs-glass-bg)] px-3 py-2 text-sm italic leading-relaxed text-[var(--fs-ink)]"
      >
        {bio.excerpt}
      </p>
      <p className="text-xs text-[var(--fs-ink-dim)]">
        Read from{' '}
        <a
          href={bio.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="brief-person-sourced-bio-source"
          className="font-medium text-[var(--purple-primary)] underline"
        >
          {bio.sourceUrl}
        </a>{' '}
        on {bio.fetchedAt}.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {adopted ? null : (
          <button
            type="button"
            data-testid="brief-person-sourced-bio-use"
            disabled={busy}
            onClick={onUse}
            className="rounded-lg bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] px-4 py-2 text-xs font-semibold text-white shadow-md shadow-[var(--purple-primary-lightest)] transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0 disabled:pointer-events-none disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Use it'}
          </button>
        )}
        <button
          type="button"
          data-testid="brief-person-sourced-bio-dismiss"
          disabled={busy}
          onClick={onDismiss}
          className="rounded-lg border border-[var(--fs-rule)] px-4 py-2 text-xs font-semibold text-[var(--fs-ink)] transition-colors hover:border-[var(--purple-primary)]/40 disabled:pointer-events-none disabled:opacity-40"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function Thumbnails({
  assets,
  label,
}: {
  assets: BriefAssetView[];
  label: string;
}) {
  if (assets.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label={label}>
      {assets.map((asset) => (
        <li key={asset.id} className="flex w-28 flex-col gap-1">
          <Thumbnail asset={asset} />
          <AssetCaption asset={asset} />
        </li>
      ))}
    </ul>
  );
}

/**
 * What a picture is said to show, under the picture.
 *
 * Read-only on purpose: the caption is written where the file is sent, in the
 * uploader, and a second editable copy of the same sentence on the same page
 * is a second chance for the two to disagree. What this is for is recognition
 * -- telling four screenshots apart at thumbnail size -- and being honest
 * about whose sentence it is, because a caption we guessed and a caption the
 * client wrote are not the same evidence.
 */
function AssetCaption({ asset }: { asset: BriefAssetView }) {
  if (!asset.caption) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span
        data-testid="brief-asset-caption"
        className="text-[11px] leading-snug text-[var(--fs-ink-dim)]"
      >
        {asset.caption}
      </span>
      {asset.captionSource ? (
        <span
          data-testid="brief-asset-caption-source"
          className="text-[11px] text-[var(--fs-ink-faint)]"
        >
          {asset.captionSource === 'auto'
            ? 'We suggested this'
            : 'You wrote this'}
        </span>
      ) : null}
    </div>
  );
}

/**
 * One file, at thumbnail size. Exported because `SourcedPortrait` shows the
 * same picture in the same way, and two thumbnails with two different
 * fallbacks for a signed URL that failed to sign is one more than there should
 * be.
 */
export function Thumbnail({ asset }: { asset: BriefAssetView }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived URL on a private bucket cannot be optimised by next/image
    <img
      src={asset.url ?? ''}
      alt="A file you sent"
      data-testid="brief-thumbnail"
      data-asset-id={asset.id}
      className="h-20 w-full rounded-xl border border-[var(--fs-glass-edge)] object-cover"
    />
  );
}

export default BriefForm;
