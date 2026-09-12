'use client';

/**
 * "Use my profile picture on the site", asked once, on the claim page.
 *
 * While the preview was being built we read whatever the visitor's public
 * Instagram, LinkedIn or website exposed, and when that included a picture we
 * kept it so the preview could look like them rather than like a template.
 * That picture is filed with no rights confirmation on it, which makes it
 * invisible to `loadUsableAssets` and unpublishable on a paid site by
 * construction. This checkbox is the only thing that changes that.
 *
 * Three deliberate decisions.
 *
 * IT SHOWS THE PICTURE. A consent question about an image the person cannot
 * see is not consent, it is a checkbox. The signed URL is short lived and the
 * object is in a private bucket, so this is the one place it is ever visible.
 *
 * IT IS CHECKED BY DEFAULT. The visitor pasted the link, the picture is of
 * them, and it is already on the preview they are looking at and about to pay
 * for. Making them opt in to their own face would be friction dressed as
 * caution. Unchecking is one tap and is respected exactly.
 *
 * IT NAMES THE NETWORK. "We took this off your Instagram" is a different
 * sentence from "use this picture", and the visitor is entitled to the first
 * one before they answer the second.
 *
 * The component decides nothing. Whether there is a picture to ask about is
 * settled server side; this draws the question and reports the answer.
 */
import { useState } from 'react';

import type { FetchedProfilePicture } from '../discovery.logic';

const KEY = 'landing.discovery.brand.consent.';

export interface ProfilePictureConsentProps {
  picture?: FetchedProfilePicture;
  /** Fired whenever the answer changes, and once on mount with the default. */
  onChange: (useIt: boolean) => void;
  t: (key: string) => string;
}

export function ProfilePictureConsent({
  picture,
  onChange,
  t,
}: ProfilePictureConsentProps) {
  const [checked, setChecked] = useState(true);

  // No picture, no question. A claim page that asks about a photograph that
  // does not exist is worse than one that asks nothing.
  if (!picture) return null;

  const network = t(`landing.discovery.brand.network.${picture.network}`);

  return (
    <div
      data-testid="profile-picture-consent"
      data-network={picture.network}
      className="mt-2 flex items-start gap-3 rounded-lg border border-[var(--fs-rule)] bg-white/50 p-2.5 dark:bg-white/[0.03]"
    >
      {picture.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={picture.url}
          alt={t(`${KEY}alt`)}
          data-testid="profile-picture-consent-image"
          className="h-12 w-12 shrink-0 rounded-md object-cover"
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <label className="flex items-start gap-2 text-[12px] leading-snug text-[var(--fs-ink)]">
          <input
            type="checkbox"
            data-testid="profile-picture-consent-checkbox"
            checked={checked}
            onChange={(event) => {
              setChecked(event.target.checked);
              onChange(event.target.checked);
            }}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--purple-primary)]"
          />
          <span>{t(`${KEY}label`)}</span>
        </label>
        <p className="mt-1 text-[11px] leading-snug text-[var(--fs-ink-faint)]">
          {`${t(`${KEY}from`)} ${network}. ${t(`${KEY}note`)}`}
        </p>
      </div>
    </div>
  );
}
