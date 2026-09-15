/**
 * A file path is not a sentence.
 *
 * `src/components/Services.astro` is where the services section lives, and
 * "the services section" is what a client should read. This is the mapping,
 * and it is a table of rules rather than anything clever: a table can be read,
 * argued with and tested, and when it has no answer it says so by returning
 * the generic subject instead of guessing at a name.
 *
 * The rule works on the shape the Astro templates actually have -- pages under
 * `src/pages`, blocks under `src/components`, the label content under
 * `src/content`, styling under `src/styles`, everything a build needs but
 * nobody reads under `src/lib`, `src/scripts` and the config files. It runs on
 * the basename and the directory, never on file contents, so it costs nothing
 * to call on every tool event.
 */
import type { ActivitySubject } from './events';

/** Lower-cased, slashes normalised, query and leading ./ removed. */
function normalise(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

/**
 * `src/pages/services/[slug].astro` -> `services`, `src/pages/index.astro` ->
 * `index`. A nested route is named by its directory, because that is the page
 * a reader thinks of: the services pages, not the slug file.
 */
function routeNameOf(rest: string): string {
  const withoutExt = rest.replace(/\.(astro|md|mdx|html)$/, '');
  const segments = withoutExt.split('/').filter(Boolean);
  if (segments.length === 0) return 'index';
  const last = segments[segments.length - 1] ?? '';
  // A dynamic segment names nothing; fall back to the folder that holds it.
  if (last.startsWith('[') && segments.length > 1) {
    return segments[segments.length - 2] ?? 'index';
  }
  return last;
}

const PAGE_BY_ROUTE: Record<string, ActivitySubject> = {
  index: 'page.home',
  home: 'page.home',
  about: 'page.about',
  story: 'page.about',
  services: 'page.services',
  expertise: 'page.services',
  work: 'page.work',
  portfolio: 'page.work',
  projects: 'page.work',
  'case-studies': 'page.work',
  contact: 'page.contact',
  pricing: 'page.pricing',
  plans: 'page.pricing',
  gallery: 'page.gallery',
  photos: 'page.gallery',
  book: 'page.booking',
  booking: 'page.booking',
  appointments: 'page.booking',
  blog: 'page.blog',
  news: 'page.blog',
  privacy: 'page.legal',
  terms: 'page.legal',
  imprint: 'page.legal',
  legal: 'page.legal',
  cookies: 'page.legal',
};

/**
 * Matched against the component's file name with the extension and any
 * separators removed, so `CTASection.astro`, `cta-section.astro` and
 * `ctaSection.astro` all land on the same row. Order matters: the first
 * fragment found wins, so the more specific names come first.
 */
const SECTION_RULES: ReadonlyArray<readonly [string, ActivitySubject]> = [
  ['abouthero', 'section.about'],
  ['aboutstory', 'section.about'],
  ['contacthero', 'section.contact'],
  ['contactform', 'section.contact'],
  ['contactdetails', 'section.contact'],
  ['casestudies', 'section.work'],
  ['testimonial', 'section.testimonials'],
  ['review', 'section.testimonials'],
  ['hero', 'section.hero'],
  ['service', 'section.services'],
  ['expertise', 'section.services'],
  ['pricing', 'section.pricing'],
  ['plans', 'section.pricing'],
  ['gallery', 'section.gallery'],
  ['portfolio', 'section.work'],
  ['work', 'section.work'],
  ['faq', 'section.faq'],
  ['question', 'section.faq'],
  ['booking', 'section.booking'],
  ['calendar', 'section.booking'],
  ['stats', 'section.stats'],
  ['header', 'section.header'],
  ['nav', 'section.header'],
  ['followbar', 'section.header'],
  ['footer', 'section.footer'],
  ['cta', 'section.cta'],
  ['contact', 'section.contact'],
  ['about', 'section.about'],
];

function sectionOf(fileName: string): ActivitySubject {
  const flattened = fileName
    .replace(/\.(astro|tsx|jsx|vue|svelte|html)$/, '')
    .replace(/[^a-z0-9]/g, '');
  for (const [fragment, subject] of SECTION_RULES) {
    if (flattened.includes(fragment)) return subject;
  }
  return 'section.other';
}

const IMAGE_EXTENSIONS =
  /\.(png|jpe?g|webp|avif|gif|svg|ico|mp4|webm|woff2?|ttf|otf)$/;

/**
 * The one rule. Give it a workspace-relative path, get back the subject token
 * the timeline will speak. Anything it cannot place is `file.other`: the step
 * happened, and we decline to name it more precisely than we know.
 */
export function subjectForPath(path: string): ActivitySubject {
  const clean = normalise(path);
  if (!clean) return 'file.other';

  const pagesAt = clean.indexOf('src/pages/');
  if (pagesAt >= 0) {
    const route = routeNameOf(clean.slice(pagesAt + 'src/pages/'.length));
    return PAGE_BY_ROUTE[route] ?? 'page.other';
  }

  const componentsAt = clean.indexOf('src/components/');
  if (componentsAt >= 0) {
    const rest = clean.slice(componentsAt + 'src/components/'.length);
    // `contact/ContactFormPanel.astro` is the contact section whatever the
    // file inside the folder is called, so the folder gets first say.
    const segments = rest.split('/').filter(Boolean);
    if (segments.length > 1) {
      const folder = sectionOf(segments[0] ?? '');
      if (folder !== 'section.other') return folder;
    }
    return sectionOf(segments[segments.length - 1] ?? '');
  }

  if (clean.includes('src/layouts/')) return 'section.header';
  if (clean.includes('src/content/') || clean.endsWith('site-data.ts'))
    return 'content.site';
  if (clean.includes('src/styles/') || clean.endsWith('.css'))
    return 'style.site';
  if (IMAGE_EXTENSIONS.test(clean)) return 'image.site';
  if (
    clean.startsWith('public/') ||
    clean.includes('/public/') ||
    clean.includes('src/assets/')
  )
    return 'image.site';
  if (
    clean.includes('src/lib/') ||
    clean.includes('src/scripts/') ||
    /(^|\/)(astro\.config|package\.json|tsconfig|tailwind\.config|netlify\.toml)/.test(
      clean,
    )
  )
    return 'setup.site';

  return 'file.other';
}

/**
 * The same rule for a list of paths, keeping the order and dropping the
 * duplicates. Used where a pass reports every path it touched at once.
 */
export function subjectsForPaths(paths: readonly string[]): ActivitySubject[] {
  const seen = new Set<ActivitySubject>();
  const out: ActivitySubject[] = [];
  for (const path of paths) {
    const subject = subjectForPath(path);
    if (seen.has(subject)) continue;
    seen.add(subject);
    out.push(subject);
  }
  return out;
}

/**
 * The gate subjects, keyed off the failure codes the build already throws.
 * A code with no row here is `gate.other` rather than an invented gate name.
 */
const GATE_BY_CODE: Record<string, ActivitySubject> = {
  APPROVED_EDIT_DROPPED: 'gate.changes',
  CHANGE_REQUEST_NOT_APPLIED: 'gate.changes',
  CHANGE_REQUEST_REPAIR_DAMAGED_SITE: 'gate.changes',
  PAGE_BUDGET_EXCEEDED: 'gate.pages',
  PLACEHOLDER_COPY_SHIPPED: 'gate.copy',
  INVENTED_PROJECT: 'gate.copy',
  PLACEHOLDER_IMAGE_SHIPPED: 'gate.images',
  PORTRAIT_MISPLACED: 'gate.images',
  GENERATED_HTML_UNSAFE: 'gate.markup',
  TEMPLATE_EFFECTS_DROPPED: 'gate.markup',
  BUILD_LEASE_LOST: 'gate.build',
  FULL_SITE_BUILD_FAILED: 'gate.build',
  CHANGE_REQUEST_BUILD_FAILED: 'gate.build',
  SITE_REBUILD_FAILED: 'gate.build',
  OPERATOR_EDIT_BUILD_FAILED: 'gate.build',
  EMPTY_IMAGE_SHIPPED: 'gate.images',
  INVALID_PROJECT_STATE: 'gate.other',
  CHANGE_REQUEST_MISSING: 'gate.other',
  OPERATOR_EDIT_MANIFEST_MISSING: 'gate.other',
  OPERATOR_EDIT_INVALID_STATE: 'gate.other',
};

/** The subject for a gate, from the failure code the pipeline already uses. */
export function subjectForFailureCode(code: string): ActivitySubject {
  return GATE_BY_CODE[code] ?? 'gate.other';
}
