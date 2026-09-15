/**
 * The "About you" section of the brief form.
 *
 * Split out from BriefForm.test.tsx because `person` is its own subsystem
 * with its own rule: shown only when the client was actually asked, never
 * inferred from anything else on the brief; a sourced bio is a proposal and
 * never treated as the client's own words until they approve it; and a
 * link's consent checkbox is the only thing that turns "here is my profile"
 * into "you may go and read it". The rest of the save plumbing -- the server
 * s answer replacing local state, errors surfacing, the save button
 * disabling while a request is in flight -- is already covered next door in
 * BriefForm.test.tsx and is not repeated here.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BriefForm, type BriefAssetView, type BriefView } from '../BriefForm';
import {
  EMPTY_PERSON,
  type BriefPerson,
} from '@flowstarter/agentic-codegen/src/flowstarter/person';
import type { BriefReadiness } from '@/lib/flowstarter/brief-readiness';

const WORKSPACE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

/**
 * Not the real rule's output: these tests are about what the "About you"
 * section renders and sends, not about what is still missing, so a fixed,
 * uninteresting readiness keeps every test focused on that.
 */
const READINESS: BriefReadiness = {
  ready: false,
  missing: [],
  completeness: 0,
};

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
    pageCount: null,
    person: null,
    ...overrides,
  };
}

function person(overrides: Partial<BriefPerson> = {}): BriefPerson {
  return { ...EMPTY_PERSON, ...overrides };
}

const originalFetch = global.fetch;

