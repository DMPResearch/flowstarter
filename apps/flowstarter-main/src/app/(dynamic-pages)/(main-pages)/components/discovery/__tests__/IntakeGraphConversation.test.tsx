/**
 * The graph-backed intake, as the visitor experiences it.
 *
 * `/api/discovery/intake-graph` is mocked at the network boundary — the graph
 * itself (`graph.test.ts`) and the model calls it makes (`llm-turns.test.ts`)
 * are pinned elsewhere. What is under test here is the component: it draws
 * whatever `ask` the route hands back, including the `note` bubble a
 * question-back or a natural clarification adds, free text is always a way
 * to answer even a chip question, and a route failure never leaves the
 * visitor stuck.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '@/locales/en';
import type { DiscoveryData } from '../discovery.logic';
import { EMPTY_DISCOVERY } from '../discovery.logic';
import type { IntakeQuestionId } from '../intake-script';
import type { IntakeGraphTurnResult } from '@/lib/flowstarter/intake-graph/types';
import { IntakeGraphConversation } from '../steps/IntakeGraphConversation';

const t = (key: string): string =>
  (en as unknown as Record<string, string>)[key] ?? key;

const originalFetch = global.fetch;

function renderConversation(
  overrides: Partial<{
    data: DiscoveryData;
    answered: IntakeQuestionId[];
  }> = {}
) {
  const onState = vi.fn();
  const update = vi.fn();
  const onPolicyStop = vi.fn();
  render(
    <IntakeGraphConversation
      data={overrides.data ?? EMPTY_DISCOVERY}
      update={update}
      answered={overrides.answered ?? []}
      onState={onState}
      onPolicyStop={onPolicyStop}
      t={t}
    />
  );
  return { onState, update, onPolicyStop };
}

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('booting the conversation', () => {
  it('starts the thread and shows the first ask, then answers with the composer', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes('/api/discovery/intake-graph')) {
        return { ok: false, json: async () => ({}) } as Response;
      }
      return {
        ok: true,
        json: async () =>
          ({
            threadId: 't-1',
            status: 'ask',
            ask: {
              type: 'ask',
              questionId: 'fullName',
              kind: 'text',
              prompt: 'What should I call you?',
              required: true,
            },
            data: EMPTY_DISCOVERY,
            answered: [],
            progress: { done: 0, total: 16 },
          } satisfies IntakeGraphTurnResult),
      } as Response;
    }) as unknown as typeof fetch;

    const { onState } = renderConversation();

    expect(
      await screen.findByText('What should I call you?')
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(t('landing.discovery.chat.composerLabel'))
    ).toBeInTheDocument();
    expect(onState).toHaveBeenCalledWith({
      data: EMPTY_DISCOVERY,
      answered: [],
    });

    // The intro and the first ask are two agent messages with nothing
    // between them — one run, so the agent's name and mark show once.
    const log = screen.getByRole('log');
    expect(
      within(log).getAllByText(t('landing.discovery.chat.agentName'))
    ).toHaveLength(1);
    expect(within(log).getAllByTestId('agent-avatar')).toHaveLength(1);
  });

  it('shows the typing beat while the first turn is in flight, not the static loading line', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes('/api/discovery/intake-graph')) {
        return { ok: false, json: async () => ({}) } as Response;
      }
      return {
        ok: true,
        json: async () =>
          ({
            threadId: 't-typing',
            status: 'ask',
            ask: {
              type: 'ask',
              questionId: 'fullName',
              kind: 'text',
              prompt: 'What should I call you?',
              required: true,
            },
            data: EMPTY_DISCOVERY,
            answered: [],
            progress: { done: 0, total: 16 },
          } satisfies IntakeGraphTurnResult),
      } as Response;
    }) as unknown as typeof fetch;

    renderConversation();

    // The turn is still in flight: the animated dots show, not the old
    // static "loading" copy.
    expect(
      screen.getByRole('status', {
        name: t('landing.discovery.chat.thinking'),
      })
    ).toBeInTheDocument();
    expect(screen.queryByText(t('app.loadingExperience'))).toBeNull();

    expect(
      await screen.findByText('What should I call you?')
    ).toBeInTheDocument();
    // The ask has landed — the typing beat is gone.
    expect(
      screen.queryByRole('status', {
        name: t('landing.discovery.chat.thinking'),
      })
    ).toBeNull();
  });

  it('fails open with an error line when the start call itself throws', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderConversation();

    expect(
      await screen.findByText(t('landing.discovery.chat.errors.required'))
    ).toBeInTheDocument();
    errorSpy.mockRestore();
  });
});

describe('a turn with a note', () => {
  it('shows the model’s reaction — an answer to a question, or a natural clarification — ahead of the ask', async () => {
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      const body: IntakeGraphTurnResult =
        call === 1
          ? {
              threadId: 't-note',
              status: 'ask',
              ask: {
                type: 'ask',
                questionId: 'email',
                kind: 'text',
                prompt: 'And your email?',
                required: true,
                note: 'We use it to send your preview link, nothing else.',
              },
              data: EMPTY_DISCOVERY,
              answered: ['fullName'],
              progress: { done: 1, total: 16 },
            }
          : {
              threadId: 't-note',
              status: 'ask',
              ask: {
                type: 'ask',
                questionId: 'email',
                kind: 'text',
                prompt: 'And your email?',
                required: true,
              },
              data: EMPTY_DISCOVERY,
              answered: ['fullName'],
              progress: { done: 1, total: 16 },
              errorKey: 'landing.discovery.chat.errors.required',
            };
      return { ok: true, json: async () => body } as Response;
    }) as unknown as typeof fetch;

    renderConversation({ answered: ['fullName'] });

    const note = await screen.findByText(
      'We use it to send your preview link, nothing else.'
    );
    expect(note).toBeInTheDocument();
    // The raw errorKey never shows alongside a note.
    expect(
      screen.queryByText(t('landing.discovery.chat.errors.required'))
    ).toBeNull();
  });
});

describe('free text is always a way to answer', () => {
  it('shows a typed-answer composer under a choice question, not only its chips', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () =>
        ({
          threadId: 't-choice',
          status: 'ask',
          ask: {
            type: 'ask',
            questionId: 'timeline',
            kind: 'choice',
            prompt: 'How soon?',
            required: false,
            options: [
              { value: 'asap', label: 'ASAP' },
              { value: 'flexible', label: 'Flexible' },
            ],
          },
          data: EMPTY_DISCOVERY,
          answered: [],
          progress: { done: 0, total: 16 },
        } satisfies IntakeGraphTurnResult),
    })) as unknown as typeof fetch;

    renderConversation();

    await screen.findByText('How soon?');
    expect(screen.getByRole('button', { name: 'ASAP' })).toBeInTheDocument();
    // The composer is there too — a chip is a shortcut, not the only door.
    expect(
      screen.getByLabelText(t('landing.discovery.chat.composerLabel'))
    ).toBeInTheDocument();
  });
});

describe('answering resumes the thread', () => {
  it('sends a typed answer and renders the next ask the route returns', async () => {
    const user = userEvent.setup();
    let call = 0;
    global.fetch = vi.fn(async (_input, init) => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          json: async () =>
            ({
              threadId: 't-flow',
              status: 'ask',
              ask: {
                type: 'ask',
                questionId: 'fullName',
                kind: 'text',
                prompt: 'What should I call you?',
                required: true,
              },
              data: EMPTY_DISCOVERY,
              answered: [],
              progress: { done: 0, total: 16 },
            } satisfies IntakeGraphTurnResult),
        } as Response;
      }
      const parsed = JSON.parse(String(init?.body ?? '{}'));
      expect(parsed.action).toBe('resume');
      expect(parsed.resume).toEqual({ kind: 'text', text: 'Maria Ionescu' });
      return {
        ok: true,
        json: async () =>
          ({
            threadId: 't-flow',
            status: 'ask',
            ask: {
              type: 'ask',
              questionId: 'email',
              kind: 'text',
              prompt: 'And your email?',
              required: true,
            },
            data: { ...EMPTY_DISCOVERY, fullName: 'Maria Ionescu' },
            answered: ['fullName'],
            progress: { done: 1, total: 16 },
          } satisfies IntakeGraphTurnResult),
      } as Response;
    }) as unknown as typeof fetch;

    renderConversation();
    await screen.findByText('What should I call you?');

    const composer = screen.getByLabelText(
      t('landing.discovery.chat.composerLabel')
    );
    await user.type(composer, 'Maria Ionescu');
    await user.click(
      screen.getByRole('button', { name: t('landing.discovery.chat.send') })
    );

    expect(await screen.findByText('And your email?')).toBeInTheDocument();
  });

  it('sends on Enter, the same as clicking Send', async () => {
    const user = userEvent.setup();
    let call = 0;
    global.fetch = vi.fn(async (_input, init) => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          json: async () =>
            ({
              threadId: 't-enter',
              status: 'ask',
              ask: {
                type: 'ask',
                questionId: 'fullName',
                kind: 'text',
                prompt: 'What should I call you?',
                required: true,
              },
              data: EMPTY_DISCOVERY,
              answered: [],
              progress: { done: 0, total: 16 },
            } satisfies IntakeGraphTurnResult),
        } as Response;
      }
      const parsed = JSON.parse(String(init?.body ?? '{}'));
      expect(parsed.resume).toEqual({ kind: 'text', text: 'Maria Ionescu' });
      return {
        ok: true,
        json: async () =>
          ({
            threadId: 't-enter',
            status: 'ask',
            ask: {
              type: 'ask',
              questionId: 'email',
              kind: 'text',
              prompt: 'And your email?',
              required: true,
            },
            data: { ...EMPTY_DISCOVERY, fullName: 'Maria Ionescu' },
            answered: ['fullName'],
            progress: { done: 1, total: 16 },
          } satisfies IntakeGraphTurnResult),
      } as Response;
    }) as unknown as typeof fetch;

    renderConversation();
    await screen.findByText('What should I call you?');

    const composer = screen.getByLabelText(
      t('landing.discovery.chat.composerLabel')
    );
    await user.type(composer, 'Maria Ionescu{Enter}');

    expect(await screen.findByText('And your email?')).toBeInTheDocument();
  });

  it('breaks the line on Shift+Enter instead of sending', async () => {
    const user = userEvent.setup();
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () =>
        ({
          threadId: 't-shift-enter',
          status: 'ask',
          ask: {
            type: 'ask',
            questionId: 'fullName',
            kind: 'text',
            prompt: 'What should I call you?',
            required: true,
          },
          data: EMPTY_DISCOVERY,
          answered: [],
          progress: { done: 0, total: 16 },
        } satisfies IntakeGraphTurnResult),
    })) as unknown as typeof fetch;

    renderConversation();
    await screen.findByText('What should I call you?');

    const composer = screen.getByLabelText(
      t('landing.discovery.chat.composerLabel')
    );
    await user.type(composer, 'Maria{Shift>}{Enter}{/Shift}Ionescu');

    // No second call to the route — Shift+Enter never submitted.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(composer).toHaveValue('Maria\nIonescu');
    expect(screen.getByText('What should I call you?')).toBeInTheDocument();
  });

  it('skips an optional question with the dashed chip', async () => {
    const user = userEvent.setup();
    let call = 0;
    global.fetch = vi.fn(async (_input, init) => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          json: async () =>
            ({
              threadId: 't-skip',
              status: 'ask',
              ask: {
                type: 'ask',
                questionId: 'businessName',
                kind: 'text',
                prompt: "What's the business called?",
                required: false,
              },
              data: EMPTY_DISCOVERY,
              answered: ['fullName', 'email'],
              progress: { done: 2, total: 16 },
            } satisfies IntakeGraphTurnResult),
        } as Response;
      }
      const parsed = JSON.parse(String(init?.body ?? '{}'));
      expect(parsed.resume).toEqual({ kind: 'skip' });
      return {
        ok: true,
        json: async () =>
          ({
            threadId: 't-skip',
            status: 'ask',
            ask: {
              type: 'ask',
              questionId: 'description',
              kind: 'longtext',
              prompt: 'What does the business do?',
              required: true,
            },
            data: EMPTY_DISCOVERY,
            answered: ['fullName', 'email', 'businessName'],
            progress: { done: 3, total: 16 },
          } satisfies IntakeGraphTurnResult),
      } as Response;
    }) as unknown as typeof fetch;

    renderConversation({ answered: ['fullName', 'email'] });
    await screen.findByText("What's the business called?");

    await user.click(
      screen.getByRole('button', { name: t('landing.discovery.chat.skip') })
    );

    expect(
      await screen.findByText('What does the business do?')
    ).toBeInTheDocument();
  });

  it('shows the answered history with an empty answer labelled, not left blank', async () => {
    // Every pre-preview question is required now, so nothing can be skipped
    // on purpose. The rendering still has to survive the case: a route that
    // reports a question answered while the script stored nothing for it --
    // a recovered thread, a fold that validated and wrote no field -- must
    // draw that turn as an empty answer rather than as a hole in the log.
    const history = {
      data: { ...EMPTY_DISCOVERY, fullName: 'Maria Ionescu' },
      answered: ['fullName', 'links'] as IntakeQuestionId[],
    };
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () =>
        ({
          threadId: 't-hist',
          status: 'ask',
          ask: {
            type: 'ask',
            questionId: 'description',
            kind: 'longtext',
            prompt: 'What does the business do?',
            required: true,
          },
          data: history.data,
          answered: history.answered,
          progress: { done: 2, total: 4 },
        } satisfies IntakeGraphTurnResult),
    })) as unknown as typeof fetch;

    renderConversation(history);

    const log = await screen.findByRole('log');
    expect(within(log).getByText('Maria Ionescu')).toBeInTheDocument();
    expect(
      within(log).getByText(t('landing.discovery.chat.skipped'))
    ).toBeInTheDocument();
  });
});

describe('a resume that fails', () => {
  it('shows the required error line rather than hanging, and lets the visitor try again', async () => {
    const user = userEvent.setup();
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          json: async () =>
            ({
              threadId: 't-fail',
              status: 'ask',
              ask: {
                type: 'ask',
                questionId: 'fullName',
                kind: 'text',
                prompt: 'What should I call you?',
                required: true,
              },
              data: EMPTY_DISCOVERY,
              answered: [],
              progress: { done: 0, total: 16 },
            } satisfies IntakeGraphTurnResult),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    renderConversation();
    await screen.findByText('What should I call you?');

    const composer = screen.getByLabelText(
      t('landing.discovery.chat.composerLabel')
    );
    await user.type(composer, 'Maria Ionescu');
    await user.click(
      screen.getByRole('button', { name: t('landing.discovery.chat.send') })
    );

    expect(
      await screen.findByText(t('landing.discovery.chat.errors.required'))
    ).toBeInTheDocument();
  });
});

/**
 * Finding 1 of the 2026-09-15 showcase run, at the screen.
 *
 * The recorder filmed two takes of a prohibited brief typed into the browser.
 * Both ended the same way: the route answered `status: 'complete'`,
 * `ask: null`, the description blanked, and the visitor was left in front of a
 * conversation that had simply stopped -- no refusal, no notice, nothing to
 * film. The composer sat there accepting text that went nowhere.
 */
