/**
 * A Romanian visitor reaches the discovery funnel in Romanian.
 *
 * Before this, `IntakeGraphConversation` and `useScopeRoute` both already
 * read locale from `I18nProvider`'s context correctly -- the bug was upstream
 * of them: the provider itself never received anything but the hardcoded
 * `'en'` in `app/layout.tsx`, because nothing resolved a visitor's language
 * from their cookie or their `Accept-Language` header. `resolveLocale`
 * (`src/lib/locale-resolution.ts`) is that resolution, run here exactly as
 * `middleware.ts` runs it -- against a simulated `Accept-Language: ro`
 * header, with no cookie -- and fed into the same `I18nProvider` the app
 * mounts, to prove the whole chain: header in, Romanian catalogue copy out.
 */
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '@/locales/en';
import ro from '@/locales/ro';
import { I18nProvider, useTranslations } from '@/lib/i18n';
import { resolveLocale } from '@/lib/locale-resolution';
import { EMPTY_DISCOVERY } from '../discovery.logic';
import { promptText, questionById } from '../intake-script';
import { IntakeGraphConversation } from '../steps/IntakeGraphConversation';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Reads the real catalogue copy through the real `t`, the way every step in
 * the funnel does — not a hand-copied string that could drift from `ro.ts`. */
function DiscoveryFirstQuestion() {
  const { t } = useTranslations();
  const question = questionById('activityWhat');
  if (!question) throw new Error('activityWhat is not in the script');
  return <p>{promptText(question, EMPTY_DISCOVERY, t)}</p>;
}

function renderWithResolvedLocale(
  ui: ReactElement,
  input: { cookie?: string | null; acceptLanguage?: string | null }
) {
  const locale = resolveLocale(input);
  return render(
    <I18nProvider initialLocale={locale} initialMessages={{ en, ro }}>
      {ui}
    </I18nProvider>
  );
}

describe('a Romanian Accept-Language header reaches the discovery catalogue', () => {
  it('renders the activity question in Romanian when no cookie has chosen yet and the header is ro', () => {
    renderWithResolvedLocale(<DiscoveryFirstQuestion />, {
      cookie: null,
      acceptLanguage: 'ro-RO,ro;q=0.9,en;q=0.5',
    });

    expect(
      screen.getByText(ro['landing.discovery.chat.q.activityWhat.prompt'])
    ).toBeInTheDocument();
  });

  it('stays in English when the header is unsupported', () => {
    renderWithResolvedLocale(<DiscoveryFirstQuestion />, {
      cookie: null,
      acceptLanguage: 'fr-FR,fr;q=0.9',
    });

    expect(
      screen.getByText(en['landing.discovery.chat.q.activityWhat.prompt'])
    ).toBeInTheDocument();
  });

  it('an explicit English cookie choice wins even under a Romanian header', () => {
    renderWithResolvedLocale(<DiscoveryFirstQuestion />, {
      cookie: 'en',
      acceptLanguage: 'ro-RO,ro;q=0.9',
    });

    expect(
      screen.getByText(en['landing.discovery.chat.q.activityWhat.prompt'])
    ).toBeInTheDocument();
  });
});

describe('the resolved locale reaches the intake graph request, not just the screen', () => {
  it('sends locale: "ro" to /api/discovery/intake-graph once the page locale resolves to Romanian', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        threadId: 't-1',
        status: 'ask',
        ask: {
          type: 'ask',
          questionId: 'fullName',
          kind: 'text',
          prompt: 'Cum să îți spun?',
          required: true,
        },
        data: EMPTY_DISCOVERY,
        answered: [],
        progress: { done: 0, total: 16 },
      }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const locale = resolveLocale({
      cookie: null,
      acceptLanguage: 'ro-RO,ro;q=0.9',
    });
    expect(locale).toBe('ro');

    render(
      <I18nProvider initialLocale={locale} initialMessages={{ en, ro }}>
        <IntakeGraphConversation
          data={EMPTY_DISCOVERY}
          update={vi.fn()}
          answered={[]}
          onState={vi.fn()}
          onPolicyStop={vi.fn()}
          t={(key: string) => key}
        />
      </I18nProvider>
    );

    await screen.findByText('Cum să îți spun?');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    const body = JSON.parse(String(init.body));
    expect(body.locale).toBe('ro');
  });
});
