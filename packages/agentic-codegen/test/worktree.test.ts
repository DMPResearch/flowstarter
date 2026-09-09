/**
 * `SafeGitWorktreeManager` is the git worktree policy AGENTS.md points at:
 * "Commit messages the worker creates must match the policy in
 * `packages/agentic-codegen/src/flowstarter/worktree.ts`, which accepts
 * exactly two shapes and rejects everything else." These tests exercise the
 * real class against real temporary git repositories (no mocking of git
 * itself, matching how `flowstarter-workflows.test.ts` already proves
 * `discard`), plus the guard rails around it: absolute-path and git
 * top-level checks in the constructor and `create`, the broad-root and
 * path-containment guards, and the generic git-failure branch in `runGit`.
 */
import { execFileSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { deepTempDir } from './helpers';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeGitWorktreeManager } from '../src/flowstarter/worktree';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('the temp roots these tests run on', () => {
  it('is deep enough for assertNotBroadRoot on any platform', async () => {
    // The guard counts segments of the REALPATH, and `os.tmpdir()` is two
    // segments on Linux and six on macOS. Every test below hands its root to
    // the manager, so if this invariant breaks they all break at once, on one
    // platform only, with an error that says nothing about tmpdir. Assert it
    // here instead, where the message is the diagnosis.
    const root = await deepTempDir('fs-depth');
    temporaryDirectories.push(root);
    const canonical = await realpath(root);
    expect(
      canonical.split(sep).filter(Boolean).length,
      `${canonical} has too few segments; the worktree guard refuses it`,
    ).toBeGreaterThanOrEqual(3);
  });
});

async function initRepo(): Promise<string> {
  const repositoryRoot = await deepTempDir('fs-repo');
  temporaryDirectories.push(repositoryRoot);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repositoryRoot });
  // Write the identity into the repository, not just onto the setup commit.
  // `SafeGitWorktreeManager.commit` runs a plain `git commit` in the worktree
  // and inherits whatever config it finds, and a CI runner has no global
  // gitconfig: on Depot these tests failed with "Author identity unknown"
  // while passing on any developer machine, which has one. A worktree shares
  // its parent repository's config, so setting it here covers both.
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repositoryRoot });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repositoryRoot });
  execFileSync(
    'git',
    [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ],
    { cwd: repositoryRoot },
  );
  return repositoryRoot;
}

async function worktreesDir(): Promise<string> {
  const worktreesRoot = await deepTempDir('fs-worktrees');
  temporaryDirectories.push(worktreesRoot);
  return worktreesRoot;
}

describe('SafeGitWorktreeManager construction', () => {
  it('rejects a non-absolute repository or worktrees root', () => {
    expect(
      () =>
        new SafeGitWorktreeManager({
          repositoryRoot: 'relative/repo',
          worktreesRoot: '/tmp/worktrees',
        }),
    ).toThrow(/absolute paths/);
    expect(
      () =>
        new SafeGitWorktreeManager({
          repositoryRoot: '/tmp/repo',
          worktreesRoot: 'relative/worktrees',
        }),
    ).toThrow(/absolute paths/);
  });

  it('rejects a baseRef that is not a safe git ref', () => {
    expect(
      () =>
        new SafeGitWorktreeManager({
          repositoryRoot: '/tmp/repo',
          worktreesRoot: '/tmp/worktrees',
          baseRef: '-oops',
        }),
    ).toThrow(/baseRef is not a safe git ref/);
  });
});

