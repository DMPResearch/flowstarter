import 'server-only';
/**
 * The client site editor's model of a site: what a client may point at, what
 * happens when they change it, and how the previous wording survives.
 *
 * WHERE THE SITE LIVES. `flowstarter_project_artifacts.preview_manifest` holds
 * one manifest per workspace — `{files:[{path,content,encoding?}]}` of Astro
 * sources — and that is the thing the build worker builds and the deploy path
 * ships. It is therefore the editable source of truth, and it is also a single
 * row: an editor that wrote into it and nothing else would destroy the old
 * copy on every save. So `saveSiteVersion` appends a full snapshot to
 * `site_versions` first and updates the artifact row to match. The first write
 * for a workspace snapshots the delivered site as version 1 before the change
 * becomes version 2, so "put it back how it was" is always reachable.
 *
 * WHAT A TARGET IS. Templates are Astro components reading their copy from
 * `src/content/*.md`, so the text a client sees is a YAML scalar on a known
 * line of a known file, and a target id is `src/content/site-labels.md#27` —
 * the same `file#line` addressing `listSiteImageSlots` already uses for image
 * slots. Sites built by the full-build agent additionally carry stable
 * `data-flowstarter-id` attributes (see FULL_SITE_CODING_SYSTEM_PROMPT), and
 * those are honoured as target ids too, so the editor keeps working unchanged
 * once a site has them.
 *
 * WHAT IS NOT A TARGET. Anything that is not one of the above: a component, a
 * stylesheet, a class attribute, a route, an href. `classifyTargetCapability`
 * maps those onto the `EditorCapability` they really are, and
 * `resolveEditorPolicy` refuses them — server-side, on a request the UI never
 * offered, because UI visibility is not an authorization boundary.
 */
import { createHash } from 'node:crypto';
import {
  resolveEditorPolicy,
  type EditorActorRole,
  type EditorCapability,
  type EditorPolicyDecision,
  type SubscriptionAccessStatus,
} from '@flowstarter/agentic-codegen/src/flowstarter/editor-policy';
import type { Json } from '@/lib/database.types';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

// ── Limits ─────────────────────────────────────────────────────────────────

/**
 * An instruction is one sentence about one block ("make this warmer, mention
 * Saturday opening"). The inline agent has a 5,000-character output ceiling
 * and no authority to do anything larger, so a longer prompt buys nothing and
 * costs tokens the tenant is billed for.
 */
export const MAX_INSTRUCTION_CHARS = 600;

/**
 * Per-workspace, per-UTC-day ceiling on proposals that reach the model. Each
 * one spends the tenant's tokens, and the editor is a self-service control on
 * a care plan rather than a metered product, so the cap is what keeps a stuck
 * client (or a stuck script) from turning a subscription into a bill. Counted
 * on *proposals*, not applies: the tokens are spent whether or not the client
 * likes the result.
 */
export const DAILY_EDIT_CAP = 25;

/** Burst guard in front of the daily cap. One workspace, one minute. */
export const EDIT_RATE_LIMIT = { limit: 6, windowMs: 60_000 };

/** Ceiling on a single replacement, matching the agent's own tool schema. */
export const MAX_REPLACEMENT_CHARS = 5_000;

/** Ceiling on how many targets one site may offer, so a huge manifest cannot
 * turn the editor page into a denial of service against ourselves. */
export const MAX_TARGETS = 500;

// ── Manifest ───────────────────────────────────────────────────────────────

export interface SiteFile {
  path: string;
  content: string;
  /** Present for binary assets; `content` is then base64. */
  encoding?: 'base64';
}

export type SiteEditorErrorCode =
  | 'not_found'
  | 'stale'
  | 'invalid'
  | 'unsafe'
  | 'conflict';

export class SiteEditorError extends Error {
  constructor(
    message: string,
    readonly code: SiteEditorErrorCode,
    readonly status = 400
  ) {
    super(message);
    this.name = 'SiteEditorError';
  }
}

