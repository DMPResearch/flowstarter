/**
 * The gate against the single most damaging thing this generator does: put a
 * client on a page who does not exist.
 *
 * A placeholder sentence that survives is embarrassing. A fabricated case
 * study is something else — it is the paying client telling a visitor about
 * work they never did, under their own name, on a site they bought from us.
 * It has happened: a three-project portfolio shipped with a fourth study for
 * a company nobody has heard of, complete with a result percentage.
 *
 * So when the brief lists real projects, the built site is checked against
 * that list. Three properties keep the check honest:
 *
 * - **It only has an opinion when it was given one.** No brief project names,
 *   no findings. A brief that lists none is handled a page earlier, by the
 *   page-set rule dropping the work page; a gate that guessed here would fail
 *   every build taken before the dashboard asked the question.
 * - **It looks only where projects live.** The work and case-study routes,
 *   and the work section of a one-page site. A false positive fails a paid
 *   build and costs an operator an hour, so the scope is narrow on purpose
 *   and every widening of it belongs in this comment.
 * - **Matching is loose and the generic labels are listed.** "Ereno, a calm
 *   inbox" is the project "Ereno" written for a page, not a new client, and
 *   "Selected work" is a section label rather than a claim about anybody.
 */

/** The job fails with this when the built site names a project nobody hired. */
export const INVENTED_PROJECT = 'INVENTED_PROJECT';

export interface InventedProjectFinding {
  /** Path of the built page the heading was found in. */
  path: string;
  /** The heading, as the page renders it. */
  heading: string;
}

/** Findings named back to the agent; more is noise, not information. */
const MAX_FINDINGS_LISTED = 8;

/** Built pages. Never a stylesheet, never a script, never a source file. */
const HTML_FILE = /\.html?$/i;

/**
 * Top-level sections whose every page is about the client's work. Matched on
 * the first path segment, which is how a static build lays out its routes.
 */
const WORK_SECTIONS: readonly string[] = ['work', 'case-studies'];

/**
 * Markers that say "the work section starts here" on a page that is not under
 * a work route — the home page of a one-page site, in practice.
 *
 * Deliberately short and literal. A link to /case-studies is not on this list:
 * a home page linking to the work page is every home page, and scanning one
 * for headings would put the services and about copy in front of a gate that
 * has no business judging it.
 */
const CASE_STUDY_MARKERS: readonly string[] = [
  'id="work"',
  "id='work'",
  'id="case-studies"',
  "id='case-studies'",
  'data-section="work"',
  'data-flowstarter-section="work"',
];

/**
 * Headings that label a section rather than name a client.
 *
 * Closed and hand-written, like the placeholder sentinels next door: no model
 * decides what counts, and an operator can answer "what may a work page say
 * that is not a project" by reading this list. Everything in it is either a
 * section title the templates ship or a case-study sub-heading they use.
 */
export const GENERIC_HEADINGS: ReadonlySet<string> = new Set([
  'selected work',
  'our work',
  'case studies',
  'projects',
  'recent projects',
  'featured work',
  'portfolio',
  'what we did',
  'the brief',
  'the result',
  'the outcome',
  'the challenge',
  'the approach',
  'results',
  'overview',
  'get in touch',
  'contact',
  'next project',
  'previous project',
  'services',
  'about',
  'testimonials',
  'frequently asked questions',
]);

/** `<h2>`/`<h3>` and their text, in document order. */
const HEADING = /<h([23])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;

