import {
  LegalDraftNotice,
  MarketingShell,
  PageHero,
  ProseSection,
} from '@/components/marketing';
import {
  controllerIdentityLines,
  controllerSentence,
  legalDraftNoticeVisible,
  readOperatorIdentity,
} from '@/lib/legal/company';
import {
  DPA_STATEMENT,
  SUBPROCESSORS,
  subprocessorsOutsideEu,
  termsUrl,
} from '@/lib/legal/subprocessors';
import {
  DATA_REQUEST_RESPONSE_DAYS,
  ON_REQUEST_RETENTION,
  dataRequestSentence,
  enforcedRetention,
} from '@/lib/legal/retention';
import { analyticsDisclosure } from '@/lib/legal/cookies';

export const metadata = {
  title: 'Privacy Policy',
  description:
    'How Flowstarter collects, uses, and protects your data. GDPR-aligned, plain-English, with a full list of subprocessors.',
};

const LAST_UPDATED = 'September 14, 2026';

const cellStyle = {
  padding: '0.7rem 0.85rem',
  borderBottom: '1px solid var(--ls-rule)',
  fontFamily: 'var(--ls-sans)',
  fontSize: '0.9rem',
  lineHeight: 1.5,
  color: 'var(--ls-ink-dim)',
  verticalAlign: 'top' as const,
};

const headerCellStyle = {
  ...cellStyle,
  fontFamily: 'var(--ls-mono)',
  fontSize: '10.5px',
  letterSpacing: '0.18em',
  textTransform: 'uppercase' as const,
  color: 'var(--ls-ink-faint)',
  background: 'transparent',
  borderBottom: '1px solid var(--ls-rule-strong)',
  fontWeight: 500,
  textAlign: 'left' as const,
};

