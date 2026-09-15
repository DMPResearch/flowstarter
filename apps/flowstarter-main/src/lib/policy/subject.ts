/**
 * What each enforcement point hands the classifier.
 *
 * Pure string composition, no I/O, no policy. It exists so that six call sites
 * cannot each invent their own idea of "the text", which is how one of them
 * ends up forgetting the field that mattered.
 *
 * Two rules shape the output:
 *
 *   1. LABELLED FIELDS, MOST TELLING FIRST. The classifier reads a capped
 *      window; what a business sells belongs at the top of it, and a labelled
 *      field is easier for a model to reason about than a concatenated blob.
 *   2. THE LINK IS A HOSTNAME AND A TITLE, NEVER A FETCH. Nothing here opens a
 *      connection. The caller passes what it already fetched elsewhere.
 */

export interface SubjectField {
  label: string;
  value: string | null | undefined;
}

const MAX_FIELD_CHARS = 2_000;

function clean(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_CHARS);
}

/** Join labelled fields, dropping the empty ones. */
export function composeSubject(fields: readonly SubjectField[]): string {
  return fields
    .map((field) => ({ label: field.label, value: clean(field.value) }))
    .filter((field) => field.value.length > 0)
    .map((field) => `${field.label}: ${field.value}`)
    .join('\n');
}

/**
 * The hostname of the one link the quick intake asks for.
 *
 * `new URL` only parses; it never opens a connection. A value that is not a
 * URL yields an empty string rather than throwing, because a visitor typing
 * their Instagram handle without a scheme is not an error worth a 400.
 */
export function hostnameOf(link: string | null | undefined): string {
  const raw = clean(link);
  if (!raw) return '';
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    try {
      return new URL(`https://${raw}`).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }
}

export interface IntakeSubjectInput {
  businessName?: string | null;
  description?: string | null;
  offer?: string | null;
  industry?: string | null;
  targetAudience?: string | null;
  goal?: string | null;
  services?: string | null;
  /** The one link, in whatever form the visitor typed it. */
  websiteUrl?: string | null;
  instagramUrl?: string | null;
  linkedinUrl?: string | null;
  /** The `<title>` of that link, when something upstream already read it. */
  linkTitle?: string | null;
}

/** The quick intake and the live preview both judge this. */
export function intakeSubject(input: IntakeSubjectInput): string {
  const hosts = [input.websiteUrl, input.instagramUrl, input.linkedinUrl]
    .map(hostnameOf)
    .filter(Boolean);
  return composeSubject([
    { label: 'What the business does', value: input.description },
    { label: 'Offer', value: input.offer },
    { label: 'Services', value: input.services },
    { label: 'Business name', value: input.businessName },
    { label: 'Industry', value: input.industry },
    { label: 'Customers', value: input.targetAudience },
    { label: 'Goal for the site', value: input.goal },
    { label: 'Link hostname', value: hosts.join(' ') },
    { label: 'Link page title', value: input.linkTitle },
  ]);
}

export interface IntakeLink {
  /** What the URL actually is, so a fact row reads right instead of a bare link. */
  label: string;
  url: string;
}

/**
 * The one link a quick intake carries, labelled for a person to read.
 *
 * For the operator email's fact row only -- see `policyReviewOperatorEmail`
 * in `@/lib/email-templates` -- never for the classifier, which reads
 * `intakeSubject`'s hostname-only line instead. Preference order matches that
 * line: the visitor's own site first, then Instagram, then LinkedIn. `null`
 * when the visitor gave none.
 */
export function intakeLink(input: {
  websiteUrl?: string | null;
  instagramUrl?: string | null;
  linkedinUrl?: string | null;
}): IntakeLink | null {
  const website = (input.websiteUrl ?? '').trim();
  if (website) return { label: 'Their site', url: website };
  const instagram = (input.instagramUrl ?? '').trim();
  if (instagram) return { label: 'Their profile', url: instagram };
  const linkedin = (input.linkedinUrl ?? '').trim();
  if (linkedin) return { label: 'Their profile', url: linkedin };
  return null;
}

export interface BriefProjectLike {
  name?: string | null;
  line?: string | null;
  link?: string | null;
}

export interface BriefSubjectInput {
  offer?: string | null;
  projects?: readonly BriefProjectLike[] | null;
  businessName?: string | null;
}

/**
 * The brief, after the deposit. This is the surface a clean intake can turn
 * dirty on: the four quick answers say "creative studio" and the brief says
 * what the studio actually sells.
 */
export function briefSubject(input: BriefSubjectInput): string {
  const projects = (input.projects ?? [])
    .map((project) =>
      [clean(project.name), clean(project.line), hostnameOf(project.link)]
        .filter(Boolean)
        .join(' - ')
    )
    .filter(Boolean)
    .join('\n');
  return composeSubject([
    { label: 'Offer', value: input.offer },
    { label: 'Business name', value: input.businessName },
    { label: 'Projects', value: projects },
  ]);
}

/** A client's change request, or an operator's note on one. */
export function changeRequestSubject(input: {
  request?: string | null;
  note?: string | null;
}): string {
  return composeSubject([
    { label: 'Requested change', value: input.request },
    { label: 'Operator note', value: input.note },
  ]);
}
