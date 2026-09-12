/**
 * The intake, as the visitor experiences it.
 *
 * The wizard is rendered whole rather than the conversation alone, because the
 * behaviours worth protecting are the ones that span both: the step the wizard
 * thinks it is on follows the question on screen, the draft it autosaves is
 * still a plain `DiscoveryData`, and the escape hatch really does reach the
 * preview.
 *
 * The preview is stubbed — it talks to the network and it is not what is
 * under test here. No model is called anywhere in this file, and the one
 * `fetch` that survives (the recommendation refinement, on the deposit step)
 * is answered with a refusal, which is the case the deterministic
 * recommendation is supposed to survive.
 *
 * The conversation is four questions long now. Everything that used to be
 * driven through it with a chip or a panel — the industry, the page count, the
 * commerce answer, the two commercial cards — is asked after the deposit and
 * is covered in `intake-brief-questions.test.ts` against the question objects.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/locales/en';
import type { DiscoveryData } from '../discovery.logic';
import { DiscoveryWizard } from '../DiscoveryWizard';

vi.mock('../steps/PreviewStep', () => ({
  PreviewStep: () => <div data-testid="preview-stub">preview</div>,
}));

const t = (key: string): string =>
  (en as unknown as Record<string, string>)[key] ?? key;

/** A prompt as the visitor sees it, with the tokens the agent fills in. */
const said = (key: string, values: Record<string, string> = {}): string =>
  t(key).replace(
    /\{(\w+)\}/g,
    (whole, token: string) => values[token] ?? whole
  );

const originalFetch = global.fetch;

function draft(): DiscoveryData | null {
  const raw = window.sessionStorage.getItem('fs-discovery-draft-v1');
  return raw ? (JSON.parse(raw) as { data: DiscoveryData }).data : null;
}

/**
 * The agent's beat before a new question is switched off here: it is cadence,
 * not behaviour, and a walk through the four questions should not spend
 * seconds admiring it. The one test that is about the beat turns it back on.
 */
