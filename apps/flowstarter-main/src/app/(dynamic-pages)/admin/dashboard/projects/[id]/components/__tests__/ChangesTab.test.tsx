/**
 * The operator's change request card: how it is addressed, and what it sends.
 *
 * Two things are pinned here. The card carries `data-request-id`, so a
 * screenshot script, an E2E spec or a person in devtools can point at one
 * request out of a list rather than at "the third li". And the picker on the
 * "Build this change" block sends exactly the pictures that were ticked --
 * only those, and nothing at all when nobody ticked anything, because an
 * empty `assetIds` would read on the server as "the operator chose none"
 * rather than "the operator did not choose".
 *
 * The third is what each line is allowed to say. Six uncaptioned pictures once
 * arrived as six identical lines an operator could not tell apart, so a line
 * now carries whose words the caption is and what the picture was taken to be
 * -- and, as it has since #119, never a storage path and never a hash.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChangeRequestView } from '@/lib/flowstarter/change-requests';
import type { ChangeRequestAssetOption } from '@/lib/flowstarter/change-requests-api';
import { RequestCard } from '../ChangesTab';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The build conversation opens a stream the moment a job id exists; it has
// its own suite, and it is not what this one is about.
vi.mock('../BuildConversation', () => ({
  BuildConversation: () => <div data-testid="build-conversation" />,
}));

const PROJECT_ID = 'c009105e-f8ec-42bf-bdcf-cf92bb500f45';
const CHANGE_ID = '72fe7f79-0e83-4cf6-9b4a-2502842b9a54';
const ASSET_A = 'b104b1e0-6d4c-4a3e-9230-13cc17b426a0';
const ASSET_B = '1c9d0e93-1d15-4ee8-ba3c-2dc99e5186ff';

const fetchMock = vi.fn();
global.fetch = fetchMock as unknown as typeof fetch;

function paidRequest(): ChangeRequestView {
  return {
    id: CHANGE_ID,
    request: 'Add a small gallery to the Flowstarter case study page',
    classification: 'structural',
    matchedRules: ['structural:new-thing'],
    status: 'paid',
    quoteMinor: 19_000,
    currency: 'eur',
    quoteNote: null,
    quotedAt: '2026-09-12T09:00:00.000Z',
    respondedAt: null,
    paidAt: '2026-09-12T10:00:00.000Z',
    completedAt: null,
    createdAt: '2026-09-12T08:00:00.000Z',
    buildJobId: null,
    builtVersion: null,
    completedVia: null,
    suggestedQuoteMinor: 19_000,
  };
}

function renderCard(
  assets: ChangeRequestAssetOption[] = [
    {
      id: ASSET_A,
      label: 'The Flowstarter client dashboard',
      caption: null,
      captionSource: null,
      kind: null,
      thumbnailUrl: 'https://storage.example/signed/a.jpg',
    },
    {
      id: ASSET_B,
      label: 'operator-pipeline.png',
      caption: null,
      captionSource: null,
      kind: null,
      thumbnailUrl: null,
    },
  ]
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ul>
        <RequestCard
          request={paidRequest()}
          projectId={PROJECT_ID}
          projectState="LIVE_SUBSCRIPTION"
          assets={assets}
        />
      </ul>
    </QueryClientProvider>
  );
}

/** The body of the one POST the card made. */
async function sentBody(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      jobId: 'job-1',
      created: true,
      dispatched: true,
      seedVersion: 4,
      assets: [],
      request: paidRequest(),
    }),
  });
});

