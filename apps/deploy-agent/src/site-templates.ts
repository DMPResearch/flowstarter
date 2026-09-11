/**
 * The Dockerfile and Caddyfile a site container is built from.
 *
 * These used to be read from `join(import.meta.dir, '..', 'docker')`. That
 * works when the agent runs from a checkout and fails on every host that
 * runs the shipped artifact: the deploy-agent is distributed as a single
 * `bun build --compile` binary, where `import.meta.dir` is a synthetic
 * `/$bunfs/root` path with no `docker/` directory beside it. Docker mode
 * would have failed on its first deploy with ENOENT.
 *
 * So both templates are imported as embedded assets. In a checkout the
 * import resolves to the real file on disk; in the compiled binary Bun
 * packs the bytes in and resolves it to the virtual filesystem. Either way
 * `Bun.file(...).text()` returns the same content.
 *
 * `DEPLOY_AGENT_DOCKER_TEMPLATE_DIR` overrides both with files from an
 * operator-controlled directory, for a host that has to patch the base
 * image (a CVE in `caddy:2.11.4-alpine`, say) without waiting for a new
 * agent build. The directory is operator-owned and never tenant-writable:
 * nothing in a deploy request can name it or write into it.
 */

import { join } from 'node:path';
import caddyfileAsset from '../docker/site-runtime.Caddyfile' with { type: 'file' };
import dockerfileAsset from '../docker/site-runtime.Dockerfile' with { type: 'file' };

export const CADDYFILE_TEMPLATE_NAME = 'site-runtime.Caddyfile';
export const DOCKERFILE_TEMPLATE_NAME = 'site-runtime.Dockerfile';

export interface SiteRuntimeTemplates {
  caddyfile: string;
  dockerfile: string;
  /** Where these came from, for the startup log and error messages. */
  source: 'embedded' | 'operator';
}

export class TemplateLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateLoadError';
  }
}

async function readText(path: string): Promise<string> {
  const text = await Bun.file(path).text();
  if (text.trim().length === 0) {
    throw new TemplateLoadError(`site runtime template is empty: ${path}`);
  }
  return text;
}

/**
 * Reads both templates. `overrideDir` (default:
 * `DEPLOY_AGENT_DOCKER_TEMPLATE_DIR`) wins when set; a directory that is
 * set but unreadable is an error rather than a silent fall back to the
 * embedded copies, because an operator who pinned a patched base image
 * should hear about it instead of quietly shipping the old one.
 */
export async function loadSiteRuntimeTemplates(
  overrideDir: string | null = process.env.DEPLOY_AGENT_DOCKER_TEMPLATE_DIR ?? null
): Promise<SiteRuntimeTemplates> {
  const dir = overrideDir?.trim();
  if (dir) {
    try {
      const [caddyfile, dockerfile] = await Promise.all([
        readText(join(dir, CADDYFILE_TEMPLATE_NAME)),
        readText(join(dir, DOCKERFILE_TEMPLATE_NAME)),
      ]);
      return { caddyfile, dockerfile, source: 'operator' };
    } catch (e) {
      throw new TemplateLoadError(
        `could not read site runtime templates from DEPLOY_AGENT_DOCKER_TEMPLATE_DIR (${dir}): ` +
          `${e instanceof Error ? e.message : 'unknown error'}`
      );
    }
  }

  const [caddyfile, dockerfile] = await Promise.all([
    readText(caddyfileAsset),
    readText(dockerfileAsset),
  ]);
  return { caddyfile, dockerfile, source: 'embedded' };
}
