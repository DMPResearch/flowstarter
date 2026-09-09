/**
 * The write the build worker depends on. Every assertion the worker makes at
 * claim time is checked here at write time, because a failure discovered
 * later happens after the client has already paid.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
// Static import: `vi.mock` is hoisted above it, and the app's tsconfig does
// not permit top-level await.
import {
  savePreviewArtifacts,
  PreviewArtifactError,
} from '../preview-artifacts';

const rows: {
  workspaces: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
} = { workspaces: [], artifacts: [] };
const captured: { update?: Record<string, unknown>; stateFilter?: unknown } =
  {};

/** Tables whose next query comes back as a Postgrest error. */
const failing = new Set<string>();

function builderFor(table: string) {
  const store = table === 'workspaces' ? rows.workspaces : rows.artifacts;
  let mode: 'select' | 'upsert' | 'update' = 'select';
  let stateFilter: string[] | null = null;
  const builder = {
    select() {
      return builder;
    },
    upsert(values: Record<string, unknown>) {
      mode = 'upsert';
      if (failing.has(table)) {
        return Promise.resolve({
          data: null,
          error: { message: `fake: ${table} is down` },
        });
      }
      const index = store.findIndex(
        (row) => row.workspace_id === values.workspace_id
      );
      if (index >= 0) store[index] = values;
      else store.push(values);
      return Promise.resolve({ data: null, error: null });
    },
    update(values: Record<string, unknown>) {
      mode = 'update';
      captured.update = values;
      return builder;
    },
    eq() {
      return builder;
    },
    in(_column: string, values: string[]) {
      stateFilter = values;
      captured.stateFilter = values;
      return builder;
    },
    maybeSingle() {
      if (failing.has(`${table}:${mode}`)) {
        return Promise.resolve({
          data: null,
          error: { message: `fake: ${table} is down` },
        });
      }
      if (mode === 'update') {
        const workspace = rows.workspaces[0];
        // The `.in(...)` guard decides whether the update matched a row.
        if (
          stateFilter &&
          !stateFilter.includes(String(workspace?.project_state))
        ) {
          return Promise.resolve({ data: null, error: null });
        }
        Object.assign(workspace ?? {}, captured.update);
        return Promise.resolve({ data: { id: workspace?.id }, error: null });
      }
      return Promise.resolve({ data: store[0] ?? null, error: null });
    },
  };
  return builder;
}

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({ from: builderFor }),
}));

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    intake: { projectId: WORKSPACE_ID, business: { name: 'Calm Path' } },
    brandConfig: { schemaVersion: '1.0' },
    template: { slug: 'wellness-therapy', reason: 'Fits the service journey.' },
    files: [
      { path: 'src/content/site.md', content: 'personalized', type: 'file' },
    ],
    previewArtifactUrl: 's3://previews/calm-path.tar.gz',
    ...overrides,
  } as never;
}

beforeEach(() => {
  rows.workspaces = [{ id: WORKSPACE_ID, project_state: ProjectState.INTAKE }];
  rows.artifacts = [];
  captured.update = undefined;
  captured.stateFilter = undefined;
  failing.clear();
});

describe('savePreviewArtifacts', () => {
  it('writes everything the build worker reads back', async () => {
    const result = await savePreviewArtifacts(validInput());

    expect(result).toMatchObject({
      workspaceId: WORKSPACE_ID,
      fileCount: 1,
      templateSlug: 'wellness-therapy',
    });
    const row = rows.artifacts[0] as Record<string, never>;
    expect(row.workspace_id).toBe(WORKSPACE_ID);
    expect(row.template_slug).toBe('wellness-therapy');
    expect(row.preview_artifact_url).toBe('s3://previews/calm-path.tar.gz');
    // The worker parses exactly this shape.
    expect(row.preview_manifest).toEqual({
      files: [{ path: 'src/content/site.md', content: 'personalized' }],
    });
    expect((row.intake_payload as { projectId: string }).projectId).toBe(
      WORKSPACE_ID
    );
  });

  it('advances the lifecycle to PREVIEW_READY when asked', async () => {
    const result = await savePreviewArtifacts(
      validInput({ advanceToPreviewReady: true })
    );

    expect(result.advanced).toBe(true);
    expect(captured.update).toMatchObject({
      project_state: ProjectState.PREVIEW_READY,
    });
    expect(captured.stateFilter).toEqual([
      ProjectState.INTAKE,
      ProjectState.PREVIEW_READY,
    ]);
  });

  it('never walks a paid workspace backwards', async () => {
    rows.workspaces[0]!.project_state = ProjectState.DEPOSIT_PAID;

    const result = await savePreviewArtifacts(
      validInput({ advanceToPreviewReady: true })
    );

    // The artifacts are refreshed, but the lifecycle stays where it is.
    expect(result.advanced).toBe(false);
    expect(rows.workspaces[0]!.project_state).toBe(ProjectState.DEPOSIT_PAID);
    expect(rows.artifacts).toHaveLength(1);
  });

  it('replaces the artifacts when a preview is regenerated', async () => {
    await savePreviewArtifacts(validInput());
    await savePreviewArtifacts(
      validInput({
        template: { slug: 'creative-portfolio', reason: 'Second look.' },
        files: [{ path: 'src/content/site.md', content: 'v2', type: 'file' }],
      })
    );

    expect(rows.artifacts).toHaveLength(1);
    expect(rows.artifacts[0]!.template_slug).toBe('creative-portfolio');
  });

  it('refuses a manifest the worker could not build from', async () => {
    await expect(
      savePreviewArtifacts(validInput({ files: [] }))
    ).rejects.toThrow(PreviewArtifactError);
    await expect(
      savePreviewArtifacts(
        validInput({ files: [{ path: 'a.md', type: 'file' }] })
      )
    ).rejects.toThrow(/has no content/);
  });

  it('refuses a preview whose intake belongs to another workspace', async () => {
    await expect(
      savePreviewArtifacts(
        validInput({
          intake: { projectId: 'b1f4e1088-0000-4f18-83b1-406cc292b23c' },
        })
      )
    ).rejects.toThrow(/must match the workspace/);
  });

  it('refuses a workspace that does not exist', async () => {
    rows.workspaces = [];
    await expect(savePreviewArtifacts(validInput())).rejects.toThrow(
      /Workspace does not exist/
    );
  });
});

