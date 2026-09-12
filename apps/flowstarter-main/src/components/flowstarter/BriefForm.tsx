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
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { cn } from '@/lib/utils';
import { AssetUploader } from './AssetUploader';

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
  projects: BriefProjectView[];
  noProjects: boolean;
  designReferenceAssetIds: string[];
  photoAssetIds: string[];
  portraitAssetId: string | null;
  readyAt: string | null;
  overrideAt: string | null;
}

/** One file, as `/api/client/brief/[workspaceId]` reports it. */
export interface BriefAssetView {
  id: string;
  kind: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  usable: boolean;
  url: string | null;
}

export interface BriefFormProps {
  workspaceId: string;
  initialBrief: BriefView;
  initialReadiness: BriefReadiness;
  initialAssets: BriefAssetView[];
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
}: BriefFormProps) {
  const [offer, setOffer] = useState(initialBrief.offer);
  const [offerLeft, setOfferLeft] = useState(false);
  const [projects, setProjects] = useState<BriefProjectView[]>(
    initialBrief.projects
  );
  const [noProjects, setNoProjects] = useState(initialBrief.noProjects);
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

  // The uploader reports "a write happened", not which ids landed, so the
  // newly arrived files are found by difference against what we already knew.
  // Kept in a ref because the callback the uploader holds is created once.
  const knownIds = useRef(new Set(initialAssets.map((asset) => asset.id)));
  useEffect(() => {
    knownIds.current = new Set(assets.map((asset) => asset.id));
  }, [assets]);

  const endpoint = `/api/client/brief/${workspaceId}`;

  const adopt = useCallback(
    async (target: UploadTarget) => {
      let payload: BriefResponse;
      try {
        const response = await fetch(endpoint);
        if (!response.ok) return;
        payload = (await response.json()) as BriefResponse;
      } catch {
        // The files are stored either way; the next save will pick them up.
        return;
      }
      const fresh = payload.assets
        .filter((asset) => !knownIds.current.has(asset.id))
        .map((asset) => asset.id);
      setAssets(payload.assets);
      if (fresh.length === 0) return;

      if (target === 'design') {
        setReferenceIds((current) =>
          [...current, ...fresh].slice(0, MAX_REFERENCES)
        );
        return;
      }
      if (target === 'photos') {
        setPhotoIds((current) => [...current, ...fresh].slice(0, MAX_PHOTOS));
        return;
      }
      setProjects((current) =>
        current.map((project, index) =>
          index === target
            ? {
                ...project,
                screenshotAssetIds: [
                  ...project.screenshotAssetIds,
                  ...fresh,
                ].slice(0, MAX_SCREENSHOTS),
              }
            : project
        )
      );
    },
    [endpoint]
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

  const save = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offer,
          // Ticking "no past work" clears the list rather than hiding it: the
          // route refuses a body that says both, and a half-typed project the
          // client cannot see is not something to save on their behalf.
          projects: noProjects ? [] : projects,
          noProjects,
          designReferenceAssetIds: referenceIds,
          photoAssetIds: photoIds,
          portraitAssetId: portraitId,
        }),
      });
      const payload = (await response
        .json()
        .catch(() => ({}))) as Partial<BriefResponse>;
      if (!response.ok || !payload.brief || !payload.readiness) {
        setError(payload.error ?? 'We could not save that. Please try again.');
        return;
      }
      // The server's answer replaces the form, so what a client sees after a
      // save is what is stored, not what they typed.
      setOffer(payload.brief.offer);
      setProjects(payload.brief.projects);
      setNoProjects(payload.brief.noProjects);
      setReferenceIds(payload.brief.designReferenceAssetIds);
      setPhotoIds(payload.brief.photoAssetIds);
      setPortraitId(payload.brief.portraitAssetId);
      setReadiness(payload.readiness);
      setAssets(payload.assets ?? []);
      setLinkErrors({});
      setSaved(true);
    } catch {
      setError('We could not save that. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [
    endpoint,
    noProjects,
    offer,
    photoIds,
    portraitId,
    projects,
    referenceIds,
  ]);

  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const photos = photoIds
    .map((id) => assetById.get(id))
    .filter((asset): asset is BriefAssetView => Boolean(asset));
  const offerChars = offer.replace(/\s+/g, ' ').trim().length;
  const blocking = readiness.missing.filter(
    (entry) => entry.severity === 'blocking'
  );
  const degrades = readiness.missing.filter(
    (entry) => entry.severity !== 'blocking'
  );

  return (
    <div className="flex flex-col gap-5" data-testid="brief-form">
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

      {/* ── 2. Products or projects ────────────────────────────────────── */}
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
                    onSufficiency={() => void adopt(index)}
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

      {/* ── 3. Design references ───────────────────────────────────────── */}
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
            onSufficiency={() => void adopt('design')}
          />
        </div>
      </GlassSurface>

      {/* ── 4. Photos for your site ────────────────────────────────────── */}
      <GlassSurface as="section" variant="card">
        <div className="flex flex-col gap-3">
          <SectionHeading
            title="Photos for your site"
            hint={`The place you work, the thing you make, or you at work. At least ${MIN_PHOTO_LONG_EDGE} pixels on the long edge, straight off a recent phone is fine, and no heavy filters.`}
          />

          {photos.length > 0 ? (
            <ul className="flex flex-wrap gap-3" aria-label="Your photos">
              {photos.map((asset) => (
                <li
                  key={asset.id}
                  data-testid="brief-photo"
                  className="flex w-28 flex-col gap-2"
                >
                  <Thumbnail asset={asset} />
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

          <AssetUploader
            workspaceId={workspaceId}
            slot="hero"
            askKey="brief_photos"
            label="Add photos"
            onSufficiency={() => void adopt('photos')}
          />
        </div>
      </GlassSurface>

      {/* ── 5. What is still missing ───────────────────────────────────── */}
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
        <li key={asset.id}>
          <Thumbnail asset={asset} />
        </li>
      ))}
    </ul>
  );
}

function Thumbnail({ asset }: { asset: BriefAssetView }) {
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
