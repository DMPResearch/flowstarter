/**
 * The `TEMPLATE_EFFECTS_DROPPED` gate: the motion a template ships has to
 * survive the agent that fills it with a client's words.
 *
 * Every other output gate asks whether the built site is honest, safe or
 * complete. None of them asks whether it still *moves*. A delivered portfolio
 * made this visible: the compiled pages carried the template's own script
 * bundle — three `IntersectionObserver`s and the reveal selectors — and not
 * one element the observers could attach to, because the agent had rewritten
 * the section components and written new markup for them. The script was
 * there, the hooks were gone, and every gate passed.
 *
 * The rule this module states is narrow and mechanical:
 *
 *   A build may not remove an effect hook that the site it started from had.
 *
 * "Effect hook" is not a taste judgement and is never hand-listed. It is
 * derived from the template's own source by three rules, all of them about
 * something in one file reaching into another:
 *
 *   - **Script-bound attributes.** Whatever `src/scripts/**` selects on —
 *     `[data-about-reveal]`, `[data-journey-card]`, `[data-stats-section]`.
 *     A `data-` attribute no loaded script mentions is ordinary markup and is
 *     not the gate's business; one a script mentions is a contract between two
 *     files, and only one of the two is being rewritten.
 *   - **State-class reveals.** A CSS rule whose selector mentions a class the
 *     script layer adds (`.is-visible`, `.is-active`, `.is-observing`) is an
 *     animation waiting for that script. The class it hangs off is the hook.
 *   - **Sticky sections.** A rule declaring `position: sticky` is the
 *     "scroll-stopping" effect, and it is invisible the moment the element it
 *     applies to is renamed away.
 *
 * The manifest is *derived*, never stored in the workspace the agent can
 * write to: `deriveTemplateEffectsManifest` runs over the seed the build
 * started from, which the workflow holds in memory. So there is no file to
 * fake, no baseline to edit, and nothing to keep in sync. `effects.json` in
 * each template directory is the same derivation written down for humans to
 * review, kept honest by a test rather than read by the product.
 *
 * Nothing here counts elements. A site with three services instead of six has
 * three service cards and that is a content decision, not a dropped effect;
 * requiring a count would fail honest builds. Presence per page is the floor,
 * and a floor is what a baseline has to be when the thing above it is allowed
 * to vary.
 *
 * `workflows.ts` fails the build with {@link TEMPLATE_EFFECTS_DROPPED} after
 * one repair pass, the same shape as `GENERATED_HTML_UNSAFE`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parse, type DefaultTreeAdapterMap } from 'parse5';

/** The job fails with this when a build dropped the template's effect layer. */
export const TEMPLATE_EFFECTS_DROPPED = 'TEMPLATE_EFFECTS_DROPPED';

/** A file as every reader in this package passes one around. */
export interface TemplateEffectsFile {
  path: string;
  content: string;
}

/**
 * One component that carries an effect, and how to tell whether a built page
 * still has it.
 *
 * The `markers` are what make this gate safe to run against a paid build. A
 * site whose client has no testimonials is *told* not to render a testimonial
 * section, and a section that is not there has not lost anything; a section
 * that is still there and has lost the attribute its script reads has. So the
 * question is asked in two steps — is this component still on the page, and
 * if it is, does it still carry its hooks — and the first step is answered by
 * the class names the component's own markup writes out.
 *
 * This is not a theory. The delivered portfolio that prompted all of this had
 * dropped `Stats` and `Testimonial` from its homepage entirely, which is a
 * content decision, and had also rewritten `Expertise` so that
 * `expertise__left` and `expertise__right` survived and the
 * `expertise__left-inner` that carried `position: sticky` did not. One of
 * those is a build that lost an effect. Only one.
 */
export interface TemplateEffectsSection {
  /** The component, posix, e.g. `src/components/Expertise.astro`. */
  component: string;
  /** Literal classes its markup writes; the page is asked about these. */
  markers: string[];
  /** Script-bound `data-` attributes its markup always renders. */
  hooks: string[];
  /** Classes whose own styles animate off a script-applied state class. */
  reveals: string[];
  /** Classes whose own styles declare `position: sticky`. */
  sticky: string[];
}

