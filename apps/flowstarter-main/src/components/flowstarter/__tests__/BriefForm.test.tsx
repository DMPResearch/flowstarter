/**
 * The brief form.
 *
 * The interesting behaviour is not "inputs exist". It is that the form never
 * decides anything the rule decides: the checklist and the "you are done" line
 * come from the readiness the server sent, a save replaces the whole local
 * state with the server's answer, and the two answers that must not be
 * confused, "no past work to show" and "nothing filled in yet", are one
 * explicit checkbox that empties the list on save.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BriefForm, type BriefAssetView, type BriefView } from '../BriefForm';
import { CURRENT_RIGHTS_STATEMENT_VERSION } from '../rights-statement';
import { portraitVerdictText } from '../portrait-copy';
import {
  MIN_OFFER_CHARS,
  evaluateBriefReadiness,
  type BriefReadiness,
} from '@/lib/flowstarter/brief-readiness';

const WORKSPACE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const PHOTO_BIG = '11111111-1111-4111-8111-111111111111';
const PHOTO_SMALL = '22222222-2222-4222-8222-222222222222';
const PHOTO_SOURCED = '33333333-3333-4333-8333-333333333333';

const GOOD_OFFER =
  'We fit and service gas boilers for homes across the county, and we take on ' +
  'the emergency call-outs nobody else will.';

const originalFetch = global.fetch;

function brief(overrides: Partial<BriefView> = {}): BriefView {
  return {
    offer: '',
    businessName: '',
    projects: [],
    noProjects: false,
    designReferenceAssetIds: [],
    photoAssetIds: [],
    portraitAssetId: null,
    readyAt: null,
    overrideAt: null,
    // Null until the client touches the page-count control; the derived value
    // is what they are shown until then.
    pageCount: null,
    // Never asked. Every assertion in this file is about a brief whose intake
    // predates the person section, which is also the state that keeps the
    // "About you" section off the form entirely; the tests that do exercise
    // it live in `brief-form-person.test.tsx` and pass their own object.
    person: null,
    ...overrides,
  };
}

function asset(overrides: Partial<BriefAssetView> = {}): BriefAssetView {
  return {
    id: PHOTO_BIG,
    kind: null,
    mime: 'image/png',
    width: 2400,
    height: 1600,
    usable: true,
    url: 'https://storage.test/signed.png',
    source: 'upload',
    sourceUrl: null,
    rightsConfirmedAt: '2026-09-12T10:00:00.000Z',
    caption: null,
    captionSource: null,
    autoCaptionKind: null,
    ...overrides,
  };
}

/** The real rule, so the fixture readiness is never a hand-written fiction. */
function readinessFor(view: BriefView, assets: BriefAssetView[]) {
  return evaluateBriefReadiness({
    offer: view.offer,
    projects: view.projects,
    noProjects: view.noProjects,
    designReferenceAssetIds: view.designReferenceAssetIds,
    photos: view.photoAssetIds.flatMap((id) => {
      const found = assets.find((one) => one.id === id);
      return found
        ? [
            {
              assetId: found.id,
              kind: found.kind,
              width: found.width,
              height: found.height,
              rightsConfirmed: found.usable,
            },
          ]
        : [];
    }),
  });
}

function mount(
  view: BriefView = brief(),
  assets: BriefAssetView[] = [],
  readiness: BriefReadiness = readinessFor(view, assets),
  /**
   * What the server's `derivedBriefPageCount` worked out from this brief. The
   * form never derives it itself: the rule lives in the codegen package and
   * the client bundle has no business carrying it.
   */
  derivedPageCount = 'lt-5',
  /**
   * What `workspaces.name` is right now — the value `deriveBusinessName`
   * produced at claim time. Shown as the business-name input's value
   * whenever the brief has not corrected it yet.
   */
  derivedBusinessName = 'A New Business'
) {
  return render(
    <BriefForm
      workspaceId={WORKSPACE}
      initialBrief={view}
      initialReadiness={readiness}
      initialAssets={assets}
      derivedPageCount={derivedPageCount}
      derivedBusinessName={derivedBusinessName}
    />
  );
}

/** The option the page-count group is showing as chosen. */
function selectedPageCount(): string | undefined {
  return screen
    .getAllByTestId('brief-page-count-option')
    .find((option) => option.dataset.selected === 'true')
    ?.querySelector('input')?.value;
}

/** The body of the last PUT the form sent. */
function lastPutBody(): Record<string, unknown> {
  const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
    .calls as Array<[string, RequestInit | undefined]>;
  const put = [...calls].reverse().find((call) => call[1]?.method === 'PUT');
  return JSON.parse(String(put?.[1]?.body ?? '{}'));
}

