import 'server-only';

import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { withTenant } from '@/lib/tenancy';

/**
 * The only supported way to load a workspace's assets for generation.
 *
 * Rights are confirmed over a specific set of files at selection time, so an
 * asset row existing says we hold the file, not that we may publish it. Every
 * other reader in the app answers "what does this workspace have" -- the gate
 * deliberately counts unconfirmed uploads, because they still tell us what is
 * missing. This one answers "what may we build with", which is a different
 * question and the only one the generator is allowed to ask.
 *
 * It lives apart from those readers so the filter cannot be lost by editing a
 * shared query, and a guard test fails the build if the preview route or the
 * worker assembles generator assets from a raw table read instead.
 */
export interface UsableAsset {
  id: string;
  storagePath: string;
  mime: string | null;
  width: number | null;
  height: number | null;
  usableFor: string[];
  caption: string | null;
  /**
   * Who is answerable for `caption`: `'client'` once a human typed or
   * confirmed it, `'auto'` while it is still only a vision call's unconfirmed
   * guess, null before any caption exists. The change-request placement rule
   * and its build-output gate (`@flowstarter/agentic-codegen`) read this the
   * same as `caption` itself — an auto-caption is still evidence, just
   * evidence nobody has stood behind yet.
   */
  captionSource: 'client' | 'auto' | null;
  /**
   * The auto-caption's structured `kind` (`screenshot` | `photo` | `logo` |
   * `document`), for display next to `caption` in the operator's
   * change-request picker. Distinct from `kind` above, which is
   * `assets.kind` and means something else entirely (`portrait` for the
   * about-section photograph); this one is never written by anything but
   * `autoCaptionAsset`.
   */
  autoCaptionKind: 'screenshot' | 'photo' | 'logo' | 'document' | null;
  /**
   * The browser's own filename, kept for display only (the operator's
   * change-request asset picker leans on it when there is no caption). It is
   * never the storage key — that is the content hash in `storagePath` — so
   * this can be null, empty-ish, or absent without anything breaking.
   */
  originalName: string | null;
  /** When the file was uploaded, for the same picker's "no caption" label. */
  createdAt: string | null;
  /**
   * The role the app stored on the row: `portrait` for the one photograph the
   * client picked as themselves, null otherwise. Read here rather than
   * inferred, because the about section is the one place it decides anything
   * and a guess would put a stranger's face on it.
   */
  kind: string | null;
  /**
   * Where the bytes came from: `upload` for a file the client sent us, or the
   * network we downloaded it from (`linkedin`, `instagram`, `github`, `og`).
   *
   * Read rather than assumed. A portrait sourced from somebody's own LinkedIn
   * is not a file they uploaded, and the first question anybody asks when a
   * rights complaint arrives is which of the two it was.
   */
  source: string;
  /** The provider URL we downloaded it from, or null for an upload. */
  sourceUrl: string | null;
}

/** The columns this module reads; `withTenant` is deliberately loosely typed. */
interface AssetRow {
  id: string;
  storage_path: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  usable_for: string[] | null;
  caption: string | null;
  caption_source: string | null;
  auto_caption: { kind: string } | null;
  original_name: string | null;
  created_at: string | null;
  kind: string | null;
  source: string | null;
  source_url: string | null;
  rights_confirmed_at: string | null;
}

export async function loadUsableAssets(
  workspaceId: string
): Promise<UsableAsset[]> {
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await withTenant(supabase, workspaceId)
    .from('assets')
    .select(
      'id, storage_path, mime, width, height, usable_for, caption, caption_source, auto_caption, original_name, created_at, kind, source, source_url, rights_confirmed_at'
    )
    .not('rights_confirmed_at', 'is', null);
  if (error) throw error;

  const rows = (data ?? []) as unknown as AssetRow[];
  return rows
    .filter((row) => Boolean(row.rights_confirmed_at) && row.storage_path)
    .map((row) => ({
      id: row.id,
      storagePath: row.storage_path as string,
      mime: row.mime,
      width: row.width,
      height: row.height,
      usableFor: row.usable_for ?? [],
      caption: row.caption,
      captionSource:
        row.caption_source === 'client' || row.caption_source === 'auto'
          ? row.caption_source
          : null,
      autoCaptionKind:
        (row.auto_caption?.kind as UsableAsset['autoCaptionKind']) ?? null,
      originalName: row.original_name,
      createdAt: row.created_at,
      kind: row.kind,
      source: row.source ?? 'upload',
      sourceUrl: row.source_url,
    }));
}