/** What one page of the template promised to render. */
export interface TemplateEffectsPage {
  /** The page's source, posix, e.g. `src/pages/about.astro`. */
  source: string;
  /**
   * Where `astro build` puts it, e.g. `about/index.html`. Null for a dynamic
   * route (`[slug].astro`), whose output names cannot be known from source;
   * such a page still contributes to the template's declared contract but is
   * not measured against the build.
   */
  output: string | null;
  /** The effect-carrying components in this page's import graph. */
  sections: string[];
}

/** A template's effect contract, derived from its source. */
export interface TemplateEffectsManifest {
  schemaVersion: 1;
  /** Classes the loaded scripts add, remove or toggle. */
  stateClasses: string[];
  /** `data-` attributes the loaded scripts select on. */
  boundAttributes: string[];
  /** Every effect-carrying component, keyed by path and stated once. */
  sections: TemplateEffectsSection[];
  pages: TemplateEffectsPage[];
  /**
   * Effects the template declares but can never run: a hook module under
   * `src/scripts/` nothing imports, and a selector the scripts bind that no
   * page renders. Both are template defects rather than build defects — a
   * dead `useJourneyTimeline` is why a delivered site's step timeline showed
   * step one and never moved — so they are reported here and asserted on by
   * the template suite, not by the gate that fails a client's build.
   */
  orphans: {
    modules: string[];
    bindings: string[];
  };
}

/** One way a build fell short of the contract. */
export interface TemplateEffectsFinding {
  /** The built page, e.g. `about/index.html`. */
  page: string;
  /** The component that was supposed to carry it. */
  section: string;
  kind: 'hook' | 'reveal' | 'sticky';
  /** The attribute or class that went missing. */
  name: string;
  /** Why it counts as missing, in the words the repair pass is given. */
  detail: string;
}

/* -------------------------------------------------------------------------
 * Source reading
 * ---------------------------------------------------------------------- */

const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.ts', '.mts'] as const;
const PAGES_PREFIX = 'src/pages/';

function posixPath(path: string): string {
  return path.split('\\').join('/');
}

/** `a/b/../c.js` → `a/c.js`, with no access to anything above the root. */
function resolveRelative(fromFile: string, specifier: string): string {
  const base = posixPath(fromFile).split('/').slice(0, -1);
  for (const segment of posixPath(specifier).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      base.pop();
      continue;
    }
    base.push(segment);
  }
  return base.join('/');
}

/**
 * An `.astro` file's template body: frontmatter, `<style>` and `<script>`
 * removed, so a selector quoted inside a script block is never mistaken for
 * markup the page renders.
 */
function astroBody(source: string): string {
  let body = source;
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end >= 0) body = body.slice(end + 4);
  }
  return body
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ');
}

/** An `.astro` file's frontmatter, where its imports live. */
function astroFrontmatter(source: string): string {
  if (!source.startsWith('---')) return '';
  const end = source.indexOf('\n---', 3);
  return end < 0 ? '' : source.slice(3, end);
}

function blocksOf(source: string, tag: 'style' | 'script'): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  return Array.from(source.matchAll(pattern), (match) => match[1] ?? '');
}

const IMPORT_SPECIFIER = /import\s+(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]/g;

function importSpecifiers(source: string): string[] {
  return Array.from(source.matchAll(IMPORT_SPECIFIER), (match) => match[1]!);
}

/* -------------------------------------------------------------------------
 * The script layer
 * ---------------------------------------------------------------------- */

/**
 * Every script the template actually loads, as text.
 *
 * Reachability, not "everything under `src/scripts/`": a hook module nothing
 * imports cannot bind anything, and counting its selectors would let a
 * template declare effects it never runs. The unreachable modules are
 * reported separately as orphans.
 */