describe('what savePreviewArtifacts refuses to write', () => {
  it('rejects a workspace id that is not a uuid before anything else', async () => {
    await expect(
      savePreviewArtifacts(
        validInput({ workspaceId: 'nope', intake: { projectId: 'nope' } })
      )
    ).rejects.toThrow(/Invalid workspace id/);
    expect(rows.artifacts).toHaveLength(0);
  });

  it('refuses a preview with no template chosen', async () => {
    await expect(
      savePreviewArtifacts(validInput({ template: { reason: 'none' } }))
    ).rejects.toThrow(/no template selection/);
    await expect(
      savePreviewArtifacts(validInput({ template: undefined }))
    ).rejects.toThrow(/no template selection/);
  });

  it('refuses a manifest with a file that has no path', async () => {
    await expect(
      savePreviewArtifacts(
        validInput({ files: [{ path: '', content: 'x', type: 'file' }] })
      )
    ).rejects.toThrow(/no path/);
  });

  it('refuses a manifest bigger than the worker will accept', async () => {
    await expect(
      savePreviewArtifacts(
        validInput({
          files: Array.from({ length: 2_001 }, (_, i) => ({
            path: `src/${i}.md`,
            content: 'x',
            type: 'file',
          })),
        })
      )
    ).rejects.toThrow(/too many files/);

    await expect(
      savePreviewArtifacts(
        validInput({
          files: [
            {
              path: 'src/huge.md',
              content: 'x'.repeat(24 * 1024 * 1024 + 1),
              type: 'file',
            },
          ],
        })
      )
    ).rejects.toThrow(/exceeds the size limit/);
  });

  it('keeps a binary file’s encoding so the worker decodes it the same way', async () => {
    await savePreviewArtifacts(
      validInput({
        files: [
          { path: 'public/logo.png', content: 'AAAA', encoding: 'base64' },
          { path: 'src/content/site.md', content: 'plain' },
        ],
      })
    );

    expect(rows.artifacts[0]!.preview_manifest).toEqual({
      files: [
        { path: 'public/logo.png', content: 'AAAA', encoding: 'base64' },
        { path: 'src/content/site.md', content: 'plain' },
      ],
    });
  });

  it('stores nothing rather than half of a preview when a query fails', async () => {
    failing.add('workspaces:select');
    await expect(savePreviewArtifacts(validInput())).rejects.toMatchObject({
      message: expect.stringContaining('is down'),
    });
    expect(rows.artifacts).toHaveLength(0);

    failing.clear();
    failing.add('flowstarter_project_artifacts');
    await expect(savePreviewArtifacts(validInput())).rejects.toMatchObject({
      message: expect.stringContaining('is down'),
    });

    failing.clear();
    failing.add('workspaces:update');
    await expect(
      savePreviewArtifacts(validInput({ advanceToPreviewReady: true }))
    ).rejects.toMatchObject({ message: expect.stringContaining('is down') });
  });

  it('records the absent optional fields as null, not as undefined', async () => {
    await savePreviewArtifacts(
      validInput({
        template: { slug: 'wellness-therapy' },
        previewArtifactUrl: undefined,
      })
    );

    const row = rows.artifacts[0]!;
    expect(row.template_selection_reason).toBeNull();
    expect(row.preview_artifact_url).toBeNull();
    expect(row.scrape_manifest).toEqual({});
  });
});
