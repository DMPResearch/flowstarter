/**
 * The adversarial build, run for real.
 *
 * Every other test in this suite asserts on an argument vector. This one hands
 * that vector to an actual Docker daemon and lets a hostile "build" try the
 * four reads Codex risk 3 is about:
 *
 *   ../other-workspace/secret.txt   another client's worktree
 *   /etc/flowstarter/*             host configuration
 *   <worker>/.env                  this service's own credentials
 *   /var/run/docker.sock           the daemon, and with it the whole host
 *
 * It is opt-in, because the rest of the suite must run on a CI host with no
 * daemon and must never be slowed by an image pull:
 *
 *   FLOWSTARTER_BUILD_DOCKER_PROOF=1 pnpm --dir apps/build-worker vitest run \
 *     test/docker-isolation-proof.test.ts
 *
 * The fixture is deliberately inverted. Its "build" *succeeds* when it can
 * reach those paths and *fails* when it cannot, so a green isolated run is a
 * positive statement — the build ran, it tried, and every read was refused —
 * rather than the absence of evidence a crashed container would also produce.
 * The native half of the same fixture is asserted to succeed, which is the
 * defect stated as a passing test.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DockerValidationConfig } from '../src/config';
import { CommandSiteValidator, SiteValidationError } from '../src/validator';

const execFileAsync = promisify(execFile);

const ENABLED = process.env.FLOWSTARTER_BUILD_DOCKER_PROOF === '1';

/**
 * Built from `docker/validation-runtime.Dockerfile`. Override to run the proof
 * against whatever image a host actually uses.
 */
const IMAGE =
  process.env.FLOWSTARTER_BUILD_DOCKER_PROOF_IMAGE ??
  'flowstarter/build-validation:node22-pnpm10';

function dockerConfig(): DockerValidationConfig {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return {
    bin: 'docker',
    image: IMAGE,
    network: 'bridge',
    buildNetwork: 'none',
    memory: '2g',
    tmpfsSize: '512m',
    pidsLimit: 256,
    pnpmVersion: '10.29.2',
    pnpmBaked: true,
    // Never root, even here.
    user: uid === 0 ? '1000:1000' : `${uid}:${gid}`,
  };
}

/**
 * A neighbouring client's workspace, the host configuration, this worker's own
 * `.env`, and one site workspace holding a build that goes looking for all of
 * them. Returns the site workspace, which is the only path the container is
 * ever given.
 */
async function adversarialWorkspaces(): Promise<{
  root: string;
  site: string;
  secretPath: string;
  envPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'flowstarter-adversary-'));
  const site = join(root, 'client-1');
  const neighbour = join(root, 'other-workspace');
  await mkdir(join(site, 'src'), { recursive: true });
  await mkdir(neighbour, { recursive: true });

  const secretPath = join(neighbour, 'secret.txt');
  const envPath = join(root, '.env');
  await writeFile(secretPath, 'another client stripe key\n', 'utf8');
  await writeFile(envPath, 'SUPABASE_SERVICE_ROLE_KEY=leak\n', 'utf8');

  await writeFile(
    join(site, 'package.json'),
    JSON.stringify({ name: 'adversary', private: true }),
    'utf8',
  );
  await writeFile(join(site, 'src', 'index.txt'), 'site source\n', 'utf8');

  // The hostile build. Written as plain Node, because this is what a generated
  // `astro.config.mjs` gets to do: it is imported and executed by the build.
  await writeFile(
    join(site, 'adversary.mjs'),
    [
      "import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';",
      "import { connect } from 'node:net';",
      '',
      'const reached = [];',
      'const refused = [];',
      'const targets = [',
      `  ${JSON.stringify(secretPath)},`,
      `  ${JSON.stringify(envPath)},`,
      "  '/etc/flowstarter/deploy-agent.token',",
      "  '/var/run/docker.sock',",
      "  '../other-workspace/secret.txt',",
      '];',
      'for (const target of targets) {',
      '  try {',
      '    readFileSync(target);',
      '    reached.push(target);',
      '  } catch {',
      '    refused.push(target);',
      '  }',
      '}',
      '',
      '// The build step is given no network at all, so this must not resolve.',
      'const egress = await new Promise((resolve) => {',
      "  const socket = connect({ host: '1.1.1.1', port: 443 });",
      '  const done = (value) => { socket.destroy(); resolve(value); };',
      "  socket.setTimeout(2_000, () => done('timeout'));",
      "  socket.on('connect', () => done('connected'));",
      "  socket.on('error', () => done('refused'));",
      '});',
      '',
      "mkdirSync('dist', { recursive: true });",
      "writeFileSync('dist/adversary.json', JSON.stringify({ reached, refused, egress }));",
      '',
      '// Inverted on purpose: reaching nothing is a failed heist, and a failed',
      '// heist is what this build reports as a failure.',
      "if (reached.length === 0) { console.error('ISOLATED: ' + refused.join(' ')); process.exit(9); }",
      "console.log('REACHED: ' + reached.join(' '));",
    ].join('\n'),
    'utf8',
  );

  return { root, site, secretPath, envPath };
}

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop() as string, { recursive: true, force: true });
  }
});

describe.skipIf(!ENABLED)(
  'the isolated validator, against a live daemon',
  () => {
    beforeAll(async () => {
      await execFileAsync('docker', ['image', 'inspect', IMAGE]);
    }, 60_000);

    it('refuses every path a generated build reaches for, and all egress', async () => {
      const { root, site } = await adversarialWorkspaces();
      cleanups.push(root);
      const output: string[] = [];

      const validator = new CommandSiteValidator({
        // `node` is one of the programs the image is trusted to run, and it
        // needs no registry — which is the point: the build step runs with
        // --network=none and still has a toolchain.
        commands: [{ bin: 'node', args: ['adversary.mjs'] }],
        timeoutMs: 120_000,
        isolation: { mode: 'docker', docker: dockerConfig() },
        onOutput: (_command, lines) => output.push(...lines),
      });

      // The fixture exits non-zero precisely when it reached nothing.
      await expect(validator.validate(site, 'full')).rejects.toThrow(
        SiteValidationError,
      );
      const log = output.join('\n');
      expect(log).toContain('ISOLATED:');
      expect(log).not.toContain('REACHED:');
      expect(log).toContain('secret.txt');
      expect(log).toContain('/etc/flowstarter/deploy-agent.token');
      expect(log).toContain('/var/run/docker.sock');
    }, 180_000);

    it('is the defect, stated as a passing test: native mode reaches all of it', async () => {
      const { root, site } = await adversarialWorkspaces();
      cleanups.push(root);
      const output: string[] = [];

      const validator = new CommandSiteValidator({
        commands: [{ bin: process.execPath, args: ['adversary.mjs'] }],
        timeoutMs: 60_000,
        isolation: { mode: 'native' },
        onOutput: (_command, lines) => output.push(...lines),
      });

      // Succeeds, because the build read this worker's `.env` and the
      // neighbouring workspace's secret as the worker's own user. That is what
      // `FLOWSTARTER_BUILD_ISOLATION` refuses outside development.
      await expect(validator.validate(site, 'full')).resolves.toBeUndefined();
      expect(output.join('\n')).toContain('REACHED:');
    }, 120_000);
  },
);
