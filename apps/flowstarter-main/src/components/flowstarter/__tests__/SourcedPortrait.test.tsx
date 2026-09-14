/**
 * The card that offers a client back a photograph we went and found.
 *
 * The behaviour worth pinning is not that a picture renders. It is that the
 * client is told what the picture is good for BEFORE they are asked to accept
 * it. Instagram's public OpenGraph picture is 100 pixels square, and a card
 * that showed it beside a "Use this" button without saying so would be an
 * interface promising a portrait and delivering a favicon. So these tests
 * assert the verdict sentence itself, in the client's own words, read through
 * `portrait-copy` from the same key the rule produces, so if the rule and the
 * catalogue ever drift apart the assertion fails rather than the site.
 *
 * The other half is consent. Three of the five sources are automatic and are
 * filed with `rights_confirmed_at` null, so until the client taps "Use this"
 * the card must say we will not publish it, and a picture too small to place
 * anywhere must not be offered as a choice at all.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import en from '@/locales/en';
import {
  DEFAULT_AVATAR_EDGE,
  DEFAULT_PORTRAIT_EDGE,
  type PortraitSizeFloors,
} from '@/lib/flowstarter/portrait-config';
import {
  PORTRAIT_SOURCE_ORDER,
  type PortraitSourceId,
} from '@/lib/flowstarter/portrait-source';
import { SourcedPortrait, portraitSourceIdFor } from '../SourcedPortrait';
import { portraitSourceText, portraitVerdictText } from '../portrait-copy';
import type { BriefAssetView } from '../BriefForm';

const ASSET_ID = '44444444-4444-4444-8444-444444444444';

const FLOORS: PortraitSizeFloors = {
  portraitEdge: DEFAULT_PORTRAIT_EDGE,
  avatarEdge: DEFAULT_AVATAR_EDGE,
};

function asset(overrides: Partial<BriefAssetView> = {}): BriefAssetView {
  return {
    id: ASSET_ID,
    kind: null,
    mime: 'image/jpeg',
    width: 800,
    height: 800,
    usable: false,
    url: 'https://storage.test/signed.jpg',
    source: 'linkedin',
    sourceUrl: 'https://media.licdn.com/dms/image/example/profile.jpg',
    rightsConfirmedAt: null,
    ...overrides,
  };
}

function mount(
  overrides: Partial<BriefAssetView> = {},
  props: Partial<{
    chosen: boolean;
    busy: boolean;
    floors: PortraitSizeFloors;
    onUse: () => void;
    onReplace: () => void;
  }> = {}
) {
  const onUse = props.onUse ?? vi.fn();
  const onReplace = props.onReplace ?? vi.fn();
  render(
    <SourcedPortrait
      asset={asset(overrides)}
      chosen={props.chosen ?? false}
      busy={props.busy}
      floors={props.floors}
      onUse={onUse}
      onReplace={onReplace}
    />
  );
  return { onUse, onReplace };
}

describe('SourcedPortrait', () => {
  // The best case: LinkedIn, full size, nobody has confirmed anything yet.
  // The client should see where it came from, that it is big enough for the
  // main photo, that we will not publish it until they say so, and a way to
  // say so.
  it('offers a full-size LinkedIn picture with the portrait verdict', async () => {
    const user = userEvent.setup();
    const { onUse } = mount({ width: 800, height: 800 });

    const card = screen.getByTestId('brief-sourced-portrait');
    expect(card).toHaveAttribute('data-source', 'linkedin');
    expect(screen.getByTestId('brief-portrait-found')).toHaveTextContent(
      `${en['portrait.brief.found']} ${portraitSourceText('linkedin-openid')}`
    );

    const verdict = screen.getByTestId('brief-portrait-verdict');
    expect(verdict).toHaveAttribute('data-verdict', 'portrait');
    expect(verdict).toHaveTextContent(portraitVerdictText('portrait'));

    expect(screen.getByTestId('brief-portrait-pending')).toHaveTextContent(
      en['portrait.brief.pending']
    );

    const use = screen.getByTestId('brief-portrait-use');
    expect(use).toHaveTextContent(en['portrait.brief.use']);
    expect(use).not.toBeDisabled();
    await user.click(use);
    expect(onUse).toHaveBeenCalledTimes(1);
  });

  // The case the whole card exists for. Instagram's public page serves a
  // hundred pixels square, which can be a round avatar beside a name and can
  // never be a hero, and the client has to read that sentence before they
  // choose it rather than discover it on a built site.
  it('says in plain words that a 100 square Instagram picture is avatar only', () => {
    mount({
      source: 'instagram',
      width: 100,
      height: 100,
      sourceUrl: 'https://scontent.cdninstagram.com/v/example_100x100.jpg',
    });

    expect(screen.getByTestId('brief-portrait-found')).toHaveTextContent(
      portraitSourceText('instagram-public-og')
    );
    const verdict = screen.getByTestId('brief-portrait-verdict');
    expect(verdict).toHaveAttribute('data-verdict', 'avatar');
    expect(verdict).toHaveTextContent(portraitVerdictText('avatar'));
    // The exact promise: it is used small, and it is not stretched.
    expect(verdict).toHaveTextContent('we will not stretch it');
    expect(screen.getByTestId('brief-portrait-use')).not.toBeDisabled();
  });

  // Below the avatar floor there is nowhere on the site the picture can go, so
  // "Use this" is not an option we offer. The disabled button points at the
  // verdict sentence, which is the reason.
  it('refuses to offer a picture too small for even an avatar', () => {
    mount({ width: 50, height: 50 });

    const verdict = screen.getByTestId('brief-portrait-verdict');
    expect(verdict).toHaveAttribute('data-verdict', 'too_small');
    expect(verdict).toHaveTextContent(portraitVerdictText('too_small'));

    const use = screen.getByTestId('brief-portrait-use');
    expect(use).toBeDisabled();
    expect(use).toHaveAttribute('aria-describedby', verdict.id);
    // Replace is still there: a picture we cannot use is exactly when the
    // client most needs the uploader.
    expect(screen.getByTestId('brief-portrait-replace')).not.toBeDisabled();
  });

  // Nothing measured it, so nothing may place it. Same treatment as too small,
  // because "we do not know" is not a licence to guess.
  it('refuses to offer a picture nothing has measured', () => {
    mount({ width: null, height: null });

    expect(screen.getByTestId('brief-portrait-verdict')).toHaveAttribute(
      'data-verdict',
      'unknown'
    );
    expect(screen.getByTestId('brief-portrait-use')).toBeDisabled();
  });

  // Once it is confirmed and chosen there is nothing left to accept, so the
  // only remaining choice is to change it.
  it('shows the in-use line and only Replace once it is the chosen portrait', async () => {
    const user = userEvent.setup();
    const { onReplace } = mount(
      { rightsConfirmedAt: '2026-09-13T10:00:00.000Z', usable: true },
      { chosen: true }
    );

    expect(screen.getByTestId('brief-portrait-in-use')).toHaveTextContent(
      en['portrait.brief.inUse']
    );
    expect(screen.queryByTestId('brief-portrait-pending')).toBeNull();
    expect(screen.queryByTestId('brief-portrait-use')).toBeNull();

    await user.click(screen.getByTestId('brief-portrait-replace'));
    expect(onReplace).toHaveBeenCalledTimes(1);
  });

  // Confirmed but not chosen: the rights are on record, so there is no pending
  // line, but the client still has to say this is the one.
  it('still offers Use this on a confirmed picture that is not the choice', () => {
    mount({ rightsConfirmedAt: '2026-09-13T10:00:00.000Z', usable: true });

    expect(screen.queryByTestId('brief-portrait-pending')).toBeNull();
    expect(screen.queryByTestId('brief-portrait-in-use')).toBeNull();
    expect(screen.getByTestId('brief-portrait-use')).not.toBeDisabled();
  });

  // Both buttons stand down while the confirmation and the save are in flight,
  // so a second tap cannot start a second pair of writes.
  it('holds both buttons while the choice is being written', () => {
    mount({}, { busy: true });
    expect(screen.getByTestId('brief-portrait-use')).toBeDisabled();
    expect(screen.getByTestId('brief-portrait-replace')).toBeDisabled();
  });

  // The floors are a prop rather than a config call because `process.env` in a
  // client component is the browser-visible half and never carries an operator
  // override. Raising the floor has to change the verdict.
  it('judges against the floors it was handed, not a built-in number', () => {
    mount(
      { width: 800, height: 800 },
      { floors: { portraitEdge: 1200, avatarEdge: 96 } }
    );
    expect(screen.getByTestId('brief-portrait-verdict')).toHaveAttribute(
      'data-verdict',
      'avatar'
    );
  });

  // The asset row records the network; the card has to name the source the
  // client would recognise. Instagram is the only one that is two sources, and
  // the width is what separates the connect flow from the public page.
  it.each([
    ['linkedin', 800, 'linkedin-openid'],
    ['instagram', 1080, 'instagram-login'],
    ['instagram', 100, 'instagram-public-og'],
    ['github', 460, 'github-avatar'],
    ['og', 1200, 'website-about'],
  ] as Array<[string, number, PortraitSourceId]>)(
    'names %s at %ipx as its own source',
    (source, edge, expected) => {
      expect(portraitSourceIdFor(source, edge, FLOORS)).toBe(expected);
    }
  );

  // A source vocabulary this card does not know about is not a crash and is
  // not a guess: the card says it found a photo and names no network.
  it('names no source for a row from a network it does not model', () => {
    expect(portraitSourceIdFor('social', 800, FLOORS)).toBeNull();
    mount({ source: 'social' });
    expect(screen.getByTestId('brief-portrait-found')).toHaveTextContent(
      en['portrait.brief.found']
    );
  });

  // Every string this card puts on screen has to exist in the catalogue. A
  // missing key falls back to the key itself, which is the shape asserted
  // against here: no rendered sentence may ever start with "portrait.".
  it('resolves every locale key it uses', () => {
    for (const source of PORTRAIT_SOURCE_ORDER) {
      expect(portraitSourceText(source)).not.toBe(`portrait.source.${source}`);
    }
    for (const verdict of [
      'portrait',
      'avatar',
      'too_small',
      'unknown',
    ] as const) {
      expect(portraitVerdictText(verdict)).not.toBe(
        `portrait.verdict.${verdict}`
      );
    }
    for (const key of [
      'portrait.brief.found',
      'portrait.brief.use',
      'portrait.brief.replace',
      'portrait.brief.pending',
      'portrait.brief.inUse',
    ] as const) {
      expect(en[key]).toBeTruthy();
    }

    mount();
    for (const testId of [
      'brief-portrait-found',
      'brief-portrait-verdict',
      'brief-portrait-pending',
      'brief-portrait-use',
      'brief-portrait-replace',
    ]) {
      expect(screen.getByTestId(testId).textContent ?? '').not.toContain(
        'portrait.'
      );
    }
  });
});
