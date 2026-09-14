import {
  LegalDraftNotice,
  MarketingShell,
  PageHero,
  ProseSection,
} from '@/components/marketing';
import { guaranteeSentence } from '@/lib/billing/refund-policy';
import {
  controllerIdentityLines,
  governingLawSentence,
  legalDraftNoticeVisible,
  OPERATOR_IDENTITY_PENDING_NOTICE,
  readOperatorIdentity,
} from '@/lib/legal/company';
import { PROHIBITED_CATEGORIES } from '@/lib/policy/acceptable-use';

/**
 * The list on this page is the list the gate enforces, read from the same
 * module. A terms page that is written by hand drifts from the code within a
 * quarter, and the version a client can point at has to be the version that
 * actually stopped their project.
 */
const ACCEPTABLE_USE_SECTION = PROHIBITED_CATEGORIES;

export const metadata = {
  title: 'Terms of Service',
  description:
    'The agreement between you and Flowstarter for the design, build, and ongoing support of your site.',
};

const LAST_UPDATED = 'September 14, 2026';

export default function TermsPage() {
  // Read here rather than written below: who we are, what law applies and
  // which court hears a dispute are facts the environment supplies, and
  // until it does this page says so instead of naming a country. See
  // src/lib/legal/company.ts.
  const identity = readOperatorIdentity();
  const identityLines = controllerIdentityLines(identity);

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
          {/* On terms too, now. It used to show on privacy and cookies and
              not here, which is backwards: this page is the contract and the
              other two are disclosures. One rule decides all three. */}
          {legalDraftNoticeVisible(identity) && <LegalDraftNotice />}

          <h2>Who you are agreeing with</h2>
          {identity.provided ? (
            <>
              <p>Flowstarter is operated by {identity.identity.name}.</p>
              <ul>
                {identityLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>
              <strong>{OPERATOR_IDENTITY_PENDING_NOTICE}.</strong> Flowstarter
              is run by two people, Darius and Dorin, and is not incorporated
              yet. There is no registered company name, no registration number,
              no VAT number and no registered address to give you, so this page
              does not print any. All four appear here on the day there are any.
              Until then you are contracting with the two of us, and the{' '}
              <a href="/contact">contact page</a> reaches us.
            </p>
          )}

          <h2>What you are agreeing to</h2>
          <p>
            By starting a project, signing a scope of work, or paying an
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
              Hosting on EU infrastructure, with a TLS certificate kept renewed
              for as long as we host you.
            </li>
            <li>
              Access to the smart editor. Your monthly plan covers a fixed
              allowance of AI edits.
            </li>
            <li>
              Ongoing support by email, with response targets defined per plan.
            </li>
          </ul>
          {/* Removed, not softened: the old list promised "automated backups
              ... and uptime monitoring". Neither exists. A contract is the
              wrong place to describe infrastructure we have not built. */}

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
              hate, or fraud. The next section says exactly what that means.
            </li>
          </ul>

          <h2 id="acceptable-use">Acceptable use</h2>
          <p>
            {/* "in Romania" removed on the legal-pages branch: this page's
                own identity section says there is no registered entity yet
                and declines to name a country, so a sentence four screens
                below it cannot assert one. The reason holds without it. */}
            There are businesses we will not build a site for. This is not a
            judgement on anyone; it is the licensing, payment and legal exposure
            a two-person studio is not equipped to carry. We would rather tell
            you now than after you have paid.
          </p>
          <p>We do not build sites whose purpose is any of the following.</p>
          <ul>
            {ACCEPTABLE_USE_SECTION.map((category) => (
              <li key={category.id}>
                <strong>{category.label}.</strong> {category.reason}
              </li>
            ))}
          </ul>
          <p>
            Plenty of lawful businesses sit close to that list: a pharmacy, a
            dispensary where cannabis is legal, a firearms training school, a
            sexual health clinic, a licensed bookmaker, a lingerie shop. Those
            are ordinary work. Where our checks cannot tell the difference on
            their own, one of us reads it and comes back to you, usually the
            same working day. Nothing is charged while a project is waiting for
            that answer.
          </p>
          <p>
            We check twice: once when you describe your business, and once on
            the finished site before it goes live. If we stop a project we tell
            you which part of this section it fell under, and if we have read
            you wrong you can{' '}
            <a href="/contact">tell us what you actually do</a> and a person
            will look at it.
          </p>

          <h2>Pricing, invoicing, and refunds</h2>
          <p>
            Setup fees are split: 20% to start, 80% on launch. Monthly or yearly
            care fees are billed in advance and renew automatically until
            cancelled. Your first month is free. {guaranteeSentence()}
          </p>
          {/* The sentence above is generated from the same config the refund
              action reads, so the promise on this page and the amount the
              button is allowed to send cannot drift apart. See
              src/lib/billing/refund-policy.ts. */}

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
            writing to us on the <a href="/contact">contact page</a>. Your site
            stays online through the end of the paid period. If you need us to
            keep your site live afterwards, we can quote a standalone hosting
            fee.
          </p>

          <h2>Governing law</h2>
          <p>{governingLawSentence(identity)}</p>

          <h2>Updates to these terms</h2>
          <p>
            We rewrite this page whenever we change the way we work. Material
            updates are announced by email to active clients at least 14 days
            before they take effect.
          </p>

          <div className="ls-callout">
            <p>
              Questions about a clause? Ask on the{' '}
              <a href="/contact">contact page</a> and we will walk you through
              it before you sign.
            </p>
          </div>
        </ProseSection>
      </main>
    </MarketingShell>
  );
}
