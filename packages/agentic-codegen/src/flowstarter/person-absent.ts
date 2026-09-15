/**
 * The gate against a portfolio that does not contain its person.
 *
 * `INVENTED_PROJECT` next door catches the site saying something about the
 * client that is not true. This catches the opposite and, on the evidence,
 * the more common failure: a site that says nothing about them at all. The
 * build that prompted it shipped an about page whose only content was a stock
 * graph, three lines of studio copy nobody wrote, and an empty box captioned
 * "A photograph of me will follow here", under a business name that was the
 * platform's. Every gate passed, because no gate had an opinion about whether
 * the person was on their own website.
 *
 * Two modes, and they are different verdicts rather than different messages:
 *
 *   FAIL   the brief HAS the material and the site does not use it. The
 *          client wrote three sentences about themselves and sent a
 *          photograph, and the agent wrote a studio boilerplate instead.
 *          That is the agent's defect, it is fixable in a pass, and it fails
 *          the build so the pass happens.
 *   HOLD   the brief LACKS the material. Nothing the agent can do fixes
 *          that, so failing the build repeatedly would burn attempts on a
 *          question only the client can answer. The gate returns the ask
 *          instead, in the words the client reads.
 *
 * Only a portfolio is judged. A plumber's site is about a trade and a
 * catchment area, and a first-person life story on one is not a requirement,
 * it is a genre mistake. `siteKindFor` in `page-set.ts` is the same rule that
 * decides the page order, so a site cannot be a portfolio for one purpose and
 * not for the other.
 *
 * Matching the story is deliberately loose, and the shape of that looseness
 * took two attempts to get right.
 *
 * The agent is told to quote and lightly edit, and light editing breaks an
 * exact search: "I have taken photographs since I was nineteen" becomes
 * "Taking photographs since I was nineteen", and an exact-match gate fails a
 * correct site. So the test is PHRASES, not sentences and not words.
 *
 * It is not words, and that is the part worth writing down. The first version
 * of this rule counted how many of the story's longer words appeared anywhere
 * on the page, and it passed a real build of the template carrying a
 * completely different person's story, because "years", "product", "teams",
 * "support" and a dozen others are on every page of every portfolio ever
 * written. A bag of words measures vocabulary, and every site in a genre
 * shares a vocabulary. Runs of consecutive words measure authorship: generic
 * copy does not accidentally contain four separate three-word runs of
 * somebody's actual sentences.
 */

import { hasPersonStory, personStoryText, type BriefPerson } from './person';
import { siteKindFor } from './page-set';

/** The job fails with this when a portfolio ships without its person. */
export const PERSON_ABSENT = 'PERSON_ABSENT';

/** Built pages. Never a stylesheet, never a script, never a source file. */
const HTML_FILE = /\.html?$/i;

/**
 * Where an about page lives. Matched on the first path segment, which is how
 * a static build lays out its routes.
 */
const ABOUT_SECTIONS: readonly string[] = ['about'];

/**
 * Markers that say "the about section starts here" on a page that is not
 * under an about route: the home page of a one-page site, in practice.
 */
const ABOUT_MARKERS: readonly string[] = [
  'id="about"',
  "id='about'",
  'data-section="about"',
  'data-flowstarter-section="about"',
];

/**
 * How many of the client's own words in a row count as a quotation.
 *
 * Long enough that a run this length cannot occur by chance in generic copy,
 * short enough to survive the trimming and re-punctuating the agent is
 * explicitly allowed to do.
 */
export const STORY_SHINGLE_WORDS = 6;

/**
 * The fallback unit, when no six-word run survived the edit.
 *
 * Three consecutive words is short enough to survive a sentence being split,
 * re-punctuated or re-ordered, and long enough that a page written from
 * nothing does not contain one by accident.
 */
export const STORY_PHRASE_WORDS = 3;

/**
 * How many distinct three-word runs a page needs before it counts as written
 * from the client's story.
 *
 * Four, because one or two can genuinely coincide between two people writing
 * about the same trade ("for small teams", "over the years") and four cannot.
 */
export const MIN_STORY_PHRASES = 4;

/** Findings named back to the agent; more is noise, not information. */
const MAX_FINDINGS_LISTED = 6;

export type PersonAbsentCode =
  | 'story_not_on_about_page'
  | 'portrait_not_placed';

export interface PersonAbsentFinding {
  code: PersonAbsentCode;
  /** The built page the material should have been on. */
  path: string;
}

