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
   * The role the app stored on the row: `portrait` for the one photograph the
   * client picked as themselves, null otherwise. Read here rather than
   * inferred, because the about section is the one place it decides anything
   * and a guess would put a stranger's face on it.
   */
  kind: string | null;
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
  kind: string | null;
  rights_confirmed_at: string | null;
}

export async function loadUsableAssets(
  workspaceId: string
): Promise<UsableAsset[]> {
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await withTenant(supabase, workspaceId)
    .from('assets')
    .select(
      'id, storage_path, mime, width, height, usable_for, caption, kind, rights_confirmed_at'
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
      kind: row.kind,
    }));
}
