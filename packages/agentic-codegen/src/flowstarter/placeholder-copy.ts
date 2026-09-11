/**
 * The one place the phrases that must never reach a client's site are listed.
 *
 * The quality sweep already derives "did the agent rewrite the template's own
 * copy" from the scaffold itself, and that check is good at what it does: it
 * catches a sentence about Atelier Verso surviving on a dentist's site. What
 * it cannot do is distinguish copy that is merely unrewritten from copy that
 * is *a lie to the visitor* — a contact form that says it will send once
 * somebody wires it up, a booking page promising a Cal.com calendar that does
 * not exist, a Calendly URL with `your-username` in it. Those shipped.
 *
 * So this is a second, narrower gate with a hand-written list. A sentinel here
 * is not "template copy we would rather was rewritten". It is a string that
 * makes a promise the built site cannot keep, and finding one fails the build.
 *
 * Two properties are deliberate:
 *
 * - **The list is closed and literal.** No model decides what counts. Adding a
 *   sentinel is a code change with a test, which is the point: the list is
 *   auditable and an operator can answer "what do we refuse to ship" by
 *   reading one file.
 * - **Matching is case-insensitive and whitespace-tolerant**, because the
 *   agent rephrases whitespace and capitalisation freely while leaving the
 *   substance of a placeholder sentence untouched. A sentinel that only
 *   matched verbatim would be evaded by accident.
 */

/** The job fails with this when a sentinel survives into the built site. */
export const PLACEHOLDER_COPY_SHIPPED = 'PLACEHOLDER_COPY_SHIPPED';

export interface PlaceholderSentinel {
  /** Stable id, so a test and a job log can name one without quoting it. */
  id: string;
  /** The phrase, as the template writes it. Matched loosely; see above. */
  phrase: string;
  /** Why it must never ship, in the words an operator would use. */
  why: string;
  /**
   * Set when the phrase is only dishonest in a particular workspace. Naming
   * a calendar is a lie on a site with no booking link and plain fact on a
   * site with one, so that sentinel carries `no-booking-link` and the rest
   * apply unconditionally.
   */
  appliesWhen?: 'no-booking-link';
}

export interface PlaceholderScanOptions {
  /** Whether the workspace has a validated booking link. Defaults to false. */
  hasBookingLink?: boolean;
}

/** The sentinels in force for one workspace. */
export function activeSentinels(
  options: PlaceholderScanOptions = {},
): readonly PlaceholderSentinel[] {
  if (!options.hasBookingLink) return PLACEHOLDER_SENTINELS;
  return PLACEHOLDER_SENTINELS.filter(
    (sentinel) => sentinel.appliesWhen !== 'no-booking-link',
  );
}

/**
 * Every phrase that is a broken promise rather than merely generic copy.
 *
 * Sourced from the library templates themselves plus the strings the
 * 2026-09-11 portfolio build actually published. Keep the list short: a
 * sentinel that fires on honest copy is worse than no sentinel, because the
 * next person turns the gate off.
 */
export const PLACEHOLDER_SENTINELS: readonly PlaceholderSentinel[] = [
  // The contact-form confession shipped with slightly different wording in
  // every template, so it is listed by its invariant fragments rather than by
  // the one sentence that happened to be published.
  {
    id: 'contact-form-connect-this-form',
    phrase: 'once you connect this form',
    why: 'The contact form tells the visitor it does not work yet. It shipped on a paid site.',
  },
  {
    id: 'contact-form-once-connected',
    phrase: 'once this form is connected',
    why: 'The contact form tells the visitor it does not work yet.',
  },
  {
    id: 'contact-form-once-the-form-is-connected',
    phrase: 'once the form is connected',
    why: 'The contact form tells the visitor it does not work yet.',
  },
  {
    id: 'contact-form-endpoint',
    phrase: 'form endpoint',
    why: 'Build vocabulary rendered to a visitor who has no idea what an endpoint is.',
  },
  {
    id: 'connect-your-calendar-link',
    phrase: 'connect your calendly or cal.com link here',
    why: 'Instructions to the site owner, rendered to the visitor.',
  },
  {
    id: 'replace-the-src-below',
    phrase: 'replace the src below with your calendly or cal.com embed url',
    why: 'A build note left in the markup of the booking page.',
  },
  {
    id: 'calendly-your-username',
    phrase: 'calendly.com/your-username',
    why: 'A booking iframe pointed at a URL that belongs to nobody.',
  },
  {
    id: 'cal-com-your-username',
    phrase: 'cal.com/your-username',
    why: 'A booking iframe pointed at a URL that belongs to nobody.',
  },
  {
    id: 'promised-cal-com-calendar',
    phrase: 'cal.com calendar',
    why: 'Copy naming the booking tool rather than the client. A site with no booking link must not mention one.',
    appliesWhen: 'no-booking-link',
  },
  {
    id: 'lorem-ipsum',
    phrase: 'lorem ipsum',
    why: 'Filler that was never replaced.',
  },
  {
    id: 'your-business-name-here',
    phrase: 'your business name here',
    why: 'A scaffold slot the personalization pass missed.',
  },
  {
    id: 'name-here-placeholder',
    phrase: 'name here?',
    why: 'The dorin-portfolio logo slot, shipped verbatim.',
  },
  {
    id: 'add-your-content',
    phrase: 'add your content here',
    why: 'An instruction to the site owner left in the page.',
  },
  {
    id: 'coming-soon-placeholder',
    phrase: 'this page is coming soon',
    why: 'A page that exists only to say it does not exist yet.',
  },
  // Deliberately absent: `you@example.com` and `hello@example.com`. The first
  // is an input placeholder and is correct copy; the second is a sample
  // business address the personalization pass replaces, and the residue check
  // next door already reports it. Neither is a promise the site cannot keep,
  // and a sentinel that fires on honest copy is how a gate gets turned off.
] as const;

