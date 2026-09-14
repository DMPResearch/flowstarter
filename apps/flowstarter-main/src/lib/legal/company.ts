/**
 * Who operates Flowstarter, as a fact the environment supplies rather than a
 * sentence a page asserts.
 *
 * The terms page used to say the agreement is "governed by the laws of
 * Romania, where Flowstarter is registered" and that disputes are "settled by
 * the courts of Cluj-Napoca". The privacy page used to say "a two-person
 * studio registered in the European Union". No entity name, registration
 * number, VAT number or registered address appeared anywhere on the site, and
 * the company structure is still an open decision in the master decisions
 * doc. Both sentences were therefore either false or, if the entity does
 * exist, missing every disclosure a trader owes a consumer and a controller
 * owes a data subject under GDPR Article 13.
 *
 * So the identity is not written in the pages at all. It is read from six
 * environment variables, and until every one of them is set the pages say so
 * in as many words instead of naming a country and a courthouse:
 *
 *   FLOWSTARTER_LEGAL_ENTITY_NAME         the registered company name
 *   FLOWSTARTER_LEGAL_REGISTRATION_NUMBER the trade-register number
 *   FLOWSTARTER_LEGAL_VAT_NUMBER          the VAT identification number
 *   FLOWSTARTER_LEGAL_ADDRESS             the registered office, one line
 *   FLOWSTARTER_LEGAL_JURISDICTION        the law the agreement is under
 *   FLOWSTARTER_LEGAL_COURT               the forum for unresolved disputes
 *
 * All six or none. A half-filled identity is worse than an honest blank: it
 * reads as a complete disclosure while leaving out the part a reader would
 * need to verify it, and there is no ordering in which five of six is a legal
 * statement. `missing` names what is still absent so an operator reading a
 * log or a test failure knows exactly which value to go and find.
 */

/** The environment variables, in the order a reader of the pages meets them. */
export const LEGAL_IDENTITY_ENV_VARS = [
  'FLOWSTARTER_LEGAL_ENTITY_NAME',
  'FLOWSTARTER_LEGAL_REGISTRATION_NUMBER',
  'FLOWSTARTER_LEGAL_VAT_NUMBER',
  'FLOWSTARTER_LEGAL_ADDRESS',
  'FLOWSTARTER_LEGAL_JURISDICTION',
  'FLOWSTARTER_LEGAL_COURT',
] as const;

export type LegalIdentityEnvVar = (typeof LEGAL_IDENTITY_ENV_VARS)[number];

export interface OperatorIdentity {
  /** Registered company name, as it appears on the trade register. */
  name: string;
  /** Trade-register or company number. */
  registrationNumber: string;
  /** VAT identification number. */
  vatNumber: string;
  /** Registered office, as a single line. */
  address: string;
  /** The law the agreement is governed by, e.g. a country. */
  jurisdiction: string;
  /** The court that hears a dispute the two of us could not settle. */
  court: string;
}

export type OperatorIdentityState =
  | { provided: true; identity: OperatorIdentity }
  | { provided: false; missing: LegalIdentityEnvVar[] };

/**
 * What the pages print where a company name would go, until there is one.
 *
 * Deliberately a statement of fact about the business rather than an apology
 * or a "coming soon": a reader who needs to know who they are contracting
 * with is better served by "there is no registered entity yet" than by a
 * friendly sentence that avoids the question.
 */
export const OPERATOR_IDENTITY_PENDING_NOTICE =
  'Operator identity pending registration';

type EnvLike = Record<string, string | undefined>;

function read(env: EnvLike, key: LegalIdentityEnvVar): string {
  return (env[key] ?? '').trim();
}

/**
 * The operator identity, or the list of variables still missing.
 *
 * Takes the environment as an argument so a test can pin every branch without
 * mutating `process.env`, and defaults to the real one so a page can call it
 * with no arguments.
 */
