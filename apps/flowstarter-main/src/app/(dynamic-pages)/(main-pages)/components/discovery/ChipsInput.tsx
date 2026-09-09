import { useState } from 'react';
import { SuggestionChips } from './steps/ConciergePanes';

/**
 * Multi-select chips with freetext. Value is a comma-joined string so it
 * drops straight into the existing string fields (goal, brandTone) and the
 * API spec / LLM prompt with no model changes. Selected = presets toggled on
 * + any freetext the user adds.
 *
 * The preset grid renders through the shared `SuggestionChips` (capped
 * height with scroll on a wide pane, a single scrollable row on a narrow
 * one) so a question with many presets can't push the composer off screen
 * the way an unbounded `flex-wrap` grid did.
 */
export function ChipsInput({
  value,
  presets,
  onChange,
  placeholder = 'Add your own…',
}: {
  value: string;
  presets: readonly string[];
  onChange: (joined: string) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');

  const selected = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const has = (v: string) =>
    selected.some((s) => s.toLowerCase() === v.toLowerCase());
  const commit = (next: string[]) => onChange(next.join(', '));

  const toggle = (v: string) =>
    commit(
      has(v)
        ? selected.filter((s) => s.toLowerCase() !== v.toLowerCase())
        : [...selected, v]
    );

  const addDraft = () => {
    const v = draft.trim();
    if (v && !has(v)) commit([...selected, v]);
    setDraft('');
  };

  // Freetext the user added that isn't one of the presets.
  const extras = selected.filter(
    (s) => !presets.some((p) => p.toLowerCase() === s.toLowerCase())
  );

  return (
    <div className="space-y-2">
      <SuggestionChips>
        {presets.map((p) => {
          const active = has(p);
          return (
            <button
              key={p}
              type="button"
              onClick={() => toggle(p)}
              className={[
                'rounded-full border px-3 py-1.5 text-sm font-semibold transition-all',
                active
                  ? 'border-[var(--purple-primary)] bg-[var(--purple-primary)]/10 text-[var(--fs-ink)] ring-1 ring-[var(--purple-primary)]'
                  : 'border-[var(--fs-rule)] text-[var(--fs-ink-faint)] hover:border-[var(--purple-primary)]/40',
              ].join(' ')}
            >
              {p}
            </button>
          );
        })}
        {extras.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => toggle(e)}
            className="rounded-full border border-[var(--purple-primary)] bg-[var(--purple-primary)]/10 px-3 py-1.5 text-sm font-semibold text-[var(--fs-ink)] ring-1 ring-[var(--purple-primary)]"
            title="Remove"
          >
            {e} ✕
          </button>
        ))}
      </SuggestionChips>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addDraft();
            }
          }}
          placeholder={placeholder}
          className="w-full rounded-lg border border-[var(--fs-rule)] bg-white px-3 py-2 text-sm text-[var(--fs-ink)] placeholder:text-[var(--fs-ink-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--purple-primary)]/30 dark:bg-white/[0.03]"
        />
        <button
          type="button"
          onClick={addDraft}
          disabled={!draft.trim()}
          className="shrink-0 rounded-lg border border-[var(--fs-rule)] px-3 py-2 text-sm font-semibold text-[var(--fs-ink)] disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  );
}
