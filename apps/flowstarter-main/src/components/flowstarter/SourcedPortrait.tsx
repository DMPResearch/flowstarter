'use client';

/**
 * The photograph we found, offered back to the person it is of.
 *
 * Three of the five portrait sources are automatic: a GitHub avatar, an image
 * on the client's own site, and Instagram's public 100x100 OpenGraph picture.
 * Nobody pressed a button for those, so they are filed with
 * `rights_confirmed_at` null and are unpublishable by construction until the
 * client says yes. This card is where they say it.
 *
 * The load-bearing element is the size verdict, not the picture. Instagram's
 * public picture is a hundred pixels square, a favicon with a face on it, and
 * it can be a small round avatar beside a name but can never be the main
 * photograph on a page. A client who taps "Use this" without being told that
 * has been misled by an interface that looked like it was offering them a
 * portrait. So the verdict is computed from the same rule the build obeys,
 * `sizeVerdictFor` over the floors from `portrait-config.ts`, and rendered in
 * the client's own words before either button.
 *
 * "Replace" never deletes. Changing your mind about which photograph
 * represents you is not a reason to destroy a file, and an unconfirmed asset
 * cannot reach a published site anyway.
 */
import { useId } from 'react';
import en from '@/locales/en';
import {
  portraitSizeFloors,
  type PortraitSizeFloors,
} from '@/lib/flowstarter/portrait-config';
import {
  longEdgeOf,
  sizeVerdictFor,
  type PortraitSizeVerdict,
  type PortraitSourceId,
} from '@/lib/flowstarter/portrait-source';
// Imported from BriefForm on purpose: the thumbnail a client sees here has to
// be the same element, with the same signed-URL handling, as the thumbnails in
// the list below it. `Thumbnail` is a hoisted function declaration, so the
// import cycle between the two modules resolves before either renders.
import { Thumbnail, type BriefAssetView } from './BriefForm';
import { portraitVerdictText, portraitSourceText } from './portrait-copy';

export interface SourcedPortraitProps {
  asset: BriefAssetView;
  /** True when this asset is already the chosen portrait. */
  chosen: boolean;
  /** Fired when the client taps "Use this". Must write the rights confirmation. */
  onUse: () => void;
  /** Fired when the client taps "Replace". Clears the choice and opens the uploader. */
  onReplace: () => void;
  busy?: boolean;
  /**
   * The floors, server-computed.
   *
   * `portraitSizeFloors()` reads `process.env`, and in a client component that
   * is inlined at build time from the browser-visible environment, which never
   * carries `FLOWSTARTER_PORTRAIT_MIN_EDGE`. An operator override would
   * therefore be silently ignored here. The brief page reads the floors on the
   * server and passes them down; the default is only for a caller that has no
   * server to ask, such as a test.
   */
  floors?: PortraitSizeFloors;
}

/**
 * Which of the five sources an asset row's `source` column stands for.
 *
 * The column records the network, not the flow, and two of the five sources
 * are the same network reached two different ways. The width is what tells
 * them apart: the Instagram API with Instagram Login returns a full-size
 * picture, while the public OpenGraph picture is 100 square, so anything that
 * clears the portrait floor came from the flow the person authorised.
 */
export function portraitSourceIdFor(
  source: string,
  longEdge: number | null,
  floors: PortraitSizeFloors
): PortraitSourceId | null {
  if (source === 'linkedin') return 'linkedin-openid';
  if (source === 'github') return 'github-avatar';
  if (source === 'og') return 'website-about';
  if (source === 'instagram') {
    return longEdge !== null && longEdge >= floors.portraitEdge
      ? 'instagram-login'
      : 'instagram-public-og';
  }
  return null;
}

/** Verdicts that are not an offer: too small to place anywhere, or unmeasured. */
function isOfferable(verdict: PortraitSizeVerdict): boolean {
  return verdict === 'portrait' || verdict === 'avatar';
}

export function SourcedPortrait({
  asset,
  chosen,
  onUse,
  onReplace,
  busy = false,
  floors = portraitSizeFloors(),
}: SourcedPortraitProps) {
  const verdictId = useId();
  const longEdge = longEdgeOf({
    url: '',
    width: asset.width,
    height: asset.height,
  });
  const verdict = sizeVerdictFor(longEdge, floors);
  const sourceId = portraitSourceIdFor(asset.source, longEdge, floors);
  const confirmed = asset.rightsConfirmedAt !== null;
  const offerable = isOfferable(verdict);

  return (
    <div
      data-testid="brief-sourced-portrait"
      data-source={asset.source}
      className="flex flex-col gap-3 rounded-xl border border-[var(--fs-rule)] px-4 py-4 sm:flex-row sm:items-start"
    >
      <div className="w-28 shrink-0">
        <Thumbnail asset={asset} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p
          data-testid="brief-portrait-found"
          className="text-sm font-semibold text-[var(--fs-ink)]"
        >
          {en['portrait.brief.found']}
          {sourceId ? ` ${portraitSourceText(sourceId)}` : ''}
        </p>

        <p
          id={verdictId}
          data-testid="brief-portrait-verdict"
          data-verdict={verdict}
          className="text-xs leading-relaxed text-[var(--fs-ink-dim)]"
        >
          {portraitVerdictText(verdict)}
        </p>

        {confirmed && chosen ? (
          <p
            data-testid="brief-portrait-in-use"
            className="text-xs font-medium text-[var(--fs-ink)]"
          >
            {en['portrait.brief.inUse']}
          </p>
        ) : null}

        {confirmed ? null : (
          <p
            data-testid="brief-portrait-pending"
            className="text-xs leading-relaxed text-[var(--fs-ink-faint)]"
          >
            {en['portrait.brief.pending']}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {confirmed && chosen ? null : (
            <button
              type="button"
              data-testid="brief-portrait-use"
              // A picture below the avatar floor, or one nothing has measured,
              // is not an option we are willing to offer: the verdict beside
              // the button is the whole reason it is disabled, so it is what
              // the button points at.
              disabled={busy || !offerable}
              aria-describedby={offerable ? undefined : verdictId}
              onClick={onUse}
              className="rounded-lg bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] px-4 py-2 text-xs font-semibold text-white shadow-md shadow-[var(--purple-primary-lightest)] transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0 disabled:pointer-events-none disabled:opacity-40"
            >
              {busy ? en['app.saving'] : en['portrait.brief.use']}
            </button>
          )}

          <button
            type="button"
            data-testid="brief-portrait-replace"
            disabled={busy}
            onClick={onReplace}
            className="rounded-lg border border-[var(--fs-rule)] px-4 py-2 text-xs font-semibold text-[var(--fs-ink)] transition-colors hover:border-[var(--purple-primary)]/40 disabled:pointer-events-none disabled:opacity-40"
          >
            {en['portrait.brief.replace']}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SourcedPortrait;