function loadedScripts(
  byPath: Map<string, string>,
  astroFiles: string[],
): { sources: string[]; reachable: Set<string> } {
  const sources: string[] = [];
  const reachable = new Set<string>();
  const queue: string[] = [];

  const enqueue = (from: string, specifier: string): void => {
    if (!specifier.startsWith('.')) return;
    const resolved = resolveRelative(from, specifier);
    const candidates = [resolved];
    for (const extension of SCRIPT_EXTENSIONS) {
      if (resolved.endsWith(extension)) {
        const stem = resolved.slice(0, -extension.length);
        for (const swap of SCRIPT_EXTENSIONS) candidates.push(`${stem}${swap}`);
      } else {
        candidates.push(`${resolved}${extension}`);
      }
    }
    for (const candidate of candidates) {
      if (!byPath.has(candidate) || reachable.has(candidate)) continue;
      reachable.add(candidate);
      queue.push(candidate);
      return;
    }
  };

  for (const file of astroFiles) {
    for (const block of blocksOf(byPath.get(file) ?? '', 'script')) {
      sources.push(block);
      for (const specifier of importSpecifiers(block)) enqueue(file, specifier);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const content = byPath.get(current) ?? '';
    sources.push(content);
    for (const specifier of importSpecifiers(content)) {
      enqueue(current, specifier);
    }
  }

  return { sources, reachable };
}

/** `[data-journey-card]`, `[data-reveal="about-background-title"]`, … */
const BOUND_SELECTOR =
  /\[(data-[a-z0-9-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?\]/g;

/** A state class is a class a script puts on an element: `is-` by convention. */
const STATE_CLASS_LITERAL = /['"](is-[a-z0-9-]+)['"]/g;

/* -------------------------------------------------------------------------
 * CSS
 * ---------------------------------------------------------------------- */

interface CssRule {
  selector: string;
  declarations: string;
}

/**
 * Style text as a flat list of rules.
 *
 * Deliberately small: at-rules are descended into rather than understood, so
 * a `position: sticky` inside a `@media` block is found and a `@keyframes`
 * body contributes its steps as rules with useless selectors, which nothing
 * downstream asks about. Written by hand rather than with a CSS parser
 * because the only questions asked of the result are "does this selector
 * mention this class" and "does this block declare this property", and both
 * survive minification, which a dependency's opinion about nesting may not.
 */
export function cssRules(style: string): CssRule[] {
  const rules: CssRule[] = [];
  const withoutComments = style.replace(/\/\*[\s\S]*?\*\//g, ' ');
  let index = 0;

  const parseBlock = (prefixEnd: number): void => {
    let depth = 0;
    let start = index;
    while (index < withoutComments.length) {
      const char = withoutComments[index]!;
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const body = withoutComments.slice(start + 1, index);
          const selector = withoutComments.slice(prefixEnd, start).trim();
          if (selector.startsWith('@')) {
            // An at-rule wraps ordinary rules; read them at their own level.
            for (const nested of cssRules(body)) rules.push(nested);
          } else if (selector.length > 0) {
            rules.push({ selector, declarations: body });
          }
          index += 1;
          return;
        }
      }
      index += 1;
    }
    // Unbalanced input: whatever is left is not a rule anyone can rely on.
  };

  while (index < withoutComments.length) {
    const open = withoutComments.indexOf('{', index);
    if (open < 0) break;
    const prefixEnd = index;
    index = open;
    parseBlock(prefixEnd);
  }
  return rules;
}

/** Whether a selector mentions `.name` as a whole class token. */
function selectorHasClass(selector: string, name: string): boolean {
  let from = 0;
  for (;;) {
    const at = selector.indexOf(`.${name}`, from);
    if (at < 0) return false;
    const after = selector[at + name.length + 1];
    if (after === undefined || !/[A-Za-z0-9_-]/.test(after)) return true;
    from = at + 1;
  }
}

/** Every class token a selector mentions, in source order. */
function selectorClasses(selector: string): string[] {
  return Array.from(
    selector.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g),
    (match) => match[1]!,
  );
}

function declaresSticky(declarations: string): boolean {
  return /position\s*:\s*sticky/i.test(declarations);
}

/* -------------------------------------------------------------------------
 * Deriving the manifest
 * ---------------------------------------------------------------------- */

/** Where `astro build` puts a page source, with the default directory format. */
export function pageOutputPath(source: string): string | null {
  const relative = posixPath(source).slice(PAGES_PREFIX.length);
  if (!relative.endsWith('.astro')) return null;
  const route = relative.slice(0, -'.astro'.length);
  // A dynamic route's output names come from `getStaticPaths`, which is code.
  if (route.includes('[')) return null;
  if (route === 'index') return 'index.html';
  if (route === '404') return '404.html';
  if (route.endsWith('/index')) return `${route}.html`;
  return `${route}/index.html`;
}

/** Never part of a template's source, and never worth walking. */
const SKIPPED_SOURCE_DIRS = new Set([
  'node_modules',
  'dist',
  '.astro',
  '.git',
  '.cache',
]);

/** The files the derivation reads: markup, scripts and styles. */
const SOURCE_FILE = /\.(astro|[mc]?js|[mc]?ts|css)$/i;

/**
 * A template's own source on disk, in the shape a scaffold arrives in.
 *
 * The derivation itself takes files rather than a directory, because the two
 * callers that matter — the gate, reading the seed a build started from —
 * never have a directory to read. This is for the two that do: the script
 * that writes `effects.json` and the suite that builds the real templates.
 */
export async function readTemplateEffectsSource(
  templateDir: string,
): Promise<TemplateEffectsFile[]> {
  const files: TemplateEffectsFile[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIPPED_SOURCE_DIRS.has(entry.name)) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile() || !SOURCE_FILE.test(entry.name)) continue;
      files.push({
        path: relative(templateDir, absolute).split(sep).join('/'),
        content: await readFile(absolute, 'utf8'),
      });
    }
  };
  await walk(join(templateDir, 'src'));
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * The effect contract of the site these files describe.
 *
 * Runs over a scaffold — the template's own files, or the seed a build
 * starts from, which is the same shape. Everything it reports comes from the
 * source it was handed; nothing is configured and nothing is hard-coded.
 */