export interface PersonAbsentInput {
  /** Industry chip and free-text niche, in either order. */
  businessType?: string | null;
  /** The person section off the brief, or null when nobody was asked. */
  person: BriefPerson | null;
  /**
   * Site-rooted path of the client's portrait, when the brief carries one.
   * '' or absent means the brief has no photograph of them.
   */
  portraitPath?: string | null;
}

export type PersonAbsentVerdict =
  | { verdict: 'pass' }
  /** Not a portfolio, or nobody was ever asked: the gate has no opinion. */
  | { verdict: 'not-applicable' }
  /** The brief has the material and the site does not use it. */
  | { verdict: 'fail'; findings: PersonAbsentFinding[]; issue: string }
  /** The brief lacks the material. The ask, in the client's words. */
  | { verdict: 'hold'; ask: string };

// ───────────────────────────────────────────────────────────────────────────
// Reading the built site
// ───────────────────────────────────────────────────────────────────────────

/**
 * The part of a built file the gate may read, or null when the file has no
 * about section in it. Mirrors `workRegion` next door.
 */
function aboutRegion(path: string, content: string): string | null {
  if (!HTML_FILE.test(path)) return null;
  const segments = path.replace(/^\/+/, '').split('/');
  if (segments.some((segment) => ABOUT_SECTIONS.includes(segment))) {
    return content;
  }
  const lower = content.toLowerCase();
  return ABOUT_MARKERS.some((marker) => lower.includes(marker))
    ? content
    : null;
}

/**
 * Everything that is not a letter or a digit, for the purpose of splitting
 * prose into words.
 *
 * Written as explicit ranges rather than `\p{L}` because this package is
 * consumed as raw TypeScript by flowstarter-main, whose tsconfig target
 * predates the `u` flag. The ranges cover Latin, Latin Extended (the
 * Romanian diacritics this product sells into) and Cyrillic, which is every
 * script a client's own words have arrived in.
 */
const NOT_A_WORD_CHARACTER =
  /[^0-9a-zA-Z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]+/g;

/** Visible words, with markup, entities and punctuation taken out. */
export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .toLowerCase()
    .replace(NOT_A_WORD_CHARACTER, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text: string): string[] {
  return visibleText(text).split(' ').filter(Boolean);
}

/**
 * Every run of `size` consecutive words in a text, once each.
 *
 * A text shorter than `size` yields itself, so a one-line story is still
 * matchable rather than silently unmatchable.
 */
export function shingles(
  text: string,
  size: number = STORY_SHINGLE_WORDS,
): string[] {
  const list = words(text);
  if (list.length === 0) return [];
  if (list.length < size) return [list.join(' ')];
  const seen = new Set<string>();
  for (let i = 0; i + size <= list.length; i += 1) {
    seen.add(list.slice(i, i + size).join(' '));
  }
  // `Array.from` rather than spreading: this package is consumed as raw
  // TypeScript by flowstarter-main, whose tsconfig target predates iterator
  // spreading.
  return Array.from(seen);
}

/**
 * How many distinct runs of the story, at this length, survive on the page.
 *
 * Exported because it is the measurement the whole gate turns on, and a
 * number is far easier to reason about in a failure than a boolean.
 */
export function storyPhraseMatches(
  pageHtml: string,
  story: string,
  size: number = STORY_PHRASE_WORDS,
): number {
  const pageText = visibleText(pageHtml);
  if (!pageText) return 0;
  return shingles(story, size).filter(
    (run) => run.length > 0 && pageText.includes(run),
  ).length;
}

/**
 * True when this page was written from the client's story.
 *
 * One long run of their words, or several short ones. Exported because the
 * test for the rule is more useful than a test for the whole gate.
 */
export function pageCarriesStory(pageHtml: string, story: string): boolean {
  if (storyPhraseMatches(pageHtml, story, STORY_SHINGLE_WORDS) > 0) return true;
  return (
    storyPhraseMatches(pageHtml, story, STORY_PHRASE_WORDS) >=
    MIN_STORY_PHRASES
  );
}

/** True when the page references the client's own photograph. */
export function pagePlacesPortrait(
  pageHtml: string,
  portraitPath: string,
): boolean {
  return pageHtml.includes(portraitPath);
}

// ───────────────────────────────────────────────────────────────────────────
// The rule
// ───────────────────────────────────────────────────────────────────────────

/**
 * What the ask says when the brief simply has neither.
 *
 * Phrased for the client, not for the agent: this text reaches them through
 * the job's hold, and "PERSON_ABSENT: no first-person narrative detected" is
 * not something anybody can act on. No em dashes, no emoji.
 */
