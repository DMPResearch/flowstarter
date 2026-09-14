/**
 * Every third party that processes data on our behalf, as one table.
 *
 * The privacy page used to carry a hand-written list that had drifted from
 * the code in both directions at once. It named **Plausible** as the
 * analytics processor, which has never been installed, and **Calendly**,
 * which was replaced by a self-hosted Cal.com on our own Hetzner box. It did
 * not name Arcjet, which sees every request to the app; OpenRouter, which
 * receives the intake answers and the public-profile text every generated
 * site is written from; Cal.com at all; or GitHub and Depot, which hold the
 * source and build the images. A list that is wrong in both directions is not
 * a disclosure, it is a decoration.
 *
 * So it is a table here, next to the code, and the pages render it. Adding a
 * vendor to the app and forgetting to disclose it now means editing this file
 * or leaving a test failing, rather than nobody noticing for a year.
 *
 * `legalBasis` is the Article 6 basis for OUR processing through that vendor,
 * written in the same words the privacy page's own legal-basis section uses,
 * so the two sections cannot disagree. `terms` is where that vendor publishes
 * the data-processing terms it offers, which is what a procurement reader
 * actually wants and what the page used to replace with a claim that eight
 * DPAs had been signed.
 */

export type SubprocessorLegalBasis =
  | 'Contract performance'
  | 'Legitimate interest'
  | 'Legal obligation';

export interface Subprocessor {
  /**
   * A stable slug, never rendered, and deliberately not a hostname.
   *
   * It exists so that code asking "is this vendor disclosed?" can compare
   * something exactly instead of searching inside `name`. A substring test
   * over a display string is wrong twice over: renaming "Cal.com" to
   * "Cal.com, self-hosted" would silently pass a test looking for "Cal.com"
   * while "Calendly" would also match a search for "Cal", and a dotted vendor
   * name read as a host is exactly the shape CodeQL flags as an incomplete
   * URL check (`js/incomplete-url-substring-sanitization`). Slugs carry no
   * dots, so `keys.includes(key)` is a set membership test and nothing else.
   */
  key: string;
  /** The vendor, as it calls itself. */
  name: string;
  /** What it does for us, in one sentence a client can check. */
  purpose: string;
  /** Where the data physically sits, and the transfer route if it leaves. */
  region: string;
  /** Our Article 6 basis for the processing this vendor carries out. */
  legalBasis: SubprocessorLegalBasis;
  /**
   * Whether personal data leaves the EU to reach this vendor.
   *
   * A field rather than a phrase match on `region`. The transfers section
   * used to be derived by searching `region` for "standard contractual
   * clauses", which meant a vendor whose region was reworded dropped out of
   * the Article 44 disclosure without anybody touching the disclosure.
   */
  transfersOutsideEu: boolean;
  /** Where that vendor publishes its own data-processing terms. */
  terms: string;
  /**
   * The code that proves this entry is real. Not rendered: it is here so the
   * next person to read the list can check it in one grep instead of trusting
   * it, which is exactly what the Plausible and Calendly entries defeated.
   */
  evidence: string;
}