export function deriveTemplateEffectsManifest(
  files: readonly TemplateEffectsFile[],
): TemplateEffectsManifest {
  const byPath = new Map<string, string>();
  for (const file of files) byPath.set(posixPath(file.path), file.content);

  const astroFiles = [...byPath.keys()]
    .filter((path) => path.endsWith('.astro'))
    .sort();
  const { sources, reachable } = loadedScripts(byPath, astroFiles);
  const scriptText = sources.join('\n');

  const boundAttributes = new Set<string>();
  const boundSelectors = new Set<string>();
  for (const match of scriptText.matchAll(BOUND_SELECTOR)) {
    boundAttributes.add(match[1]!);
    const value = match[2] ?? match[3];
    boundSelectors.add(
      value === undefined ? match[1]! : `${match[1]}=${value}`,
    );
  }
  const stateClasses = new Set<string>();
  for (const match of scriptText.matchAll(STATE_CLASS_LITERAL)) {
    stateClasses.add(match[1]!);
  }

  /** Which `.astro` files a page pulls in, transitively, itself included. */
  const graphOf = (page: string): string[] => {
    const seen = new Set<string>([page]);
    const queue = [page];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const frontmatter = astroFrontmatter(byPath.get(current) ?? '');
      for (const specifier of importSpecifiers(frontmatter)) {
        if (!specifier.startsWith('.') || !specifier.endsWith('.astro')) {
          continue;
        }
        const resolved = resolveRelative(current, specifier);
        if (!byPath.has(resolved) || seen.has(resolved)) continue;
        seen.add(resolved);
        queue.push(resolved);
      }
    }
    return [...seen].sort();
  };

  /** Attributes the markup renders whatever the data says. */
  const unconditionalHooks = (body: string): Set<string> => {
    const found = new Set<string>();
    const pattern = /\bdata-[a-z0-9-]+/g;
    for (const match of body.matchAll(pattern)) {
      const attribute = match[0];
      if (!boundAttributes.has(attribute)) continue;
      const after = body.slice(match.index + attribute.length);
      // `data-x={expr}` renders nothing when the expression is nullish, so it
      // is not something a build can be held to. `data-x` and `data-x="lit"`
      // always reach the page.
      if (/^\s*=\s*\{/.test(after)) continue;
      if (/^[A-Za-z0-9-]/.test(after)) continue;
      found.add(attribute);
    }
    return found;
  };

  /** The literal classes a component's own markup writes out. */
  const markerClasses = (body: string): Set<string> => {
    const found = new Set<string>();
    for (const match of body.matchAll(/\bclass\s*=\s*"([^"]*)"/g)) {
      for (const token of match[1]!.split(/\s+/)) {
        // A class built from an expression (`${className}`) is not a name a
        // page can be asked about.
        if (token && !token.includes('{') && !token.includes('$')) {
          found.add(token);
        }
      }
    }
    return found;
  };

  /**
   * How many components write each class.
   *
   * A marker has to identify *this* section, and a template's shared
   * furniture does not: `container`, `section-title` and `section-label` are
   * written by a dozen components, so a page that still has a heading would
   * look like a page that still has every section. Only a class exactly one
   * component writes can answer "is this section still here".
   */
  const componentsPerClass = new Map<string, number>();
  for (const component of astroFiles) {
    for (const name of markerClasses(astroBody(byPath.get(component) ?? ''))) {
      componentsPerClass.set(name, (componentsPerClass.get(name) ?? 0) + 1);
    }
  }

  /**
   * The other half of "shared furniture": every class the template's global
   * stylesheets style. `section-label` happens to be written by one component
   * today and is a utility the next page can use tomorrow, so it identifies
   * nothing.
   */
  const globalClasses = new Set<string>();
  for (const [path, content] of byPath) {
    if (!path.startsWith('src/styles/') || !path.endsWith('.css')) continue;
    for (const rule of cssRules(content)) {
      for (const name of selectorClasses(rule.selector))
        globalClasses.add(name);
    }
  }

  /** What one component contributes, whichever pages happen to import it. */
  const sectionOf = (component: string): TemplateEffectsSection | undefined => {
    const source = byPath.get(component) ?? '';
    const hooks = unconditionalHooks(astroBody(source));
    const reveals = new Set<string>();
    const sticky = new Set<string>();
    for (const block of blocksOf(source, 'style')) {
      for (const rule of cssRules(block)) {
        const classes = selectorClasses(rule.selector);
        if (classes.length === 0) continue;
        if (classes.some((name) => stateClasses.has(name))) {
          // The element the animation hangs off: the first class in the
          // selector that is not the state the script toggles.
          const base = classes.find((name) => !stateClasses.has(name));
          if (base) reveals.add(base);
        }
        if (declaresSticky(rule.declarations)) {
          const last = classes[classes.length - 1]!;
          if (!stateClasses.has(last)) sticky.add(last);
        }
      }
    }
    if (hooks.size === 0 && reveals.size === 0 && sticky.size === 0) {
      return undefined;
    }
    const markers = new Set(
      [...markerClasses(astroBody(source))].filter(
        (name) =>
          componentsPerClass.get(name) === 1 &&
          !globalClasses.has(name) &&
          !stateClasses.has(name),
      ),
    );
    // Without a class of its own there is no way to ask whether this
    // component is still on the page, and a rule that cannot tell "removed"
    // from "rewritten" is a rule that fails honest builds.
    if (markers.size === 0) return undefined;
    return {
      component,
      markers: [...markers].sort(),
      hooks: [...hooks].sort(),
      reveals: [...reveals].sort(),
      sticky: [...sticky].sort(),
    };
  };

  const sections = new Map<string, TemplateEffectsSection>();
  const renderedHooks = new Set<string>();
  for (const component of astroFiles) {
    for (const hook of unconditionalHooks(
      astroBody(byPath.get(component) ?? ''),
    )) {
      renderedHooks.add(hook);
    }
    const section = sectionOf(component);
    if (section) sections.set(component, section);
  }

  const pages: TemplateEffectsPage[] = [];
  for (const page of astroFiles.filter((path) =>
    path.startsWith(PAGES_PREFIX),
  )) {
    pages.push({
      source: page,
      output: pageOutputPath(page),
      sections: graphOf(page).filter((component) => sections.has(component)),
    });
  }

  const orphanModules = [...byPath.keys()]
    .filter(
      (path) =>
        path.startsWith('src/scripts/') &&
        SCRIPT_EXTENSIONS.some((extension) => path.endsWith(extension)) &&
        !reachable.has(path),
    )
    .sort();
  const orphanBindings = [...boundSelectors]
    .filter((selector) => {
      const attribute = selector.split('=')[0]!;
      return !renderedHooks.has(attribute);
    })
    .sort();

  return {
    schemaVersion: 1,
    stateClasses: [...stateClasses].sort(),
    boundAttributes: [...boundAttributes].sort(),
    sections: [...sections.values()],
    pages,
    orphans: { modules: orphanModules, bindings: orphanBindings },
  };
}

