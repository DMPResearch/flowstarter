/**
 * Per-tenant Cal.com booking helpers.
 *
 * Intake may collect a dedicated `calComUrl`, or mention a cal.com link inside
 * the free-text integrations answer. The URL is stored on
 * `workspaces.cal_com_url`. Preview files get a blurred demo only; the live
 * Cal.com embed is injected on the full-site build — never a shared org calendar.
 */
import {
  injectCalCom,
  injectCalComPreviewDemo,
  type FileMap,
} from '@flowstarter/agentic-codegen';
import { extractCalComUrl } from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import { parseCalLink } from './cal-link';

export type CalComIntakeSource = {
  calComUrl?: string | null;
  customIntegrations?: string | null;
};

/**
 * Prefer the dedicated intake field; fall back to a cal.com link buried in
 * the free-text integrations answer. Returns a normalized public URL
 * (`https://cal.com/...`) suitable for `workspaces.cal_com_url`, or null.
 *
 * The final gate is `parseCalLink`, the same rules the client's own booking
 * page enforces. Intake and the dashboard used to hold slightly different
 * opinions about what a Cal.com link is, which meant a value could be seeded
 * that the page would then refuse to save back. One set of rules, one column.
 */
export function resolveTenantCalComUrl(
  source: CalComIntakeSource
): string | null {
  const dedicated = source.calComUrl?.trim() || '';
  const fromIntegrations = extractCalComUrl(source.customIntegrations ?? '');
  const raw = dedicated || fromIntegrations || '';
  if (!raw) return null;
  const parsed = parseCalLink(raw);
  return parsed.ok ? parsed.link.url : null;
}

/** True when the string is empty or a recognizable Cal.com URL/handle. */
export function isValidCalComInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  return parseCalLink(trimmed).ok;
}

function mapScaffoldFiles<T extends { path: string; content: string }>(
  files: readonly T[],
  transform: (map: FileMap) => FileMap
): T[] {
  const map: FileMap = {};
  for (const file of files) {
    map[file.path] = file.content;
  }
  const next = transform(map);
  let changed = false;
  const out = files.map((file) => {
    const content = next[file.path];
    if (content === undefined || content === file.content) return file;
    changed = true;
    return { ...file, content };
  });
  return changed ? out : (files as T[]);
}

/**
 * Funnel/preview: blurred Cal demo only. Does not load the tenant's live
 * calendar — that happens on the full-site build via `injectCalCom`.
 */
export function injectCalComPreviewDemoIntoScaffoldFiles<
  T extends { path: string; content: string }
>(files: readonly T[]): T[] {
  return mapScaffoldFiles(files, injectCalComPreviewDemo);
}

/**
 * Full-site: live Cal.com embed. Prefer calling this from the build worker,
 * not from the funnel preview path.
 */
export function injectCalComIntoScaffoldFiles<
  T extends { path: string; content: string }
>(files: readonly T[], calUrl: string | null | undefined): T[] {
  if (!calUrl?.trim()) return files as T[];
  return mapScaffoldFiles(files, (map) => injectCalCom(map, calUrl));
}