/**
 * Reads a stored manifest back into files. Written by a Pi session or by this
 * module, but read here as untrusted JSON either way: a manifest that lost its
 * shape must fail loudly rather than produce an editor over `undefined`.
 */
export function parseSiteManifest(value: unknown): SiteFile[] {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const raw = record?.['files'];
  if (!Array.isArray(raw)) {
    throw new SiteEditorError(
      'This site has no stored file manifest yet',
      'not_found',
      404
    );
  }
  return raw.map((entry, index) => {
    const file =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {};
    const path = file['path'];
    const content = file['content'];
    if (typeof path !== 'string' || path.length === 0) {
      throw new SiteEditorError(
        `Manifest file ${index} has no path`,
        'invalid',
        500
      );
    }
    if (typeof content !== 'string') {
      throw new SiteEditorError(
        `Manifest file ${path} has no content`,
        'invalid',
        500
      );
    }
    return file['encoding'] === 'base64'
      ? { path, content, encoding: 'base64' as const }
      : { path, content };
  });
}

export function manifestJson(files: readonly SiteFile[]): Json {
  return {
    files: files.map((file) => ({
      path: file.path,
      content: file.content,
      ...(file.encoding ? { encoding: file.encoding } : {}),
    })),
  } as unknown as Json;
}

// ── Targets ────────────────────────────────────────────────────────────────

export interface EditableTarget {
  /** `src/content/site-labels.md#27`, or a `data-flowstarter-id` value. */
  id: string;
  file: string;
  /** 1-based line the value starts on. */
  line: number;
  /** Lines the value occupies (>1 only for YAML block scalars). */
  lineCount: number;
  /** How the value is written, which decides how it is written back. */
  syntax: 'quoted' | 'plain' | 'block' | 'markup';
  /** The YAML key or, for markup, the element's tag. */
  key: string;
  /** Top-level content group: `hero`, `caseStudies`, … */
  section: string;
  /** The text the site currently shows. */
  content: string;
}

/** Files whose scalars are site copy rather than code. */
function isContentFile(path: string): boolean {
  return /^src\/content\/[^\s]+\.(md|markdown|ya?ml)$/i.test(path);
}

function isMarkupFile(path: string): boolean {
  return /\.(astro|html)$/i.test(path);
}

/**
 * Keys whose value addresses or configures something rather than saying it.
 * Rewriting one of these in plain English breaks a link or a layout, which is
 * precisely the class of change the client tier does not own.
 */
const STRUCTURAL_KEYS = new Set([
  'href',
  'url',
  'src',
  'slug',
  'id',
  'class',
  'classname',
  'icon',
  'type',
  'target',
  'rel',
  'provider',
  'layout',
  'outline',
  'order',
  'format',
  'variant',
  'theme',
  'align',
  'anchor',
  'path',
  'route',
  'action',
  'method',
  'endpoint',
  'script',
  'style',
]);

