/**
 * The claim page's one picture question.
 *
 * A picture read off somebody's public profile is unpublishable until this
 * checkbox says otherwise, so what it does when nobody touches it, and what it
 * does when somebody unticks it, are both worth pinning.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import en from '@/locales/en';
import type { FetchedProfilePicture } from '../discovery.logic';
import { ProfilePictureConsent } from '../steps/ProfilePictureConsent';

const t = (key: string): string =>
  (en as unknown as Record<string, string>)[key] ?? key;

const PICTURE: FetchedProfilePicture = {
  assetId: '11111111-1111-4111-8111-111111111111',
  network: 'instagram',
  width: 1080,
  height: 1080,
  url: 'https://example.test/signed/a.jpg',
};

function renderConsent(picture?: FetchedProfilePicture) {
  const onChange = vi.fn();
  render(<ProfilePictureConsent picture={picture} onChange={onChange} t={t} />);
  return { onChange, user: userEvent.setup() };
}

describe('ProfilePictureConsent', () => {
  it('is checked by default', () => {
    // The visitor pasted the link, the picture is of them, and it is already
    // on the preview they are about to pay for. Making them opt in to their
    // own face would be friction dressed as caution.
    renderConsent(PICTURE);
    expect(
      screen.getByTestId('profile-picture-consent-checkbox')
    ).toBeChecked();
  });

  it('asks in the words the visitor was promised', () => {
    renderConsent(PICTURE);
    expect(
      screen.getByText(t('landing.discovery.brand.consent.label'))
    ).toBeInTheDocument();
  });

  it('names the network it took the picture from', () => {
    // "We took this off your Instagram" is a different sentence from "use this
    // picture", and the visitor is entitled to the first before the second.
    renderConsent(PICTURE);
    const block = screen.getByTestId('profile-picture-consent');
    expect(block).toHaveAttribute('data-network', 'instagram');
    expect(block).toHaveTextContent(
      t('landing.discovery.brand.network.instagram')
    );
  });

  it('shows the picture it is asking about', () => {
    // A consent question about an image the person cannot see is a checkbox,
    // not consent.
    renderConsent(PICTURE);
    expect(screen.getByTestId('profile-picture-consent-image')).toHaveAttribute(
      'src',
      PICTURE.url
    );
  });

  it('still asks when the picture could not be signed', () => {
    renderConsent({ ...PICTURE, url: null });
    expect(screen.getByTestId('profile-picture-consent')).toBeInTheDocument();
    expect(screen.queryByTestId('profile-picture-consent-image')).toBeNull();
  });

  it('reports the answer when it is unticked, and again when it is put back', async () => {
    const { onChange, user } = renderConsent(PICTURE);
    const box = screen.getByTestId('profile-picture-consent-checkbox');

    await user.click(box);
    expect(box).not.toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith(false);

    await user.click(box);
    expect(box).toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it('is absent when no picture was fetched', () => {
    // A claim page that asks about a photograph that does not exist is worse
    // than one that asks nothing.
    const { onChange } = renderConsent(undefined);
    expect(screen.queryByTestId('profile-picture-consent')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('has copy for every network it can name', () => {
    for (const network of ['instagram', 'linkedin', 'website']) {
      const key = `landing.discovery.brand.network.${network}`;
      expect(t(key)).not.toBe(key);
    }
    for (const part of ['label', 'from', 'note', 'alt']) {
      const key = `landing.discovery.brand.consent.${part}`;
      expect(t(key)).not.toBe(key);
    }
  });
});