export const SUBPROCESSORS: readonly Subprocessor[] = [
  {
    key: 'clerk',
    name: 'Clerk',
    purpose: 'Sign-in, sessions and the account record behind them.',
    region: 'United States, under EU standard contractual clauses',
    legalBasis: 'Contract performance',
    transfersOutsideEu: true,
    terms: 'https://clerk.com/legal/dpa',
    evidence: 'src/middleware.ts, src/lib/clerk-supabase-jwt.ts',
  },
  {
    key: 'supabase',
    name: 'Supabase',
    purpose:
      'The database and the file storage holding your project, its brief and anything you upload.',
    region: 'European Union',
    legalBasis: 'Contract performance',
    transfersOutsideEu: false,
    terms: 'https://supabase.com/legal/dpa',
    evidence: 'src/supabase-clients, supabase/migrations',
  },
  {
    key: 'hetzner',
    name: 'Hetzner',
    purpose:
      'The servers running this app, your site, and the booking software below.',
    region: 'Germany and Finland',
    legalBasis: 'Contract performance',
    transfersOutsideEu: false,
    terms: 'https://www.hetzner.com/legal/privacy-policy',
    evidence: 'src/lib/hosting, deploy/hetzner-staging',
  },
  {
    key: 'cloudflare',
    name: 'Cloudflare',
    purpose: 'DNS for your domain, the edge in front of it, and DDoS defence.',
    region: 'United States, under EU standard contractual clauses',
    legalBasis: 'Legitimate interest',
    transfersOutsideEu: true,
    terms: 'https://www.cloudflare.com/cloudflare-customer-dpa',
    evidence: 'src/lib/hosting/site-domains-api.ts',
  },
  {
    key: 'stripe',
    name: 'Stripe',
    purpose: 'Card payments, invoices, refunds and the tax record of them.',
    region: 'Ireland',
    legalBasis: 'Legal obligation',
    transfersOutsideEu: false,
    terms: 'https://stripe.com/legal/dpa',
    evidence: 'src/lib/billing, src/app/api/webhooks/stripe',
  },
  {
    key: 'resend',
    name: 'Resend',
    purpose: 'Delivering the email this product sends you.',
    region: 'United States, under EU standard contractual clauses',
    legalBasis: 'Contract performance',
    transfersOutsideEu: true,
    terms: 'https://resend.com/legal/dpa',
    evidence: 'src/lib/email.ts',
  },
  {
    key: 'arcjet',
    name: 'Arcjet',
    purpose:
      'Deciding whether a request to this app is a person, a crawler or an attack.',
    region: 'United States, under EU standard contractual clauses',
    legalBasis: 'Legitimate interest',
    transfersOutsideEu: true,
    terms: 'https://arcjet.com/data-processing-agreement',
    evidence: 'src/lib/arcjet.ts, src/middleware.ts',
  },
  {
    key: 'openrouter',
    name: 'OpenRouter',
    purpose:
      'The gateway the writing and design agents call. It sees your intake answers and the public profile text your site is written from.',
    region: 'United States, under EU standard contractual clauses',
    legalBasis: 'Contract performance',
    transfersOutsideEu: true,
    terms: 'https://openrouter.ai/privacy',
    evidence: 'src/lib/ai/client.ts, src/lib/ai/llm.ts',
  },
  {
    key: 'cal-com',
    name: 'Cal.com, self-hosted',
    purpose:
      'The booking page we make for your site. We run it ourselves on the Hetzner servers above, so booking data does not leave them.',
    region: 'Germany, on our own servers',
    legalBasis: 'Contract performance',
    transfersOutsideEu: false,
    terms: 'Self-hosted. No third party receives this data.',
    evidence: 'src/lib/flowstarter/cal-com.ts, deploy/hetzner-staging/cal',
  },
  {
    key: 'github',
    name: 'GitHub',
    purpose:
      'Source code and continuous integration. It holds no client data, only the code that runs this product.',
    region: 'United States, under EU standard contractual clauses',
    legalBasis: 'Legitimate interest',
    transfersOutsideEu: true,
    terms: 'https://github.com/customer-terms/github-data-protection-agreement',
    evidence: '.github/workflows',
  },
  {
    key: 'depot',
    name: 'Depot',
    purpose:
      'Builds the container images CI ships. Same as GitHub: code, not client data.',
    region: 'United States, under EU standard contractual clauses',
    legalBasis: 'Legitimate interest',
    transfersOutsideEu: true,
    terms: 'https://depot.dev/legal/dpa',
    evidence: '.github/workflows, Dockerfile.flowstarter-main-dev',
  },
];

/**
 * What the privacy page says about data-processing agreements.
 *
 * The old sentence was "Each one has signed a data-processing agreement with
 * us covering Article 28 GDPR requirements", which asserts eight executed
 * contracts. Nobody has checked that eight signed documents exist, and
 * several of these vendors offer their Article 28 terms as a standing
 * publication you accept rather than a document they counter-sign. So the
 * page now states what is true and checkable: here is the list, here is where
 * each vendor's terms live, and here is how to ask for ours.
 */
export const DPA_STATEMENT =
  'Each vendor below publishes the data-processing terms it offers, and the ' +
  'link in its row goes to them. We accept those terms as part of using the ' +
  'service. We do not claim a separately negotiated and counter-signed ' +
  'agreement with every one of them, because that is not what most of them ' +
  'offer. If you need a data-processing agreement from us for your own ' +
  'records, ask on the contact page and we will send one.';

/** Vendors whose data leaves the European Union, for the transfers section. */
export function subprocessorsOutsideEu(
  list: readonly Subprocessor[] = SUBPROCESSORS
): Subprocessor[] {
  return list.filter((entry) => entry.transfersOutsideEu);
}

/**
 * Is this vendor disclosed?
 *
 * Exact on the slug. The obvious version of this searches inside `name`, and
 * that is wrong in both directions: "Cal" matches Calendly, and a vendor
 * renamed from "Cal.com" to "Cal.com, self-hosted" keeps passing a test that
 * no longer means anything. A dotted vendor name compared by substring is
 * also the literal shape of `js/incomplete-url-substring-sanitization`, which
 * is what CodeQL flagged on the first version of the test for this file.
 */
export function isDisclosed(
  key: string,
  list: readonly Subprocessor[] = SUBPROCESSORS
): boolean {
  return list.some((entry) => entry.key === key);
}

/**
 * `terms` as a link, or null when it is a sentence rather than a URL.
 *
 * Cal.com's row says "Self-hosted. No third party receives this data." and
 * every other row is a URL, so the page has to tell them apart. The obvious
 * test is `terms.startsWith('http')`, which is the same incomplete-URL shape
 * as a substring host check: it passes `httpfoo`, and it would happily render
 * `http://` as a link on a page whose whole job is to be checkable.
 *
 * So the string is parsed and the protocol compared exactly. Anything that is
 * not a well-formed absolute https URL renders as text, which is the safe
 * direction: a reader sees the words rather than following a link we could
 * not vouch for.
 */
export function termsUrl(terms: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(terms);
  } catch {
    return null;
  }
  return parsed.protocol === 'https:' ? parsed : null;
}
