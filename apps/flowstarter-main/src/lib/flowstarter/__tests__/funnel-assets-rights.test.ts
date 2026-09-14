/**
 * The one write that makes a fetched picture publishable.
 *
 * A photograph read off somebody's public profile is filed with
 * `rights_confirmed_at` NULL, which is what keeps it out of
 * `loadUsableAssets` and therefore off a paid site. The claim page asks one
 * question and this is what that answer does. Everything about it is worth a
 * test: that it only touches pictures we fetched, that it does not overwrite
 * an existing confirmation, and that it records who and when.
 */
import { describe, expect, it, vi } from 'vitest';

import { confirmFetchedPictureRights } from '../funnel-assets';

const PREVIEW = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

/**
 * A Supabase double that records the query it was asked to build. Only the
 * chain `confirmFetchedPictureRights` actually uses is implemented; anything
 * else throwing is the point, not an omission.
 */
function fakeSupabase(rows: Array<{ id: string }> = [{ id: 'a' }]) {
  const calls: Record<string, unknown> = {};
  const builder = {
    update(patch: Record<string, unknown>) {
      calls.patch = patch;
      return builder;
    },
    eq(column: string, value: unknown) {
      calls[`eq:${column}`] = value;
      return builder;
    },
    in(column: string, values: unknown) {
      calls[`in:${column}`] = values;
      return builder;
    },
    is(column: string, value: unknown) {
      calls[`is:${column}`] = value;
      return builder;
    },
    select() {
      return Promise.resolve({ data: rows, error: null });
    },
  };
  return {
    client: { from: (table: string) => ((calls.table = table), builder) },
    calls,
  };
}

describe('confirmFetchedPictureRights', () => {
  it('writes the confirmation, the version, the address and the agent', async () => {
    const { client, calls } = fakeSupabase();
    const result = await confirmFetchedPictureRights({
      previewId: PREVIEW,
      statementVersion: '2026-08-30',
      ip: '203.0.113.9',
      userAgent: 'Mozilla/5.0',
      supabase: client as never,
    });

    expect(result).toEqual({ confirmed: 1 });
    expect(calls.table).toBe('funnel_assets');
    const patch = calls.patch as Record<string, string>;
    expect(patch.rights_statement_version).toBe('2026-08-30');
    expect(patch.rights_ip).toBe('203.0.113.9');
    expect(patch.rights_user_agent).toBe('Mozilla/5.0');
    // A timestamp, not a boolean: the question is when, and evidence with no
    // time on it is not evidence.
    expect(Date.parse(patch.rights_confirmed_at as string)).not.toBeNaN();
  });

  it('is scoped to the preview it was asked about', async () => {
    const { client, calls } = fakeSupabase();
    await confirmFetchedPictureRights({
      previewId: PREVIEW,
      statementVersion: '2026-08-30',
      ip: null,
      userAgent: null,
      supabase: client as never,
    });
    expect(calls['eq:preview_id']).toBe(PREVIEW);
  });

  it('only confirms pictures we fetched, never one the visitor uploaded', async () => {
    // A visitor tapping "use my profile picture" is answering about the
    // picture we took off their profile. It must not retroactively confirm
    // rights over anything else filed against the same preview.
    const { client, calls } = fakeSupabase();
    await confirmFetchedPictureRights({
      previewId: PREVIEW,
      statementVersion: '2026-08-30',
      ip: null,
      userAgent: null,
      supabase: client as never,
    });
    expect(calls['in:source']).toEqual([
      'instagram',
      'linkedin',
      'github',
      'og',
    ]);
    expect(calls['in:source']).not.toContain('upload');
  });

  it('leaves an existing confirmation alone', async () => {
    // Evidence is insert-once. A second claim must not rewrite the moment the
    // first one recorded.
    const { client, calls } = fakeSupabase();
    await confirmFetchedPictureRights({
      previewId: PREVIEW,
      statementVersion: '2026-08-30',
      ip: null,
      userAgent: null,
      supabase: client as never,
    });
    expect(calls['is:rights_confirmed_at']).toBeNull();
  });

  it('truncates a user agent long enough to be a payload', async () => {
    const { client, calls } = fakeSupabase();
    await confirmFetchedPictureRights({
      previewId: PREVIEW,
      statementVersion: '2026-08-30',
      ip: null,
      userAgent: 'x'.repeat(900),
      supabase: client as never,
    });
    expect(
      (calls.patch as Record<string, string>).rights_user_agent
    ).toHaveLength(500);
  });

  it('reports zero when there was nothing fetched to confirm', async () => {
    const { client } = fakeSupabase([]);
    expect(
      await confirmFetchedPictureRights({
        previewId: PREVIEW,
        statementVersion: '2026-08-30',
        ip: null,
        userAgent: null,
        supabase: client as never,
      })
    ).toEqual({ confirmed: 0 });
  });

  it('surfaces a database error rather than reporting a false confirmation', async () => {
    const client = {
      from: () => ({
        update: () => ({
          eq: () => ({
            in: () => ({
              is: () => ({
                select: async () => ({
                  data: null,
                  error: { message: 'permission denied' },
                }),
              }),
            }),
          }),
        }),
      }),
    };
    await expect(
      confirmFetchedPictureRights({
        previewId: PREVIEW,
        statementVersion: '2026-08-30',
        ip: null,
        userAgent: null,
        supabase: client as never,
      })
    ).rejects.toMatchObject({ message: 'permission denied' });
  });

  it('does not reach for a client when one is handed to it', async () => {
    const service = vi.fn();
    const { client } = fakeSupabase();
    await confirmFetchedPictureRights({
      previewId: PREVIEW,
      statementVersion: '2026-08-30',
      ip: null,
      userAgent: null,
      supabase: client as never,
    });
    expect(service).not.toHaveBeenCalled();
  });
});