/** Values that are addresses, flags or numbers — never prose. */
function isStructuralValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  if (/^[/#]/.test(trimmed)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return true;
  if (/^(mailto|tel|data|javascript):/i.test(trimmed)) return true;
  if (/^(true|false|null|yes|no|on|off)$/i.test(trimmed)) return true;
  if (/^-?\d+(\.\d+)?(px|rem|em|%|s|ms)?$/i.test(trimmed)) return true;
  // Prose has letters in it. `---`, `{{ x }}`, `#fff` do not qualify.
  if (!/[A-Za-z]/.test(trimmed)) return true;
  return false;
}

const TOP_LEVEL_KEY = /^([A-Za-z][A-Za-z0-9_]*):\s*$/;
const QUOTED_SCALAR =
  /^(\s*)(?:-\s+)?([A-Za-z][A-Za-z0-9_]*):[ \t]+(["'])([\s\S]*)\3[ \t]*$/;
const PLAIN_SCALAR =
  /^(\s*)(?:-\s+)?([A-Za-z][A-Za-z0-9_]*):[ \t]+([^"'\s#][^#]*?)[ \t]*$/;
const BLOCK_HEADER =
  /^(\s*)(?:-\s+)?([A-Za-z][A-Za-z0-9_]*):[ \t]*([|>])[-+]?[ \t]*$/;
/** One editable block stamped by the full-build agent, text and all. */
const MARKUP_TARGET =
  /<([a-zA-Z][\w-]*)\b[^<>]*\bdata-flowstarter-id="([^"<>]{1,160})"[^<>]*>([^<>]*)<\//g;

/**
 * Every block a client may point at, in document order.
 *
 * Deliberately conservative: a value it cannot confidently classify as prose
 * is left out, because a target the editor offers is a target the policy will
 * hand to the content agent. Missing one headline costs a support message;
 * offering an `href` costs a broken site.
 */
export function listEditableTargets(
  files: readonly SiteFile[]
): EditableTarget[] {
  const targets: EditableTarget[] = [];
  for (const file of files) {
    if (file.encoding === 'base64') continue;
    if (isContentFile(file.path)) {
      collectContentTargets(file, targets);
    } else if (isMarkupFile(file.path)) {
      collectMarkupTargets(file, targets);
    }
    if (targets.length >= MAX_TARGETS) break;
  }
  return targets.slice(0, MAX_TARGETS);
}

function collectContentTargets(file: SiteFile, out: EditableTarget[]): void {
  const lines = file.content.split('\n');
  let section = 'general';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const top = TOP_LEVEL_KEY.exec(line);
    if (top) {
      section = top[1] as string;
      continue;
    }

    const block = BLOCK_HEADER.exec(line);
    if (block) {
      const key = block[2] as string;
      if (STRUCTURAL_KEYS.has(key.toLowerCase())) continue;
      const headerIndent = (block[1] as string).length;
      const body: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const candidate = lines[cursor] as string;
        const indent = candidate.length - candidate.trimStart().length;
        if (candidate.trim().length > 0 && indent <= headerIndent) break;
        body.push(candidate);
        cursor += 1;
      }
      // Trailing blank lines belong to the file, not the value.
      while (body.length > 0 && (body[body.length - 1] as string).trim() === '')
        body.pop();
      if (body.length === 0) continue;
      const bodyIndent = Math.min(
        ...body
          .filter((entry) => entry.trim().length > 0)
          .map((entry) => entry.length - entry.trimStart().length)
      );
      const content = body
        .map((entry) => entry.slice(bodyIndent))
        .join('\n')
        .trim();
      if (isStructuralValue(content)) continue;
      out.push({
        id: `${file.path}#${index + 1}`,
        file: file.path,
        line: index + 1,
        lineCount: 1 + body.length,
        syntax: 'block',
        key,
        section,
        content,
      });
      index = cursor - 1;
      continue;
    }

    const quoted = QUOTED_SCALAR.exec(line);
    if (quoted) {
      const key = quoted[2] as string;
      const value = unescapeYaml(quoted[4] as string, quoted[3] as string);
      if (STRUCTURAL_KEYS.has(key.toLowerCase())) continue;
      if (isStructuralValue(value)) continue;
      out.push({
        id: `${file.path}#${index + 1}`,
        file: file.path,
        line: index + 1,
        lineCount: 1,
        syntax: 'quoted',
        key,
        section,
        content: value,
      });
      continue;
    }

    const plain = PLAIN_SCALAR.exec(line);
    if (plain) {
      const key = plain[2] as string;
      const value = (plain[3] as string).trim();
      if (STRUCTURAL_KEYS.has(key.toLowerCase())) continue;
      if (isStructuralValue(value)) continue;
      out.push({
        id: `${file.path}#${index + 1}`,
        file: file.path,
        line: index + 1,
        lineCount: 1,
        syntax: 'plain',
        key,
        section,
        content: value,
      });
    }
  }
}

function collectMarkupTargets(file: SiteFile, out: EditableTarget[]): void {
  const lines = file.content.split('\n');
  lines.forEach((line, index) => {
    MARKUP_TARGET.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MARKUP_TARGET.exec(line)) !== null) {
      const text = decodeEntities(match[3] as string).trim();
      // A stamped element whose text is not on this line (a nested component,
      // a slot) cannot be rewritten line-locally, so it is not offered.
      if (text.length === 0 || isStructuralValue(text)) continue;
      out.push({
        id: match[2] as string,
        file: file.path,
        line: index + 1,
        lineCount: 1,
        syntax: 'markup',
        key: match[1] as string,
        section: file.path.split('/').pop() ?? file.path,
        content: text,
      });
    }
  });
}

