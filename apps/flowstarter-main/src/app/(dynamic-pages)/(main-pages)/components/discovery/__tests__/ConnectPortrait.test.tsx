/**
 * The one place the funnel asks for somebody's face.
 *
 * `portrait-source.ts` measured the alternatives and reached one conclusion:
 * scraping behind a login is not acceptable, so the only sources that can
 * produce a real, full-size portrait are the two where the person presses the
 * button themselves. This panel is that button, which makes three of its
 * behaviours worth pinning rather than assuming.
 *
 * A BUTTON THAT CANNOT WORK MUST NOT LOOK LIKE ONE THAT CAN. A deployment may
 * hold credentials for neither provider, and the panel only learns which from
 * the server. Every path through that answer, including the request failing,
 * has to end in a disabled button that says why rather than in a click that
 * 500s, so every path is a test here.
 *
 * THE NAMESPACE IS MINTED ONCE. The connect round trip happens at the links
 * question, before a preview exists, so the wizard mints the id the assets are
 * filed under. A visitor who tries LinkedIn, thinks better of it and tries
 * Instagram must land in the same namespace both times.
 *
 * EVERY OUTCOME IS A SENTENCE. The callback can come back nine different ways
 * and each of them is something a person reads. None of them may be a code, a
 * blank, or an untranslated key.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import en from '@/locales/en';
import { EMPTY_DISCOVERY, type DiscoveryData } from '../discovery.logic';
import { ConnectPortrait } from '../steps/ConnectPortrait';

const t = (key: string): string =>
  (en as unknown as Record<string, string>)[key] ?? key;

/** The availability answer, shaped exactly like the route's 200 body. */
function availability(linkedin: boolean, instagram: boolean) {
  return {
    ok: true,
    json: async () => ({
      providers: [
        {
          provider: 'linkedin',
          available: linkedin,
          missing: linkedin ? [] : ['LINKEDIN_CLIENT_ID'],
        },
        {
          provider: 'instagram',
          available: instagram,
          missing: instagram ? [] : ['INSTAGRAM_CLIENT_ID'],
        },
      ],
    }),
  } as unknown as Response;
}

function renderConnect(options?: {
  data?: Partial<DiscoveryData>;
  fetchImpl?: typeof fetch;
}) {
  const update = vi.fn();
  const navigate = vi.fn();
  const fetchImpl =
    options?.fetchImpl ??
    (vi.fn(async () => availability(true, true)) as unknown as typeof fetch);
  const data: DiscoveryData = { ...EMPTY_DISCOVERY, ...(options?.data ?? {}) };
  render(
    <ConnectPortrait
      data={data}
      update={update}
      t={t}
      fetchImpl={fetchImpl}
      navigate={navigate}
    />
  );
  return { update, navigate, fetchImpl, user: userEvent.setup() };
}

/** Both buttons, once the availability answer has landed. */
async function buttons() {
  const linkedin = await screen.findByTestId('connect-linkedin');
  return { linkedin, instagram: screen.getByTestId('connect-instagram') };
}

