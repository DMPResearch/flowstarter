import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  buildDockerContext,
  containerName,
  deployDockerSite,
  httpReadinessCheck,
  imageName,
  LABEL_MODE,
  LABEL_OWNER,
  LABEL_SLOT,
  LABEL_SLUG,
  removeDockerSite,
  type CommandResult,
  type CommandRunner,
  type DockerDeployDeps,
  type SiteMode,
  type Slot,
} from './docker-runtime';
import { DOCKERFILE_TEMPLATE_NAME, type SiteRuntimeTemplates } from './site-templates';

const BLOCK = 512;

const TEMPLATES: SiteRuntimeTemplates = {
  caddyfile: ':8080 {\n\troot * /srv\n\tfile_server\n}\n',
  dockerfile: 'FROM caddy:2.11.4-alpine\nCOPY public/ /srv/\n',
  source: 'embedded',
};

/** A one-file, valid gzipped ustar archive — enough for buildDockerContext
 * to extract without a real artifact pipeline. */
async function writeFixtureTarball(): Promise<string> {
  const block = new Uint8Array(BLOCK);
  const name = Buffer.from('index.html');
  block.set(name, 0);
  const body = Buffer.from('<h1>hi</h1>');
  const writeOctal = (offset: number, width: number, value: number) => {
    block.set(Buffer.from(value.toString(8).padStart(width - 1, '0') + '\0'), offset);
  };
  writeOctal(100, 8, 0o644);
  writeOctal(108, 8, 0);
  writeOctal(116, 8, 0);
  writeOctal(124, 12, body.length);
  writeOctal(136, 12, 0);
  block.fill(0x20, 148, 156);
  block[156] = '0'.charCodeAt(0);
  block.set(Buffer.from('ustar\0'), 257);
  block.set(Buffer.from('00'), 263);
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i] as number;
  block.set(Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `), 148);

  const padding = (BLOCK - (body.length % BLOCK)) % BLOCK;
  const tar = Buffer.concat([
    Buffer.from(block),
    body,
    Buffer.alloc(padding),
    Buffer.alloc(BLOCK * 2),
  ]);
  const dir = await mkdtemp(join(tmpdir(), 'docker-runtime-fixture-'));
  const path = join(dir, 'site.tar.gz');
  await writeFile(path, gzipSync(tar));
  return path;
}

interface FakeContainer {
  name: string;
  labels: Record<string, string>;
  imageId: string;
  port: number;
  restart: string | null;
}

interface FakeDockerOptions {
  mode: SiteMode;
  slug: string;
  activeSlot?: Slot | null;
  buildFails?: boolean;
  runFails?: boolean;
  /** Pre-existing containers this agent does not own, keyed by name. */
  foreignContainers?: { name: string; labels?: Record<string, string> }[];
  /** Image ID the pre-existing active slot runs, for same-artifact tests. */
  activeImageId?: string;
}

/**
 * An in-memory Docker daemon: containers with labels and image IDs, images
 * with tags. Enough of a model that "did this call delete something it did
 * not own" and "did this call delete an image another container is using"
 * are answerable from the final state rather than from argv alone.
 */
function makeFakeDocker(opts: FakeDockerOptions) {
  const calls: string[][] = [];
  const containers = new Map<string, FakeContainer>();
  const imageTags = new Map<string, string>();
  let portCounter = 41000;
  let imageCounter = 0;

  if (opts.activeSlot) {
    const name = containerName(opts.mode, opts.slug, opts.activeSlot);
    containers.set(name, {
      name,
      labels: {
        [LABEL_OWNER]: 'true',
        [LABEL_MODE]: opts.mode,
        [LABEL_SLUG]: opts.slug,
        [LABEL_SLOT]: opts.activeSlot,
      },
      imageId: opts.activeImageId ?? 'sha256:preexisting',
      port: portCounter++,
      restart: 'unless-stopped',
    });
  }
  for (const foreign of opts.foreignContainers ?? []) {
    containers.set(foreign.name, {
      name: foreign.name,
      labels: foreign.labels ?? {},
      imageId: 'sha256:somebody-elses',
      port: portCounter++,
      restart: null,
    });
  }

  function labelFilters(args: string[]): Record<string, string> {
    const filters: Record<string, string> = {};
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] !== '--filter') continue;
      const value = args[i + 1] as string;
      if (!value.startsWith('label=')) continue;
      const [key, ...rest] = value.slice('label='.length).split('=');
      filters[key as string] = rest.join('=');
    }
    return filters;
  }

  function matches(labels: Record<string, string>, filters: Record<string, string>): boolean {
    return Object.entries(filters).every(([k, v]) => labels[k] === v);
  }

  /** Renders the `|`-joined Go template `inspectContainer` sends. */
  function renderInspect(format: string, container: FakeContainer): string {
    return format
      .split('|')
      .map((token) => {
        if (token === '{{.Image}}') return container.imageId;
        const label = token.match(/^\{\{index \.Config\.Labels "(.+)"\}\}$/);
        if (label) return container.labels[label[1] as string] ?? '';
        return '';
      })
      .join('|');
  }

  const runner: CommandRunner = async (_bin, args): Promise<CommandResult> => {
    calls.push(args);
    const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
    const fail = (stderr: string): CommandResult => ({ code: 1, stdout: '', stderr });

    switch (args[0]) {
      case 'ps': {
        const filters = labelFilters(args);
        const names = [...containers.values()]
          .filter((c) => matches(c.labels, filters))
          .map((c) => c.name);
        return ok(names.join('\n'));
      }
      case 'images': {
        const filters = labelFilters(args);
        // Only images this fake built carry our labels.
        const ids = [...imageTags.entries()]
          .filter(() => matches({ ...filters }, filters))
          .map(([, id]) => id);
        return ok(ids.join('\n'));
      }
      case 'build': {
        if (opts.buildFails) return fail('docker build: simulated failure');
        const tagIdx = args.indexOf('-t');
        const tag = args[tagIdx + 1] as string;
        imageTags.set(tag, imageTags.get(tag) ?? `sha256:image-${++imageCounter}`);
        return ok();
      }
      case 'run': {
        if (opts.runFails) return fail('docker run: simulated failure');
        const name = args[args.indexOf('--name') + 1] as string;
        if (containers.has(name)) return fail(`name "${name}" is already in use`);
        const tag = args[args.length - 1] as string;
        const labels: Record<string, string> = {};
        for (let i = 0; i < args.length - 1; i++) {
          if (args[i] !== '--label') continue;
          const [key, ...rest] = (args[i + 1] as string).split('=');
          labels[key as string] = rest.join('=');
        }
        const restartIdx = args.indexOf('--restart');
        containers.set(name, {
          name,
          labels,
          imageId: imageTags.get(tag) ?? `sha256:unknown-${tag}`,
          port: portCounter++,
          restart: restartIdx === -1 ? null : (args[restartIdx + 1] as string),
        });
        return ok();
      }
      case 'container': {
        if (args[1] !== 'inspect') return fail('unsupported');
        const name = args[args.length - 1] as string;
        const container = containers.get(name);
        if (!container) return fail(`no such container: ${name}`);
        return ok(`${renderInspect(args[args.indexOf('--format') + 1] as string, container)}\n`);
      }
      case 'image': {
        if (args[1] !== 'inspect') return fail('unsupported');
        const ref = args[args.length - 1] as string;
        const id = imageTags.get(ref) ?? ([...imageTags.values()].includes(ref) ? ref : null);
        return id ? ok(`${id}\n`) : fail(`no such image: ${ref}`);
      }
      case 'port': {
        const container = containers.get(args[1] as string);
        return container ? ok(`127.0.0.1:${container.port}\n`) : fail('no such container');
      }
      case 'rm': {
        const name = args[args.length - 1] as string;
        if (!containers.delete(name)) return fail('no such container');
        return ok();
      }
      case 'rmi': {
        const ref = args[args.length - 1] as string;
        const id = imageTags.get(ref) ?? ref;
        // The daemon refuses an unforced delete of an image a container
        // references, and untags it anyway when forced.
        if (!args.includes('-f') && [...containers.values()].some((c) => c.imageId === id)) {
          return fail(`conflict: unable to delete ${ref} (must be forced)`);
        }
        for (const [tag, tagId] of imageTags) {
          if (tag === ref || tagId === ref) imageTags.delete(tag);
        }
        return ok();
      }
      default:
        return ok();
    }
  };

  return { runner, calls, containers, imageTags };
}

function fakeSnippetStore(initial: string | null = null) {
  const writes: { slug: string; snippet: string }[] = [];
  let current = initial;
  return {
    writes,
    readSnippet: async () => current,
    writeSnippet: async (_slug: string, snippet: string) => {
      current = snippet;
      writes.push({ slug: _slug, snippet });
    },
  };
}

function deps(overrides: Partial<DockerDeployDeps> & { runner: CommandRunner }): DockerDeployDeps {
  return {
    isReady: async () => true,
    readSnippet: async () => null,
    writeSnippet: async () => undefined,
    reloadCaddy: async () => ({ ok: true, stderr: '' }),
    readyTimeoutMs: 200,
    readyIntervalMs: 10,
    ...overrides,
  };
}

function request(overrides: Partial<Parameters<typeof deployDockerSite>[0]> = {}) {
  return {
    slug: 'acme',
    mode: 'sites' as SiteMode,
    tarballPath: '',
    sha256: 'a'.repeat(64),
    templates: TEMPLATES,
    buildSnippet: (upstream: string) => `reverse_proxy ${upstream}`,
    ...overrides,
  };
}

describe('buildDockerContext', () => {
  test('writes both templates into the context and never lets a tenant file shadow the Dockerfile', async () => {
    const tarballPath = await writeFixtureTarball();
    const staging = await buildDockerContext(tarballPath, TEMPLATES);
    try {
      expect(await readFile(join(staging.contextDir, 'Caddyfile'), 'utf8')).toBe(
        TEMPLATES.caddyfile
      );
      expect(await readFile(staging.dockerfilePath, 'utf8')).toBe(TEMPLATES.dockerfile);
      expect(staging.dockerfilePath).toBe(join(staging.contextDir, DOCKERFILE_TEMPLATE_NAME));
      // Tenant bytes land under public/, one level below the templates.
      expect(await readFile(join(staging.contextDir, 'public', 'index.html'), 'utf8')).toBe(
        '<h1>hi</h1>'
      );
    } finally {
      await staging.cleanup();
    }
  });

  test('builds from a real path, not an embedded asset path docker cannot read', async () => {
    const tarballPath = await writeFixtureTarball();
    const { runner, calls } = makeFakeDocker({ mode: 'sites', slug: 'acme' });

    await deployDockerSite(
      request({ tarballPath }),
      deps({ runner, writeSnippet: async () => undefined })
    );

    const build = calls.find((c) => c[0] === 'build') as string[];
    const dockerfileArg = build[build.indexOf('-f') + 1] as string;
    expect(dockerfileArg.startsWith('/$bunfs')).toBe(false);
    expect(dockerfileArg).toContain(DOCKERFILE_TEMPLATE_NAME);
  });
});

describe('deployDockerSite — runtime contract', () => {
  test('runs the container with the required hardening flags, restart policy and ownership labels', async () => {
    const tarballPath = await writeFixtureTarball();
    const { runner, calls, containers } = makeFakeDocker({ mode: 'sites', slug: 'acme' });
    const snippets = fakeSnippetStore();
    let reloaded = 0;

    const outcome = await deployDockerSite(
      request({ tarballPath }),
      deps({
        runner,
        readSnippet: snippets.readSnippet,
        writeSnippet: snippets.writeSnippet,
        reloadCaddy: async () => {
          reloaded++;
          return { ok: true, stderr: '' };
        },
      })
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.containerName).toBe(containerName('sites', 'acme', 'a'));
    expect(outcome.imageName).toBe(imageName('sites', 'acme', 'a'.repeat(64)));

    const run = calls.find((c) => c[0] === 'run') as string[];
    expect(run).toContain('--read-only');
    expect(run).toContain('--cap-drop');
    expect(run).toContain('ALL');
    expect(run).toContain('--security-opt');
    expect(run).toContain('no-new-privileges:true');
    expect(run).toContain('--pids-limit');
    expect(run).toContain('--memory');
    expect(run).toContain('-p');
    expect(run).toContain('127.0.0.1::8080');
    expect(run.join(' ')).toContain(`${LABEL_OWNER}=true`);
    expect(run.join(' ')).toContain(`${LABEL_MODE}=sites`);
    expect(run.join(' ')).toContain(`${LABEL_SLUG}=acme`);

    // A site has to survive a host reboot without anybody logging in.
    expect(containers.get(outcome.containerName)?.restart).toBe('unless-stopped');

    const build = calls.find((c) => c[0] === 'build') as string[];
    expect(build.join(' ')).toContain(`${LABEL_SLUG}=acme`);

    expect(reloaded).toBe(1);
    expect(snippets.writes).toHaveLength(1);
    expect(snippets.writes[0]?.snippet).toMatch(/^reverse_proxy 127\.0\.0\.1:\d+$/);
  });

  test('deploys into the slot that is not currently active, and retires the old one on success', async () => {
    const tarballPath = await writeFixtureTarball();
    const { runner, containers } = makeFakeDocker({
      mode: 'sites',
      slug: 'acme',
      activeSlot: 'a',
    });
    const snippets = fakeSnippetStore('# old snippet\n');

    const outcome = await deployDockerSite(
      request({ tarballPath, sha256: 'b'.repeat(64) }),
      deps({ runner, readSnippet: snippets.readSnippet, writeSnippet: snippets.writeSnippet })
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.containerName).toBe(containerName('sites', 'acme', 'b'));
    expect(containers.has(containerName('sites', 'acme', 'a'))).toBe(false);
    expect(containers.has(containerName('sites', 'acme', 'b'))).toBe(true);
  });
});

describe('deployDockerSite — ownership', () => {
  test('refuses the slot rather than destroying a container this agent does not own', async () => {
    const tarballPath = await writeFixtureTarball();
    const squatter = containerName('sites', 'acme', 'a');
    const { runner, containers } = makeFakeDocker({
      mode: 'sites',
      slug: 'acme',
      foreignContainers: [{ name: squatter, labels: { 'com.example.owner': 'someone-else' } }],
    });
    const snippets = fakeSnippetStore();

    const outcome = await deployDockerSite(
      request({ tarballPath }),
      deps({ runner, readSnippet: snippets.readSnippet, writeSnippet: snippets.writeSnippet })
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('does not own');
    // Still there, untouched.
    expect(containers.get(squatter)?.imageId).toBe('sha256:somebody-elses');
    expect(snippets.writes).toHaveLength(0);
  });

  test('a container carrying another slug\'s labels in our namespace is also left alone', async () => {
    const tarballPath = await writeFixtureTarball();
    const squatter = containerName('sites', 'acme', 'a');
    const { runner, containers } = makeFakeDocker({
      mode: 'sites',
      slug: 'acme',
      foreignContainers: [
        {
          name: squatter,
          labels: { [LABEL_OWNER]: 'true', [LABEL_MODE]: 'sites', [LABEL_SLUG]: 'other-tenant' },
        },
      ],
    });

    const outcome = await deployDockerSite(request({ tarballPath }), deps({ runner }));

    expect(outcome.ok).toBe(false);
    expect(containers.has(squatter)).toBe(true);
  });
});

describe('deployDockerSite — image shared with the live slot', () => {
  test('redeploying the same artifact does not delete the image the live container is running', async () => {
    const tarballPath = await writeFixtureTarball();
    const sha256 = 'c'.repeat(64);
    const tag = imageName('sites', 'acme', sha256);
    const { runner, calls, imageTags, containers } = makeFakeDocker({
      mode: 'sites',
      slug: 'acme',
      activeSlot: 'a',
    });
    // The live container already runs the image this deploy will rebuild
    // under the same sha-derived tag.
    imageTags.set(tag, 'sha256:same-artifact');
    const live = containers.get(containerName('sites', 'acme', 'a')) as FakeContainer;
    live.imageId = 'sha256:same-artifact';

    const outcome = await deployDockerSite(request({ tarballPath, sha256 }), deps({ runner }));

    expect(outcome.ok).toBe(true);
    // The old slot is gone, but its image — which the new slot is also
    // running — survives.
    expect(containers.has(containerName('sites', 'acme', 'a'))).toBe(false);
    expect(imageTags.get(tag)).toBe('sha256:same-artifact');
    expect(containers.get(containerName('sites', 'acme', 'b'))?.imageId).toBe(
      'sha256:same-artifact'
    );
    // `docker rmi -f` is what would untag a live site's image; the agent
    // never passes it, so the daemon gets to refuse.
    expect(calls.filter((c) => c[0] === 'rmi').every((c) => !c.includes('-f'))).toBe(true);
  });

  test('a failed deploy of the same artifact leaves the live image intact', async () => {
    const tarballPath = await writeFixtureTarball();
    const sha256 = 'd'.repeat(64);
    const tag = imageName('sites', 'acme', sha256);
    const { runner, imageTags, containers } = makeFakeDocker({
      mode: 'sites',
      slug: 'acme',
      activeSlot: 'a',
    });
    imageTags.set(tag, 'sha256:same-artifact');
    const live = containers.get(containerName('sites', 'acme', 'a')) as FakeContainer;
    live.imageId = 'sha256:same-artifact';

    const outcome = await deployDockerSite(
      request({ tarballPath, sha256 }),
      deps({ runner, isReady: async () => false, readyTimeoutMs: 40 })
    );

    expect(outcome.ok).toBe(false);
    expect(containers.has(containerName('sites', 'acme', 'a'))).toBe(true);
    expect(imageTags.get(tag)).toBe('sha256:same-artifact');
  });
});

describe('deployDockerSite — readiness', () => {
  test('a container that never becomes ready is torn down and the deploy fails, without touching Caddy', async () => {
    const tarballPath = await writeFixtureTarball();
    const { runner, containers } = makeFakeDocker({ mode: 'sites', slug: 'acme' });
    const snippets = fakeSnippetStore();
    let reloaded = 0;

    const outcome = await deployDockerSite(
      request({ tarballPath }),
      deps({
        runner,
        isReady: async () => false,
        readSnippet: snippets.readSnippet,
        writeSnippet: snippets.writeSnippet,
        reloadCaddy: async () => {
          reloaded++;
          return { ok: true, stderr: '' };
        },
        readyTimeoutMs: 60,
      })
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('ready');
    expect(reloaded).toBe(0);
    expect(snippets.writes).toHaveLength(0);
    expect(containers.has(containerName('sites', 'acme', 'a'))).toBe(false);
  });

  test('httpReadinessCheck accepts only a 200 — an empty container answering 404 is not ready', async () => {
    const statuses = [200, 204, 301, 404, 500];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const status = Number(new URL(req.url).pathname.slice(1));
        return status === 301
          ? new Response('', { status, headers: { Location: '/200' } })
          : new Response('', { status });
      },
    });
    try {
      const results: Record<number, boolean> = {};
      for (const status of statuses) {
        results[status] = await httpReadinessCheck(
          `http://127.0.0.1:${server.port}/${status}`
        );
      }
      expect(results).toEqual({ 200: true, 204: false, 301: false, 404: false, 500: false });
    } finally {
      server.stop(true);
    }
  });
});