/* -------------------------------------------------------------------------
 * Measuring a build against it
 * ---------------------------------------------------------------------- */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

function isElement(node: Node): node is Element {
  return 'tagName' in node && Array.isArray((node as Element).attrs);
}

/** Every attribute name and class token a compiled page carries. */
function pageTokens(html: string): {
  attributes: Set<string>;
  classes: Set<string>;
} {
  const attributes = new Set<string>();
  const classes = new Set<string>();
  const walk = (node: Node): void => {
    if (isElement(node)) {
      for (const attribute of node.attrs) {
        attributes.add(attribute.name.toLowerCase());
        if (attribute.name.toLowerCase() !== 'class') continue;
        for (const token of attribute.value.split(/\s+/)) {
          if (token) classes.add(token);
        }
      }
    }
    const children = (node as { childNodes?: Node[] }).childNodes;
    if (children) for (const child of children) walk(child);
  };
  walk(parse(html));
  return { attributes, classes };
}

/** `dist/about/index.html` and `about/index.html` are the same page. */
function outputName(path: string): string {
  const posix = posixPath(path);
  return posix.startsWith('dist/') ? posix.slice('dist/'.length) : posix;
}

/**
 * What the built site dropped from `manifest`.
 *
 * Only pages the build actually emitted are measured: the page set a brief
 * buys is decided long before this runs, and a page that was pruned is not a
 * page that lost its effects.
 */
