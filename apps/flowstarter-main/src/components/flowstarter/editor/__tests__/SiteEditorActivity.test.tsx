/**
 * What a client watches while their change is applied.
 *
 * Before this, the only sign the agent was doing anything was a button label
 * that read "Saving…" for as long as the request took. The timeline beside
 * the proposal is built by rule from the request lifecycle -- see
 * `lib/flowstarter/activity/editor-events.ts` -- so what is worth pinning
 * here is that the rule is actually wired to the requests: the steps appear
 * when a request is made, they stop growing where a request stopped, and a
 * refusal does not leave the panel claiming work that never happened.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import en from '@/locales/en';
import type { EditorState } from '../editor-client';
import { SiteEditor } from '../SiteEditor';

const requestEditor = vi.hoisted(() => vi.fn());

vi.mock('../editor-client', async () => {
  const actual = await vi.importActual<typeof import('../editor-client')>(
    '../editor-client'
  );
  return { ...actual, requestEditor };
});

const WORKSPACE = '8f2a5a2a-2f59-4a8f-8f4e-6d2a6b6d0f11';

function initialState(): EditorState {
  return {
    site: {
      name: 'Bright Plumbing',
      version: 3,
      templateSlug: 'local-trade',
      rendersBuiltHtml: true,
    },
    targets: [
      {
        id: 'hero-title',
        key: 'hero.title',
        section: 'Hero',
        content: 'Emergency plumbing, any hour',
        file: 'src/content/site-labels.md',
        line: 12,
      },
    ],
    versions: [],
    allowance: {
      used: 0,
      cap: 10,
      maxInstructionChars: 300,
      credits: {
        tier: 'starter',
        allowance: 50,
        used: 4,
        remaining: 46,
        resetsAt: '2026-10-01T00:00:00.000Z',
        exhausted: false,
      },
    },
    policy: {
      content: { action: 'inline_content_agent', reason: '' },
      image: { action: 'client_media_upload', reason: '' },
      structural: { action: 'maintenance_request', reason: '' },
    },
  };
}

function mount() {
  return render(
    <I18nProvider initialLocale="en" initialMessages={{ en }}>
      <SiteEditor workspaceId={WORKSPACE} initial={initialState()} />
    </I18nProvider>
  );
}

/** The step labels currently drawn, in order. */
function steps(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.fs-activity__label')).map(
    (node) => node.textContent ?? ''
  );
}

async function proposeAChange(container: HTMLElement) {
  fireEvent.click(screen.getByText('Emergency plumbing, any hour'));
  fireEvent.change(container.querySelector('textarea') as HTMLTextAreaElement, {
    target: { value: 'Say we answer within the hour' },
  });
  fireEvent.click(screen.getByTestId('editor-propose'));
}

beforeEach(() => {
  requestEditor.mockReset();
});

describe('the editor activity timeline', () => {
  it('draws nothing until the client asks for a change', () => {
    const { container } = mount();
    expect(container.querySelector('.fs-activity')).toBeNull();
  });

  it('grows a step per stage the change actually passed through', async () => {
    requestEditor
      .mockResolvedValueOnce({
        targetId: 'hero-title',
        originalContent: 'Emergency plumbing, any hour',
        replacementContent: 'We answer within the hour, any hour',
        allowance: {
          used: 1,
          credits: {
            tier: 'starter',
            allowance: 50,
            used: 5,
            remaining: 45,
            resetsAt: '2026-10-01T00:00:00.000Z',
            exhausted: false,
          },
        },
      })
      .mockResolvedValueOnce({ version: 4, targets: [] })
      // `apply()` re-reads the editor state before it calls the change saved,
      // so the third call is that read.
      .mockResolvedValueOnce({
        ...initialState(),
        site: { ...initialState().site, version: 4 },
      });

    const { container } = mount();
    await proposeAChange(container);

    // The proposal is back and nothing else has happened yet: the ladder
    // stops at the write, because nothing has been checked or saved.
    await waitFor(() => {
      expect(steps(container)).toEqual([
        'Read the preview',
        'Edited the site copy',
      ]);
    });
    expect(container.querySelector('.fs-activity__spinner')).toBeNull();

    fireEvent.click(screen.getByTestId('editor-apply'));

    await waitFor(() => {
      expect(steps(container)).toEqual([
        'Read the preview',
        'Edited the site copy',
        'Checked the safe markup check',
        'Published the site',
        'Finished the site',
      ]);
    });
  });

  it('folds to a summary once the change is live', async () => {
    requestEditor
      .mockResolvedValueOnce({
        targetId: 'hero-title',
        originalContent: 'Emergency plumbing, any hour',
        replacementContent: 'We answer within the hour, any hour',
        allowance: {
          used: 1,
          credits: {
            tier: 'starter',
            allowance: 50,
            used: 5,
            remaining: 45,
            resetsAt: '2026-10-01T00:00:00.000Z',
            exhausted: false,
          },
        },
      })
      .mockResolvedValueOnce({ version: 4, targets: [] })
      // `apply()` re-reads the editor state before it calls the change saved,
      // so the third call is that read.
      .mockResolvedValueOnce({
        ...initialState(),
        site: { ...initialState().site, version: 4 },
      });

    const { container } = mount();
    await proposeAChange(container);
    await waitFor(() => expect(steps(container).length).toBe(2));
    fireEvent.click(screen.getByTestId('editor-apply'));

    await waitFor(() => {
      expect(
        screen.getByText(en['agentActivity.headline.changeDone'])
      ).toBeInTheDocument();
    });
    expect(container.querySelector('.fs-activity')).toHaveAttribute(
      'data-status',
      'done'
    );
  });

  it('stops where the refusal stopped rather than claiming a full run', async () => {
    requestEditor.mockRejectedValueOnce(new Error('nope'));

    const { container } = mount();
    await proposeAChange(container);

    await waitFor(() => {
      expect(container.querySelector('.fs-activity')).toHaveAttribute(
        'data-status',
        'failed'
      );
    });
    // One real step and the stop. Nothing was checked and nothing was saved,
    // so nothing says it was.
    expect(steps(container)).toEqual([
      'Read the preview',
      'Stopped at a quality check',
    ]);
  });
});
