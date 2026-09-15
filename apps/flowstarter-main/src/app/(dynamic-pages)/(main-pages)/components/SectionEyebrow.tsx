/**
 * The section eyebrow, numbered when it is one of the header destinations.
 *
 * Every section that had one was drawing its own: an inline-flex with two
 * hand-written hairline spans either side of the label, repeated verbatim in
 * eight files with the rule's width and colour inlined as style props. This
 * is that mark, once. Nav destinations pass the index from `LANDING_NAV`;
 * other sections keep the masthead line without a number so they cannot
 * collide with the menu.
 *
 * Server Component: it renders text and a line, and has nothing to hydrate.
 */
export function SectionEyebrow({
  index,
  label,
  align = 'center',
}: {
  /** Two digits from `LANDING_NAV`, set in the mono face. Omit for sections
   * that are not in the header menu. */
  index?: string;
  label: string;
  align?: 'center' | 'left';
}) {
  return (
    <p
      className={`ls-eyebrow ${index ? 'ls-eyebrow--numbered' : ''} ${
        align === 'center' ? 'mx-auto' : ''
      }`}
    >
      {index ? <span className="idx">{index}</span> : null}
      {index ? <span className="rule" aria-hidden="true" /> : null}
      <span>{label}</span>
    </p>
  );
}