describe('SafeGitWorktreeManager.create', () => {
  it('rejects a projectId that is not a canonical UUID', async () => {
    const repositoryRoot = await initRepo();
    const worktreesRoot = await worktreesDir();
    const manager = new SafeGitWorktreeManager({
      repositoryRoot,
      worktreesRoot,
      baseRef: 'main',
    });

    await expect(manager.create('not-a-uuid')).rejects.toThrow(
      /canonical UUID/,
    );
  });

  it('refuses a worktrees root that equals the repository root', async () => {
    const repositoryRoot = await initRepo();
    const manager = new SafeGitWorktreeManager({
      repositoryRoot,
      worktreesRoot: repositoryRoot,
      baseRef: 'main',
    });

    await expect(
      manager.create('0f4e1088-8d8f-4f18-83b1-406cc292b23c'),
    ).rejects.toThrow(/cannot equal the repository root/);
  });

  it('refuses a worktrees root that is too broad a filesystem path', async () => {
    const repositoryRoot = await initRepo();
    // "/" already exists, so the recursive mkdir the manager performs is a
    // no-op; the manager should still refuse to use it as a worktrees root
    // before it ever touches git, regardless of the platform's tmp layout.
    const manager = new SafeGitWorktreeManager({
      repositoryRoot,
      worktreesRoot: '/',
      baseRef: 'main',
    });

    await expect(
      manager.create('0f4e1088-8d8f-4f18-83b1-406cc292b23c'),
    ).rejects.toThrow(/broad filesystem path/);
  });

  it('refuses a repositoryRoot that is not the git top-level directory', async () => {
    const repositoryRoot = await initRepo();
    const nested = join(repositoryRoot, 'nested');
    await mkdir(nested);
    const worktreesRoot = await worktreesDir();
    const manager = new SafeGitWorktreeManager({
      repositoryRoot: nested,
      worktreesRoot,
      baseRef: 'main',
    });

    await expect(
      manager.create('0f4e1088-8d8f-4f18-83b1-406cc292b23c'),
    ).rejects.toThrow(/not the git top-level directory/);
  });

  it('refuses to create a second worktree for a project id already in use', async () => {
    const repositoryRoot = await initRepo();
    const worktreesRoot = await worktreesDir();
    const manager = new SafeGitWorktreeManager({
      repositoryRoot,
      worktreesRoot,
      baseRef: 'main',
    });
    const projectId = 'a1b2c3d4-1111-4222-8333-444455556666';

    await manager.create(projectId);

    await expect(manager.create(projectId)).rejects.toThrow(
      /Worktree path already exists/,
    );
  });

  it('refuses to create a worktree when the branch already exists without a worktree directory', async () => {
    const repositoryRoot = await initRepo();
    const worktreesRoot = await worktreesDir();
    const projectId = 'b2c3d4e5-2222-4333-8444-555566667777';
    // A branch can outlive its worktree (e.g. `git worktree remove` ran but
    // the branch delete step was interrupted). `create` must still refuse.
    execFileSync('git', ['branch', `client/flowstarter-${projectId}`], {
      cwd: repositoryRoot,
    });
    const manager = new SafeGitWorktreeManager({
      repositoryRoot,
      worktreesRoot,
      baseRef: 'main',
    });

    await expect(manager.create(projectId)).rejects.toThrow(
      /Git branch already exists/,
    );
  });
});

describe('SafeGitWorktreeManager.discard', () => {
  it('does nothing when the worktrees root does not exist at all', async () => {
    const repositoryRoot = await initRepo();
    const missingWorktreesRoot = join(
      await deepTempDir('fs-missing'),
      'never-created',
    );
    const manager = new SafeGitWorktreeManager({
      repositoryRoot,
      worktreesRoot: missingWorktreesRoot,
      baseRef: 'main',
    });

    await expect(
      manager.discard('c3d4e5f6-3333-4444-8555-666677778888'),
    ).resolves.toBeUndefined();
  });

  it('falls back to a manual removal for a directory git no longer tracks as a worktree', async () => {
    const repositoryRoot = await initRepo();
    const worktreesRoot = await worktreesDir();
    const projectId = 'd4e5f6a7-4444-4555-8666-777788889999';
    const worktreePath = join(worktreesRoot, `flowstarter-${projectId}`);
    // Simulate a crashed attempt: the directory exists on disk but git's
    // `.git/worktrees` metadata never registered it (or was already pruned),
    // so `git worktree remove` will decline it and the code must remove the
    // directory itself.
    await mkdir(worktreePath);
    await writeFile(join(worktreePath, 'stray.txt'), 'leftover', 'utf8');
    const manager = new SafeGitWorktreeManager({
      repositoryRoot,
      worktreesRoot,
      baseRef: 'main',
    });

    await manager.discard(projectId);

    await expect(access(worktreePath)).rejects.toThrow();
  });
});