describe('deployDockerSite — rollback', () => {
  test('a failed Caddy reload restores the previous snippet and tears down the new container', async () => {
    const tarballPath = await writeFixtureTarball();
    const { runner, containers } = makeFakeDocker({ mode: 'sites', slug: 'acme' });
    const snippets = fakeSnippetStore('# previous snippet\n');
    const reloadResults = [{ ok: false, stderr: 'invalid Caddyfile' }, { ok: true, stderr: '' }];

    const outcome = await deployDockerSite(
      request({ tarballPath }),
      deps({
        runner,
        readSnippet: snippets.readSnippet,
        writeSnippet: snippets.writeSnippet,
        reloadCaddy: async () => reloadResults.shift() ?? { ok: true, stderr: '' },
      })
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('invalid Caddyfile');
    expect(snippets.writes).toHaveLength(2);
    expect(snippets.writes[0]?.snippet).toContain('reverse_proxy');
    expect(snippets.writes[1]?.snippet).toBe('# previous snippet\n');
    expect(containers.has(containerName('sites', 'acme', 'a'))).toBe(false);
  });

  test('a writeSnippet that throws is reported as a failed deploy, not an orphaned container', async () => {
    const tarballPath = await writeFixtureTarball();
    const { runner, containers } = makeFakeDocker({ mode: 'sites', slug: 'acme' });
    let attempts = 0;

    const outcome = await deployDockerSite(
      request({ tarballPath }),
      deps({
        runner,
        readSnippet: async () => '# previous snippet\n',
        writeSnippet: async () => {
          attempts++;
          throw new Error('EROFS: read-only file system');
        },
      })
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('EROFS');
    // The container it had already started is gone, not left behind with
    // nothing pointing at it.
    expect(containers.has(containerName('sites', 'acme', 'a'))).toBe(false);
    // Rollback tried to restore the old snippet even though that throws too.
    expect(attempts).toBe(2);
  });

  test('a reloadCaddy that throws is caught and rolled back the same way', async () => {
    const tarballPath = await writeFixtureTarball();
    const { runner, containers } = makeFakeDocker({ mode: 'sites', slug: 'acme' });
    const snippets = fakeSnippetStore('# previous snippet\n');

    const outcome = await deployDockerSite(
      request({ tarballPath }),
      deps({
        runner,
        readSnippet: snippets.readSnippet,
        writeSnippet: snippets.writeSnippet,
        reloadCaddy: async () => {
          throw new Error('systemctl: connection to the bus failed');
        },
      })
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('connection to the bus failed');
    expect(snippets.writes[snippets.writes.length - 1]?.snippet).toBe('# previous snippet\n');
    expect(containers.has(containerName('sites', 'acme', 'a'))).toBe(false);
  });

  test('a first deploy whose reload fails removes the snippet instead of restoring nothing', async () => {
    const tarballPath = await writeFixtureTarball();
    const { runner } = makeFakeDocker({ mode: 'sites', slug: 'acme' });
    const snippets = fakeSnippetStore(null);
    const reloadResults = [{ ok: false, stderr: 'invalid Caddyfile' }, { ok: true, stderr: '' }];

    await deployDockerSite(
      request({ tarballPath }),
      deps({
        runner,
        readSnippet: snippets.readSnippet,
        writeSnippet: snippets.writeSnippet,
        reloadCaddy: async () => reloadResults.shift() ?? { ok: true, stderr: '' },
      })
    );

    expect(snippets.writes[snippets.writes.length - 1]?.snippet).toBe('');
  });
});

describe('deployDockerSite — build/run failures', () => {
  test('a failed docker build never starts a container', async () => {
    const tarballPath = await writeFixtureTarball();
    const { runner, calls } = makeFakeDocker({ mode: 'sites', slug: 'acme', buildFails: true });
    const snippets = fakeSnippetStore();

    const outcome = await deployDockerSite(
      request({ tarballPath }),
      deps({ runner, readSnippet: snippets.readSnippet, writeSnippet: snippets.writeSnippet })
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('docker build failed');
    expect(calls.some((c) => c[0] === 'run')).toBe(false);
    expect(snippets.writes).toHaveLength(0);
  });

  test('a failed docker run is reported and cleaned up', async () => {
    const tarballPath = await writeFixtureTarball();
    const { runner, containers } = makeFakeDocker({
      mode: 'sites',
      slug: 'acme',
      runFails: true,
    });
    const snippets = fakeSnippetStore();

    const outcome = await deployDockerSite(
      request({ tarballPath }),
      deps({ runner, readSnippet: snippets.readSnippet, writeSnippet: snippets.writeSnippet })
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('docker run failed');
    expect(snippets.writes).toHaveLength(0);
    expect(containers.has(containerName('sites', 'acme', 'a'))).toBe(false);
  });

  test('a corrupt artifact fails in the build context, before any docker call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docker-runtime-bad-'));
    const tarballPath = join(dir, 'site.tar.gz');
    await writeFile(tarballPath, 'not gzip at all');
    const { runner, calls } = makeFakeDocker({ mode: 'sites', slug: 'acme' });

    const outcome = await deployDockerSite(request({ tarballPath }), deps({ runner }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('build context failed');
    expect(calls).toHaveLength(0);
  });
});

describe('removeDockerSite — ownership scoping', () => {
  test('only removes containers and images matching this slug and mode, by label filter', async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_bin, args) => {
      calls.push(args);
      if (args[0] === 'ps') return { code: 0, stdout: 'container-1\ncontainer-2\n', stderr: '' };
      if (args[0] === 'images') return { code: 0, stdout: 'image-1\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };

    await removeDockerSite(runner, 'sites', 'acme');

    const psArgs = calls.find((c) => c[0] === 'ps') as string[];
    expect(psArgs.join(' ')).toContain(`label=${LABEL_OWNER}=true`);
    expect(psArgs.join(' ')).toContain(`label=${LABEL_MODE}=sites`);
    expect(psArgs.join(' ')).toContain(`label=${LABEL_SLUG}=acme`);

    const imagesArgs = calls.find((c) => c[0] === 'images') as string[];
    expect(imagesArgs.join(' ')).toContain(`label=${LABEL_SLUG}=acme`);

    const rmCalls = calls.filter((c) => c[0] === 'rm');
    expect(rmCalls.map((c) => c[c.length - 1])).toEqual(['container-1', 'container-2']);

    const rmiCalls = calls.filter((c) => c[0] === 'rmi');
    expect(rmiCalls.map((c) => c[c.length - 1])).toEqual(['image-1']);
    // Unforced: an image something else still holds stays.
    expect(rmiCalls.every((c) => !c.includes('-f'))).toBe(true);
  });

  test('removes nothing when no owned resources are found', async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_bin, args) => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '' };
    };

    await removeDockerSite(runner, 'previews', 'ghost');

    expect(calls.some((c) => c[0] === 'rm')).toBe(false);
    expect(calls.some((c) => c[0] === 'rmi')).toBe(false);
  });

  test('leaves a foreign container with a colliding name in place', async () => {
    const { runner, containers } = makeFakeDocker({
      mode: 'sites',
      slug: 'acme',
      foreignContainers: [{ name: containerName('sites', 'acme', 'a') }],
    });

    await removeDockerSite(runner, 'sites', 'acme');

    // `docker ps --filter label=…` never returned it, so nothing removed it.
    expect(containers.has(containerName('sites', 'acme', 'a'))).toBe(true);
  });
});
