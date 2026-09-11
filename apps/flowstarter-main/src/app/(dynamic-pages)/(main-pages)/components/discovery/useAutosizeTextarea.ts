'use client';

/**
 * Grows the intake composer with what is typed into it: one line tall at
 * rest, taller as the visitor writes, capped at `maxRows` and scrolling past
 * that rather than pushing the log off screen. No dependency — just the
 * textarea's own `scrollHeight`, read after collapsing the element back to
 * `auto` so a shrink (backspace, the reset to an empty composer after
 * sending) is measured too, not only a grow.
 *
 * `useLayoutEffect`, not `useEffect`: the resize has to land before the
 * browser paints, or a fast typist sees a one-frame jump every time the
 * field crosses a line.
 */
import { useLayoutEffect, type RefObject } from 'react';

export interface UseAutosizeTextareaOptions {
  /** How many lines the field may grow to before it scrolls instead. */
  maxRows?: number;
}

const DEFAULT_MAX_ROWS = 6;

export function useAutosizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  { maxRows = DEFAULT_MAX_ROWS }: UseAutosizeTextareaOptions = {}
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const style = window.getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const borderBottom = parseFloat(style.borderBottomWidth) || 0;
    const border = borderTop + borderBottom;

    // Collapse first: with a stale height still set, `scrollHeight` never
    // reports a value smaller than that height, so a shrink would never be
    // seen — the field would grow but never come back down.
    el.style.height = 'auto';

    const maxContent = lineHeight * maxRows + paddingTop + paddingBottom;
    const nextContent = Math.min(el.scrollHeight, maxContent);
    // `scrollHeight` excludes the border; `style.height` is border-box
    // (Tailwind's preflight), so the border has to be added back on top.
    el.style.height = `${nextContent + border}px`;
    el.style.overflowY = el.scrollHeight > maxContent ? 'auto' : 'hidden';
  }, [ref, value, maxRows]);
}