describe('ConnectPortrait', () => {
  it('offers both providers when the deployment has both sets of credentials', async () => {
    // The ordinary case, and the only one where the visitor sees two live
    // buttons. Order follows `PORTRAIT_SOURCE_ORDER`: LinkedIn first, because
    // it is the better source.
    renderConnect();
    const { linkedin, instagram } = await buttons();
    await waitFor(() =>
      expect(linkedin).toHaveAttribute('data-available', 'true')
    );
    expect(instagram).toHaveAttribute('data-available', 'true');
    expect(linkedin).not.toBeDisabled();
    expect(instagram).not.toBeDisabled();
    expect(linkedin).toHaveTextContent(t('landing.discovery.connect.linkedin'));
    expect(instagram).toHaveTextContent(
      t('landing.discovery.connect.instagram')
    );
    // Nothing to explain away, so no note.
    expect(screen.queryByTestId('connect-unavailable-note')).toBeNull();
  });

  it('disables the provider this deployment cannot do, and says so once', async () => {
    // Half-configured is the common state of a staging box. The visitor still
    // gets the offer that works, and the one that does not is a disabled
    // button with a sentence under it rather than a click that fails.
    renderConnect({
      fetchImpl: vi.fn(async () =>
        availability(true, false)
      ) as unknown as typeof fetch,
    });
    const { linkedin, instagram } = await buttons();
    await waitFor(() =>
      expect(instagram).toHaveAttribute('data-available', 'false')
    );
    expect(linkedin).toHaveAttribute('data-available', 'true');
    expect(instagram).toBeDisabled();
    expect(instagram).toHaveAttribute('aria-disabled', 'true');
    expect(instagram).toHaveTextContent(
      t('landing.discovery.connect.unavailable')
    );
    // One note, however many buttons it covers. Saying it twice reads as two
    // separate problems.
    expect(screen.getAllByTestId('connect-unavailable-note')).toHaveLength(1);
    expect(screen.getByTestId('connect-unavailable-note')).toHaveTextContent(
      t('landing.discovery.connect.unavailableNote')
    );
  });

  it('offers nothing clickable when neither provider is configured', async () => {
    renderConnect({
      fetchImpl: vi.fn(async () =>
        availability(false, false)
      ) as unknown as typeof fetch,
    });
    const { linkedin, instagram } = await buttons();
    await waitFor(() => expect(linkedin).toBeDisabled());
    expect(instagram).toBeDisabled();
    expect(linkedin).toHaveAttribute('data-available', 'false');
    expect(instagram).toHaveAttribute('data-available', 'false');
    expect(screen.getByTestId('connect-unavailable-note')).toBeInTheDocument();
  });

  it('treats an availability request that failed as unavailable, not as probably fine', async () => {
    // A question we cannot answer is answered "no". Drawing a live button on
    // the strength of a request that did not come back is how a visitor gets
    // sent to a route that 500s.
    renderConnect({
      fetchImpl: vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    });
    const { linkedin, instagram } = await buttons();
    await waitFor(() => expect(linkedin).toBeDisabled());
    expect(instagram).toBeDisabled();
    expect(screen.getByTestId('connect-unavailable-note')).toBeInTheDocument();
  });

  it('reads a non-200 availability answer the same way', async () => {
    renderConnect({
      fetchImpl: vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    });
    const { linkedin, instagram } = await buttons();
    await waitFor(() => expect(linkedin).toBeDisabled());
    expect(instagram).toBeDisabled();
  });

  it('mints a preview id, reports it, and leaves for the provider with a way back', async () => {
    const { update, navigate, user } = renderConnect();
    const { linkedin } = await buttons();
    await waitFor(() => expect(linkedin).not.toBeDisabled());

    await user.click(linkedin);

    // The namespace is minted here because the round trip happens before a
    // preview exists and before the server has issued any id.
    expect(update).toHaveBeenCalledTimes(1);
    const [key, value] = update.mock.calls[0] as [string, string];
    expect(key).toBe('portraitPreviewId');
    expect(value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    expect(navigate).toHaveBeenCalledTimes(1);
    const url = navigate.mock.calls[0]![0] as string;
    expect(url).toBe(
      `/api/connect/linkedin/start?previewId=${value}&returnTo=${encodeURIComponent(
        `${window.location.pathname}${window.location.search}`
      )}`
    );
    // The way back is encoded, so a query string on the intake page survives
    // the round trip instead of truncating the provider's redirect_uri.
    expect(url).not.toContain('returnTo=/');

    // And the visitor is told the page is about to change under them.
    expect(screen.getByTestId('connect-busy')).toHaveTextContent(
      t('landing.discovery.connect.busy')
    );
  });

  it('reuses the preview id a first attempt already minted', async () => {
    // Tried LinkedIn, changed their mind, tried Instagram. Both attempts file
    // under one namespace, so the callback does not scatter assets.
    const existing = '11111111-1111-4111-8111-111111111111';
    const { update, navigate, user } = renderConnect({
      data: { portraitPreviewId: existing },
    });
    const { instagram } = await buttons();
    await waitFor(() => expect(instagram).not.toBeDisabled());

    await user.click(instagram);

    // Nothing to write: the id is already in the draft.
    expect(update).not.toHaveBeenCalled();
    expect(navigate.mock.calls[0]![0]).toContain(`previewId=${existing}`);
    expect(navigate.mock.calls[0]![0]).toContain(
      '/api/connect/instagram/start'
    );
  });

  it('shows the outcome instead of the buttons once the round trip has been made', async () => {
    // Coming back is the end of the offer. Leaving the buttons up invites a
    // second attempt against a question that has already been answered.
    renderConnect({
      data: { portraitConnect: { provider: 'linkedin', outcome: 'connected' } },
    });
    const outcome = screen.getByTestId('connect-outcome');
    expect(outcome).toHaveAttribute('data-outcome', 'connected');
    expect(outcome).toHaveTextContent(t('landing.discovery.connect.connected'));
    expect(screen.queryByTestId('connect-linkedin')).toBeNull();
  });

  it('gives every outcome the callback can send its own sentence', async () => {
    // Nine endings, three kinds of sentence: the two ordinary ones, the
    // reasons `portrait-source.ts` already has words for, and one honest
    // generic line for everything the rule does not name. None of them is a
    // code, a blank, or a leaked key.
    const expected: Array<[string, string]> = [
      ['connected', t('landing.discovery.connect.connected')],
      ['cancelled', t('landing.discovery.connect.cancelled')],
      ['failed', t('landing.discovery.connect.failed')],
      ['not_public_url', t('portrait.reason.not_public_url')],
      ['below_avatar_floor', t('portrait.reason.below_avatar_floor')],
      ['unreadable', t('landing.discovery.connect.failed')],
      ['too_large', t('landing.discovery.connect.failed')],
      ['not_an_image', t('landing.discovery.connect.failed')],
      ['store_failed', t('landing.discovery.connect.failed')],
    ];
    for (const [outcome, sentence] of expected) {
      const { unmount } = render(
        <ConnectPortrait
          data={{
            ...EMPTY_DISCOVERY,
            portraitConnect: { provider: 'linkedin', outcome },
          }}
          update={vi.fn()}
          t={t}
          fetchImpl={
            vi.fn(async () =>
              availability(true, true)
            ) as unknown as typeof fetch
          }
          navigate={vi.fn()}
        />
      );
      const node = screen.getByTestId('connect-outcome');
      expect(node).toHaveAttribute('data-outcome', outcome);
      expect(node).toHaveTextContent(sentence);
      expect(node.textContent).not.toMatch(/portrait\.|landing\./);
      unmount();
    }
  });

  it('explains the Instagram personal-account wall rather than calling it a failure', () => {
    // Terminal and provider specific: Basic Display is retired, so there is no
    // retry that helps. The sentence names the way in instead.
    render(
      <ConnectPortrait
        data={{
          ...EMPTY_DISCOVERY,
          portraitConnect: {
            provider: 'instagram',
            outcome: 'personal_account',
          },
        }}
        update={vi.fn()}
        t={t}
        fetchImpl={
          vi.fn(async () => availability(true, true)) as unknown as typeof fetch
        }
        navigate={vi.fn()}
      />
    );
    expect(screen.getByTestId('connect-outcome')).toHaveTextContent(
      t('landing.discovery.connect.instagramPersonal')
    );
  });

  it('has copy in the catalogue for every key it can print', () => {
    // Hardcoding a visible string outside the locale file is a defect in this
    // repo, so the guard is that every key the panel reaches resolves.
    for (const part of [
      'title',
      'note',
      'linkedin',
      'instagram',
      'unavailable',
      'unavailableNote',
      'busy',
      'connected',
      'cancelled',
      'failed',
      'instagramPersonal',
    ]) {
      const key = `landing.discovery.connect.${part}`;
      expect(t(key)).not.toBe(key);
    }
    for (const reason of ['not_public_url', 'below_avatar_floor']) {
      const key = `portrait.reason.${reason}`;
      expect(t(key)).not.toBe(key);
    }
    expect(t('landing.discovery.chat.q.connectPortrait.prompt')).not.toBe(
      'landing.discovery.chat.q.connectPortrait.prompt'
    );
  });
});