describe('SafeGitWorktreeManager.commit', () => {
  const worktreeShape = {
    branch: 'client/flowstarter-anything',
    path: '/does/not/matter',
  };

  it('accepts the FULL_SITE_BUILD initial-commit shape', async () => {
    const repositoryRoot = await initRepo();
    const worktreesRoot = await worktreesDir();
    const manager = new SafeGitWorktreeManager({
      repositoryRoot,
      worktreesRoot,
      baseRef: 'main',
    });
    const projectId = 'e5f6a7b8-5555-4666-8777-88889999aaaa';
    const worktree = await manager.create(projectId);
    await writeFile(join(worktree.path, 'note.txt'), 'first build', 'utf8');

    const sha = await manager.commit(
      worktree,
      `build: initialize Flowstarter site ${projectId}`,
    );

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(
      execFileSync('git', ['log', '-1', '--format=%s'], {
        cwd: worktree.path,
        encoding: 'utf8',
      }).trim(),
    ).toBe(`build: initialize Flowstarter site ${projectId}`);
  });

  it('accepts the SITE_REBUILD publish-edit shape', async () => {
    const repositoryRoot = await initRepo();
    const worktreesRoot = await worktreesDir();
    const manager = new SafeGitWorktreeManager({
      repositoryRoot,
      worktreesRoot,
      baseRef: 'main',
    });
    const projectId = 'f6a7b8c9-6666-4777-8888-9999aaaabbbb';
    const worktree = await manager.create(projectId);
    await writeFile(join(worktree.path, 'edit.txt'), 'client edit', 'utf8');

    const sha = await manager.commit(
      worktree,
      `build: publish client edit to site ${projectId}`,
    );

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(
      execFileSync('git', ['log', '-1', '--format=%s'], {
        cwd: worktree.path,
        encoding: 'utf8',
      }).trim(),
    ).toBe(`build: publish client edit to site ${projectId}`);
  });

  it('rejects a message with the wrong prefix', async () => {
    const manager = new SafeGitWorktreeManager({
      repositoryRoot: '/tmp/repo',
      worktreesRoot: '/tmp/worktrees',
      baseRef: 'main',
    });

    await expect(
      manager.commit(
        worktreeShape,
        'chore: initialize Flowstarter site a1b2c3d4-1111-4222-8333-444455556666',
      ),
    ).rejects.toThrow(/outside the Flowstarter build policy/);
  });

  it('rejects a message missing the required scope wording', async () => {
    const manager = new SafeGitWorktreeManager({
      repositoryRoot: '/tmp/repo',
      worktreesRoot: '/tmp/worktrees',
      baseRef: 'main',
    });

    await expect(
      manager.commit(
        worktreeShape,
        'build: initialize site a1b2c3d4-1111-4222-8333-444455556666',
      ),
    ).rejects.toThrow(/outside the Flowstarter build policy/);
  });

  it('rejects a message with trailing junk after the project id', async () => {
    const manager = new SafeGitWorktreeManager({
      repositoryRoot: '/tmp/repo',
      worktreesRoot: '/tmp/worktrees',
      baseRef: 'main',
    });

    await expect(
      manager.commit(
        worktreeShape,
        'build: initialize Flowstarter site a1b2c3d4-1111-4222-8333-444455556666 please',
      ),
    ).rejects.toThrow(/outside the Flowstarter build policy/);
  });

  it('rejects an empty subject', async () => {
    const manager = new SafeGitWorktreeManager({
      repositoryRoot: '/tmp/repo',
      worktreesRoot: '/tmp/worktrees',
      baseRef: 'main',
    });

    await expect(manager.commit(worktreeShape, '')).rejects.toThrow(
      /outside the Flowstarter build policy/,
    );
  });

  it('rejects a multi-line body appended to an otherwise valid subject', async () => {
    const manager = new SafeGitWorktreeManager({
      repositoryRoot: '/tmp/repo',
      worktreesRoot: '/tmp/worktrees',
      baseRef: 'main',
    });

    await expect(
      manager.commit(
        worktreeShape,
        'build: initialize Flowstarter site a1b2c3d4-1111-4222-8333-444455556666\n\nExtra body text.',
      ),
    ).rejects.toThrow(/outside the Flowstarter build policy/);
  });

  it('rejects an unsafe branch name before it looks at the message at all', async () => {
    const manager = new SafeGitWorktreeManager({
      repositoryRoot: '/tmp/repo',
      worktreesRoot: '/tmp/worktrees',
      baseRef: 'main',
    });

    await expect(
      manager.commit(
        { branch: '-oops', path: '/does/not/matter' },
        'build: initialize Flowstarter site a1b2c3d4-1111-4222-8333-444455556666',
      ),
    ).rejects.toThrow(/branch is not a safe git ref/);
  });

  it('refuses a worktree path that resolves outside the configured worktrees root', async () => {
    const repositoryRoot = await initRepo();
    const worktreesRoot = await worktreesDir();
    const outsidePath = await mkdtemp(join(tmpdir(), 'fs-outside-'));
    temporaryDirectories.push(outsidePath);
    const manager = new SafeGitWorktreeManager({
      repositoryRoot,
      worktreesRoot,
      baseRef: 'main',
    });
    const projectId = 'aaaaaaaa-7777-4888-8999-aaaabbbbcccc';

    await expect(
      manager.commit(
        { branch: 'client/flowstarter-foo', path: outsidePath },
        `build: initialize Flowstarter site ${projectId}`,
      ),
    ).rejects.toThrow(/escapes its configured root/);
  });

  it('surfaces the underlying git failure when there is nothing to commit', async () => {
    const repositoryRoot = await initRepo();
    const worktreesRoot = await worktreesDir();
    const manager = new SafeGitWorktreeManager({
      repositoryRoot,
      worktreesRoot,
      baseRef: 'main',
    });
    const projectId = 'bbbbbbbb-8888-4999-8aaa-bbbbccccdddd';
    const worktree = await manager.create(projectId);
    // No file changes were made in the worktree, so `git add --all` stages
    // nothing and `git commit` fails with "nothing to commit".

    await expect(
      manager.commit(
        worktree,
        `build: initialize Flowstarter site ${projectId}`,
      ),
    ).rejects.toThrow(/git commit failed/);
  });
});
