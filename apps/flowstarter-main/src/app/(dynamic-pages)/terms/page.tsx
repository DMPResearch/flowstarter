import { MarketingShell, PageHero, ProseSection } from '@/components/marketing';

export const metadata = {
  title: 'Terms of Service',
  description:
    'The agreement between you and Flowstarter for the design, build, and ongoing support of your site.',
};

const LAST_UPDATED = 'February 27, 2026';

export default function TermsPage() {
  return (
    <MarketingShell>
      <main id="main-content" className="flex-1">
        <PageHero
          eyebrow="Terms"
          headlinePrefix="The agreement,"
          headlineFlourish="in plain English."
          sub="A short, readable contract between you and Flowstarter. The legalese sits inside individual scopes of work; this page is the framework."
          meta={
            <span className="ls-page-meta">
              <span>Last updated</span>
              <span className="dot" aria-hidden="true" />
              <span>{LAST_UPDATED}</span>
            </span>
          }
        />

        <ProseSection>
          <h2>What you are agreeing to</h2>
          <p>
            By booking a discovery call, signing a scope of work, or paying an
            invoice, you accept these terms. They cover everything we do for you
            including design, build, hosting, smart editor access, and ongoing
            support. Specific deliverables, prices, and timelines live in the
            scope of work we agree on together.
          </p>

          <h2>What we provide</h2>
          <ul>
            <li>
              A hand-crafted website, built by Darius and Dorin with AI as our
              assistant.
            </li>
            <li>
              Hosting on EU infrastructure, automated backups, SSL, and uptime
              monitoring.
            </li>
            <li>
              Access to the smart editor. Your monthly plan covers a fixed
              allowance of AI edits. Add-on packs are available.
            </li>
            <li>
              Ongoing support via email and your discovery-call number, with
              response targets defined per plan.
            </li>
          </ul>

          <h2>What we expect from you</h2>
          <ul>
            <li>
              Timely feedback during design and build. Long pauses on your side
              may shift the agreed launch date.
            </li>
            <li>
              Accurate ownership of the copy, images, and assets you provide.
              You are responsible for licensing rights to anything you upload.
            </li>
            <li>
              Lawful use. We do not host content that promotes illegal activity,
              hate, or fraud.
            </li>
          </ul>

          <h2>Pricing, invoicing, and refunds</h2>
          <p>
            Setup fees are split: 20% to start, 80% on launch. Monthly or yearly
            care fees are billed in advance and renew automatically until
            cancelled. Your first month is free. If you are not happy with the
            result within 30 days of launch, we refund 50% of the setup fee, no
            questions asked.
          </p>

          <h2>Ownership and portability</h2>
          <p>
            Your domain stays in your name. Your content stays yours. On request
            we will hand over a static export of your site so you can move it
            elsewhere. We do not hold your business hostage.
          </p>

          <h2>Confidentiality</h2>
          <p>
            We treat anything we learn about your business (strategy, pricing,
            customer lists) as confidential. We will not share it with anyone,
            including future clients in your industry, without your explicit
            permission.
          </p>

          <h2>Liability</h2>
          <p>
            Our total liability under this agreement is limited to the amount
            you paid us in the previous twelve months. We do not provide a
            warranty against indirect or consequential losses (e.g. lost
            revenue) caused by downtime or third-party providers.
          </p>

          <h2>Cancellation</h2>
          <p>
            You can cancel your monthly plan at any time with 30 days notice by
            emailing{' '}
            <a href="mailto:hello@flowstarter.net">hello@flowstarter.net</a>.
            Your site stays online through the end of the paid period. If you
            need us to keep your site live afterwards, we can quote a standalone
            hosting fee.
          </p>

          <h2>Governing law</h2>
          <p>
            This agreement is governed by the laws of Romania, where Flowstarter
            is registered. Disputes are first attempted in good faith over a
            call, and if unresolved, settled by the courts of Cluj-Napoca.
          </p>

          <h2>Updates to these terms</h2>
          <p>
            We rewrite this page whenever we change the way we work. Material
            updates are announced by email to active clients at least 14 days
            before they take effect.
          </p>

          <div className="ls-callout">
            <p>
              Questions about a clause? Write to{' '}
              <a href="mailto:hello@flowstarter.net">hello@flowstarter.net</a>{' '}
              and we will walk you through it before you sign.
            </p>
          </div>
        </ProseSection>
      </main>
    </MarketingShell>
  );
}
