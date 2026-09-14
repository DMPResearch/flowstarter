/**
 * The property the whole feature exists for: a custom work brief costs nothing.
 *
 * The wizard is rendered whole and walked through the four quick questions the
 * way a visitor walks it, and `PreviewStep` is deliberately NOT stubbed. If the
 * routing gate ever stopped standing between the last question and the preview,
 * the real component would mount, it would POST to
 * `/api/discovery/preview/live`, and the assertion below would catch it. A stub
 * would have made this test pass forever regardless.
 *
 * Every request the page makes is answered here, so nothing reaches a model or
 * a network.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/locales/en';
import { DiscoveryWizard } from '../DiscoveryWizard';

/**
 * The one thing about `PreviewStep` that is stubbed, and it is not the fetch.
 * The real component asks Clerk whether the visitor is signed in, which needs a
 * provider this test has no reason to mount. Everything else about it is real,
 * including the POST that the assertions below are watching for.
 */
vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({ isSignedIn: false, isLoaded: true }),
}));

const t = (key: string): string =>
  (en as unknown as Record<string, string>)[key] ?? key;

const originalFetch = global.fetch;

/** Every URL the walk touches, in order, so an unexpected one is visible. */
let requested: string[] = [];
let scopeAnswers: Array<Record<string, unknown>> = [];
/** What `/api/discovery/scope` replies, per call. */
let scopeReplies: Array<Record<string, unknown>> = [];

function mockFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    requested.push(url);
    if (url.startsWith('/api/discovery/scope')) {
      scopeAnswers.push(
        JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      );
      const reply = scopeReplies.shift() ?? { route: 'self-serve' };
      return { ok: true, json: async () => reply } as Response;
    }
    return { ok: false, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

type User = ReturnType<typeof userEvent.setup>;

async function say(user: User, text: string) {
  const composer = screen.getByLabelText(
    t('landing.discovery.chat.composerLabel')
  );
  await user.clear(composer);
  await user.type(composer, text);
  await user.click(
    screen.getByRole('button', { name: t('landing.discovery.chat.send') })
  );
}

/**
 * The four required quick questions, plus the two one-tap turns that hang off
 * the links answer: "is this your own site?" (PR #155, asked because the answer
 * below includes a website) and the optional connect-photo offer.
 */
async function walkTheQuickIntake(user: User) {
  await say(user, 'Sarah Smith');
  await say(user, 'sarah@example.com');
  await say(
    user,
    'A portal my customers log into to track their orders and pay invoices'
  );
  await say(user, 'https://acme.example.com');
  await say(user, 'No');
  await user.click(
    await screen.findByRole('button', {
      name: t('landing.discovery.chat.skip'),
    })
  );
}

function renderWizard() {
  render(
    <DiscoveryWizard
      source="test"
      onComplete={vi.fn()}
      conversationPaceMs={0}
      t={t}
    />
  );
  return userEvent.setup();
}

beforeEach(() => {
  window.sessionStorage.clear();
  requested = [];
  scopeAnswers = [];
  scopeReplies = [];
  mockFetch();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('the routing gate, in the wizard', () => {
  it('spends no generation budget on a custom work brief', async () => {
    scopeReplies = [
      {
        route: 'discovery-call',
        scope: 'custom',
        bookingUrl: 'https://cal.flowstarter.dev/darius/discovery-call',
      },
    ];
    const user = renderWizard();
    await walkTheQuickIntake(user);

    await screen.findByText(t('landing.discovery.scope.offer.title'));

    // THE ASSERTION. `PreviewStep` is the only thing that calls this route and
    // it was never mounted, so the route was never called.
    expect(
      requested.some((url) => url.startsWith('/api/discovery/preview/live'))
    ).toBe(false);
    expect(
      requested.filter((url) => url.startsWith('/api/discovery/scope'))
    ).toHaveLength(1);
  });

  it('offers the call in the studio’s name and embeds the booking page', async () => {
    scopeReplies = [
      {
        route: 'discovery-call',
        bookingUrl: 'https://cal.flowstarter.dev/darius/discovery-call',
      },
    ];
    const user = renderWizard();
    await walkTheQuickIntake(user);

    expect(
      await screen.findByText(t('landing.discovery.scope.offer.studio'))
    ).toHaveTextContent('DMPResearch');
    const frame = await screen.findByTitle(t('discoveryCall.bookingTitle'));
    expect(frame).toHaveAttribute(
      'src',
      expect.stringContaining('cal.flowstarter.dev/darius/discovery-call')
    );
  });

  it('falls back to the contact copy when there is no booking page', async () => {
    scopeReplies = [{ route: 'discovery-call', bookingUrl: null }];
    const user = renderWizard();
    await walkTheQuickIntake(user);

    expect(
      await screen.findByText(t('landing.discovery.scope.offer.fallbackTitle'))
    ).toBeInTheDocument();
    expect(screen.queryByTitle(t('discoveryCall.bookingTitle'))).toBeNull();
  });

  it('asks the one clarifying question, then acts on the answer', async () => {
    scopeReplies = [
      {
        route: 'ask-one-more-question',
        questionKey: 'landing.discovery.scope.question',
      },
      { route: 'discovery-call', bookingUrl: null },
    ];
    const user = renderWizard();
    await walkTheQuickIntake(user);

    await screen.findByText(t('landing.discovery.scope.question'));
    // Still nothing spent while the question is on screen.
    expect(
      requested.some((url) => url.startsWith('/api/discovery/preview/live'))
    ).toBe(false);

    await user.click(
      screen.getByRole('button', {
        name: t('landing.discovery.scope.answer.software'),
      })
    );

    await screen.findByText(t('landing.discovery.scope.offer.title'));
    expect(scopeAnswers).toHaveLength(2);
    // The second pass carries the answer, which is what tells the rule the
    // question has already been asked.
    expect(scopeAnswers[0].clarification).toBeUndefined();
    expect(scopeAnswers[1].clarification).toBe(
      t('landing.discovery.scope.answer.software')
    );
  });

  it('lets a standard brief through to the preview exactly as before', async () => {
    scopeReplies = [{ route: 'self-serve', scope: 'standard' }];
    const user = renderWizard();
    await walkTheQuickIntake(user);

    await waitFor(() => {
      expect(
        requested.some((url) => url.startsWith('/api/discovery/preview/live'))
      ).toBe(true);
    });
  });

  it('fails open to the preview when the gate cannot be reached', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      requested.push(url);
      if (url.startsWith('/api/discovery/scope')) throw new Error('offline');
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const user = renderWizard();
    await walkTheQuickIntake(user);

    await waitFor(() => {
      expect(
        requested.some((url) => url.startsWith('/api/discovery/preview/live'))
      ).toBe(true);
    });
  });
});
