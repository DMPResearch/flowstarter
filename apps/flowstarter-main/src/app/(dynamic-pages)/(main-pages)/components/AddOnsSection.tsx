const ADDONS = [
  { label: 'Logo Design', price: 'EUR 250' },
  { label: 'Copywriting', price: 'from EUR 150/page' },
  { label: 'CRM Integration', price: 'EUR 200' },
  { label: 'Multi-language', price: 'from EUR 400' },
  { label: 'Migration from existing site', price: 'from EUR 300' },
  { label: 'Additional pages', price: 'EUR 80/page' },
  { label: 'Custom integrations', price: 'quoted individually' },
];

export function AddOnsSection() {
  return (
    <section id="add-ons" className="ls-scope ls-section ls-section--pad">
      <div className="ls-mesh" aria-hidden />
      <div className="ls-grain" aria-hidden />
      <div className="ls-container">
        <div className="mx-auto max-w-3xl text-center">
          <div className="ls-eyebrow inline-flex items-center justify-center gap-3">
            <span className="num">07</span>
            <span>Add-ons catalog</span>
          </div>
          <h2 className="ls-display mt-7">
            <span className="line">Add only what you need.</span>
            <span className="line flourish mt-2">
              Fixed pricing, no surprises.
            </span>
          </h2>
        </div>

        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ADDONS.map((item) => (
            <article key={item.label} className="ls-card p-6">
              <h3 className="text-[1.01rem] font-semibold text-[var(--ls-ink)]">
                {item.label}
              </h3>
              <p className="mt-2 text-sm text-[var(--ls-ink-dim)]">
                {item.price}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
