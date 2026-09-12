/**
 * The two pieces of the client's enquiries UI that make a decision.
 *
 * Rotate is the one action on the settings page that breaks something which
 * currently works, so the confirmation is not decoration: a click that rotated
 * on the first press would take a client's contact form down without them
 * having agreed to it. The spam toggle is the other: spam is kept rather than
 * deleted, and a client has to be able to find a real customer the classifier
 * was wrong about.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LeadCaptureSettings } from '../LeadCaptureSettings';
import { LeadsList, formatLeadDate } from '../LeadsList';
import type { WorkspaceLead } from '@/lib/flowstarter/lead-capture';

vi.mock('server-only', () => ({}));

const WORKSPACE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const TOKEN = 'Kx9-_abcdefghijklmnopqrstuvwxyz0123456789AB';
const NEXT = 'Zz8-_zyxwvutsrqponmlkjihgfedcba9876543210CD';
const ENDPOINT = `https://flowstarter.test/api/leads/capture/${TOKEN}`;

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

function settings() {
  return render(
    <LeadCaptureSettings
      workspaceId={WORKSPACE}
      initialToken={TOKEN}
      endpoint={ENDPOINT}
    />
  );
}

describe('LeadCaptureSettings', () => {
  it('shows the token and the endpoint', () => {
    settings();
    expect(screen.getByTestId('lead-capture-token')).toHaveTextContent(TOKEN);
    expect(screen.getByTestId('lead-capture-endpoint')).toHaveTextContent(
      ENDPOINT
    );
  });

  it('asks before rotating, and says what it costs', () => {
    settings();
    fireEvent.click(screen.getByTestId('lead-capture-rotate'));
    expect(screen.getByTestId('lead-capture-confirm')).toHaveTextContent(
      'stops the old token working straight away'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rotates nothing when the client backs out', () => {
    settings();
    fireEvent.click(screen.getByTestId('lead-capture-rotate'));
    fireEvent.click(screen.getByTestId('lead-capture-rotate-cancel'));
    expect(screen.queryByTestId('lead-capture-confirm')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts, then shows the new token and the new endpoint', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: NEXT, slug: 'acme' }),
    });
    settings();
    fireEvent.click(screen.getByTestId('lead-capture-rotate'));
    fireEvent.click(screen.getByTestId('lead-capture-rotate-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('lead-capture-token')).toHaveTextContent(NEXT)
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/client/lead-capture/${WORKSPACE}`,
      { method: 'POST' }
    );
    expect(screen.getByTestId('lead-capture-endpoint')).toHaveTextContent(
      `https://flowstarter.test/api/leads/capture/${NEXT}`
    );
    expect(screen.getByTestId('lead-capture-rotated')).toBeInTheDocument();
  });

  it('keeps the old token on screen when the rotation was refused', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Could not rotate your token.' }),
    });
    settings();
    fireEvent.click(screen.getByTestId('lead-capture-rotate'));
    fireEvent.click(screen.getByTestId('lead-capture-rotate-confirm'));

    await screen.findByRole('alert');
    expect(screen.getByTestId('lead-capture-token')).toHaveTextContent(TOKEN);
  });

  it('says so when the server could not be reached', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    settings();
    fireEvent.click(screen.getByTestId('lead-capture-rotate'));
    fireEvent.click(screen.getByTestId('lead-capture-rotate-confirm'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server'
    );
  });
});

// ── The list ───────────────────────────────────────────────────────────────

function lead(overrides: Partial<WorkspaceLead> = {}): WorkspaceLead {
  return {
    id: `lead-${Math.random()}`,
    name: 'Elena',
    email: 'elena@salon.ro',
    phone: null,
    message: 'Doresc o programare',
    source: '/contact',
    status: 'new',
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('LeadsList', () => {
  it('says so when there is nothing yet', () => {
    render(<LeadsList leads={[]} spam={[]} />);
    expect(screen.getByTestId('leads-empty')).toBeInTheDocument();
  });

  it('shows the enquiries it was given', () => {
    render(<LeadsList leads={[lead()]} spam={[]} />);
    expect(screen.getByText('Doresc o programare')).toBeInTheDocument();
    expect(screen.getByText(/elena@salon.ro/)).toBeInTheDocument();
  });

  it('keeps spam out of the way until it is asked for', () => {
    render(
      <LeadsList
        leads={[lead()]}
        spam={[lead({ status: 'spam', message: 'Buy now' })]}
      />
    );
    expect(screen.queryByText('Buy now')).toBeNull();
    fireEvent.click(screen.getByTestId('leads-spam-toggle'));
    expect(screen.getByText('Buy now')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('leads-spam-toggle'));
    expect(screen.queryByText('Buy now')).toBeNull();
  });

  it('names somebody who left no name', () => {
    render(<LeadsList leads={[lead({ name: null })]} spam={[]} />);
    expect(screen.getByText('Someone')).toBeInTheDocument();
  });
});

describe('formatLeadDate', () => {
  it('is a date, not a relative phrase a client cannot quote', () => {
    expect(formatLeadDate('2026-09-01T10:00:00.000Z')).toMatch(
      /^1 Sept? 2026$/
    );
  });

  it('is empty rather than "Invalid Date" for a value that is not one', () => {
    expect(formatLeadDate('not a date')).toBe('');
  });
});
