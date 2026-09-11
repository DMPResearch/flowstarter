/**
 * Local `astro dev` previews bind to http://127.0.0.1:<port>. The wizard is
 * often opened over HTTPS (Cloudflare tunnel → www.flowstarter.dev), and a
 * browser will not paint an HTTP localhost iframe inside that page — mixed
 * content — so the pane goes blank even though generation succeeded.
 *
 * Keep the real upstream URL on the job; hand the client a same-origin path
 * under `/api/discovery/preview/live/frame/<demoId>/` that proxies through.
 */
const LOCAL_PREVIEW_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLocalPreviewUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return false;
    return LOCAL_PREVIEW_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/** Same-origin iframe src for a local preview job (no trailing slash — Next 308s it away). */
export function framedPreviewPath(demoId: string): string {
  return `/api/discovery/preview/live/frame/${demoId}`;
}

/** Base href for proxied HTML so root-relative `/_astro/…` assets stay under the frame. */
export function framedPreviewBaseHref(demoId: string): string {
  return `${framedPreviewPath(demoId)}/`;
}

/**
 * What the wizard (and "Open in new tab") should load. Daytona / hosted URLs
 * pass through; loopback ones become the frame proxy so HTTPS parents work.
 */
export function previewUrlForClient(
  demoId: string,
  previewUrl: string | undefined
): string | undefined {
  if (!previewUrl) return undefined;
  return isLocalPreviewUrl(previewUrl) ? framedPreviewPath(demoId) : previewUrl;
}

/**
 * Inject `<base href="…">` for *path-relative* URLs (no leading slash).
 *
 * Path-absolute URLs like `/_astro/…` and `/flowstarter-assets/…` ignore the
 * base path and resolve against the document origin — which is the Next app
 * when the iframe is same-origin. Those must be rewritten separately.
 */
export function injectFrameBase(html: string, baseHref: string): string {
  const baseTag = `<base href="${baseHref}">`;
  if (/<base\b/i.test(html)) {
    return html.replace(/<base\b[^>]*>/i, baseTag);
  }
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (open) => `${open}${baseTag}`);
  }
  return `${baseTag}${html}`;
}

/**
 * Prefix path-absolute same-document URLs so they stay under the frame proxy.
 * Leaves scheme-relative (`//…`), absolute, and already-framed paths alone.
 */
export function rewriteRootAbsoluteUrls(
  html: string,
  framePath: string
): string {
  const prefix = framePath.replace(/\/$/, '');
  const rewrite = (path: string): string => {
    if (!path.startsWith('/') || path.startsWith('//')) return path;
    if (path === prefix || path.startsWith(`${prefix}/`)) return path;
    return `${prefix}${path}`;
  };

  let out = html.replace(
    /\b(href|src|poster|data-src|action)=("|')(\/[^"']*)\2/gi,
    (_m, attr: string, quote: string, path: string) =>
      `${attr}=${quote}${rewrite(path)}${quote}`
  );

  out = out.replace(
    /\bsrcset=("|')([^"']*)\1/gi,
    (_m, quote: string, value: string) => {
      const rewritten = value
        .split(',')
        .map((part) => {
          const trimmed = part.trim();
          const match = /^(\S+)(\s+.*)?$/.exec(trimmed);
          if (!match) return part;
          return `${rewrite(match[1]!)}${match[2] ?? ''}`;
        })
        .join(', ');
      return `srcset=${quote}${rewritten}${quote}`;
    }
  );

  // Inline styles and <style> blocks: url(/images/…) and url('/images/…').
  out = out.replace(
    /url\(\s*(['"]?)(\/[^)"']+)\1\s*\)/gi,
    (_m, quote: string, path: string) => `url(${quote}${rewrite(path)}${quote})`
  );

  return out;
}