export function readOperatorIdentity(
  env: EnvLike = process.env as EnvLike
): OperatorIdentityState {
  const missing = LEGAL_IDENTITY_ENV_VARS.filter((key) => !read(env, key));
  if (missing.length > 0) return { provided: false, missing };
  return {
    provided: true,
    identity: {
      name: read(env, 'FLOWSTARTER_LEGAL_ENTITY_NAME'),
      registrationNumber: read(env, 'FLOWSTARTER_LEGAL_REGISTRATION_NUMBER'),
      vatNumber: read(env, 'FLOWSTARTER_LEGAL_VAT_NUMBER'),
      address: read(env, 'FLOWSTARTER_LEGAL_ADDRESS'),
      jurisdiction: read(env, 'FLOWSTARTER_LEGAL_JURISDICTION'),
      court: read(env, 'FLOWSTARTER_LEGAL_COURT'),
    },
  };
}

/**
 * Whether the draft notice is still shown.
 *
 * One rule, one answer, every legal page. The notice used to be on privacy
 * and cookies and not on terms, which is backwards: terms is the contract and
 * the other two are disclosures. Now all three ask this, and all three stop
 * showing it on the same deploy, the one that sets the six variables.
 */
export function legalDraftNoticeVisible(state: OperatorIdentityState): boolean {
  return !state.provided;
}

/**
 * The governing-law sentence on the terms page.
 *
 * With an identity it names the law and the court from the environment. With
 * none it says there is no registered entity yet and that a dispute is
 * therefore handled under the law of wherever the client is, which is the
 * position a client is actually in when the other side has no seat to point
 * at. It does not name Romania, Cluj-Napoca, or any other place the product
 * cannot prove it is registered in.
 */
export function governingLawSentence(state: OperatorIdentityState): string {
  if (!state.provided) {
    return (
      'Flowstarter is not yet incorporated, so this agreement names no ' +
      'company seat and no home court. Until it does, a dispute is governed ' +
      'by the law of the country you live or trade in, and this page will ' +
      'say so on the day that changes. We settle things over a call first.'
    );
  }
  const { name, jurisdiction, court } = state.identity;
  return (
    `This agreement is governed by the laws of ${jurisdiction}, where ` +
    `${name} is registered. Disputes are first attempted in good faith over ` +
    `a call, and if unresolved, settled by ${court}. Nothing here removes a ` +
    'consumer right you hold where you live.'
  );
}

/**
 * The controller-identity lines on the privacy page.
 *
 * Returned as lines rather than one paragraph so the page can render them as
 * a list, which is how a reader looking for a VAT number actually reads them.
 * Empty while the identity is pending, because there is nothing true to list.
 */
export function controllerIdentityLines(
  state: OperatorIdentityState
): string[] {
  if (!state.provided) return [];
  const { name, registrationNumber, vatNumber, address } = state.identity;
  return [
    `Registered name: ${name}`,
    `Registration number: ${registrationNumber}`,
    `VAT number: ${vatNumber}`,
    `Registered address: ${address}`,
  ];
}

/**
 * The sentence that introduces those lines, or the honest notice in place of
 * them.
 *
 * GDPR Article 13 wants the controller's identity and contact details. With
 * no entity there is no identity to give, and the only true thing to say is
 * that there is not one yet, and who to write to in the meantime.
 */
export function controllerSentence(state: OperatorIdentityState): string {
  if (!state.provided) {
    return (
      `${OPERATOR_IDENTITY_PENDING_NOTICE}. Flowstarter is run by two ` +
      'people, Darius and Dorin, and is not yet incorporated, so there is no ' +
      'registered company name, registration number, VAT number or ' +
      'registered address to give you. All four are published here as soon ' +
      'as there are any. Until then the two of us are the controller, and ' +
      'the contact page reaches us.'
    );
  }
  return (
    `Flowstarter is operated by ${state.identity.name}. Its registration ` +
    'details are below, and the contact page reaches us.'
  );
}