export function findTemplateEffectsFindings(
  built: readonly TemplateEffectsFile[],
  manifest: TemplateEffectsManifest,
): TemplateEffectsFinding[] {
  const html = new Map<string, string>();
  const styles: string[] = [];
  for (const file of built) {
    const name = outputName(file.path);
    if (/\.html?$/i.test(name)) {
      html.set(name, file.content);
      for (const block of blocksOf(file.content, 'style')) styles.push(block);
      continue;
    }
    if (name.endsWith('.css')) styles.push(file.content);
  }
  if (html.size === 0) return [];

  const rules = styles.flatMap((style) => cssRules(style));
  const stateRuleFor = (name: string): boolean =>
    rules.some(
      (rule) =>
        selectorHasClass(rule.selector, name) &&
        selectorClasses(rule.selector).some((cls) =>
          manifest.stateClasses.includes(cls),
        ),
    );
  const stickyRuleFor = (name: string): boolean =>
    rules.some(
      (rule) =>
        selectorHasClass(rule.selector, name) &&
        declaresSticky(rule.declarations),
    );

  const sectionsByComponent = new Map(
    manifest.sections.map((section) => [section.component, section]),
  );

  const findings: TemplateEffectsFinding[] = [];
  for (const page of manifest.pages) {
    if (!page.output) continue;
    const content = html.get(page.output);
    if (content === undefined) continue;
    const { attributes, classes } = pageTokens(content);

    for (const component of page.sections) {
      const section = sectionsByComponent.get(component);
      if (!section) continue;
      // Step one: is this section still on the page at all? A brief with no
      // testimonials buys a homepage with no testimonial section, and a
      // section that is not there did not lose anything.
      if (!section.markers.some((marker) => classes.has(marker))) continue;
      const where = { page: page.output, section: component };

      for (const hook of section.hooks) {
        if (attributes.has(hook)) continue;
        findings.push({
          ...where,
          kind: 'hook',
          name: hook,
          detail:
            `the section ${component} is still on the page but nothing ` +
            `carries ${hook}, so the script that reads it has nothing to ` +
            'attach to',
        });
      }
      for (const reveal of section.reveals) {
        if (classes.has(reveal) && stateRuleFor(reveal)) continue;
        findings.push({
          ...where,
          kind: 'reveal',
          name: reveal,
          detail: classes.has(reveal)
            ? `.${reveal} is on the page but the rules that animate it are gone`
            : `the section ${component} is still on the page but nothing in ` +
              `it has the class ${reveal} its animation hangs off`,
        });
      }
      for (const name of section.sticky) {
        if (classes.has(name) && stickyRuleFor(name)) continue;
        findings.push({
          ...where,
          kind: 'sticky',
          name,
          detail: classes.has(name)
            ? `.${name} is on the page but nothing makes it position: sticky, ` +
              'so the section no longer holds while the page scrolls past it'
            : `the section ${component} is still on the page but the element ` +
              `that held it while the page scrolled, .${name}, is gone`,
        });
      }
    }
  }
  return findings;
}

/** A component whose source stopped declaring part of its own effect layer. */
export interface TemplateEffectsRegression {
  /** The component, posix, e.g. `src/components/Expertise.astro`. */
  component: string;
  /** The attributes and classes its source used to have and no longer does. */
  missing: string[];
}

