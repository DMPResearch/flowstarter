/**
 * Post-publish rendered QA for discovery previews.
 *
 * BrandConfig already enforces WCAG pairs on named tokens. Templates still
 * paint those tokens onto the wrong surfaces (dark body copy on a dark hero).
 * This walk of the live DOM is the pass that can see that. One repair is
 * enough; if Playwright is missing or the page will not load, the funnel
 * keeps the unpublished-quality preview rather than failing open to nothing.
 */

export const GHOST_CONTRAST_FLOOR = 2.5;

export function renderedAuditEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env.FLOWSTARTER_RENDERED_AUDIT?.trim().toLowerCase();
  return raw !== 'false' && raw !== '0';
}

export function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Parses computed `rgb()` / `rgba()` (comma or space separated). */
export function parseCssRgb(
  color: string
): { r: number; g: number; b: number; a: number } | null {
  const match = color.match(
    /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/i
  );
  if (!match) return null;
  const r = Number(match[1]);
  const g = Number(match[2]);
  const b = Number(match[3]);
  let a = 1;
  if (match[4] !== undefined) {
    a = match[4].endsWith('%')
      ? Number(match[4].slice(0, -1)) / 100
      : Number(match[4]);
  }
  if (![r, g, b, a].every((n) => Number.isFinite(n))) return null;
  return { r, g, b, a };
}

export function contrastRatioFromRgb(
  foreground: string,
  background: string
): number | null {
  const fg = parseCssRgb(foreground);
  const bg = parseCssRgb(background);
  if (!fg || !bg || fg.a < 0.5) return null;
  const ratio =
    (Math.max(
      relativeLuminance(fg.r, fg.g, fg.b),
      relativeLuminance(bg.r, bg.g, bg.b)
    ) +
      0.05) /
    (Math.min(
      relativeLuminance(fg.r, fg.g, fg.b),
      relativeLuminance(bg.r, bg.g, bg.b)
    ) +
      0.05);
  return ratio;
}

export function formatRenderedAuditFeedback(
  issues: readonly string[]
): string | undefined {
  if (issues.length === 0) return undefined;
  const unique = Array.from(new Set(issues)).slice(0, 6);
  return (
    'Visible text is unreadable against its background. Repair style tokens and section colors only — use light text on dark surfaces and onPrimary/onAccent on those fills. Do not rewrite copy. Defects: ' +
    unique.join(' | ')
  );
}

type AuditInPageArgs = { contrastFloor: number };

/**
 * Runs inside Playwright's page. Must stay serializable: no closures over
 * module scope, no TypeScript-only syntax Playwright cannot evaluate.
 */
export function auditRenderedPageInBrowser({
  contrastFloor,
}: AuditInPageArgs): string[] {
  const issues: string[] = [];
  const freeze = document.createElement('style');
  freeze.textContent =
    '*, *::before, *::after { animation: none !important; transition: none !important; }';
  document.head.appendChild(freeze);
  document.documentElement.style.scrollBehavior = 'auto';
  document.body.style.scrollBehavior = 'auto';

  const parse = (color: string) => {
    const m = color.match(
      /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/i
    );
    if (!m) return null;
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    return { r, g, b };
  };
  const lum = (rgb: { r: number; g: number; b: number }) => {
    const ch = (v: number) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(rgb.r) + 0.7152 * ch(rgb.g) + 0.0722 * ch(rgb.b);
  };
  const effectiveBg = (el: Element): string | null => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const bg = cs.backgroundColor;
      if (bg && !bg.includes('rgba(0, 0, 0, 0)') && bg !== 'transparent') {
        const parsed = parse(bg);
        if (!parsed) continue;
        return bg;
      }
    }
    return (
      getComputedStyle(document.body).backgroundColor || 'rgb(255,255,255)'
    );
  };

  const texts = Array.from(
    document.querySelectorAll('h1,h2,h3,h4,p,a,li,blockquote')
  )
    .filter((el) => {
      if (el.closest('.fs-teaser-locked')) return false;
      const cs = getComputedStyle(el);
      return (
        cs.visibility !== 'hidden' &&
        Number(cs.opacity) > 0.5 &&
        (el.textContent || '').trim().length > 8
      );
    })
    .slice(0, 220);

  const docHeight = Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight,
    1
  );
  const flagged = new Set<string>();
  for (const factor of [0, 0.3, 0.6]) {
    window.scrollTo(0, Math.min(docHeight, factor * docHeight));
    for (const el of texts) {
      if (flagged.size >= 4) return issues;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 12) continue;
      if (r.bottom < 8 || r.top > window.innerHeight - 8) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + Math.min(r.height / 2, 36);
      if (
        cx < 0 ||
        cy < 0 ||
        cx > window.innerWidth ||
        cy > window.innerHeight
      ) {
        continue;
      }
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || !(hit === el || el.contains(hit) || hit.contains(el)))
        continue;
      const bgColor = effectiveBg(el);
      if (!bgColor) continue;
      const fg = parse(getComputedStyle(el).color);
      const bg = parse(bgColor);
      if (!fg || !bg) continue;
      const contrast =
        (Math.max(lum(fg), lum(bg)) + 0.05) /
        (Math.min(lum(fg), lum(bg)) + 0.05);
      if (contrast >= contrastFloor) continue;
      const key = (el.textContent || '').trim().slice(0, 48);
      if (flagged.has(key)) continue;
      flagged.add(key);
      const host = el.closest('section,footer,header,nav,div[class]');
      issues.push(
        `near-invisible text (contrast ${contrast.toFixed(2)}, ${
          getComputedStyle(el).color
        } on ${bgColor}) in <${host?.tagName.toLowerCase() ?? '?'}>: "${key}"`
      );
    }
  }
  return issues;
}

export async function auditRenderedPreview(
  previewUrl: string
): Promise<string | undefined> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    args: ['--disable-features=site-per-process'],
  });
  const issues: string[] = [];
  try {
    const matrix = [
      {
        label: 'desktop-light',
        ctx: {
          viewport: { width: 1280, height: 800 },
          colorScheme: 'light' as const,
        },
      },
      {
        label: 'desktop-dark',
        ctx: {
          viewport: { width: 1280, height: 800 },
          colorScheme: 'dark' as const,
        },
      },
    ];
    for (const { label, ctx } of matrix) {
      const context = await browser.newContext({
        ...ctx,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      try {
        await page.goto(previewUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 20_000,
        });
        await page.waitForTimeout(700);
        const found = await page.evaluate(auditRenderedPageInBrowser, {
          contrastFloor: GHOST_CONTRAST_FLOOR,
        });
        for (const issue of found) issues.push(`[${label}] ${issue}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return formatRenderedAuditFeedback(issues);
}

/**
 * Soft wrapper for the pipeline hook: opt-out via env, never throw.
 */
export function createRenderedPreviewAudit(): (
  previewUrl: string
) => Promise<string | undefined> {
  return async (previewUrl: string) => {
    if (!renderedAuditEnabled()) return undefined;
    try {
      return await auditRenderedPreview(previewUrl);
    } catch (error) {
      console.warn(
        `[rendered-preview-audit] skipped: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return undefined;
    }
  };
}
