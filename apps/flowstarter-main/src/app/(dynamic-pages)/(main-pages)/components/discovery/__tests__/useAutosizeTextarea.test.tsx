/**
 * `useAutosizeTextarea`: the intake composer's own line-growth. jsdom has no
 * real layout engine, so `scrollHeight` never reflects wrapped text the way
 * a browser's would — it is stubbed here to whatever height a given amount
 * of "content" would produce, and the hook is checked against that, not
 * against real wrapping.
 */
import { render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAutosizeTextarea } from '../useAutosizeTextarea';

const LINE_HEIGHT = 20; // px, one line of text-sm
const PADDING = 10; // px, top and bottom each
const BORDER = 1; // px, top and bottom each

/** What `scrollHeight` would report for the harness's current content. Set
 *  by each test before the render/rerender that should observe it — the
 *  hook only ever reads it, it never drives the harness's own layout. */
let mockScrollHeight = LINE_HEIGHT + PADDING * 2;

function oneLineHeight(): string {
  return `${LINE_HEIGHT + PADDING * 2 + BORDER * 2}px`;
}

function Harness({ value, maxRows }: { value: string; maxRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutosizeTextarea(ref, value, { maxRows });
  return (
    <textarea
      ref={ref}
      readOnly
      value={value}
      style={{
        lineHeight: `${LINE_HEIGHT}px`,
        paddingTop: `${PADDING}px`,
        paddingBottom: `${PADDING}px`,
        borderTopWidth: `${BORDER}px`,
        borderBottomWidth: `${BORDER}px`,
        borderStyle: 'solid',
      }}
    />
  );
}

beforeEach(() => {
  mockScrollHeight = LINE_HEIGHT + PADDING * 2;
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => mockScrollHeight,
  });
});

afterEach(() => {
  delete (HTMLTextAreaElement.prototype as { scrollHeight?: unknown })
    .scrollHeight;
});

describe('useAutosizeTextarea', () => {
  it('is one line tall at rest', () => {
    const { getByRole } = render(<Harness value="" />);
    const el = getByRole('textbox') as HTMLTextAreaElement;
    expect(el.style.height).toBe(oneLineHeight());
    expect(el.style.overflowY).toBe('hidden');
  });

  it('grows with content', () => {
    const { getByRole, rerender } = render(<Harness value="" />);
    const el = getByRole('textbox') as HTMLTextAreaElement;

    mockScrollHeight = LINE_HEIGHT * 3 + PADDING * 2; // three lines
    rerender(<Harness value={'one\ntwo\nthree'} />);

    expect(el.style.height).toBe(
      `${LINE_HEIGHT * 3 + PADDING * 2 + BORDER * 2}px`
    );
    expect(el.style.overflowY).toBe('hidden');
  });

  it('caps at maxRows and scrolls past it', () => {
    const { getByRole, rerender } = render(<Harness value="" maxRows={6} />);
    const el = getByRole('textbox') as HTMLTextAreaElement;

    // Ten lines' worth of content — well past the six-line cap.
    mockScrollHeight = LINE_HEIGHT * 10 + PADDING * 2;
    rerender(<Harness value={'line\n'.repeat(10)} maxRows={6} />);

    const cappedHeight = LINE_HEIGHT * 6 + PADDING * 2 + BORDER * 2;
    expect(el.style.height).toBe(`${cappedHeight}px`);
    expect(el.style.overflowY).toBe('auto');
  });

  it('resets to one line once the content is cleared', () => {
    const { getByRole, rerender } = render(<Harness value="" maxRows={6} />);
    const el = getByRole('textbox') as HTMLTextAreaElement;

    mockScrollHeight = LINE_HEIGHT * 10 + PADDING * 2;
    rerender(<Harness value={'line\n'.repeat(10)} maxRows={6} />);
    expect(el.style.overflowY).toBe('auto');

    // The composer clears after sending — a real browser would remeasure a
    // one-line `scrollHeight` once the value (and thus the wrapped content)
    // is gone; the stub mirrors that rather than asserting on it.
    mockScrollHeight = LINE_HEIGHT + PADDING * 2;
    rerender(<Harness value="" maxRows={6} />);

    expect(el.style.height).toBe(oneLineHeight());
    expect(el.style.overflowY).toBe('hidden');
  });
});