/** Every call the form made, as [url, init] pairs. */
function fetchCalls(): Array<[string, RequestInit | undefined]> {
  return (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
    .calls as Array<[string, RequestInit | undefined]>;
}

/** The POST to the rights endpoint, if the form sent one. */
function rightsCall(): [string, RequestInit | undefined] | undefined {
  return fetchCalls().find((call) => String(call[0]).endsWith('/rights'));
}

/**
 * A fetch double that answers the two endpoints separately.
 *
 * "Use this" is two requests in one gesture -- the rights confirmation and
 * then the save -- and the failure worth testing is one of them going wrong
 * while the other would have succeeded, which a single blanket answer cannot
 * describe.
 */
function respondPerUrl(answers: {
  rights: { ok: boolean; payload: unknown };
  brief: { ok: boolean; payload: unknown };
}) {
  global.fetch = vi.fn(async (url: string) => {
    const answer = String(url).endsWith('/rights')
      ? answers.rights
      : answers.brief;
    return {
      ok: answer.ok,
      status: answer.ok ? 200 : 400,
      json: async () => answer.payload,
    };
  }) as unknown as typeof fetch;
}

function respondWith(payload: unknown, ok = true) {
  global.fetch = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 400,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  respondWith({});
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('BriefForm', () => {
  it('counts the offer quietly while it is being written', async () => {
    const user = userEvent.setup();
    mount();

    const offer = screen.getByTestId('brief-offer');
    await user.type(offer, 'Boilers');
    const count = screen.getByTestId('brief-offer-count');
    expect(count).toHaveTextContent(`7 of about ${MIN_OFFER_CHARS}`);
    expect(count.className).toContain('--fs-ink-faint');

    // Only once they have left the field does the hint firm up.
    await user.tab();
    expect(screen.getByTestId('brief-offer-count').className).not.toContain(
      '--fs-ink-faint'
    );
  });

  it('stops counting down once the offer is long enough', async () => {
    mount(brief({ offer: GOOD_OFFER }));
    expect(screen.getByTestId('brief-offer-count')).toHaveTextContent(
      'That is plenty to write from'
    );
  });

  it('adds and removes project rows, and says how many are listed', async () => {
    const user = userEvent.setup();
    mount();

    expect(screen.queryAllByTestId('brief-project-row')).toHaveLength(0);
    expect(screen.getByTestId('brief-project-count')).toHaveTextContent(
      '0 listed'
    );

    await user.click(screen.getByTestId('brief-add-project'));
    expect(screen.getAllByTestId('brief-project-row')).toHaveLength(1);
    expect(screen.getByTestId('brief-project-count')).toHaveTextContent(
      '1 listed'
    );

    await user.click(screen.getByTestId('brief-add-project'));
    expect(screen.getByTestId('brief-project-count')).toHaveTextContent(
      '2 listed'
    );

    await user.click(screen.getAllByTestId('brief-remove-project')[1]);
    expect(screen.getAllByTestId('brief-project-row')).toHaveLength(1);
  });

  it('stands the list down when the client has no past work to show', async () => {
    const user = userEvent.setup();
    mount(
      brief({
        projects: [
          { name: 'Boiler swap', line: '', link: '', screenshotAssetIds: [] },
        ],
      })
    );

    await user.click(screen.getByTestId('brief-no-projects'));
    const row = screen.getByTestId('brief-project-row');
    expect(within(row).getByTestId('brief-project-name')).toBeDisabled();
    expect(screen.getByTestId('brief-add-project')).toBeDisabled();
    expect(screen.getByTestId('brief-project-list').className).toContain(
      'opacity-40'
    );

    // And the save clears it, rather than sending a body the route refuses.
    respondWith({
      brief: brief({ noProjects: true }),
      readiness: readinessFor(brief({ noProjects: true }), []),
      assets: [],
    });
    await user.click(screen.getByTestId('brief-save'));
    await waitFor(() => expect(lastPutBody().projects).toEqual([]));
    expect(lastPutBody().noProjects).toBe(true);
  });

  it('checks a project link when the field is left, not while typing', async () => {
    const user = userEvent.setup();
    mount(
      brief({
        projects: [
          { name: 'Boiler swap', line: '', link: '', screenshotAssetIds: [] },
        ],
      })
    );

    const link = screen.getByTestId('brief-project-link');
    await user.type(link, 'http://example.com');
    expect(screen.queryByTestId('brief-link-error')).toBeNull();

    await user.tab();
    expect(screen.getByTestId('brief-link-error')).toHaveTextContent(
      'https://'
    );

    await user.clear(link);
    await user.type(link, 'https://example.com');
    await user.tab();
    expect(screen.queryByTestId('brief-link-error')).toBeNull();
  });

  it('accepts a project with no link at all', async () => {
    const user = userEvent.setup();
    mount(
      brief({
        projects: [
          { name: 'Boiler swap', line: '', link: '', screenshotAssetIds: [] },
        ],
      })
    );
    await user.click(screen.getByTestId('brief-project-link'));
    await user.tab();
    expect(screen.queryByTestId('brief-link-error')).toBeNull();
  });

  it('lists what is still missing, blocking asks first', () => {
    mount();
    const items = screen.getAllByTestId('brief-missing-item');
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toHaveAttribute('data-severity', 'blocking');
    expect(items[0]).toHaveTextContent('what you offer');
    expect(items[items.length - 1] as HTMLElement).toHaveAttribute(
      'data-severity',
      'degrades'
    );
    expect(screen.getByTestId('brief-progress')).toHaveTextContent(
      '0% complete'
    );
  });

  it('replaces the checklist with one line when the brief is complete', () => {
    const view = brief({ offer: GOOD_OFFER, noProjects: true });
    const assets = [
      asset({ id: PHOTO_BIG, kind: 'portrait' }),
      asset({ id: PHOTO_SMALL, width: 2000, height: 1500 }),
    ];
    mount(
      { ...view, photoAssetIds: [PHOTO_BIG, PHOTO_SMALL] },
      assets,
      readinessFor({ ...view, photoAssetIds: [PHOTO_BIG, PHOTO_SMALL] }, assets)
    );

    expect(screen.getByTestId('brief-ready')).toHaveTextContent(
      'Your brief is complete'
    );
    expect(screen.queryByTestId('brief-missing-item')).toBeNull();
  });

  it('warns on a photo that is smaller than we asked for, and only that one', () => {
    const assets = [
      asset({ id: PHOTO_BIG }),
      asset({ id: PHOTO_SMALL, width: 800, height: 600 }),
    ];
    mount(brief({ photoAssetIds: [PHOTO_BIG, PHOTO_SMALL] }), assets);

    const warnings = screen.getAllByTestId('brief-undersized-warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toHaveTextContent('Smaller than we asked for');
    expect(screen.getAllByTestId('brief-photo')).toHaveLength(2);
  });

  it('sends the photo the client marked as their portrait', async () => {
    const user = userEvent.setup();
    const assets = [asset({ id: PHOTO_BIG }), asset({ id: PHOTO_SMALL })];
    mount(brief({ photoAssetIds: [PHOTO_BIG, PHOTO_SMALL] }), assets);

    await user.click(screen.getAllByTestId('brief-portrait')[1]);
    await user.click(screen.getByTestId('brief-save'));
    await waitFor(() =>
      expect(lastPutBody().portraitAssetId).toBe(PHOTO_SMALL)
    );
  });

  it('sends the whole brief and takes the server s answer back', async () => {
    const user = userEvent.setup();
    mount();

    const saved = brief({
      offer: GOOD_OFFER,
      noProjects: true,
      photoAssetIds: [PHOTO_BIG],
      readyAt: '2026-09-12T09:00:00.000Z',
    });
    respondWith({
      brief: saved,
      readiness: readinessFor(saved, [asset()]),
      assets: [asset()],
    });

    await user.type(screen.getByTestId('brief-offer'), 'Boilers');
    await user.click(screen.getByTestId('brief-save'));

    await waitFor(() =>
      expect(screen.getByTestId('brief-saved')).toBeInTheDocument()
    );
    const body = lastPutBody();
    expect(body).toMatchObject({
      offer: 'Boilers',
      projects: [],
      noProjects: false,
      designReferenceAssetIds: [],
      photoAssetIds: [],
      portraitAssetId: null,
    });
    // What the client typed is replaced by what was stored.
    expect(screen.getByTestId('brief-offer')).toHaveValue(GOOD_OFFER);
    expect(screen.getByTestId('brief-no-projects')).toBeChecked();
    expect(screen.getAllByTestId('brief-photo')).toHaveLength(1);
  });

  it('shows the server s refusal rather than pretending it saved', async () => {
    const user = userEvent.setup();
    mount();
    respondWith({ error: 'Those files are not on this project' }, false);

    await user.click(screen.getByTestId('brief-save'));
    await waitFor(() =>
      expect(screen.getByTestId('brief-error')).toHaveTextContent(
        'Those files are not on this project'
      )
    );
    expect(screen.queryByTestId('brief-saved')).toBeNull();
  });

  it('says something useful when the save never reaches us', async () => {
    const user = userEvent.setup();
    mount();
    global.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    await user.click(screen.getByTestId('brief-save'));
    await waitFor(() =>
      expect(screen.getByTestId('brief-error')).toHaveTextContent(
        'We could not save that'
      )
    );
  });

  it('refuses a 200 whose body is not a brief', async () => {
    const user = userEvent.setup();
    mount();
    respondWith({ nothing: true });

    await user.click(screen.getByTestId('brief-save'));
    await waitFor(() =>
      expect(screen.getByTestId('brief-error')).toBeInTheDocument()
    );
  });

  it('holds the save button while the save is in flight', async () => {
    const user = userEvent.setup();
    mount();
    let release: (value: unknown) => void = () => undefined;
    global.fetch = vi.fn(
      () => new Promise((resolve) => (release = resolve))
    ) as unknown as typeof fetch;

    await user.click(screen.getByTestId('brief-save'));
    expect(screen.getByTestId('brief-save')).toBeDisabled();
    expect(screen.getByTestId('brief-save')).toHaveTextContent('Saving');

    release({ ok: true, status: 200, json: async () => ({}) });
    await waitFor(() =>
      expect(screen.getByTestId('brief-save')).not.toBeDisabled()
    );
  });

  /**
   * The page budget. Before this control existed, a brief could not say how
   * big the site should be at all: the quick intake stopped asking, the
   * default `'unsure'` bought six content pages, and a four-page brief was
   * handed two pages of invented subject matter. The client can now answer,
   * and until they do they are shown what their own brief adds up to.
   */
  it('pre-selects what the brief adds up to, and says that is what it is', () => {
    mount(brief(), [], undefined, 'lt-5');
    expect(selectedPageCount()).toBe('lt-5');
    expect(screen.getByTestId('brief-page-count-derived')).toBeInTheDocument();
  });

  it('shows the client\u2019s own answer instead, once they have one', () => {
    mount(brief({ pageCount: '8-15' }), [], undefined, 'lt-5');
    expect(selectedPageCount()).toBe('8-15');
    expect(
      screen.queryByTestId('brief-page-count-derived')
    ).not.toBeInTheDocument();
  });

  it('lets the client widen it, and sends what they picked', async () => {
    const user = userEvent.setup();
    mount(brief(), [], undefined, 'lt-5');

    const options = screen.getAllByTestId('brief-page-count-option');
    const wider = options.find(
      (option) => option.querySelector('input')?.value === '5-7'
    );
    await user.click(wider as HTMLElement);
    expect(selectedPageCount()).toBe('5-7');

    await user.click(screen.getByTestId('brief-save'));
    await waitFor(() => expect(lastPutBody().pageCount).toBe('5-7'));
  });

  /**
   * The defect found on the 2026-09-14 paid build: the pre-selected option
   * is already `checked`, so clicking it fires no native `change` event and
   * `page_count` stayed null even though the client visibly confirmed
   * "Under 5". Clicking the already-selected option has to be expressible as
   * a real choice, not a no-op.
   */
  it('lets the client confirm the pre-selected default by clicking it', async () => {
    const user = userEvent.setup();
    mount(brief(), [], undefined, 'lt-5');

    const options = screen.getAllByTestId('brief-page-count-option');
    const preSelected = options.find(
      (option) => option.querySelector('input')?.value === 'lt-5'
    );
    expect(preSelected?.dataset.selected).toBe('true');
    await user.click(preSelected as HTMLElement);
    expect(selectedPageCount()).toBe('lt-5');
    expect(
      screen.queryByTestId('brief-page-count-derived')
    ).not.toBeInTheDocument();

    await user.click(screen.getByTestId('brief-save'));
    await waitFor(() => expect(lastPutBody().pageCount).toBe('lt-5'));
  });

  it('sends null while the client has not chosen, so the rule keeps deriving', async () => {
    const user = userEvent.setup();
    mount(brief(), [], undefined, 'lt-5');
    await user.click(screen.getByTestId('brief-save'));
    await waitFor(() => expect(lastPutBody().pageCount).toBeNull());
  });

  it('takes the server\u2019s answer back after a save, like every other field', async () => {
    const user = userEvent.setup();
    respondWith({
      brief: { ...brief({ pageCount: '15+' }) },
      readiness: readinessFor(brief(), []),
      assets: [],
    });
    mount(brief(), [], undefined, 'lt-5');
    await user.click(screen.getByTestId('brief-save'));
    await waitFor(() => expect(selectedPageCount()).toBe('15+'));
  });

  it('gives every section an uploader rather than rolling its own', () => {
    mount();
    // Design references and photos, plus one per project row.
    expect(screen.getAllByTestId('asset-uploader')).toHaveLength(2);
  });

  // A photograph we read off one of the client's own pages is not the same
  // thing as a file they sent us, and the form has to say so before it is
  // used. The verdict comes from the rule, so the card cannot promise a hero
  // image the size floor would refuse.
  it('offers a sourced photo back, with the size verdict in plain words', () => {
    const assets = [
      asset({
        id: PHOTO_SOURCED,
        source: 'linkedin',
        sourceUrl: 'https://media.licdn.com/dms/image/example/profile.jpg',
        rightsConfirmedAt: null,
        usable: false,
        width: 800,
        height: 800,
      }),
    ];
    mount(brief({ photoAssetIds: [PHOTO_SOURCED] }), assets);

    const card = screen.getByTestId('brief-sourced-portrait');
    expect(card).toHaveAttribute('data-source', 'linkedin');
    expect(screen.getByTestId('brief-portrait-verdict')).toHaveTextContent(
      portraitVerdictText('portrait')
    );
    // The radio group, the warning and the uploader are all still there.
    expect(screen.getAllByTestId('brief-photo')).toHaveLength(1);
    expect(screen.getAllByTestId('asset-uploader')).toHaveLength(2);
  });

  // Nothing was sourced, so there is nothing to offer back: a brief made only
  // of uploads must not grow a card asking permission for a file the client
  // already handed over.
  it('shows no sourced card when every photo is one the client sent', () => {
    const assets = [asset({ id: PHOTO_BIG }), asset({ id: PHOTO_SMALL })];
    mount(brief({ photoAssetIds: [PHOTO_BIG, PHOTO_SMALL] }), assets);
    expect(screen.queryByTestId('brief-sourced-portrait')).toBeNull();
  });

  // One gesture, two writes, in this order. The rights confirmation is what
  // makes the file publishable at all, so saving a brief that names it first
  // would leave a portrait chosen and unusable.
  it('confirms the rights and then saves the brief when Use this is tapped', async () => {
    const user = userEvent.setup();
    const sourced = asset({
      id: PHOTO_SOURCED,
      source: 'github',
      sourceUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      rightsConfirmedAt: null,
      usable: false,
      width: 460,
      height: 460,
    });
    const view = brief({ photoAssetIds: [PHOTO_SOURCED] });
    mount(view, [sourced]);

    const saved = { ...view, portraitAssetId: PHOTO_SOURCED };
    respondPerUrl({
      rights: { ok: true, payload: { confirmedAssetIds: [PHOTO_SOURCED] } },
      brief: {
        ok: true,
        payload: {
          brief: saved,
          readiness: readinessFor(saved, [sourced]),
          assets: [sourced],
        },
      },
    });

    await user.click(screen.getByTestId('brief-portrait-use'));

    await waitFor(() => expect(rightsCall()).toBeDefined());
    const [url, init] = rightsCall() as [string, RequestInit];
    expect(url).toBe(`/api/client/assets/${WORKSPACE}/rights`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      assetIds: [PHOTO_SOURCED],
      statementVersion: CURRENT_RIGHTS_STATEMENT_VERSION,
    });

    await waitFor(() =>
      expect(lastPutBody().portraitAssetId).toBe(PHOTO_SOURCED)
    );
    // The rights call really did come first.
    const order = fetchCalls().map((call) =>
      String(call[0]).endsWith('/rights')
    );
    expect(order.indexOf(true)).toBeLessThan(order.indexOf(false));
  });

  // Changing your mind about which photograph represents you is not a reason
  // to destroy a file, and an unconfirmed asset cannot reach a site anyway.
  it('clears the choice on Replace without deleting anything', async () => {
    const user = userEvent.setup();
    const sourced = asset({
      id: PHOTO_SOURCED,
      source: 'instagram',
      sourceUrl: 'https://scontent.cdninstagram.com/v/example_100x100.jpg',
      rightsConfirmedAt: '2026-09-13T09:00:00.000Z',
      width: 100,
      height: 100,
    });
    mount(
      brief({
        photoAssetIds: [PHOTO_SOURCED],
        portraitAssetId: PHOTO_SOURCED,
      }),
      [sourced]
    );

    expect(screen.getByTestId('brief-portrait-in-use')).toBeInTheDocument();
    await user.click(screen.getByTestId('brief-portrait-replace'));

    // Nothing was sent at all: no DELETE, no request of any kind.
    expect(fetchCalls()).toHaveLength(0);
    // The photo is still listed, and it is no longer the portrait.
    expect(screen.getAllByTestId('brief-photo')).toHaveLength(1);
    expect(screen.getByTestId('brief-portrait')).not.toBeChecked();

    await user.click(screen.getByTestId('brief-save'));
    await waitFor(() => expect(lastPutBody().portraitAssetId).toBeNull());
  });

  // A refused confirmation must not be swallowed, and it must not be followed
  // by a save: a client who taps a button and sees nothing will tap it again.
  it('surfaces a refused rights confirmation and does not save the brief', async () => {
    const user = userEvent.setup();
    const sourced = asset({
      id: PHOTO_SOURCED,
      source: 'og',
      sourceUrl: 'https://example.com/about/me.jpg',
      rightsConfirmedAt: null,
      usable: false,
      width: 1200,
      height: 1600,
    });
    mount(brief({ photoAssetIds: [PHOTO_SOURCED] }), [sourced]);

    respondPerUrl({
      rights: {
        ok: false,
        payload: { error: 'Those files are not on this project' },
      },
      brief: { ok: true, payload: {} },
    });

    await user.click(screen.getByTestId('brief-portrait-use'));

    await waitFor(() =>
      expect(screen.getByTestId('brief-error')).toHaveTextContent(
        'Those files are not on this project'
      )
    );
    expect(screen.queryByTestId('brief-saved')).toBeNull();
    expect(fetchCalls().some((call) => call[1]?.method === 'PUT')).toBe(false);
  });

  // A transport failure on the confirmation gets the same treatment as a
  // refusal: said out loud, and no save behind it.
  it('says so when the confirmation never reaches us', async () => {
    const user = userEvent.setup();
    const sourced = asset({
      id: PHOTO_SOURCED,
      source: 'linkedin',
      rightsConfirmedAt: null,
      usable: false,
    });
    mount(brief({ photoAssetIds: [PHOTO_SOURCED] }), [sourced]);

    global.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    await user.click(screen.getByTestId('brief-portrait-use'));
    await waitFor(() =>
      expect(screen.getByTestId('brief-error')).toHaveTextContent(
        'We could not record that confirmation'
      )
    );
  });
});

describe('BriefForm — business name', () => {
  it("shows the workspace's current name until the client corrects it", () => {
    mount(brief(), [], undefined, 'lt-5', 'Arome Coffee');
    expect(screen.getByTestId('brief-business-name')).toHaveValue(
      'Arome Coffee'
    );
  });

  it('shows what the client already saved here, over the derived value', () => {
    mount(
      brief({ businessName: 'Arome Coffee Roastery' }),
      [],
      undefined,
      'lt-5',
      'Arome Coffee'
    );
    expect(screen.getByTestId('brief-business-name')).toHaveValue(
      'Arome Coffee Roastery'
    );
  });

  it('sends an edit on save, and the server has the last word on what is shown', async () => {
    const user = userEvent.setup();
    mount(brief(), [], undefined, 'lt-5', 'Arome Coffee');

    const input = screen.getByTestId('brief-business-name');
    await user.clear(input);
    await user.type(input, 'Arome Coffee Roastery');

    respondWith({
      brief: brief({ businessName: 'Arome Coffee Roastery' }),
      readiness: readinessFor(brief(), []),
      assets: [],
    });
    await user.click(screen.getByTestId('brief-save'));

    await waitFor(() =>
      expect(lastPutBody().businessName).toBe('Arome Coffee Roastery')
    );
    expect(screen.getByTestId('brief-business-name')).toHaveValue(
      'Arome Coffee Roastery'
    );
  });

  it('sends the derived value unedited, which the route treats as a no-op rename', async () => {
    // The input is seeded with the derived value so it behaves like an
    // ordinary text field once mounted (see the seeding comment in
    // BriefForm.tsx). Saving without touching it still sends that value, but
    // it already matches the workspace's current name, so
    // `applyBusinessNameToWorkspace` on the server does nothing with it.
    const user = userEvent.setup();
    mount(brief(), [], undefined, 'lt-5', 'Arome Coffee');
    respondWith({
      brief: brief({ businessName: '' }),
      readiness: readinessFor(brief(), []),
      assets: [],
    });
    await user.click(screen.getByTestId('brief-save'));
    await waitFor(() => expect(lastPutBody().offer).toBe(''));
    expect(lastPutBody().businessName).toBe('Arome Coffee');
  });
});

/**
 * Captions, on the form that shows them back.
 *
 * The form neither writes nor guesses one: it displays what is stored and says
 * whose sentence it is, and it asks for one on the upload where placement
 * depends on it -- a project screenshot -- while leaving it optional on the
 * general photographs.
 */
describe('BriefForm — captions', () => {
  const SHOT = '44444444-4444-4444-8444-444444444444';

  it('shows a screenshot’s caption under it, and says we suggested it', () => {
    mount(
      brief({
        projects: [
          {
            name: 'Arome Coffee',
            line: '',
            link: '',
            screenshotAssetIds: [SHOT],
          },
        ],
      }),
      [
        asset({
          id: SHOT,
          caption: 'The Arome Coffee order page on a phone',
          captionSource: 'auto',
          autoCaptionKind: 'screenshot',
        }),
      ]
    );

    const row = screen.getByTestId('brief-project-row');
    expect(within(row).getByTestId('brief-asset-caption')).toHaveTextContent(
      'The Arome Coffee order page on a phone'
    );
    expect(
      within(row).getByTestId('brief-asset-caption-source')
    ).toHaveTextContent('We suggested this');
  });

  it('says a photo’s caption is the client’s when they wrote it', () => {
    mount(brief({ photoAssetIds: [PHOTO_BIG] }), [
      asset({
        id: PHOTO_BIG,
        caption: 'The bench at the back of the workshop',
        captionSource: 'client',
      }),
    ]);

    const photo = screen.getByTestId('brief-photo');
    expect(within(photo).getByTestId('brief-asset-caption')).toHaveTextContent(
      'The bench at the back of the workshop'
    );
    expect(
      within(photo).getByTestId('brief-asset-caption-source')
    ).toHaveTextContent('You wrote this');
  });

  it('shows nothing at all for a picture nobody has captioned', () => {
    mount(brief({ photoAssetIds: [PHOTO_BIG] }), [asset({ id: PHOTO_BIG })]);

    expect(screen.getByTestId('brief-photo')).toBeInTheDocument();
    expect(screen.queryByTestId('brief-asset-caption')).toBeNull();
    expect(screen.queryByTestId('brief-asset-caption-source')).toBeNull();
  });

  // A screenshot with no caption cannot be filed against a project; a
  // photograph of a workshop is still a photograph of a workshop. So the gate
  // is on one uploader and not the other, and the prompt names the project.
  it('asks for a caption on project screenshots and not on the photos', () => {
    mount(
      brief({
        projects: [
          { name: 'Arome Coffee', line: '', link: '', screenshotAssetIds: [] },
        ],
      })
    );

    const projectUploader = within(
      screen.getByTestId('brief-project-row')
    ).getByTestId('asset-uploader');
    expect(projectUploader).toHaveAttribute('data-require-caption', 'true');

    const photosUploader = screen
      .getAllByTestId('asset-uploader')
      .find((node) => node.textContent?.includes('Add photos'));
    expect(photosUploader).toHaveAttribute('data-require-caption', 'false');
  });
});

/**
 * Attaching an upload to its project is not a diff.
 *
 * Paid portfolio run 9 (workspace `ba3e9323-2c74-4166-af29-58ba37f130e5`)
 * uploaded, captioned and rights-confirmed a screenshot for every one of
 * three projects, in order, and the first project's saved brief still came
 * back with `screenshotAssetIds: []`: the file the client attached and
 * confirmed the rights to was never on the project it belonged to, with no
 * error and no visible reason. Every server-side gate was clean — the PUT
 * body the browser sent already had the empty array in it, so this was
 * never the route dropping anything.
 *
 * The form used to work out "what is new" by fetching the whole workspace's
 * asset list after every write and diffing it against a ref of every id it
 * had ever seen. That only gives the right answer if nothing else on the
 * page reads the same list between one uploader's write and its own diff —
 * and a brief has one uploader per project plus two more, all sharing that
 * one ref. Whichever refresh happens to land first claims every id the list
 * had not shown the form yet, including ids a *different*, still-in-flight
 * uploader just wrote and has not had its own turn to claim.
 *
 * These tests drive the real uploaders, in the order the run's own script
 * used — upload, caption, confirm rights, per project, including the extra
 * upload of the same file the run recorded for its first project — and
 * check what actually reaches the PUT body: every project keeps its own
 * screenshot, and nothing is unaccounted for.
 */
describe('BriefForm — an attached, confirmed screenshot is never dropped', () => {
  const FLOWSTARTER_SHOT = '2f205e87-4d8e-483d-bee8-641351b54ed2';
  const ERENO_SHOT = 'b6879783-ef3a-4764-b48f-34174cdda566';
  const DMPRESEARCH_SHOT = 'd153afd4-c78b-474e-a626-318336fce2b9';

  /** A stand-in for XMLHttpRequest, answering uploads in the order sent. */
  class QueueXhr {
    static queue: Array<{ status: number; body: string }> = [];
    static sent: FormData[] = [];

    private handlers: Record<string, () => void> = {};
    private progress: ((event: ProgressEvent) => void) | null = null;
    status = 0;
    responseText = '';

    upload = {
      addEventListener: (
        _type: string,
        callback: (event: ProgressEvent) => void
      ) => {
        this.progress = callback;
      },
    };

    open() {}
    addEventListener(type: string, callback: () => void) {
      this.handlers[type] = callback;
    }
    send(body: FormData) {
      QueueXhr.sent.push(body);
      this.progress?.({
        lengthComputable: true,
        loaded: 10,
        total: 10,
      } as ProgressEvent);
      const next = QueueXhr.queue.shift();
      this.status = next?.status ?? 500;
      this.responseText = next?.body ?? '{}';
      this.handlers['load']?.();
    }
  }

  function uploadedPayload(
    id: string,
    usable: boolean,
    captionSource: string | null
  ) {
    return JSON.stringify({
      uploaded: [{ id, deduplicated: false }],
      assets: [
        {
          id,
          kind: null,
          mime: 'image/jpeg',
          width: 1440,
          height: 900,
          usable,
          url: 'https://storage.test/signed.jpg',
          caption: null,
          captionSource,
          autoCaptionKind: null,
        },
      ],
      sufficiency: { ready: false, missing: [] },
    });
  }

  const originalXhr = global.XMLHttpRequest;

  beforeEach(() => {
    QueueXhr.queue = [];
    QueueXhr.sent = [];
    global.XMLHttpRequest = QueueXhr as unknown as typeof XMLHttpRequest;
  });

  afterEach(() => {
    global.XMLHttpRequest = originalXhr;
  });

  function fileInputIn(row: HTMLElement): HTMLInputElement {
    const input = row.querySelector('input[type="file"]');
    if (!input) throw new Error('no file input in this row');
    return input as HTMLInputElement;
  }

  const A_FILE = () =>
    new File([new Uint8Array([1, 2, 3])], 'shot.jpg', { type: 'image/jpeg' });

  /** Routes fetch by method and path: caption, rights, and the brief itself. */
  function routeFetch() {
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const href = String(url);
      if (href.endsWith('/caption')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          assetId: string;
          caption: string;
        };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            asset: {
              id: body.assetId,
              caption: body.caption,
              captionSource: 'client',
            },
          }),
        };
      }
      if (href.endsWith('/rights')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          assetIds: string[];
        };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            confirmedAssetIds: body.assetIds,
            sufficiency: { ready: false, missing: [] },
          }),
        };
      }
      if (href === `/api/client/brief/${WORKSPACE}` && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            brief: brief(),
            readiness: readinessFor(brief(), []),
            assets: [],
          }),
        };
      }
      // PUT /api/client/brief -- the save the test asserts against.
      return {
        ok: true,
        status: 200,
        json: async () => ({
          brief: brief(),
          readiness: readinessFor(brief(), []),
          assets: [],
        }),
      };
    }) as unknown as typeof fetch;
  }

  /** One project row through the real uploader: upload, caption, confirm. */
  async function fillProjectScreenshot(
    user: ReturnType<typeof userEvent.setup>,
    row: HTMLElement,
    assetId: string
  ) {
    await user.upload(fileInputIn(row), A_FILE());
    const thumbnail = await within(row).findByTestId('asset-thumbnail');
    expect(thumbnail).toBeInTheDocument();

    const captionInput = within(row).getByTestId(
      `asset-caption-input-${assetId}`
    );
    await user.type(captionInput, 'What this screenshot shows');
    await user.click(within(row).getByTestId(`asset-caption-save-${assetId}`));
    await waitFor(() =>
      expect(
        within(row).getByTestId(`asset-caption-source-${assetId}`)
      ).toHaveTextContent('You confirmed this')
    );

    await user.click(within(row).getByTestId('rights-checkbox'));
    await user.click(within(row).getByTestId('confirm-rights'));
    await within(row).findByTestId('asset-uploader-done');
  }

  it('keeps every project’s screenshot, replaying run 9’s own order of writes', async () => {
    routeFetch();
    const user = userEvent.setup();
    mount();

    // Three project rows, the way the run's own script built them: one
    // `brief-add-project` click per project, not three pre-seeded rows.
    await user.click(screen.getByTestId('brief-add-project'));
    await user.click(screen.getByTestId('brief-add-project'));
    await user.click(screen.getByTestId('brief-add-project'));
    const rows = screen.getAllByTestId('brief-project-row');
    expect(rows).toHaveLength(3);

    // Project 0 (Flowstarter): the real upload the run recorded, and the
    // second, deduplicated upload of the exact same file the run's own
    // `project_events` also recorded before rights were confirmed.
    QueueXhr.queue.push({
      status: 201,
      body: uploadedPayload(FLOWSTARTER_SHOT, false, null),
    });
    QueueXhr.queue.push({
      status: 201,
      body: uploadedPayload(FLOWSTARTER_SHOT, false, null),
    });
    await user.upload(fileInputIn(rows[0]), A_FILE());
    await within(rows[0]).findByTestId('asset-thumbnail');
    await user.upload(fileInputIn(rows[0]), A_FILE());

    const flowstarterCaption = within(rows[0]).getByTestId(
      `asset-caption-input-${FLOWSTARTER_SHOT}`
    );
    await user.clear(flowstarterCaption);
    await user.type(flowstarterCaption, 'The Flowstarter home page');
    await user.click(
      within(rows[0]).getByTestId(`asset-caption-save-${FLOWSTARTER_SHOT}`)
    );
    await waitFor(() =>
      expect(
        within(rows[0]).getByTestId(`asset-caption-source-${FLOWSTARTER_SHOT}`)
      ).toHaveTextContent('You confirmed this')
    );
    await user.click(within(rows[0]).getByTestId('rights-checkbox'));
    await user.click(within(rows[0]).getByTestId('confirm-rights'));
    await within(rows[0]).findByTestId('asset-uploader-done');

    // Project 1 (Ereno) and project 2 (DMPResearch), the same way, each
    // after project 0's whole cycle finished -- the run's own sequence.
    QueueXhr.queue.push({
      status: 201,
      body: uploadedPayload(ERENO_SHOT, false, null),
    });
    await fillProjectScreenshot(user, rows[1], ERENO_SHOT);

    QueueXhr.queue.push({
      status: 201,
      body: uploadedPayload(DMPRESEARCH_SHOT, false, null),
    });
    await fillProjectScreenshot(user, rows[2], DMPRESEARCH_SHOT);

    await user.click(screen.getByTestId('brief-save'));
    await waitFor(() => {
      const projects = lastPutBody().projects as Array<{
        screenshotAssetIds: string[];
      }>;
      expect(projects[0].screenshotAssetIds).toEqual([FLOWSTARTER_SHOT]);
    });
    const projects = lastPutBody().projects as Array<{
      screenshotAssetIds: string[];
    }>;
    expect(projects[1].screenshotAssetIds).toEqual([ERENO_SHOT]);
    expect(projects[2].screenshotAssetIds).toEqual([DMPRESEARCH_SHOT]);
  });

  /**
   * The mechanism, isolated from the DOM choreography above: what a project
   * gets is exactly the ids its own uploader just reported, nothing borrowed
   * from what another uploader on the same page happens to have written by
   * then. Project 1 uploads and confirms first here — the opposite order
   * from the replay above — and still ends up with only its own asset,
   * because attachment no longer depends on a shared "what have we seen so
   * far" list that whichever call runs first gets to consume.
   */
  it('attaches each project’s screenshot from its own write, regardless of upload order', async () => {
    routeFetch();
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByTestId('brief-add-project'));
    await user.click(screen.getByTestId('brief-add-project'));
    const rows = screen.getAllByTestId('brief-project-row');

    // Project 1 (index 1) goes through its whole cycle first.
    QueueXhr.queue.push({
      status: 201,
      body: uploadedPayload(ERENO_SHOT, false, null),
    });
    await fillProjectScreenshot(user, rows[1], ERENO_SHOT);

    // Project 0 (index 0) only starts afterwards.
    QueueXhr.queue.push({
      status: 201,
      body: uploadedPayload(FLOWSTARTER_SHOT, false, null),
    });
    await fillProjectScreenshot(user, rows[0], FLOWSTARTER_SHOT);

    await user.click(screen.getByTestId('brief-save'));
    await waitFor(() => {
      const projects = lastPutBody().projects as Array<{
        screenshotAssetIds: string[];
      }>;
      expect(projects[0].screenshotAssetIds).toEqual([FLOWSTARTER_SHOT]);
      expect(projects[1].screenshotAssetIds).toEqual([ERENO_SHOT]);
    });
  });
});