/**
 * The same rule, one step earlier: source against source.
 *
 * The compiled check above is the gate of record, and it can only run where
 * there is a `dist/` to read. The funnel preview has none — it is served by a
 * dev server — and the preview is also where the damage starts, because the
 * paid build is seeded from whatever the preview agent left behind. So this
 * asks the cheap version of the question directly of the files: for every
 * section the template declared, does the workspace's own copy of that
 * component still declare the same hooks, reveal classes and sticky rules?
 *
 * A component that is gone from the workspace entirely is not reported: that
 * is a page-level decision and the page that imported it says so.
 */
export function findTemplateEffectsRegressions(
  seed: readonly TemplateEffectsFile[],
  current: readonly TemplateEffectsFile[],
): TemplateEffectsRegression[] {
  const before = deriveTemplateEffectsManifest(seed);
  const byPath = new Map(
    current.map((file) => [posixPath(file.path), file.content]),
  );
  // Derived from the *current* files so that a section is measured against
  // the same rules, not against a snapshot of the seed's own vocabulary.
  const after = new Map(
    deriveTemplateEffectsManifest(current).sections.map((section) => [
      section.component,
      section,
    ]),
  );

  const regressions: TemplateEffectsRegression[] = [];
  for (const section of before.sections) {
    if (!byPath.has(section.component)) continue;
    const now = after.get(section.component);
    const missing = [
      ...section.hooks.filter((hook) => !now?.hooks.includes(hook)),
      ...section.reveals.filter((name) => !now?.reveals.includes(name)),
      ...section.sticky.filter((name) => !now?.sticky.includes(name)),
    ];
    if (missing.length > 0) {
      regressions.push({ component: section.component, missing });
    }
  }
  return regressions;
}

/** What the preview log says, and what the repair pass is asked to fix. */
export function describeTemplateEffectsRegressions(
  regressions: readonly TemplateEffectsRegression[],
): string {
  const lines = regressions
    .slice(0, TEMPLATE_EFFECTS_LISTED)
    .map(
      (entry) => `${entry.component} no longer has ${entry.missing.join(', ')}`,
    );
  if (regressions.length > TEMPLATE_EFFECTS_LISTED) {
    lines.push(`… and ${regressions.length - TEMPLATE_EFFECTS_LISTED} more.`);
  }
  return (
    "You rewrote the markup of sections that carry the template's effects, " +
    'and the attributes and classes its scripts and stylesheets reach for by ' +
    `name are gone: ${lines.join('; ')}. Put each of those components back the ` +
    'way the template ships them — the same elements, classes, data- ' +
    'attributes and <style> block — and personalize the copy by editing the ' +
    'content files those components read instead.'
  );
}

/** The most findings named in one message; the rest are counted. */
export const TEMPLATE_EFFECTS_LISTED = 12;

function findingLines(findings: readonly TemplateEffectsFinding[]): string[] {
  const lines = findings
    .slice(0, TEMPLATE_EFFECTS_LISTED)
    .map((finding) => `${finding.page}: ${finding.detail}`);
  if (findings.length > TEMPLATE_EFFECTS_LISTED) {
    lines.push(`… and ${findings.length - TEMPLATE_EFFECTS_LISTED} more.`);
  }
  return lines;
}

/** The verdict, for the job log and the failure the build throws. */
export function describeTemplateEffectsIssue(
  findings: readonly TemplateEffectsFinding[],
): string {
  return (
    `${TEMPLATE_EFFECTS_DROPPED}: the built site lost effects the template ` +
    `ships. ${findingLines(findings).join(' ')}`
  );
}

/**
 * The repair brief, which is a different sentence from the verdict: it says
 * what to do rather than what is wrong, and what to do is always the same —
 * put the template's own markup back and edit the content instead.
 */
export function describeTemplateEffectsRepair(
  findings: readonly TemplateEffectsFinding[],
): string {
  return (
    "The site you built dropped part of the template's effect layer. These " +
    "attributes and classes are read by the template's own scripts and " +
    'stylesheets, so removing or renaming them turns off a scroll reveal, a ' +
    'sticky section or a timeline and leaves the script running against ' +
    `nothing. ${findingLines(findings).join(' ')} Restore the template's ` +
    'markup for those sections exactly as it ships — the same elements, ' +
    "classes, data- attributes and component styles — and put the client's " +
    'words back into it by editing the content, not by writing new markup.'
  );
}
