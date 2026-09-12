/**
 * Deterministic, persistent host ports for each site's Docker containers.
 *
 * The incident this exists to prevent: a container published on whatever
 * ephemeral host port Docker picked (`-p 127.0.0.1::8080`), and after a
 * reboot the daemon restarted it on a DIFFERENT ephemeral port while the
 * site's Caddy snippet still pointed at the old one. A working container
 * behind a 502, because nothing recorded which port was "the" port.
 *
 * The fix is to never let the port be a surprise: a slug's host port is
 * derived from its own name by a pure hash, so redeploying (or a daemon
 * restart) never changes it, and the assignment is recorded in a small
 * JSON file so it survives a hash-range change or a rare collision without
 * moving a live site's port out from under it.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface PortRange {
  min: number;
  max: number;
}

export const DEFAULT_SITE_PORT_RANGE = '20000-29999';

function parseRangeStrict(raw: string): PortRange | null {
  const m = raw.trim().match(/^(\d+)-(\d+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
  if (min < 1 || max > 65535 || min >= max) return null;
  return { min, max };
}

/**
 * Parses `DEPLOY_AGENT_SITE_PORT_RANGE` (`"min-max"`, both inclusive).
 * Falls back to `DEFAULT_SITE_PORT_RANGE` for anything that is not two
 * valid ports in ascending order, so an operator's typo does not crash the
 * agent, it just does not narrow the range the way they meant it to.
 */
export function parsePortRange(raw: string | undefined | null): PortRange {
  const fallback = parseRangeStrict(DEFAULT_SITE_PORT_RANGE);
  if (!fallback)
    throw new Error('DEFAULT_SITE_PORT_RANGE is not a valid range');
  if (!raw) return fallback;
  return parseRangeStrict(raw) ?? fallback;
}

/**
 * FNV-1a, 32-bit. Not cryptographic, it only has to spread slugs evenly
 * across the range and never change for the same input. Everywhere this
 * package needs a real hash (artifact integrity, image tags) already uses
 * sha256.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The port `slug` (with an optional salt, for deriving a second candidate
 * from the same slug) hashes to inside `range`. Pure and deterministic:
 * the same two arguments always produce the same port.
 */
export function derivePort(slug: string, range: PortRange, salt = ''): number {
  const span = range.max - range.min + 1;
  const offset = fnv1a(salt ? `${slug}:${salt}` : slug) % span;
  return range.min + offset;
}

export interface SitePortPair {
  a: number;
  b: number;
}

export interface PortState {
  sites: Record<string, SitePortPair>;
}

export function emptyPortState(): PortState {
  return { sites: {} };
}

function isSitePortPair(v: unknown): v is SitePortPair {
  if (!v || typeof v !== 'object') return false;
  const pair = v as Record<string, unknown>;
  return Number.isInteger(pair.a) && Number.isInteger(pair.b);
}

/**
 * Tolerant of a missing, empty or corrupt file: an operator who deletes
 * `.ports.json` by hand gets a fresh set of assignments, not a crashed
 * agent. Entries that do not look like a port pair are dropped rather than
 * propagated.
 */
export function parsePortState(raw: string): PortState {
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !('sites' in data))
      return emptyPortState();
    const sitesRaw = (data as { sites: unknown }).sites;
    if (!sitesRaw || typeof sitesRaw !== 'object') return emptyPortState();
    const sites: Record<string, SitePortPair> = {};
    for (const [slug, pair] of Object.entries(
      sitesRaw as Record<string, unknown>,
    )) {
      if (isSitePortPair(pair)) sites[slug] = { a: pair.a, b: pair.b };
    }
    return { sites };
  } catch {
    return emptyPortState();
  }
}

export function serializePortState(state: PortState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export async function loadPortState(path: string): Promise<PortState> {
  try {
    return parsePortState(await readFile(path, 'utf8'));
  } catch {
    return emptyPortState();
  }
}

/**
 * Writes via a temp file plus rename, the same durability rule every other
 * piece of state this agent owns follows. A crash mid-write must never
 * leave `.ports.json` truncated, because a truncated file parses as "no
 * assignments yet" and would start silently reassigning ports for every
 * site on the box.
 */
export async function savePortState(
  path: string,
  state: PortState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, serializePortState(state));
  await rename(tmp, path);
}

function usedPorts(state: PortState): Set<number> {
  const used = new Set<number>();
  for (const pair of Object.values(state.sites)) {
    used.add(pair.a);
    used.add(pair.b);
  }
  return used;
}

function firstFreePort(
  start: number,
  range: PortRange,
  taken: Set<number>,
): number {
  const span = range.max - range.min + 1;
  for (let i = 0; i < span; i++) {
    const candidate = range.min + ((start - range.min + i) % span);
    if (!taken.has(candidate)) return candidate;
  }
  // Every port in the range is already assigned. There is nowhere else to
  // put it; the caller gets the original candidate back, and a `docker
  // run` that collides with a live port fails loudly instead of this
  // function quietly pretending it found somewhere to go.
  return start;
}

/**
 * The stable host port pair for `slug`'s two blue/green slots.
 *
 * A slug that already has an entry in `state` keeps it for the rest of its
 * life, whatever the hash would produce today. That is what makes the port
 * survive a range change, a collision resolved on a later deploy, or a
 * reboot. A new slug gets the two ports its hash points at, walked forward
 * past anything already taken, so two slugs never end up sharing a port
 * even when their hashes collide.
 *
 * Mutates `state.sites[slug]`; the caller is responsible for persisting
 * `state` afterward.
 */
export function assignSitePorts(
  state: PortState,
  slug: string,
  range: PortRange,
): SitePortPair {
  const existing = state.sites[slug];
  if (existing) return existing;

  const taken = usedPorts(state);
  const a = firstFreePort(derivePort(slug, range, 'a'), range, taken);
  taken.add(a);
  const b = firstFreePort(derivePort(slug, range, 'b'), range, taken);

  const pair: SitePortPair = { a, b };
  state.sites[slug] = pair;
  return pair;
}

/**
 * Frees `slug`'s ports for reuse. Called on `DELETE /sites/:slug`: a
 * deleted site's ports go back into the pool for whichever new slug's hash
 * lands on them next.
 */
export function releaseSitePorts(state: PortState, slug: string): void {
  delete state.sites[slug];
}