export function findTarget(
  files: readonly SiteFile[],
  targetId: string
): EditableTarget | null {
  return listEditableTargets(files).find((t) => t.id === targetId) ?? null;
}

/**
 * What kind of change a target id is really asking for.
 *
 * An editable block is `content`. Anything else is named as the capability it
 * actually is, so the policy's refusal reads as the truth ("layout changes
 * require Flowstarter review") rather than as a generic 404 — which would be
 * both less useful and a hint that the id was wrong rather than the change.
 */
export function classifyTargetCapability(
  files: readonly SiteFile[],
  targetId: string
): EditorCapability {
  if (findTarget(files, targetId)) return 'content';
  const path = targetId.split('#')[0] ?? '';
  if (/\.(css|scss|sass)$/i.test(path)) return 'color';
  if (/\.(ts|tsx|js|jsx|mjs|cjs|json)$/i.test(path)) return 'code';
  if (isMarkupFile(path)) return 'layout';
  if (isContentFile(path)) {
    // A content file, but a line that is not a prose scalar: an href, a
    // structural key, a list of section ids.
    return 'layout';
  }
  return 'code';
}

// ── Applying a change ──────────────────────────────────────────────────────

/**
 * The same rule the inline agent's own tool enforces, re-checked here because
 * `/apply` takes `replacementContent` from a browser. A caller who skipped
 * `/edit` entirely must not be able to post markup into a content file.
 */
export function assertSafeReplacement(content: string): void {
  if (content.length === 0) {
    throw new SiteEditorError('The replacement is empty', 'unsafe');
  }
  if (content.length > MAX_REPLACEMENT_CHARS) {
    throw new SiteEditorError('The replacement is too long', 'unsafe');
  }
  if (
    content.includes('<') ||
    content.includes('>') ||
    content.includes('```') ||
    /data-flowstarter-id/i.test(content) ||
    // eslint-disable-next-line no-control-regex -- control characters are the point
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(content)
  ) {
    throw new SiteEditorError(
      'The replacement must be plain text without markup',
      'unsafe'
    );
  }
}

/** Newlines and surrounding whitespace differ harmlessly between round-trips. */
function sameContent(left: string, right: string): boolean {
  const normalise = (value: string) =>
    value
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .trim();
  return normalise(left) === normalise(right);
}

export interface AppliedEdit {
  files: SiteFile[];
  changedPaths: string[];
  target: EditableTarget;
}

/**
 * Rewrites exactly one target and returns a new file set.
 *
 * `originalContent` is optimistic concurrency, not decoration: two people (or
 * one person in two tabs) editing the same headline would otherwise have the
 * second apply silently overwrite a version its author never saw. The target
 * is re-read from the *current* manifest, and if the text moved on, the apply
 * is refused with `stale` so the caller can re-propose against what is there.
 */