export default function PrivacyPage() {
  const identity = readOperatorIdentity();
  const identityLines = controllerIdentityLines(identity);
  const enforced = enforcedRetention();
  const analytics = analyticsDisclosure();
  const outsideEu = subprocessorsOutsideEu();

  return (
    <MarketingShell>
      <main id="main-content" className="flex-1">
        <PageHero
          eyebrow="Privacy"
          headlinePrefix="Your data,"
          headlineFlourish="handled with care."
          sub="We collect what we need to build, host, and support your site, and nothing more. No surveillance ad tech, no broker resale, no surprises."
          meta={
            <span className="ls-page-meta">
              <span>Last updated</span>
              <span className="dot" aria-hidden="true" />
              <span>{LAST_UPDATED}</span>
            </span>
          }
        />

        <ProseSection>
          {legalDraftNoticeVisible(identity) && <LegalDraftNotice />}

          <h2>1. Who we are</h2>
          {/* The old text said "a two-person studio registered in the European
              Union", which named no entity and no address. Article 13 wants
              the controller's identity; when there is not one to give, saying
              so is the only honest answer. */}
          <p>{controllerSentence(identity)}</p>
          {identityLines.length > 0 && (
            <ul>
              {identityLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <p>
            We act as the <strong>data controller</strong> for this marketing
            site and as the <strong>data processor</strong> for the client sites
            and dashboards we build and host on your behalf. Data-protection
            questions go through the <a href="/contact">contact page</a>.
          </p>

          <h2>2. What data we collect</h2>
          <p>
            We collect the smallest amount of data that lets us deliver the
            service safely.
          </p>
          <ul>
            <li>
              <strong>Account data</strong>: name, email, and (for paying
              clients) billing address and VAT number. Collected at sign-up and
              during invoicing.
            </li>
            <li>
              <strong>Intake answers</strong>: what you tell us about your
              business, and the public profiles you point us at, when you ask
              for a preview. This is the text your site is written from, and it
              is sent to the language-model gateway listed below.
            </li>
            <li>
              <strong>Uploaded content</strong>: copy, images, logos, and brand
              assets you (or your team) upload to your project.
            </li>
            <li>
              <strong>Cookies</strong>: a small number of cookies for sign-in,
              your theme and the country we infer. The full list is on the{' '}
              <a href="/cookies">cookie page</a>.
            </li>
          </ul>
          {/* "Site usage: anonymised analytics events" is gone. There is no
              analytics tool installed and no events table, so it described
              data this product does not hold. */}

          <h2>3. How we use your data</h2>
          <ul>
            <li>
              <strong>Service delivery</strong>: building your site, hosting it,
              providing the smart editor, and answering support.
            </li>
            <li>
              <strong>Billing</strong>: generating invoices, processing payments
              and refunds, and meeting our tax obligations.
            </li>
            <li>
              <strong>Transactional email</strong>: confirmations, project
              updates, security alerts, and renewal notices.
            </li>
            <li>
              <strong>Security</strong>: deciding whether a request to this site
              is a person, a crawler or an attack.
            </li>
            <li>
              <strong>Marketing email</strong>: only with your explicit opt-in
              consent, and only to subscribers who actively chose to receive it.
            </li>
          </ul>

          <h2>4. Legal basis (GDPR Article 6)</h2>
          <ul>
            <li>
              <strong>Contract performance</strong>: for everything we do to
              deliver and support your project.
            </li>
            <li>
              <strong>Legitimate interest</strong>: for security monitoring and
              fraud prevention.
            </li>
            <li>
              <strong>Legal obligation</strong>: for tax and accounting records.
            </li>
            <li>
              <strong>Consent</strong>: for marketing email and any optional
              cookie.
            </li>
          </ul>

          <h2>5. Analytics</h2>
          <p>{analytics.statement}</p>

          <h2>6. Subprocessors we share data with</h2>
          {/* Generated from src/lib/legal/subprocessors.ts, which is the same
              table the cookie page reads. The old hand-written list named
              Plausible (never installed) and Calendly (replaced by a
              self-hosted Cal.com) and omitted Arcjet, the language-model
              gateway, Cal.com, GitHub and Depot. A list that is wrong in both
              directions is not a disclosure. */}
          <p>
            Every third party that processes data on our behalf is below. We
            update this page before adding a new one.
          </p>

          <div
            style={{
              marginTop: '1.2rem',
              border: '1px solid var(--ls-rule)',
              borderRadius: '14px',
              overflow: 'hidden',
              background: 'var(--ls-glass-bg)',
            }}
          >
            <div style={{ overflowX: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontFamily: 'var(--ls-sans)',
                }}
              >
                <thead>
                  <tr>
                    <th style={headerCellStyle}>Who</th>
                    <th style={headerCellStyle}>What for</th>
                    <th style={headerCellStyle}>Where</th>
                    <th style={headerCellStyle}>Legal basis</th>
                    <th style={headerCellStyle}>Their terms</th>
                  </tr>
                </thead>
                <tbody>
                  {SUBPROCESSORS.map((entry, i) => {
                    const last = i === SUBPROCESSORS.length - 1;
                    const cell = last
                      ? { ...cellStyle, borderBottom: 'none' }
                      : cellStyle;
                    return (
                      <tr key={entry.name}>
                        <td style={{ ...cell, color: 'var(--ls-ink)' }}>
                          {entry.name}
                        </td>
                        <td style={cell}>{entry.purpose}</td>
                        <td style={cell}>{entry.region}</td>
                        <td style={cell}>{entry.legalBasis}</td>
                        <td
                          style={{
                            ...cell,
                            fontSize: '0.82rem',
                            wordBreak: 'break-word',
                          }}
                        >
                          {/* Parsed, not prefix-matched: see termsUrl(). A
                              row whose terms are a sentence rather than a URL
                              renders as words. */}
                          {(() => {
                            const url = termsUrl(entry.terms);
                            if (!url) return entry.terms;
                            return (
                              <a
                                href={url.href}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {`${url.hostname}${url.pathname}`.replace(
                                  /\/$/,
                                  ''
                                )}
                              </a>
                            );
                          })()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <h2>7. Data-processing agreements</h2>
          {/* The old sentence asserted eight signed DPAs. Nobody has checked
              that eight executed documents exist, and most of these vendors
              publish standing terms rather than counter-signing one. */}
          <p>{DPA_STATEMENT}</p>

          <h2>8. International transfers</h2>
          <p>
            Production hosting lives in the European Union: the servers in
            Germany and Finland, the database in the EU, and the booking
            software on our own machines.{' '}
            {outsideEu.length > 0 && (
              <>
                {outsideEu.length} of the vendors above are headquartered in the
                United States ({outsideEu.map((entry) => entry.name).join(', ')}
                ). Each of those transfers is covered by the European
                Commission&apos;s <strong>Standard Contractual Clauses</strong>,
                and where applicable, by the EU&ndash;US Data Privacy Framework.
              </>
            )}
          </p>

          <h2>9. How long we keep things</h2>
          {/* This section used to publish five retention periods as if a job
              enforced them. None did: there is no deletion job for account
              data, no analytics table, no billing pruning and no email log
              table at all. Two of the five described data this product does
              not hold. What follows is split into what a job does and what a
              person does, and the windows below are read from the same
              environment variables the jobs read. */}
          <p>
            Two things are deleted on a timer by a job that runs against our own
            database.
          </p>
          <ul>
            {enforced.map((entry) => (
              <li key={entry.subject}>
                <strong>{entry.subject}</strong>: deleted {entry.window} after
                it is made, by {entry.enforcedBy}.
              </li>
            ))}
          </ul>
          <p>
            Everything else we hold for as long as it is useful to your project,
            and delete when you ask. We would rather tell you that than print a
            number nothing in the product counts.
          </p>
          <ul>
            {ON_REQUEST_RETENTION.map((entry) => (
              <li key={entry.subject}>
                <strong>{entry.subject}</strong>: {entry.reason}
              </li>
            ))}
          </ul>

          <h2>10. Your rights under GDPR</h2>
          <p>You have the right to:</p>
          <ul>
            <li>
              <strong>Access</strong>: request a copy of the personal data we
              hold about you.
            </li>
            <li>
              <strong>Rectification</strong>: correct any inaccurate or
              incomplete data.
            </li>
            <li>
              <strong>Erasure</strong>: ask us to delete your data, subject to
              the tax-record obligation above.
            </li>
            <li>
              <strong>Portability</strong>: receive your data in a
              machine-readable format.
            </li>
            <li>
              <strong>Objection</strong>: object to processing based on
              legitimate interest.
            </li>
            <li>
              <strong>Restriction</strong>: limit how we process your data while
              a query is being resolved.
            </li>
            <li>
              <strong>Complaint</strong>: lodge a complaint with your national
              data-protection authority.
            </li>
          </ul>
          <p>{dataRequestSentence()}</p>

          <h2>11. Children</h2>
          <p>
            Flowstarter is not intended for anyone under the age of 16. We do
            not knowingly collect data from children. If you believe a child has
            submitted data to us, tell us on the{' '}
            <a href="/contact">contact page</a> and we will delete it.
          </p>

          <h2>12. Changes to this policy</h2>
          <p>
            We update this page whenever our practices change. Material changes
            are announced by email to active clients at least 14 days before
            they take effect. The &ldquo;last updated&rdquo; date at the top of
            this page always reflects the latest revision.
          </p>

          <div className="ls-callout">
            <p>
              Questions about privacy, or a request about your own data? The{' '}
              <a href="/contact">contact page</a> is the route, and we answer
              within {DATA_REQUEST_RESPONSE_DAYS} days. Need a data-processing
              agreement from us for your own records? Ask there and we will send
              one.
            </p>
          </div>
        </ProseSection>
      </main>
    </MarketingShell>
  );
}
