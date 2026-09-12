'use client';

/**
 * "Your colours and voice", under the preview pane.
 *
 * The visitor pastes an Instagram, a LinkedIn or a website, and the server
 * reads whatever those pages expose to somebody without a login. What comes
 * back is shown here: four swatches derived from the pictures by rule, and one
 * line about how the site should sound, phrased from the visitor's own words.
 *
 * The part of this that matters most is the part that admits failure. Measured
 * against the real pages, Instagram answers an anonymous request with a
 * success code and an empty shell, and LinkedIn refuses outright, so for most
 * visitors the honest answer is "I could not read that". Showing a palette
 * without saying where it came from would be the easy thing and the wrong one:
 * the visitor would believe we had looked at their brand when we had looked at
 * their tone chips. So every network that would not talk to us gets a line
 * naming it and saying why, and when none of them did, the visitor is offered
 * the upload instead.
 *
 * This component draws; it decides nothing. The palette, the contrast
 * adjustment, the tone fallback and the question of whether to offer the
 * upload are all settled before the data reaches here.
 */
import { useRef, useState } from 'react';
import { ImagePlus, Loader2, Pencil } from 'lucide-react';

import type { DerivedPalette, DerivedTone } from '../discovery.logic';

const KEY = 'landing.discovery.brand.';

/** The four roles, in the order the swatches are drawn. */
const ROLES = ['primary', 'secondary', 'accent', 'neutral'] as const;

export interface BrandStripProps {
  palette?: DerivedPalette;
  tone?: DerivedTone;
  unavailable?: Array<{ network: string; reason: string }>;
  /** True while the server is reading the profiles. */
  loading?: boolean;
  /**
   * True when nothing was readable and a picture would help. Decided by the
   * route, not here.
   */
  offerPictureUpload?: boolean;
  /** Set once a picture has been taken, so the ask turns into a thank you. */
  pictureUploaded?: boolean;
  onUploadPicture?: (file: File) => void | Promise<void>;
  onAdjust?: () => void;
  t: (key: string) => string;
}

export function BrandStrip({
  palette,
  tone,
  unavailable = [],
  loading = false,
  offerPictureUpload = false,
  pictureUploaded = false,
  onUploadPicture,
  onAdjust,
  t,
}: BrandStripProps) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  // Nothing to say yet: no links answered, no derivation run. Drawing an empty
  // strip here would be a promise the pane has not earned.
  if (!loading && !palette && !tone) return null;

  const pick = async (file: File | undefined) => {
    if (!file || !onUploadPicture) return;
    setBusy(true);
    try {
      await onUploadPicture(file);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="brand-strip" className="mt-3">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--fs-ink-faint)]">
        {t(`${KEY}title`)}
      </p>

      {loading && !palette ? (
        <p
          data-testid="brand-strip-loading"
          className="flex items-center gap-1.5 py-1.5 text-[12px] text-[var(--fs-ink-faint)]"
        >
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          {t(`${KEY}reading`)}
        </p>
      ) : null}

      {palette ? (
        <div className="space-y-1.5">
          <ul
            data-testid="brand-swatches"
            data-source={palette.source}
            className="flex items-center gap-1.5"
          >
            {ROLES.map((role) => (
              <li key={role} className="flex min-w-0 items-center gap-1">
                <span
                  data-testid={`brand-swatch-${role}`}
                  data-hex={palette[role].base}
                  // The one place in the product a colour is set from data
                  // rather than a token: these are the visitor's own colours
                  // and there is no token that could hold them.
                  style={{ backgroundColor: palette[role].base }}
                  className="h-5 w-5 shrink-0 rounded-md border border-[var(--fs-rule)]"
                  title={`${t(`${KEY}swatch.${role}`)} ${palette[role].base}`}
                  aria-label={`${t(`${KEY}swatch.${role}`)} ${
                    palette[role].base
                  }`}
                />
              </li>
            ))}
            {onAdjust ? (
              <li className="ml-auto">
                <button
                  type="button"
                  data-testid="brand-adjust"
                  onClick={onAdjust}
                  className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-[var(--fs-ink-faint)] transition-colors hover:text-[var(--purple-primary)]"
                >
                  <Pencil className="h-3 w-3" aria-hidden="true" />
                  {t(`${KEY}adjust`)}
                </button>
              </li>
            ) : null}
          </ul>
          <p className="text-[11px] leading-snug text-[var(--fs-ink-faint)]">
            {t(`${KEY}paletteFrom.${palette.source}`)}
          </p>
        </div>
      ) : null}

      {tone && tone.adjectives.length > 0 ? (
        <div data-testid="brand-tone" className="mt-2 space-y-1">
          <p className="text-[12px] font-medium text-[var(--fs-ink)]">
            {tone.adjectives.join(', ')}
          </p>
          {tone.voice ? (
            <p className="text-[11px] leading-snug text-[var(--fs-ink-dim)]">
              {tone.voice}
            </p>
          ) : null}
          <p className="text-[11px] leading-snug text-[var(--fs-ink-faint)]">
            {t(`${KEY}voiceFrom.${tone.source}`)}
          </p>
        </div>
      ) : null}

      {unavailable.length > 0 ? (
        <div data-testid="brand-unavailable" className="mt-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--fs-ink-faint)]">
            {t(`${KEY}unavailableTitle`)}
          </p>
          <ul className="mt-1 space-y-0.5">
            {unavailable.map((entry) => (
              <li
                key={`${entry.network}-${entry.reason}`}
                data-network={entry.network}
                data-reason={entry.reason}
                className="text-[11px] leading-snug text-[var(--fs-ink-faint)]"
              >
                {`${t(`${KEY}network.${entry.network}`)} ${t(
                  `${KEY}unavailable.${entry.reason}`
                )}.`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {offerPictureUpload && !pictureUploaded && onUploadPicture ? (
        <div data-testid="brand-picture-ask" className="mt-2 space-y-1.5">
          <p className="text-[11px] leading-snug text-[var(--fs-ink-dim)]">
            {t(`${KEY}pictureAsk`)}
          </p>
          <button
            type="button"
            data-testid="brand-picture-cta"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--fs-rule)] px-2.5 py-1.5 text-[12px] text-[var(--fs-ink)] transition-colors hover:border-[var(--purple-primary)]/40 disabled:opacity-60"
          >
            {busy ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {t(`${KEY}pictureCta`)}
          </button>
          <p className="text-[10px] leading-snug text-[var(--fs-ink-faint)]">
            {t(`${KEY}pictureRights`)}
          </p>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            data-testid="brand-picture-input"
            onChange={(event) => {
              void pick(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </div>
      ) : null}

      {pictureUploaded ? (
        <p
          data-testid="brand-picture-done"
          className="mt-2 text-[11px] leading-snug text-[var(--fs-ink-dim)]"
        >
          {t(`${KEY}pictureDone`)}
        </p>
      ) : null}
    </section>
  );
}
