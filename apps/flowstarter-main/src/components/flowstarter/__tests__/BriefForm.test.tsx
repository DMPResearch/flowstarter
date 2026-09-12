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
import {
  MIN_OFFER_CHARS,
  evaluateBriefReadiness,
  type BriefReadiness,
} from '@/lib/flowstarter/brief-readiness';

const WORKSPACE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const PHOTO_BIG = '11111111-1111-4111-8111-111111111111';
const PHOTO_SMALL = '22222222-2222-4222-8222-222222222222';

const GOOD_OFFER =
  'We fit and service gas boilers for homes across the county, and we take on ' +
  'the emergency call-outs nobody else will.';

const originalFetch = global.fetch;

function brief(overrides: Partial<BriefView> = {}): BriefView {
  return {
    offer: '',
    projects: [],
    noProjects: false,
    designReferenceAssetIds: [],
    photoAssetIds: [],
    portraitAssetId: null,
    readyAt: null,
    overrideAt: null,
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
  readiness: BriefReadiness = readinessFor(view, assets)
) {
  return render(
    <BriefForm
      workspaceId={WORKSPACE}
      initialBrief={view}
      initialReadiness={readiness}
      initialAssets={assets}
    />
  );
}

/** The body of the last PUT the form sent. */
function lastPutBody(): Record<string, unknown> {
  const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
    .calls as Array<[string, RequestInit | undefined]>;
  const put = [...calls].reverse().find((call) => call[1]?.method === 'PUT');
  return JSON.parse(String(put?.[1]?.body ?? '{}'));
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

  it('gives every section an uploader rather than rolling its own', () => {
    mount();
    // Design references and photos, plus one per project row.
    expect(screen.getAllByTestId('asset-uploader')).toHaveLength(2);
  });
});