function respondWith(payload: unknown, ok = true) {
  global.fetch = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 400,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

/** The body of the last PUT the form sent. */
function lastPutBody(): Record<string, unknown> {
  const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
    .calls as Array<[string, RequestInit | undefined]>;
  const put = [...calls].reverse().find((call) => call[1]?.method === 'PUT');
  return JSON.parse(String(put?.[1]?.body ?? '{}'));
}

function mount(view: BriefView, assets: BriefAssetView[] = []) {
  return render(
    <BriefForm
      workspaceId={WORKSPACE}
      initialBrief={view}
      initialReadiness={READINESS}
      initialAssets={assets}
      derivedPageCount="lt-5"
      derivedBusinessName="A New Business"
    />
  );
}

beforeEach(() => {
  respondWith({});
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('BriefForm — About you', () => {
  it('renders nothing at all when nobody was ever asked', () => {
    mount(brief({ person: null }));
    expect(screen.queryByText('About you')).toBeNull();
    expect(screen.queryByTestId('brief-person-name')).toBeNull();
    expect(screen.queryByTestId('brief-person-story')).toBeNull();
  });

  it("shows the client's own stored answers", () => {
    mount(
      brief({
        person: person({
          name: 'Priya Patel',
          headline: 'Furniture from reclaimed wood',
          story: 'I started out fixing bikes in my dad’s garage.',
          howIWork: 'I answer my own emails.',
          values: 'I would rather say no than do a rushed job.',
          feel: 'Like they met someone who knows what they are doing.',
          toneWords: ['warm', 'precise'],
          proudestWork:
            'A kitchen renovation for a family who had saved for years.',
          activity: {
            what: 'I build custom furniture.',
            who: 'Young families renovating their first home.',
            typical: 'A call, a plan, then a few weeks of work.',
            knownFor: 'Turning a project around fast.',
            years: 'About eight years.',
          },
        }),
      })
    );

    expect(screen.getByText('About you')).toBeInTheDocument();
    expect(screen.getByTestId('brief-person-name')).toHaveValue('Priya Patel');
    expect(screen.getByTestId('brief-person-headline')).toHaveValue(
      'Furniture from reclaimed wood'
    );
    expect(screen.getByTestId('brief-person-story')).toHaveValue(
      'I started out fixing bikes in my dad’s garage.'
    );
    expect(screen.getByTestId('brief-person-how-i-work')).toHaveValue(
      'I answer my own emails.'
    );
    expect(screen.getByTestId('brief-person-values')).toHaveValue(
      'I would rather say no than do a rushed job.'
    );
    expect(screen.getByTestId('brief-person-feel')).toHaveValue(
      'Like they met someone who knows what they are doing.'
    );
    const toneWords = screen.getAllByTestId('brief-person-tone-word');
    expect(toneWords[0]).toHaveValue('warm');
    expect(toneWords[1]).toHaveValue('precise');
    expect(screen.getByTestId('brief-person-proudest-work')).toHaveValue(
      'A kitchen renovation for a family who had saved for years.'
    );
    expect(screen.getByTestId('brief-person-activity-what')).toHaveValue(
      'I build custom furniture.'
    );
    expect(screen.getByTestId('brief-person-activity-who')).toHaveValue(
      'Young families renovating their first home.'
    );
    expect(screen.getByTestId('brief-person-activity-typical')).toHaveValue(
      'A call, a plan, then a few weeks of work.'
    );
    expect(screen.getByTestId('brief-person-activity-known-for')).toHaveValue(
      'Turning a project around fast.'
    );
    expect(screen.getByTestId('brief-person-activity-years')).toHaveValue(
      'About eight years.'
    );
  });

  it('sends a typed story in the PUT body', async () => {
    const user = userEvent.setup();
    mount(brief({ person: person() }));

    await user.type(
      screen.getByTestId('brief-person-story'),
      'I fix bikes in my spare time.'
    );
    await user.click(screen.getByTestId('brief-save'));

    await waitFor(() => {
      const sent = lastPutBody().person as { story: string };
      expect(sent.story).toBe('I fix bikes in my spare time.');
    });
  });

  it('shows a sourced bio as a proposal, with its source visible, and never in the story field', () => {
    mount(
      brief({
        person: person({
          story: '',
          sourcedBio: {
            excerpt: 'Priya builds furniture from reclaimed wood in Leeds.',
            source: 'linkedin-headline',
            sourceUrl: 'https://linkedin.com/in/priya',
            fetchedAt: '2026-09-10T09:00:00.000Z',
            adoptedAt: null,
          },
        }),
      })
    );

    const card = screen.getByTestId('brief-person-sourced-bio');
    expect(card).toHaveAttribute('data-adopted', 'false');
    expect(
      screen.getByTestId('brief-person-sourced-bio-excerpt')
    ).toHaveTextContent('Priya builds furniture from reclaimed wood in Leeds.');
    const source = screen.getByTestId('brief-person-sourced-bio-source');
    expect(source).toHaveAttribute('href', 'https://linkedin.com/in/priya');
    expect(source).toHaveTextContent('https://linkedin.com/in/priya');

    // A proposal is not the client's own words until they say so: it must
    // never be copied into the field they type their story into.
    expect(screen.getByTestId('brief-person-story')).toHaveValue('');
  });

  it('sends adoptSourcedBio: true when the client presses "Use it"', async () => {
    const user = userEvent.setup();
    mount(
      brief({
        person: person({
          sourcedBio: {
            excerpt: 'Priya builds furniture from reclaimed wood in Leeds.',
            source: 'linkedin-headline',
            sourceUrl: 'https://linkedin.com/in/priya',
            fetchedAt: '2026-09-10T09:00:00.000Z',
            adoptedAt: null,
          },
        }),
      })
    );

    await user.click(screen.getByTestId('brief-person-sourced-bio-use'));

    await waitFor(() => {
      const sent = lastPutBody().person as { adoptSourcedBio?: boolean };
      expect(sent.adoptSourcedBio).toBe(true);
    });
  });

  it('sends adoptSourcedBio: false when the client presses "Dismiss"', async () => {
    const user = userEvent.setup();
    mount(
      brief({
        person: person({
          sourcedBio: {
            excerpt: 'Priya builds furniture from reclaimed wood in Leeds.',
            source: 'linkedin-headline',
            sourceUrl: 'https://linkedin.com/in/priya',
            fetchedAt: '2026-09-10T09:00:00.000Z',
            adoptedAt: null,
          },
        }),
      })
    );

    await user.click(screen.getByTestId('brief-person-sourced-bio-dismiss'));

    await waitFor(() => {
      const sent = lastPutBody().person as { adoptSourcedBio?: boolean };
      expect(sent.adoptSourcedBio).toBe(false);
    });
  });

  it("starts a link's consent unticked, and sends consented: true only once it is ticked", async () => {
    const user = userEvent.setup();
    mount(
      brief({
        person: person({
          links: [
            {
              kind: 'linkedin',
              url: 'https://linkedin.com/in/priya',
              consented: false,
            },
          ],
        }),
      })
    );

    const row = screen
      .getAllByTestId('brief-person-link-row')
      .find((entry) => entry.dataset.kind === 'linkedin');
    if (!row) throw new Error('no linkedin row rendered');
    const checkbox = within(row).getByTestId('brief-person-link-consent');
    expect(checkbox).not.toBeChecked();

    await user.click(screen.getByTestId('brief-save'));
    await waitFor(() => {
      const links = (
        lastPutBody().person as {
          links: Array<{ kind: string; consented: boolean }>;
        }
      ).links;
      const linkedin = links.find((entry) => entry.kind === 'linkedin');
      expect(linkedin?.consented).toBe(false);
    });

    await user.click(checkbox);
    expect(checkbox).toBeChecked();

    await user.click(screen.getByTestId('brief-save'));
    await waitFor(() => {
      const links = (
        lastPutBody().person as {
          links: Array<{ kind: string; consented: boolean }>;
        }
      ).links;
      const linkedin = links.find((entry) => entry.kind === 'linkedin');
      expect(linkedin?.consented).toBe(true);
    });
  });

  it('never ticks a consent box by default, for every profile kind offered', () => {
    mount(brief({ person: person() }));
    const boxes = screen.getAllByTestId('brief-person-link-consent');
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      expect(box).not.toBeChecked();
    }
  });
});