describe('the change request card', () => {
  it('can be addressed by the request it is showing', () => {
    renderCard();
    expect(screen.getByTestId('change-request-card')).toHaveAttribute(
      'data-request-id',
      CHANGE_ID
    );
  });

  it('sends only the pictures an operator ticked', async () => {
    renderCard();
    fireEvent.click(screen.getByTestId(`change-request-asset-${ASSET_B}`));
    fireEvent.click(screen.getByTestId('change-request-build-start'));

    const body = await sentBody();
    expect(body.assetIds).toEqual([ASSET_B]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/admin/projects/${PROJECT_ID}/changes/${CHANGE_ID}/build`
    );
  });

  it('sends both when both are ticked, in the order they were ticked', async () => {
    renderCard();
    fireEvent.click(screen.getByTestId(`change-request-asset-${ASSET_B}`));
    fireEvent.click(screen.getByTestId(`change-request-asset-${ASSET_A}`));
    fireEvent.click(screen.getByTestId('change-request-build-start'));

    expect((await sentBody()).assetIds).toEqual([ASSET_B, ASSET_A]);
  });

  it('sends no assetIds at all when nobody ticked anything', async () => {
    // An empty array would read on the server as "the operator chose none of
    // them", which is a different instruction from "the operator did not
    // choose", and the second is what an untouched picker means.
    renderCard();
    fireEvent.click(screen.getByTestId('change-request-build-start'));

    const body = await sentBody();
    expect(body).not.toHaveProperty('assetIds');
    expect(body.note).toBe('');
  });

  it('drops a tick that was taken back again', async () => {
    renderCard();
    fireEvent.click(screen.getByTestId(`change-request-asset-${ASSET_A}`));
    fireEvent.click(screen.getByTestId(`change-request-asset-${ASSET_A}`));
    fireEvent.click(screen.getByTestId('change-request-build-start'));

    expect(await sentBody()).not.toHaveProperty('assetIds');
  });

  it('shows a thumbnail next to a picture that has one, and none for one that does not', () => {
    renderCard();
    const thumbnail = screen.getByAltText('') as HTMLImageElement;
    expect(thumbnail).toHaveAttribute(
      'src',
      'https://storage.example/signed/a.jpg'
    );
    // Only one asset in this fixture has a thumbnailUrl; a failed sign must
    // degrade to no image, not a broken one.
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(
      screen.getByText('The Flowstarter client dashboard')
    ).toBeInTheDocument();
    expect(screen.getByText('operator-pipeline.png')).toBeInTheDocument();
  });

  it('shows no picker at all when the client has confirmed no pictures', () => {
    renderCard([]);
    expect(
      screen.queryByTestId('change-request-asset-picker')
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId('change-request-build-start')
    ).toBeInTheDocument();
  });
});

describe('the picker on a paid card', () => {
  it('says whose words the caption is, and what the picture was taken to be', () => {
    renderCard([
      {
        id: ASSET_A,
        label: 'The booking page on a phone',
        caption: 'The booking page on a phone',
        captionSource: 'auto',
        kind: 'screenshot',
        thumbnailUrl: null,
      },
      {
        id: ASSET_B,
        label: 'The bench at the back of the workshop',
        caption: 'The bench at the back of the workshop',
        captionSource: 'client',
        kind: 'photo',
        thumbnailUrl: null,
      },
    ]);

    expect(
      screen.getByTestId(`change-request-asset-source-${ASSET_A}`)
    ).toHaveTextContent('AI suggested');
    expect(
      screen.getByTestId(`change-request-asset-kind-${ASSET_A}`)
    ).toHaveTextContent('screenshot');
    expect(
      screen.getByTestId(`change-request-asset-source-${ASSET_B}`)
    ).toHaveTextContent("Client's own words");
    expect(
      screen.getByTestId(`change-request-asset-kind-${ASSET_B}`)
    ).toHaveTextContent('photo');
  });

  it('says nothing where there is nothing to say', () => {
    // The fixture's captions are null, which is a picture nobody has
    // described. Inventing "unknown" or "photo" for it would be the same
    // guess the build agent is forbidden from making.
    renderCard();
    expect(
      screen.queryByTestId(`change-request-asset-source-${ASSET_A}`)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`change-request-asset-kind-${ASSET_A}`)
    ).not.toBeInTheDocument();
  });

  // #119: an operator was once shown storage paths in place of labels. Nothing
  // this picker renders may be a path or a digest, whatever else is added to
  // the response.
  it('never prints a storage path or a hash', () => {
    renderCard([
      {
        id: ASSET_A,
        label: 'The booking page on a phone',
        caption: 'The booking page on a phone',
        captionSource: 'auto',
        kind: 'screenshot',
        thumbnailUrl: 'https://storage.example/signed/a.jpg',
      },
    ]);

    const text =
      screen.getByTestId('change-request-asset-picker').textContent ?? '';
    expect(text).not.toMatch(/[0-9a-f]{32,}/i);
    expect(text).not.toMatch(/workspaces\/|assets\/|storage/i);
    expect(text).toContain('The booking page on a phone');
  });
});