describe('when the acceptable-use gate stops the intake', () => {
  function stoppedTurn(
    stop: 'refused' | 'hold',
    locale: 'en' | 'ro' = 'en'
  ): IntakeGraphTurnResult {
    return {
      threadId: 't-stop',
      status: 'complete',
      ask: null,
      data: {
        ...EMPTY_DISCOVERY,
        description: 'I sell recreational drugs by post',
      },
      answered: ['fullName', 'description'] as IntakeQuestionId[],
      progress: { done: 2, total: 16 },
      skipped: true,
      reason: 'policy',
      policyStop: stop,
      policy: {
        title:
          locale === 'ro'
            ? 'Nu putem construi acest site'
            : 'We cannot build this one',
        message: 'Our acceptable-use policy does not allow this.',
        next: 'If we have read your business wrong, tell us.',
        termsHref: '/terms#acceptable-use',
        contactHref: '/contact',
        termsLabel: 'Read the acceptable use section of our terms',
        contactLabel: 'Talk to a person',
        decision: stop === 'refused' ? 'refuse' : 'review',
        categoryId: stop === 'refused' ? 'illegal_drugs' : 'none',
        locale,
      },
    };
  }

  async function walkIntoAStop(stop: 'refused' | 'hold') {
    const user = userEvent.setup();
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          json: async () =>
            ({
              threadId: 't-stop',
              status: 'ask',
              ask: {
                type: 'ask',
                questionId: 'description',
                kind: 'longtext',
                prompt: 'What does your business do?',
                required: true,
              },
              data: EMPTY_DISCOVERY,
              answered: [],
              progress: { done: 0, total: 16 },
            } satisfies IntakeGraphTurnResult),
        } as Response;
      }
      return { ok: true, json: async () => stoppedTurn(stop) } as Response;
    }) as unknown as typeof fetch;

    const handles = renderConversation();
    await screen.findByText('What does your business do?');
    await user.type(
      screen.getByLabelText(t('landing.discovery.chat.composerLabel')),
      'I sell recreational drugs by post'
    );
    await user.click(
      screen.getByRole('button', { name: t('landing.discovery.chat.send') })
    );
    return handles;
  }

  it("shows the refusal in the gate's own words instead of going quiet", async () => {
    await walkIntoAStop('refused');

    const notice = await screen.findByTestId('intake-policy-refused');
    expect(
      within(notice).getByText('We cannot build this one')
    ).toBeInTheDocument();
    expect(notice).toHaveAttribute('data-policy-decision', 'refuse');
    // The two doors out of a refusal, in the same language as the rest of it.
    expect(
      within(notice).getByText('Talk to a person').getAttribute('href')
    ).toBe('/contact');
  });

  it('takes the composer away, because the intake is over', async () => {
    await walkIntoAStop('refused');
    await screen.findByTestId('intake-policy-refused');

    // An input box that still accepts text after the gate has said no is a
    // promise the product cannot keep, and it is what the visitor was left
    // staring at on 2026-09-15.
    expect(
      screen.queryByLabelText(t('landing.discovery.chat.composerLabel'))
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: t('landing.discovery.chat.send') })
    ).toBeNull();
  });

  it('keeps the answer the visitor gave rather than discarding it', async () => {
    const { onState } = await walkIntoAStop('refused');
    await screen.findByTestId('intake-policy-refused');

    // The exact regression: the old moderator answered with the state from
    // before the turn, so the preview pane went on reading "You do: Not yet".
    const last = onState.mock.calls.at(-1)?.[0] as { data: DiscoveryData };
    expect(last.data.description).toBe('I sell recreational drugs by post');
  });

  it('tells the wizard, so nothing downstream mounts', async () => {
    const { onPolicyStop } = await walkIntoAStop('refused');
    await screen.findByTestId('intake-policy-refused');

    expect(onPolicyStop).toHaveBeenCalledWith(
      expect.objectContaining({ stop: 'refused' })
    );
  });

  it('shows the hold with its own copy, which is not the refusal', async () => {
    await walkIntoAStop('hold');

    const notice = await screen.findByTestId('intake-policy-hold');
    expect(notice).toHaveAttribute('data-policy-decision', 'review');
  });
});
