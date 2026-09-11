/**
 * Small mono caption rendered at the top of every legal page. Signals to
 * readers (and to ourselves) that the prose below describes our current
 * operating practice and is binding on us, but may be tightened by counsel
 * before public launch.
 */
export function LegalDraftNotice() {
  return (
    <div className="ls-callout" role="note" aria-label="Draft notice">
      <p
        style={{
          fontFamily: 'var(--ls-mono)',
          fontSize: '11px',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--ls-ink-faint)',
        }}
      >
        Draft: under legal review
      </p>
      <p style={{ marginTop: '0.6rem' }}>
        The terms below describe our current operating practice and are binding
        on us. Final wording may be tightened by counsel before our public
        launch.
      </p>
    </div>
  );
}
