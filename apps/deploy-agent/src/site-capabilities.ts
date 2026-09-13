/**
 * What the artifact about to be served actually contains, read from the
 * files themselves so the Content-Security-Policy can be built from it.
 *
 * A policy written from a template would either be too loose (allow every
 * inline script, which is the hole) or too tight (forbid the two the platform
 * itself injects, which breaks the contact form). So the deploy agent looks:
 * it hashes the inline scripts it recognises as managed, and it notes which
 * origins the site frames. Everything it does not recognise gets no hash, and
 * therefore does not run.
 *
 * Recognised means one of two things, and both are deliberately narrow:
 *   - the script sits inside the injected lead-capture block, which carries
 *     `data-flowstarter-lead-capture` (see `integrations.ts` in
 *     `@flowstarter/agentic-codegen`), or
 *   - its text is one of the layout bootstraps this file lists.
 *
 * Parsing is `HTMLRewriter`, Bun's streaming HTML parser, for the same reason
 * the build gate uses `parse5`: a regular expression over markup a model
 * wrote is a bypass waiting to happen. Nothing here is the enforcement — the
 * `GENERATED_HTML_UNSAFE` gate in the build worker already refused this
 * artifact if it carried anything else — this is the containment that holds
 * when the gate is wrong.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The marker attribute the injected lead-capture block carries. Mirrors
 * `LEAD_CAPTURE_MARKER_ATTRIBUTE` in the codegen package's `markup-policy.ts`;
 * the deploy agent ships as a standalone binary and deliberately does not
 * depend on that package.
 */
export const MANAGED_BLOCK_SELECTOR = '[data-flowstarter-lead-capture] script';

/**
 * Inline scripts the templates themselves ship, by their exact text, with
 * whitespace collapsed. Same list as the build gate's
 * `MANAGED_INLINE_SCRIPT_SOURCES`, and the same reason: a marker is
 * something generated markup could also write, and this one is checked by
 * content.
 */
export const MANAGED_INLINE_SCRIPT_SOURCES: readonly string[] = [
  "document.documentElement.classList.add('js');",
];

/**
 * Origins a served site may frame — the managed Cal.com booking embed and
 * the map a contact page ships. Mirrors the build gate's allow-list. An
 * iframe pointing anywhere else was already refused by the gate; here it
 * simply contributes nothing to `frame-src`, so the browser blocks it.
 */
export const FRAMEABLE_ORIGINS: readonly string[] = [
  'https://cal.com',
  'https://app.cal.com',
  'https://www.openstreetmap.org',
  'https://openstreetmap.org',
];

/**
 * Origins the templates load webfonts and their stylesheets from. Mirrors
 * `TEMPLATE_FONT_ORIGINS` in the build gate.
 */
export const FONT_ORIGINS: readonly string[] = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://api.fontshare.com',
  'https://cdn.fontshare.com',
];

export interface SiteCapabilities {
  /** Base64 sha256 of each managed inline script found, deduplicated. */
  readonly inlineScriptHashes: string[];
  /** Allow-listed origins the site's pages frame. */
  readonly frameOrigins: string[];
}

/** Files a browser parses as markup, and therefore worth reading. */
const HTML_FILE = /\.html?$/i;

/** A page past this is not a page; reading it would be the slow step. */
const MAX_HTML_BYTES = 4 * 1024 * 1024;

function collapse(source: string): string {
  return source.split(/\s+/u).join(' ').trim();
}

function sha256Base64(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value, 'utf8').digest('base64');
}

function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** One page's managed inline scripts and framed origins. */
export async function scanHtmlCapabilities(html: string): Promise<{
  inlineScripts: string[];
  frameOrigins: string[];
}> {
  const inlineScripts: string[] = [];
  const frameOrigins: string[] = [];
  const collected: Array<{ text: string; managed: boolean }> = [];
  let insideManaged = false;
  let current: { text: string; managed: boolean } | null = null;

  const rewriter = new HTMLRewriter()
    // Registered first, so it runs before the general `script` handler for
    // the same element and can tell it which block this script is in.
    .on(MANAGED_BLOCK_SELECTOR, {
      element() {
        insideManaged = true;
      },
    })
    .on('script', {
      element(element) {
        const src = element.getAttribute('src');
        current = src === null ? { text: '', managed: insideManaged } : null;
        insideManaged = false;
        if (current) collected.push(current);
      },
      text(chunk) {
        if (current) current.text += chunk.text;
      },
    })
    .on('iframe', {
      element(element) {
        const origin = originOf(element.getAttribute('src'));
        if (origin && FRAMEABLE_ORIGINS.includes(origin)) {
          frameOrigins.push(origin);
        }
      },
    });

  await rewriter.transform(new Response(html)).text();

  const managedSources = MANAGED_INLINE_SCRIPT_SOURCES.map(collapse);
  for (const script of collected) {
    if (script.text.trim().length === 0) continue;
    if (script.managed || managedSources.includes(collapse(script.text))) {
      inlineScripts.push(script.text);
    }
  }
  return { inlineScripts, frameOrigins };
}

/**
 * Every managed inline script and framed origin in the site rooted at `dir`.
 *
 * A directory this cannot read produces no capabilities rather than an
 * error: the result of that is a policy that allows less, and a deploy is
 * not the moment to fail over a file the readiness check will catch.
 */
export async function scanSiteCapabilities(
  dir: string,
): Promise<SiteCapabilities> {
  const hashes = new Set<string>();
  const frames = new Set<string>();

  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile() || !HTML_FILE.test(entry.name)) continue;
      const file = Bun.file(absolute);
      if (file.size > MAX_HTML_BYTES) continue;
      let html: string;
      try {
        html = await file.text();
      } catch {
        continue;
      }
      const found = await scanHtmlCapabilities(html);
      for (const script of found.inlineScripts)
        hashes.add(sha256Base64(script));
      for (const origin of found.frameOrigins) frames.add(origin);
    }
  };

  await walk(dir);
  return {
    inlineScriptHashes: [...hashes].sort(),
    frameOrigins: [...frames].sort(),
  };
}