/** The few entities a heading actually contains once a template renders it. */
const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** Built output arrives with its output directory in front; routes do not. */
function routePath(path: string): string {
  return path.replace(/^\.?\//, '').replace(/^dist\//, '');
}

/** A heading's visible text: tags gone, entities resolved, whitespace folded. */
export function headingText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(
      /&[a-z]+;|&#\d+;/gi,
      (entity) => ENTITIES[entity.toLowerCase()] ?? ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A heading or a project name reduced to the words in it. Punctuation and
 * case are how the same name is written twice, not how two names differ.
 */
function canonical(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The part of a built page a heading may be judged in, or null when the page
 * is out of scope.
 *
 * A page under a work route is in scope whole. Any other page is in scope
 * only from a work-section marker to the end of the section that carries it,
 * because the rest of that page is services, about and contact copy this gate
 * knows nothing about.
 */
export function workRegion(path: string, content: string): string | null {
  const route = routePath(path);
  if (!HTML_FILE.test(route)) return null;

  const segments = route.split('/');
  if (segments.length > 1 && WORK_SECTIONS.includes(segments[0] as string)) {
    return content;
  }

  const marker = CASE_STUDY_MARKERS.map((needle) =>
    content.toLowerCase().indexOf(needle),
  ).filter((index) => index >= 0);
  if (marker.length === 0) return null;

  const start = Math.min(...marker);
  const end = content.toLowerCase().indexOf('</section>', start);
  return end < 0 ? content.slice(start) : content.slice(start, end);
}

/** True when this heading is one of the brief's projects, however written. */
export function matchesBriefProject(
  heading: string,
  briefProjectNames: readonly string[],
): boolean {
  const candidate = canonical(heading);
  if (!candidate) return true;
  return briefProjectNames.some((name) => {
    const project = canonical(name);
    if (!project) return false;
    return candidate.includes(project) || project.includes(candidate);
  });
}

/**
 * Every project-shaped heading in a built site that the brief does not
 * account for.
 *
 * `files` is the built output as `collectBuiltSiteText` returns it, paths and
 * all. An empty `briefProjectNames` returns nothing: see the header.
 */
export function findInventedProjects(
  files: readonly { path: string; content: string }[],
  briefProjectNames: readonly string[],
): InventedProjectFinding[] {
  const names = briefProjectNames.filter((name) => canonical(name).length > 0);
  if (names.length === 0) return [];

  const findings: InventedProjectFinding[] = [];
  for (const file of files) {
    const region = workRegion(file.path, file.content);
    if (region === null) continue;
    // `Array.from` rather than iterating the iterator directly: this package
    // is consumed as raw TypeScript by flowstarter-main, whose tsconfig target
    // predates iterator spreading.
    for (const match of Array.from(region.matchAll(HEADING))) {
      const heading = headingText(match[2] as string);
      if (!heading) continue;
      if (GENERIC_HEADINGS.has(canonical(heading))) continue;
      if (matchesBriefProject(heading, names)) continue;
      findings.push({ path: file.path, heading });
    }
  }
  return findings;
}

/**
 * The findings, phrased once: as feedback the agent can act on and as the
 * failure an operator reads. Same sentence either way, so what the job log
 * says and what the agent was told can never drift apart.
 */
export function describeInventedProjectFindings(
  findings: readonly InventedProjectFinding[],
  briefProjectNames: readonly string[],
): string {
  const listed = findings.slice(0, MAX_FINDINGS_LISTED);
  const detail = listed
    .map((finding) => `"${finding.heading}" in ${finding.path}`)
    .join('; ');
  const overflow =
    findings.length > listed.length
      ? ` and ${findings.length - listed.length} more`
      : '';
  const allowed = briefProjectNames.slice(0, MAX_FINDINGS_LISTED).join(', ');
  const allowedOverflow =
    briefProjectNames.length > MAX_FINDINGS_LISTED
      ? ` and ${briefProjectNames.length - MAX_FINDINGS_LISTED} more`
      : '';
  return (
    `${INVENTED_PROJECT}: the site presents work the client never told us ` +
    `about. Remove or rename each of these headings: ${detail}${overflow}. ` +
    `The only projects this client has are: ${allowed}${allowedOverflow}. ` +
    'Build the work section from those alone, using each name exactly as the ' +
    'brief writes it, and never invent a client, a project or a case study.'
  );
}