export const PERSON_ABSENT_ASK =
  'Your site is about you, and right now we have nothing of you to put on ' +
  'it. Two things unblock the build, and either one is enough to start: a ' +
  'few sentences about who you are and how you work, in your own words, and ' +
  'one photograph of you. We will quote what you write rather than rewrite ' +
  'it, and we will not make anything up about your life to fill the gap.';

/**
 * Judges one built site against the person on its brief.
 *
 * Pure: no I/O, no clock, no model. Same site and same brief, same verdict,
 * which is what lets a failed pass be retried and compared.
 */
export function judgePersonAbsent(
  files: readonly { path: string; content: string }[],
  input: PersonAbsentInput,
): PersonAbsentVerdict {
  if (siteKindFor(input.businessType) !== 'portfolio') {
    return { verdict: 'not-applicable' };
  }
  // Nobody was ever asked. Every workspace taken before the person section
  // existed is in this state, and a gate that guessed here would fail builds
  // for having no data.
  if (!input.person) return { verdict: 'not-applicable' };

  const story = personStoryText(input.person);
  const portraitPath = (input.portraitPath ?? '').trim();

  // The brief has neither. Nothing the agent can write fixes that, so this is
  // a question for the client rather than another attempt.
  if (!hasPersonStory(input.person) && !portraitPath) {
    return { verdict: 'hold', ask: PERSON_ABSENT_ASK };
  }

  const aboutPages = files.filter(
    (file) => aboutRegion(file.path, file.content) !== null,
  );

  // A portfolio with no about page at all is the same defect wearing a
  // different hat: the material exists and the site does not carry it.
  if (aboutPages.length === 0) {
    const findings: PersonAbsentFinding[] = [];
    if (story) findings.push({ code: 'story_not_on_about_page', path: '(no about page)' });
    if (portraitPath) {
      findings.push({ code: 'portrait_not_placed', path: '(no about page)' });
    }
    return {
      verdict: 'fail',
      findings,
      issue: describePersonAbsentFindings(findings, input),
    };
  }

  const findings: PersonAbsentFinding[] = [];

  if (story && !aboutPages.some((file) => pageCarriesStory(file.content, story))) {
    for (const file of aboutPages) {
      findings.push({ code: 'story_not_on_about_page', path: file.path });
    }
  }

  if (
    portraitPath &&
    !files.some((file) => pagePlacesPortrait(file.content, portraitPath))
  ) {
    for (const file of aboutPages) {
      findings.push({ code: 'portrait_not_placed', path: file.path });
    }
  }

  if (findings.length === 0) return { verdict: 'pass' };
  return {
    verdict: 'fail',
    findings,
    issue: describePersonAbsentFindings(findings, input),
  };
}

/**
 * The findings, phrased once: as feedback the agent can act on and as the
 * failure an operator reads. Same sentences either way, so what the job log
 * says and what the agent was told can never drift apart.
 */
export function describePersonAbsentFindings(
  findings: readonly PersonAbsentFinding[],
  input: PersonAbsentInput,
): string {
  const story = personStoryText(input.person);
  const portraitPath = (input.portraitPath ?? '').trim();
  const parts: string[] = [];

  const storyPages = findings
    .filter((finding) => finding.code === 'story_not_on_about_page')
    .map((finding) => finding.path)
    .slice(0, MAX_FINDINGS_LISTED);
  if (storyPages.length > 0) {
    parts.push(
      `The about page does not contain the client's own story. Pages checked: ` +
        `${storyPages.join(', ')}. Rewrite the about section from these ` +
        'sentences, quoting them and editing only for length and rhythm. Do ' +
        'not add a fact, a year, a place or a qualification that is not in ' +
        `them:\n${story}`,
    );
  }

  const portraitPages = findings
    .filter((finding) => finding.code === 'portrait_not_placed')
    .map((finding) => finding.path)
    .slice(0, MAX_FINDINGS_LISTED);
  if (portraitPages.length > 0) {
    parts.push(
      `The client's own photograph is on disk at ${portraitPath} and no page ` +
        `references it. Place it in the about section of ${portraitPages.join(
          ', ',
        )}. It is a photograph of the client: never caption it as anything ` +
        'else, and never use the template\'s demo-persona art in its place.',
    );
  }

  return (
    `${PERSON_ABSENT}: this is a personal site and the person is not on it. ` +
    parts.join(' ')
  );
}