function renderWizard(paceMs = 0) {
  const onComplete = vi.fn();
  render(
    <DiscoveryWizard
      source="test"
      onComplete={onComplete}
      conversationPaceMs={paceMs}
      t={t}
    />
  );
  return { onComplete, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;

/** Types an answer into the composer and sends it, the way a visitor would. */
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

beforeEach(() => {
  window.sessionStorage.clear();
  // The recommendation route is the only thing left that would reach out.
  global.fetch = vi.fn(async () => ({
    ok: false,
    json: async () => ({}),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('the intake conversation', () => {
  it('opens as a conversation, not a form', async () => {
    renderWizard();

    expect(
      screen.getByText(t('landing.discovery.chat.intro'))
    ).toBeInTheDocument();
    expect(
      screen.getByText(t('landing.discovery.chat.q.fullName.prompt'))
    ).toBeInTheDocument();
    // One question on screen, not four labelled inputs.
    expect(
      screen.queryByText(t('landing.discovery.chat.q.email.prompt'))
    ).toBeNull();
    // And no Continue button competing with the composer.
    expect(
      screen.queryByRole('button', {
        name: t('landing.discovery.nav.continue'),
      })
    ).toBeNull();
  });

  it('groups the intro and the first question under one name and avatar', () => {
    renderWizard();

    // The intro and the opening question are two agent messages with
    // nothing between them — one run, so the agent's name and mark show
    // once, not once per bubble.
    const log = screen.getByRole('log');
    expect(
      within(log).getAllByText(t('landing.discovery.chat.agentName'))
    ).toHaveLength(1);
    expect(within(log).getAllByTestId('agent-avatar')).toHaveLength(1);
  });

  it('asks one thing at a time and keeps every answer in the transcript', async () => {
    const { user } = renderWizard();

    await say(user, 'Maria Ionescu');
    // The agent says something back before it asks the next thing.
    expect(
      await screen.findByText(
        said('landing.discovery.chat.q.fullName.reflect', { name: 'Maria' })
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(t('landing.discovery.chat.q.email.prompt'))
    ).toBeInTheDocument();

    await say(user, 'maria@example.com');
    await screen.findByText(
      said('landing.discovery.chat.q.description.prompt', {
        business: 'your business',
      })
    );

    // Everything already said is still on screen, in order.
    const log = screen.getByRole('log');
    expect(within(log).getByText('Maria Ionescu')).toBeInTheDocument();
    expect(within(log).getByText('maria@example.com')).toBeInTheDocument();
    expect(draft()).toMatchObject({
      fullName: 'Maria Ionescu',
      email: 'maria@example.com',
    });
  });

  it('refuses a malformed required answer in the agent’s own words, and does not move on', async () => {
    const { user } = renderWizard();
    await say(user, 'Maria Ionescu');

    await say(user, 'maria at example dot com');
    expect(
      await screen.findByText(t('landing.discovery.chat.errors.email'))
    ).toBeInTheDocument();
    // Still on the same question, and nothing bad was written to the draft.
    expect(
      screen.getByText(t('landing.discovery.chat.q.email.prompt'))
    ).toBeInTheDocument();
    expect(draft()?.email).toBe('');

    await say(user, 'maria@example.com');
    await screen.findByText(
      said('landing.discovery.chat.q.description.prompt', {
        business: 'your business',
      })
    );
  });

  it('files what the visitor types where the preview reads it', async () => {
    const { user } = renderWizard();
    await say(user, 'Maria Ionescu');
    await say(user, 'maria@example.com');
    await say(user, 'A dental clinic in Cluj doing cosmetic work.');

    // Still talking: what was said is in the transcript and in the pane.
    const log = screen.getByRole('log');
    expect(
      within(log).getByText('A dental clinic in Cluj doing cosmetic work.')
    ).toBeInTheDocument();
    expect(screen.getByTestId('known-so-far')).toHaveTextContent(
      'A dental clinic in Cluj doing cosmetic work.'
    );

    // One question, three fields: the last answer is taken apart by rule into
    // exactly what the preview request carries.
    await say(user, 'instagram.com/ionescudental and ionescu-dental.ro');
    await waitFor(() =>
      expect(draft()).toMatchObject({
        description: 'A dental clinic in Cluj doing cosmetic work.',
        instagramUrl: 'https://instagram.com/ionescudental',
        websiteUrl: 'https://ionescu-dental.ro',
      })
    );
    expect(await screen.findByTestId('preview-stub')).toBeInTheDocument();
  });

  it('lets the visitor correct an earlier answer, rewriting it in place', async () => {
    const { user } = renderWizard();
    await say(user, 'Maria Ionescu');
    await say(user, 'maria@example.com');
    await screen.findByText(
      said('landing.discovery.chat.q.description.prompt', {
        business: 'your business',
      })
    );

    await user.click(
      screen.getByRole('button', {
        name: `${t('landing.discovery.chat.edit')}: ${t(
          'landing.discovery.chat.q.email.prompt'
        )}`,
      })
    );
    // The old answer is waiting in the composer.
    const composer = screen.getByLabelText(
      t('landing.discovery.chat.composerLabel')
    );
    expect(composer).toHaveValue('maria@example.com');

    await say(user, 'maria@ionescudental.ro');

    const log = screen.getByRole('log');
    expect(within(log).getByText('maria@ionescudental.ro')).toBeInTheDocument();
    // Rewritten, not appended: there is one email in the transcript.
    expect(within(log).queryByText('maria@example.com')).toBeNull();
    expect(draft()?.email).toBe('maria@ionescudental.ro');
    // And the conversation picks up where it left off.
    expect(
      screen.getByText(
        said('landing.discovery.chat.q.description.prompt', {
          business: 'your business',
        })
      )
    ).toBeInTheDocument();
  });

  it('undoes the last thing said when the visitor goes back', async () => {
    const { user } = renderWizard();
    await say(user, 'Maria Ionescu');
    await screen.findByText(t('landing.discovery.chat.q.email.prompt'));

    await user.click(
      screen.getByRole('button', { name: t('landing.discovery.nav.back') })
    );
    expect(
      await screen.findByText(t('landing.discovery.chat.q.fullName.prompt'))
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(t('landing.discovery.chat.composerLabel'))
    ).toHaveValue('Maria Ionescu');
  });
});

describe('the composer', () => {
  it('sends on Enter, the way every chat the visitor already uses does', async () => {
    const { user } = renderWizard();
    const composer = screen.getByLabelText(
      t('landing.discovery.chat.composerLabel')
    );

    await user.type(composer, 'Maria Ionescu{Enter}');

    // The next question is up, and the answer landed in the transcript —
    // same outcome as clicking Send, this time from the keyboard alone.
    expect(
      await screen.findByText(t('landing.discovery.chat.q.email.prompt'))
    ).toBeInTheDocument();
    const log = screen.getByRole('log');
    expect(within(log).getByText('Maria Ionescu')).toBeInTheDocument();
  });

  it('breaks the line on Shift+Enter instead of sending', async () => {
    const { user } = renderWizard();
    const composer = screen.getByLabelText(
      t('landing.discovery.chat.composerLabel')
    );

    await user.type(composer, 'Maria{Shift>}{Enter}{/Shift}Ionescu');

    // Still on the same question — Shift+Enter did not submit.
    expect(
      screen.getByText(t('landing.discovery.chat.q.fullName.prompt'))
    ).toBeInTheDocument();
    expect(
      screen.queryByText(t('landing.discovery.chat.q.email.prompt'))
    ).toBeNull();
    // And the newline really is in the value, not swallowed.
    expect(composer).toHaveValue('Maria\nIonescu');
  });
});

describe('what makes it a conversation', () => {
  it("reads the visitor's own line back to them, chosen by rule", async () => {
    const { user } = renderWizard();
    await say(user, 'Maria Ionescu');
    await say(user, 'maria@example.com');
    await say(
      user,
      'A dental clinic in Cluj. We do cosmetic work, mostly veneers.'
    );

    const log = screen.getByRole('log');
    // Their own first sentence, word for word. No model wrote this.
    expect(
      await within(log).findByText(
        said('landing.discovery.chat.q.description.reflect', {
          quote: 'A dental clinic in Cluj',
        })
      )
    ).toBeInTheDocument();

    // Answer it again and the reaction is rewritten rather than appended: the
    // line follows the stored value, not the history.
    await user.click(
      screen.getByRole('button', {
        name: `${t('landing.discovery.chat.edit')}: ${said(
          'landing.discovery.chat.q.description.prompt',
          { business: 'your business' }
        )}`,
      })
    );
    await say(user, 'A coffee roastery in Cluj.');
    expect(
      await within(log).findByText(
        said('landing.discovery.chat.q.description.reflect', {
          quote: 'A coffee roastery in Cluj',
        })
      )
    ).toBeInTheDocument();
    expect(
      within(log).queryByText(
        said('landing.discovery.chat.q.description.reflect', {
          quote: 'A dental clinic in Cluj',
        })
      )
    ).toBeNull();
  });

  it('takes a beat before a question it has never asked, and none before one it has', async () => {
    const { user } = renderWizard(120);
    // The opening question is new too: the agent is thinking, then asks.
    expect(
      screen.getByRole('status', {
        name: t('landing.discovery.chat.thinking'),
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByText(t('landing.discovery.chat.q.fullName.prompt'))
    ).toBeNull();
    expect(
      await screen.findByText(t('landing.discovery.chat.q.fullName.prompt'))
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('status', {
        name: t('landing.discovery.chat.thinking'),
      })
    ).toBeNull();

    await say(user, 'Maria Ionescu');
    expect(
      screen.getByRole('status', { name: t('landing.discovery.chat.thinking') })
    ).toBeInTheDocument();
    await screen.findByText(t('landing.discovery.chat.q.email.prompt'));

    // Back to a familiar question: no beat.
    await user.click(
      screen.getByRole('button', { name: t('landing.discovery.nav.back') })
    );
    expect(
      screen.getByText(t('landing.discovery.chat.q.fullName.prompt'))
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('status', {
        name: t('landing.discovery.chat.thinking'),
      })
    ).toBeNull();
  });

  // The lettered quick replies and the typed-word-to-a-chip matching live on
  // `choice` questions, and every one of those moved behind the deposit. The
  // mechanisms are covered in `intake-brief-questions.test.ts`; what the
  // pre-preview conversation still has is the composer, and the question
  // below is the one it corrects hardest.
  it('refuses a line with nothing to look at, then takes any one of the three kinds', async () => {
    const { user } = renderWizard();
    await say(user, 'Maria Ionescu');
    await say(user, 'maria@example.com');
    await say(user, 'A dental clinic in Cluj doing cosmetic work.');
    await screen.findByText(t('landing.discovery.chat.q.links.prompt'));

    await say(user, 'I do not have anything online');
    expect(
      await screen.findByText(t('landing.discovery.chat.errors.links'))
    ).toBeInTheDocument();
    // Still on the same question: a preview built without a profile is a grey
    // template with the right words on it.
    expect(
      screen.getByText(t('landing.discovery.chat.q.links.prompt'))
    ).toBeInTheDocument();
    expect(draft()?.instagramUrl).toBe('');

    await say(user, 'ionescu-dental.ro');
    await waitFor(() =>
      expect(draft()?.websiteUrl).toBe('https://ionescu-dental.ro')
    );
  });

  it('draws its progress from the wizard-level stepper, not a bar of its own', () => {
    renderWizard();
    // The stepper above the conversation owns the progress bar now; the
    // scripted conversation itself still draws none inside its own tree.
    expect(screen.getByTestId('discovery-stepper')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });
});

describe('no way past the required questions', () => {
  it('has no skip-ahead affordance on screen', () => {
    renderWizard();
    expect(
      screen.queryByRole('button', { name: /skip ahead/i })
    ).not.toBeInTheDocument();
  });

  it('offers no skip at all, because every one of the four is required', async () => {
    const { user } = renderWizard();
    const skip = () =>
      screen.queryByRole('button', { name: t('landing.discovery.chat.skip') });

    await screen.findByText(t('landing.discovery.chat.q.fullName.prompt'));
    expect(skip()).toBeNull();

    await say(user, 'Maria Ionescu');
    await screen.findByText(t('landing.discovery.chat.q.email.prompt'));
    expect(skip()).toBeNull();

    await say(user, 'maria@example.com');
    await screen.findByText(
      said('landing.discovery.chat.q.description.prompt', {
        business: 'your business',
      })
    );
    expect(skip()).toBeNull();

    // The link is the one that used to be skippable, and is not any more: it
    // is the only answer that carries a colour, a face and a voice.
    await say(user, 'A dental clinic in Cluj doing cosmetic work.');
    await screen.findByText(t('landing.discovery.chat.q.links.prompt'));
    expect(skip()).toBeNull();
    expect(draft()?.businessName).toBe('');
  });
});

/**
 * The preview first, and the money against it.
 *
 * The two commercial decisions used to be the last two turns of the
 * conversation, in front of a preview nobody had seen. They are the wizard's
 * own deposit step now, after the preview, because a price shown before there
 * is anything to price is a number the visitor has no way to judge. What has
 * not changed is that `canProceed` is the gate, not the screen.
 */
describe('the deposit, once there is a preview to price', () => {
  it('reaches the preview in four answers and gates the deposit behind a plan', async () => {
    const { user } = renderWizard();

    await say(user, 'Maria Ionescu');
    await say(user, 'maria@example.com');
    await say(user, 'A dental clinic in Cluj doing cosmetic work.');
    await say(user, 'instagram.com/ionescudental');

    // The script is spent, so the preview is what comes next — not a
    // seventeenth question, and not a price.
    expect(await screen.findByTestId('preview-stub')).toBeInTheDocument();
    expect(
      screen.queryByLabelText(t('landing.discovery.chat.composerLabel'))
    ).toBeNull();

    await user.click(
      screen.getByRole('button', { name: t('landing.discovery.nav.continue') })
    );
    expect(
      await screen.findByText(t('landing.discovery.steps.deposit.title'))
    ).toBeInTheDocument();
    // The build package is recommended by rule, so it is already filed.
    await waitFor(() => expect(draft()?.selectedTier).toBeTruthy());

    // The monthly plan is a separate decision, and the wizard will not move
    // until it is made.
    const submit = screen.getByRole('button', {
      name: t('landing.discovery.nav.saveAndBook'),
    });
    expect(submit).toBeDisabled();

    // The Pro card, named by the one line only it carries.
    await user.click(
      screen.getByRole('button', { name: /Manual model picker included/ })
    );
    await waitFor(() => expect(submit).toBeEnabled());
    expect(draft()?.subscription).toBe('pro');
  });
});

/**
 * The preview pane beside the conversation. Its shape is covered by
 * `preview-skeleton.test.ts` and `IntakePreviewPane.test.tsx`; what needs the
 * whole wizard is the wiring -- that an answer typed into the conversation
 * reaches the skeleton, and that the fact list's pencil really does send the
 * conversation back to that question rather than only looking like it does.
 */
describe('the preview beside the conversation', () => {
  it('is on screen from the first question', () => {
    renderWizard();
    expect(screen.getByTestId('intake-preview-pane')).toBeInTheDocument();
    expect(screen.getByTestId('known-so-far')).toBeInTheDocument();
  });

  it('fills the fact list as the answers land', async () => {
    const { user } = renderWizard();
    const facts = () => screen.getByTestId('known-so-far');

    await say(user, 'Ana');
    await waitFor(() => expect(facts()).toHaveTextContent('Ana'));

    await say(user, 'ana@sablefig.ro');
    await say(user, 'We roast single origin coffee.');
    await waitFor(() =>
      expect(facts()).toHaveTextContent('We roast single origin coffee.')
    );

    // The business name is not asked before the preview any more, so the
    // skeleton stays honestly unnamed rather than inventing one.
    expect(screen.queryByTestId('preview-hero-name')).toBeNull();
    expect(screen.queryByTestId('preview-header-name')).toBeNull();
  });

  it('reshapes the skeleton from the sentence the visitor writes', async () => {
    const { user } = renderWizard();
    await say(user, 'Ana');
    await say(user, 'ana@sablefig.ro');

    const sections = () =>
      screen.getByTestId('derived-site-skeleton').dataset.sections ?? '';
    expect(sections()).toContain('services');

    // The industry chips are behind the deposit now. The shape comes from
    // their own words instead, by rule, and lands in the same vocabulary.
    await say(user, 'We roast and serve single origin coffee.');
    await waitFor(() => expect(sections()).toContain('menu'));
    expect(sections()).not.toContain('services');
  });

  it('sends the conversation back to a question when its pencil is pressed', async () => {
    const { user } = renderWizard();
    await say(user, 'Ana');
    await say(user, 'ana@sablefig.ro');
    await say(user, 'We roast single origin coffee.');

    // The agent has moved on to the links.
    expect(
      await screen.findByText(t('landing.discovery.chat.q.links.prompt'))
    ).toBeInTheDocument();

    const facts = screen.getByTestId('known-so-far');
    await user.click(
      within(facts).getByRole('button', {
        name: `${t('landing.discovery.chat.edit')}: ${t(
          'landing.discovery.preview.pane.factDoes'
        )}`,
      })
    );

    // Back on the description, with the old answer waiting in the composer.
    await waitFor(() =>
      expect(
        screen.getByLabelText(t('landing.discovery.chat.composerLabel'))
      ).toHaveValue('We roast single origin coffee.')
    );

    // Answering again moves the conversation forward, not sideways: the
    // skeleton follows the new sentence.
    await say(user, 'A dental clinic in Cluj doing cosmetic work.');
    await waitFor(() =>
      expect(
        screen.getByTestId('derived-site-skeleton').dataset.sections ?? ''
      ).toContain('booking')
    );
  });

  it('offers no pencil for a question the visitor has not answered yet', () => {
    renderWizard();
    const facts = screen.getByTestId('known-so-far');
    expect(within(facts).queryAllByRole('button')).toHaveLength(0);
  });
});