export function applyTargetEdit(input: {
  files: readonly SiteFile[];
  targetId: string;
  originalContent: string;
  replacementContent: string;
}): AppliedEdit {
  assertSafeReplacement(input.replacementContent);
  const target = findTarget(input.files, input.targetId);
  if (!target) {
    throw new SiteEditorError(
      'That block is no longer part of this site',
      'not_found',
      404
    );
  }
  if (!sameContent(target.content, input.originalContent)) {
    throw new SiteEditorError(
      'This block changed since you started editing. Reload and try again.',
      'stale',
      409
    );
  }

  const files = input.files.map((file) => ({ ...file }));
  const file = files.find((entry) => entry.path === target.file);
  if (!file) {
    throw new SiteEditorError('That file is missing', 'not_found', 404);
  }
  const lines = file.content.split('\n');
  const index = target.line - 1;
  const line = lines[index] as string;

  if (target.syntax === 'markup') {
    lines[index] = rewriteMarkupLine(
      line,
      target.id,
      collapse(input.replacementContent)
    );
  } else if (target.syntax === 'block') {
    const indent = /^(\s*)/.exec(line)?.[1] ?? '';
    const bodyIndent = `${indent}  `;
    const body = input.replacementContent
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((entry) => (entry.trim() ? `${bodyIndent}${entry.trim()}` : ''));
    lines.splice(index + 1, target.lineCount - 1, ...body);
  } else {
    const prefix = /^(\s*(?:-\s+)?[A-Za-z][A-Za-z0-9_]*:)/.exec(line)?.[1];
    if (!prefix) {
      throw new SiteEditorError('That block could not be rewritten', 'invalid');
    }
    lines[index] = `${prefix} ${quoteYaml(collapse(input.replacementContent))}`;
  }

  file.content = lines.join('\n');
  return { files, changedPaths: [file.path], target };
}