/**
 * The source files the *preview* agent is allowed to edit, and so the only
 * ones it can be sent back to fix. Scanning wider at preview time would fail a
 * preview for markup the agent is structurally barred from touching.
 */
export const EDITABLE_CONTENT_PREFIXES: readonly string[] = [
  'src/content/',
  'src/data/',
];

/**
 * Files a sentinel is looked for in when the whole source tree is in scope.
 * Content and data hold the copy; pages and components hold the markup the
 * booking placeholders live in, which is exactly the blind spot the residue
 * check has.
 */
export const SCANNED_PREFIXES: readonly string[] = [
  ...EDITABLE_CONTENT_PREFIXES,
  'src/pages/',
  'src/components/',
  'src/layouts/',
];

/** Text extensions worth reading. Never a binary, never a lockfile. */
const SCANNED_EXTENSIONS =
  /\.(astro|md|mdx|html|ts|tsx|js|mjs|json|yaml|yml)$/i;

/** Findings named back to the agent; more is noise, not information. */
const MAX_FINDINGS_LISTED = 8;

export interface PlaceholderFinding {
  sentinel: PlaceholderSentinel;
  /** Workspace-relative path the phrase was found in. */
  path: string;
}

/** Collapses runs of whitespace and drops typographic punctuation variants. */
function canonical(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ');
}

/** True when this path is one the whole-tree scan reads. */
export function isScannedPath(path: string): boolean {
  const clean = path.replace(/^\.?\//, '');
  if (!SCANNED_EXTENSIONS.test(clean)) return false;
  return SCANNED_PREFIXES.some((prefix) => clean.startsWith(prefix));
}

/** True when this path is one the preview agent could actually repair. */
export function isEditableContentPath(path: string): boolean {
  const clean = path.replace(/^\.?\//, '');
  if (!SCANNED_EXTENSIONS.test(clean)) return false;
  return EDITABLE_CONTENT_PREFIXES.some((prefix) => clean.startsWith(prefix));
}

/** Every sentinel present in one file's text. */
export function findPlaceholderCopyInText(
  path: string,
  content: string,
  options: PlaceholderScanOptions = {},
): PlaceholderFinding[] {
  const haystack = canonical(content);
  return activeSentinels(options)
    .filter((sentinel) => haystack.includes(canonical(sentinel.phrase)))
    .map((sentinel) => ({ sentinel, path }));
}

/**
 * Every sentinel present in a set of files the caller has already chosen.
 *
 * Used on the built output, where the paths are `dist/about/index.html` rather
 * than source paths and the caller has already decided what a page is.
 */
export function findPlaceholderCopyInFiles(
  files: readonly { path: string; content: string }[],
  options: PlaceholderScanOptions = {},
): PlaceholderFinding[] {
  const findings: PlaceholderFinding[] = [];
  for (const file of files) {
    if (!SCANNED_EXTENSIONS.test(file.path)) continue;
    findings.push(
      ...findPlaceholderCopyInText(file.path, file.content, options),
    );
  }
  return findings;
}

/** Every sentinel present in the source tree of a site, by scaffold path. */
export function findPlaceholderCopy(
  files: Readonly<Record<string, string>>,
  options: PlaceholderScanOptions = {},
): PlaceholderFinding[] {
  return findPlaceholderCopyInFiles(
    Object.entries(files)
      .filter(([path]) => isScannedPath(path))
      .map(([path, content]) => ({ path, content })),
    options,
  );
}

/**
 * The findings, phrased once: as feedback the agent can act on and as the
 * failure an operator reads. Same sentence either way, so what the job log
 * says and what the agent was told can never drift apart.
 */
export function describePlaceholderFindings(
  findings: readonly PlaceholderFinding[],
): string {
  const listed = findings.slice(0, MAX_FINDINGS_LISTED);
  const detail = listed
    .map(
      (finding) =>
        `"${finding.sentinel.phrase}" in ${finding.path} (${finding.sentinel.why})`,
    )
    .join('; ');
  const overflow =
    findings.length > listed.length
      ? ` and ${findings.length - listed.length} more`
      : '';
  return (
    `${PLACEHOLDER_COPY_SHIPPED}: placeholder copy that promises something the ` +
    `site cannot deliver is still present. Rewrite or remove each of these: ${detail}${overflow}.`
  );
}
