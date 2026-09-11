import {
  LegalDraftNotice,
  MarketingShell,
  PageHero,
  ProseSection,
} from '@/components/marketing';

export const metadata = {
  title: 'Privacy Policy',
  description:
    'How Flowstarter collects, uses, and protects your data. GDPR-aligned, plain-English, with a full list of subprocessors.',
};

const LAST_UPDATED = 'May 2026';

export default function PrivacyPage() {
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
          <LegalDraftNotice />

          <h2>1. Who we are</h2>
          <p>
            Flowstarter is operated by Darius and Dorin, a two-person studio
            registered in the European Union. We act as the{' '}
            <strong>data controller</strong> for the marketing site
            (flowstarter.net) and as the <strong>data processor</strong> for the
            client sites and dashboards we build and host on your behalf. For
            all data-protection questions, write to{' '}
            <a href="mailto:privacy@flowstarter.net">privacy@flowstarter.net</a>
            .
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
              <strong>Discovery-call submissions</strong>: the goals, business
              details, and current-site URL you share when booking a free call.
            </li>
            <li>
              <strong>Site usage</strong>: anonymised analytics events such as
              page views, referrers, and aggregated device class. No cross-site
              tracking.
            </li>
            <li>
              <strong>Uploaded content</strong>: copy, images, logos, and brand
              assets you (or your team) upload to your project. Stored encrypted
              at rest.
            </li>
            <li>
              <strong>Cookies</strong>: a small number of strictly necessary
              cookies for auth and theme preference. Details on the{' '}
              <a href="/cookies">cookie page</a>.
            </li>
          </ul>

          <h2>3. How we use your data</h2>
          <ul>
            <li>
              <strong>Service delivery</strong>, scheduling calls, building your
              site, hosting it, providing the smart editor, and responding to
              support.
            </li>
            <li>
              <strong>Billing</strong>: generating invoices, processing
              payments, and meeting our tax obligations.
            </li>
            <li>
              <strong>Transactional email</strong>: confirmations, project
              updates, security alerts, and renewal notices.
            </li>
            <li>
              <strong>Product improvement</strong>: aggregated, de-identified
              analytics used to improve the editor and the marketing site.
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
              <strong>Legitimate interest</strong>: for aggregated analytics,
              security monitoring, and fraud prevention.
            </li>
            <li>
              <strong>Legal obligation</strong>: for tax and accounting records.
            </li>
            <li>
              <strong>Consent</strong>: for marketing email and any optional
              analytics or functional cookies.
            </li>
          </ul>

          <h2>5. Subprocessors we share data with</h2>
          <p>
            We use a small, vetted set of subprocessors. Each one has signed a
            data-processing agreement with us covering Article 28 GDPR
            requirements. The current list:
          </p>
          <ul>
            <li>
              <strong>Clerk</strong> (US, EU SCCs): authentication and session
              management.
            </li>
            <li>
              <strong>Supabase</strong> (EU region): primary database and file
              storage for client projects.
            </li>
            <li>
              <strong>Hetzner</strong> (Germany / Finland): application hosting
              and customer-site servers.
            </li>
            <li>
              <strong>Cloudflare</strong> (US, EU SCCs): DNS, edge CDN, and DDoS
              protection.
            </li>
            <li>
              <strong>Stripe</strong> (Ireland): payments, invoicing, and tax
              calculation.
            </li>
            <li>
              <strong>Resend</strong> (US, EU SCCs): transactional email
              delivery.
            </li>
            <li>
              <strong>Calendly</strong> (US, EU SCCs): discovery-call
              scheduling.
            </li>
            <li>
              <strong>Plausible</strong> (EU): privacy-friendly, cookie-less
              analytics for flowstarter.net.
            </li>
          </ul>
          <p>
            We update this list before adding any new subprocessor. If you need
            an export for procurement, email{' '}
            <a href="mailto:legal@flowstarter.net">legal@flowstarter.net</a>.
          </p>

          <h2>6. International transfers</h2>
          <p>
            All production hosting lives in the European Union (Hetzner DE/FI,
            Supabase EU). A handful of subprocessors are headquartered in the
            United States (Clerk, Cloudflare, Stripe, Resend, Calendly). Each of
            those transfers is covered by the European Commission&apos;s{' '}
            <strong>Standard Contractual Clauses</strong>, and where applicable,
            by the EU&ndash;US Data Privacy Framework.
          </p>

          <h2>7. Retention</h2>
          <ul>
            <li>
              <strong>Account data</strong>: kept for the lifetime of the
              account, then deleted 30 days after closure.
            </li>
            <li>
              <strong>Uploaded site assets</strong>: kept until you delete them,
              or 30 days after account closure.
            </li>
            <li>
              <strong>Analytics events</strong>: retained for 12 months.
            </li>
            <li>
              <strong>Billing and invoices</strong>: retained for 7 years to
              meet EU tax-record obligations.
            </li>
            <li>
              <strong>Email logs</strong>: retained for 30 days for
              deliverability troubleshooting.
            </li>
          </ul>

          <h2>8. Your rights under GDPR</h2>
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
              legal-retention obligations.
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
          <p>
            To exercise any of these rights, email{' '}
            <a href="mailto:privacy@flowstarter.net">privacy@flowstarter.net</a>
            . We verify the request and respond within 30 days.
          </p>

          <h2>9. Children</h2>
          <p>
            Flowstarter is not intended for anyone under the age of 16. We do
            not knowingly collect data from children. If you believe a child has
            submitted data to us, contact{' '}
            <a href="mailto:privacy@flowstarter.net">privacy@flowstarter.net</a>{' '}
            and we will delete it.
          </p>

          <h2>10. Changes to this policy</h2>
          <p>
            We update this page whenever our practices change. Material changes
            are announced by email to active clients at least 14 days before
            they take effect. The &ldquo;last updated&rdquo; date at the top of
            this page always reflects the latest revision.
          </p>

          <div className="ls-callout">
            <p>
              Questions about privacy? Write to{' '}
              <a href="mailto:privacy@flowstarter.net">
                privacy@flowstarter.net
              </a>
              . Need a signed data-processing agreement? Email us at the same
              address and we&apos;ll send one over.
            </p>
          </div>
        </ProseSection>
      </main>
    </MarketingShell>
  );
}