/** A scalar slot holds one line; a paragraph pasted into one would break YAML. */
function collapse(value: string): string {
  return value
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function quoteYaml(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function unescapeYaml(value: string, quote: string): string {
  return quote === '"'
    ? value.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    : value.replace(/''/g, "'");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeMarkupText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function rewriteMarkupLine(
  line: string,
  targetId: string,
  replacement: string
): string {
  MARKUP_TARGET.lastIndex = 0;
  return line.replace(MARKUP_TARGET, (whole, tag, id, text) => {
    if (id !== targetId) return whole;
    const head = whole.slice(0, whole.length - `${text}</`.length);
    return `${head}${escapeMarkupText(replacement)}</`;
  });
}

// ── Policy ─────────────────────────────────────────────────────────────────

/**
 * Stripe's vocabulary, narrowed to the four states the policy knows about.
 * Anything unrecognised is `none`, which denies: a subscription we cannot read
 * is not a subscription we may bill an agent run against.
 */
export function subscriptionAccessStatus(
  raw: string | null | undefined
): SubscriptionAccessStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'active':
      return 'active';
    case 'trialing':
    case 'trial':
      return 'trialing';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    default:
      return 'none';
  }
}

export interface EditorAccess {
  actorId: string;
  role: EditorActorRole;
  subscriptionStatus: SubscriptionAccessStatus;
}

/**
 * The one place a decision is made about a request. Returns the policy's own
 * decision so a caller can render its reason verbatim rather than inventing a
 * friendlier, less true one.
 */
export function decideEditorAction(
  access: EditorAccess,
  capability: EditorCapability
): EditorPolicyDecision {
  return resolveEditorPolicy(
    {
      actorId: access.actorId,
      role: access.role,
      subscriptionStatus: access.subscriptionStatus,
    },
    capability
  );
}

/** The HTTP status a refusal deserves. Never 404 — the workspace is real. */
export function policyStatus(decision: EditorPolicyDecision): number {
  return decision.action === 'deny' ? 402 : 403;
}

// ── Persistence ────────────────────────────────────────────────────────────

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

function db(): Db {
  return createSupabaseServiceRoleClient();
}

export interface SiteVersionSummary {
  version: number;
  summary: string | null;
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
}

export interface WorkspaceSite {
  files: SiteFile[];
  /** 0 when the delivered site has never been edited and has no snapshot yet. */
  version: number;
  templateSlug: string | null;
  templateVersion: string | null;
  subscriptionStatus: SubscriptionAccessStatus;
  workspaceName: string;
  slug: string;
  /**
   * Raw `workspaces.tier_name`, which is nullable and may still hold a legacy
   * value. Normalised by `normaliseTierKey` at the point of use rather than
   * here, so nothing in this module has to know the plan vocabulary.
   */
  tierName: string | null;
}

/**
 * The site as it stands, from the newest snapshot if there is one and from the
 * delivered artifact row if there is not.
 */
export async function loadWorkspaceSite(
  workspaceId: string
): Promise<WorkspaceSite> {
  const supabase = db();
  const [{ data: workspace }, { data: artifact }, { data: latest }] =
    await Promise.all([
      supabase
        .from('workspaces')
        .select('id, name, slug, subscription_status, tier_name')
        .eq('id', workspaceId)
        .maybeSingle(),
      supabase
        .from('flowstarter_project_artifacts')
        .select('preview_manifest, template_slug, template_version')
        .eq('workspace_id', workspaceId)
        .maybeSingle(),
      supabase
        .from('site_versions')
        .select('version, manifest')
        .eq('workspace_id', workspaceId)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  if (!workspace) {
    throw new SiteEditorError('Workspace not found', 'not_found', 404);
  }
  if (!artifact && !latest) {
    throw new SiteEditorError(
      'This project has no site to edit yet',
      'not_found',
      404
    );
  }

  const files = latest
    ? parseSiteManifest(latest.manifest)
    : parseSiteManifest(artifact?.preview_manifest);

  return {
    files,
    version: latest?.version ?? 0,
    templateSlug: artifact?.template_slug ?? null,
    templateVersion: artifact?.template_version ?? null,
    subscriptionStatus: subscriptionAccessStatus(workspace.subscription_status),
    workspaceName: workspace.name,
    slug: workspace.slug,
    tierName: workspace.tier_name ?? null,
  };
}

export async function listSiteVersions(
  workspaceId: string,
  limit = 25
): Promise<SiteVersionSummary[]> {
  const { data } = await db()
    .from('site_versions')
    .select('version, summary, created_by, created_at, published_at')
    .eq('workspace_id', workspaceId)
    .order('version', { ascending: false })
    .limit(limit);
  return (data ?? []).map((row) => ({
    version: row.version,
    summary: row.summary,
    createdBy: row.created_by,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  }));
}

export async function loadSiteVersion(
  workspaceId: string,
  version: number
): Promise<SiteFile[]> {
  const { data } = await db()
    .from('site_versions')
    .select('manifest')
    .eq('workspace_id', workspaceId)
    .eq('version', version)
    .maybeSingle();
  if (!data) {
    throw new SiteEditorError('That version does not exist', 'not_found', 404);
  }
  return parseSiteManifest(data.manifest);
}

/**
 * Appends a snapshot and points the deployable artifact at it.
 *
 * The baseline is written first when it is missing, so version 1 is always the
 * site exactly as it was delivered — otherwise the first edit would be the
 * oldest thing a client could ever revert to, which is the one version they
 * are guaranteed not to want.
 *
 * The version number is allocated by reading the max and inserting under the
 * `(workspace_id, version)` unique constraint. A losing race raises 23505 and
 * is retried rather than silently overwriting; the constraint, not the read,
 * is what makes two concurrent applies produce two versions.
 */
export async function saveSiteVersion(input: {
  workspaceId: string;
  files: readonly SiteFile[];
  summary: string;
  createdBy: string;
  /** The manifest the change was made against, snapshotted first if absent. */
  baseline?: readonly SiteFile[];
}): Promise<number> {
  const supabase = db();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data: latest } = await supabase
      .from('site_versions')
      .select('version')
      .eq('workspace_id', input.workspaceId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    let next = (latest?.version ?? 0) + 1;

    if (!latest && input.baseline) {
      const { error } = await supabase.from('site_versions').insert({
        workspace_id: input.workspaceId,
        version: 1,
        manifest: manifestJson(input.baseline),
        summary: 'The site as it was delivered',
        created_by: 'system',
      });
      if (error && error.code !== '23505') throw error;
      next = 2;
    }

    const { error } = await supabase.from('site_versions').insert({
      workspace_id: input.workspaceId,
      version: next,
      manifest: manifestJson(input.files),
      summary: input.summary.slice(0, 300),
      created_by: input.createdBy,
    });
    if (error) {
      if (error.code === '23505') continue;
      throw error;
    }

    // The worker and the deploy path both read the artifact row, so the edit
    // is not real until this mirrors the new version.
    const { error: mirrorError } = await supabase
      .from('flowstarter_project_artifacts')
      .update({
        preview_manifest: manifestJson(input.files),
        updated_at: new Date().toISOString(),
      })
      .eq('workspace_id', input.workspaceId);
    if (mirrorError) throw mirrorError;

    return next;
  }

  throw new SiteEditorError(
    'Another change landed first. Try again.',
    'conflict',
    409
  );
}

export async function markVersionPublished(
  workspaceId: string,
  version: number
): Promise<void> {
  const supabase = db();
  await supabase
    .from('site_versions')
    .update({ published_at: null })
    .eq('workspace_id', workspaceId)
    .not('published_at', 'is', null);
  const { error } = await supabase
    .from('site_versions')
    .update({ published_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('version', version);
  if (error) throw error;
}

// ── Audit and caps ─────────────────────────────────────────────────────────

export type SiteEditorEventKind =
  | 'site_edit_proposed'
  | 'site_edited'
  | 'site_image_replaced'
  | 'site_reverted'
  | 'site_publish_requested';

/**
 * A client's prompt is their own words about their own business and can name
 * anyone; it is not evidence of anything, and the audit trail is read by
 * operators. So the event carries a sha256 of the instruction and its length —
 * enough to prove two requests were the same request, and to correlate with a
 * support conversation — and never the text.
 */
export function instructionFingerprint(instruction: string): {
  instructionSha256: string;
  instructionChars: number;
} {
  return {
    instructionSha256: createHash('sha256').update(instruction).digest('hex'),
    instructionChars: instruction.length,
  };
}

export async function recordSiteEditorEvent(input: {
  workspaceId: string;
  kind: SiteEditorEventKind;
  actor: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const { error } = await db()
    .from('project_events')
    .insert({
      workspace_id: input.workspaceId,
      kind: input.kind,
      actor: input.actor,
      payload: input.payload as unknown as Json,
    });
  // Accounting must not fail a client's edit, but a cap that silently stopped
  // counting would be worse than no cap, so a failed *insert* is fatal for the
  // proposal path (which awaits this before spending tokens) and logged here.
  if (error) throw error;
}

/** UTC midnight, so the cap resets on a boundary nobody has to reason about. */
export function startOfUtcDay(now = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ).toISOString();
}

/**
 * Proposals since an instant. The daily cap and the monthly allowance count
 * the same rows over different windows, so they count them through the same
 * query: two nearly-identical counters would drift the first time one of them
 * learned about a new event kind.
 */
export async function countProposalsSince(
  workspaceId: string,
  sinceIso: string
): Promise<number> {
  return countEventsSince(workspaceId, 'site_edit_proposed', sinceIso);
}

/**
 * Applied edits since an instant, which is what the client's own dashboard
 * shows as "changes you made". Deliberately not the same number as the credit
 * count: credits are spent on the proposal, whether or not the client kept it.
 */
export async function countAppliedEditsSince(
  workspaceId: string,
  sinceIso: string
): Promise<number> {
  return countEventsSince(workspaceId, 'site_edited', sinceIso);
}

async function countEventsSince(
  workspaceId: string,
  kind: SiteEditorEventKind,
  sinceIso: string
): Promise<number> {
  const { count, error } = await db()
    .from('project_events')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('kind', kind)
    .gte('created_at', sinceIso);
  if (error) throw error;
  return count ?? 0;
}

export async function countProposalsToday(
  workspaceId: string,
  now = new Date()
): Promise<number> {
  return countProposalsSince(workspaceId, startOfUtcDay(now));
}

/**
 * The fingerprint of the request that produced the text now being applied.
 *
 * Derived here rather than echoed back by the browser: an audit row whose
 * "which request was this" field came from the client would prove nothing. The
 * newest proposal for this target is the one being applied in every real flow,
 * and a miss simply leaves the field null rather than guessing.
 */
export async function latestProposalFingerprint(
  workspaceId: string,
  targetId: string
): Promise<string | null> {
  const { data } = await db()
    .from('project_events')
    .select('payload, created_at')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'site_edit_proposed')
    .order('created_at', { ascending: false })
    .limit(20);
  for (const row of data ?? []) {
    const payload = row.payload as Record<string, unknown> | null;
    if (payload && payload['targetId'] === targetId) {
      const hash = payload['instructionSha256'];
      return typeof hash === 'string' ? hash : null;
    }
  }
  return null;
}

// ── Image slots ────────────────────────────────────────────────────────────

/**
 * `listSiteImageSlots` and `replaceSiteImage` in the codegen package are the
 * only place that knows which lines of a template's content file are picture
 * slots and how to rewrite one safely, and both work on a directory. The site
 * here is a manifest in a row, so the content files — and only those; the slot
 * readers touch nothing else — are written to a scratch directory, the package
 * does the work, and the result is folded back into the manifest.
 *
 * The alternative, re-implementing the slot regexes here, would give us two
 * definitions of "an image slot" that could disagree about which line a
 * client's photograph lands on.
 */
async function withContentWorkspace<T>(
  files: readonly SiteFile[],
  run: (root: string) => Promise<T>
): Promise<T> {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { dirname, join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'flowstarter-site-'));
  try {
    for (const file of files) {
      if (!/^src\/content\//.test(file.path)) continue;
      if (file.encoding === 'base64') continue;
      const target = join(root, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, 'utf8');
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

export interface ManifestImageSlot {
  id: string;
  file: string;
  line: number;
  currentPath: string;
  section: string;
  key: string;
  alt?: string;
}

export async function listManifestImageSlots(
  files: readonly SiteFile[]
): Promise<ManifestImageSlot[]> {
  const { listSiteImageSlots } = await import(
    '@flowstarter/agentic-codegen/src/flowstarter/site-media'
  );
  return withContentWorkspace(files, (root) => listSiteImageSlots(root));
}

export interface ImageSwapResult {
  files: SiteFile[];
  changedPaths: string[];
  slotId: string;
  publicPath: string;
  previousPath: string;
}

/**
 * Puts one of the client's own pictures into one of the site's slots.
 *
 * `replaceSiteImage` re-reads the slot's line and refuses if it no longer
 * holds the path the slot was read with, which is the same optimistic
 * concurrency `applyTargetEdit` uses for text — a slot that moved must not be
 * overwritten by a swap aimed at whatever used to be there.
 */
export async function swapManifestImage(input: {
  files: readonly SiteFile[];
  slotId: string;
  bytes: Buffer;
  alt?: string;
}): Promise<ImageSwapResult> {
  const { listSiteImageSlots, replaceSiteImage } = await import(
    '@flowstarter/agentic-codegen/src/flowstarter/site-media'
  );
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  return withContentWorkspace(input.files, async (root) => {
    const slot = (await listSiteImageSlots(root)).find(
      (candidate) => candidate.id === input.slotId
    );
    if (!slot) {
      throw new SiteEditorError(
        'That image slot is not part of this site',
        'not_found',
        404
      );
    }

    const result = await replaceSiteImage(root, {
      slot,
      bytes: input.bytes,
      ...(input.alt === undefined ? {} : { alt: input.alt }),
    });

    const files = input.files.map((file) => ({ ...file }));
    const changedPaths: string[] = [];

    const contentFile = files.find((file) => file.path === slot.file);
    if (contentFile) {
      contentFile.content = await readFile(join(root, slot.file), 'utf8');
      changedPaths.push(contentFile.path);
    }

    // `publicPath` is site-rooted (`/flowstarter-media/x.png`); in the manifest
    // that file lives under `public/`, which is where the build reads it from.
    const mediaPath = `public${result.publicPath}`;
    const mediaBytes = await readFile(join(root, mediaPath));
    const entry: SiteFile = {
      path: mediaPath,
      content: mediaBytes.toString('base64'),
      encoding: 'base64',
    };
    const existing = files.findIndex((file) => file.path === mediaPath);
    if (existing >= 0) files[existing] = entry;
    else files.push(entry);
    changedPaths.push(mediaPath);

    return {
      files,
      changedPaths,
      slotId: result.slotId,
      publicPath: result.publicPath,
      previousPath: result.previousPath,
    };
  });
}
