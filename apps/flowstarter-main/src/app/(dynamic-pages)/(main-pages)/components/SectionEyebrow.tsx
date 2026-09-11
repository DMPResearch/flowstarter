/**
 * The section eyebrow, numbered.
 *
 * Every section that had one was drawing its own: an inline-flex with two
 * hand-written hairline spans either side of the label, repeated verbatim in
 * eight files with the rule's width and colour inlined as style props. This
 * is that mark, once, with the index the sections never had.
 *
 * The index is the editorial part. A reader who lands mid-page can tell where
 * they are in the argument, and the mono numeral against the sans label is
 * the one place on this page where the two faces meet, which is what gives
 * the line its masthead feel. The rule after it ties the pair together.
 *
 * Server Component: it renders text and a line, and has nothing to hydrate.
 */
export function SectionEyebrow({
  index,
  label,
  align = 'center',
}: {
  /** Two digits, set in the mono face. The section's place in the argument. */
  index: string;
  label: string;
  align?: 'center' | 'left';
}) {
  return (
    <p
      className={`ls-eyebrow ls-eyebrow--numbered ${
        align === 'center' ? 'mx-auto' : ''
      }`}
    >
      <span className="idx">{index}</span>
      <span className="rule" aria-hidden="true" />
      <span>{label}</span>
    </p>
  );
}
