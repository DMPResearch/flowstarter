/**
 * The local (no-GitHub, no-Hetzner) end of a full-site build.
 *
 * Production's `GitHubPullRequestPublisher` hands a reviewer a draft PR. This
 * hands them a running site instead: it packages the build output, keeps the
 * tarball on this worker where the deploy-agent can fetch it, and asks
 * flowstarter-main to run the ordinary `deploySite` path over it. Nothing in
 * the deploy chain is bypassed or simulated — same tarball format, same agent
 * endpoint, same `deployments` ledger row — so the thing this proves on a
 * laptop is the thing that runs in production.
 *
 * The tenant's Cal.com integration is reconciled over the packaged output,
 * unconditionally, whether or not a link is set. The worker already runs
 * `injectCalCom` into `src/pages/book.astro` before the agent runs, which is
 * what a real `astro build` carries through; re-running it here over the
 * output covers the tree that was never built from Astro sources. With a
 * validated link that wires the live embed; with none it removes whatever
 * demo or embed block the packaged output still carries, so a client never
 * gets the blurred preview demo — or a stale calendar for a link they have
 * since removed — on the site they paid for.
 */

import {
  injectCalCom,
  injectLeadCapture,
  packSiteTarball,
  type ArchiveFile,
  type FileMap,
} from '@flowstarter/agentic-codegen';
import type { PullRequestPublisher } from '@flowstarter/agentic-codegen';
import { ArtifactStore } from './artifacts';
import { collectSiteFiles, resolveSiteOutputDir } from './site-output';

export class LocalPublishError extends Error {}

export interface LocalSitePublisherOptions {
  store: ArtifactStore;
  /** flowstarter-main's origin; owns deploySite and the deployments ledger. */
  flowstarterMainUrl: string;
  /** Same secret dispatch is signed with — the internal deploy route checks it. */
  sharedSecret: string;
  /** Relative to the site root; falls back to the root when absent. */
  outputDir: string;
  /** Resolved when the deploy route reports no URL of its own. */
  stagingUrlTemplate: string;
  fetchImpl?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  onProgress?: (message: string) => void;
}

interface DeployResponse {
  siteUrl?: string | null;
  deployment?: {
    deploymentId?: string;
    status?: string;
    detail?: string | null;
  };
}

export class LocalSitePublisher implements PullRequestPublisher {
  constructor(private readonly options: LocalSitePublisherOptions) {}

  async create(input: {
    projectId: string;
    branch: string;
    worktreePath: string;
    commitSha: string;
    siteRoot?: string;
    calComUrl?: string | null;
    leadCaptureEndpoint?: string | null;
    changeRequestId?: string | null;
    siteVersion?: number | null;
  }): Promise<{ pullRequestUrl: string; stagingUrl: string }> {
    const siteRoot = input.siteRoot ?? input.worktreePath;
    const outputDir = await resolveSiteOutputDir(
      siteRoot,
      this.options.outputDir,
    );
    const collected = await collectSiteFiles(outputDir);
    const files = withIntegrations(collected, {
      calComUrl: input.calComUrl ?? null,
      leadCaptureEndpoint: input.leadCaptureEndpoint ?? null,
    });
    this.options.onProgress?.(
      `packaging ${files.length} files from ${outputDir}`,
    );

    const artifact = await this.options.store.put(
      input.projectId,
      packSiteTarball(files),
    );
    // Never the URL: its random path token IS the bearer credential that
    // lets anyone fetch the (unreleased, potentially unpaid-for) site — see
    // `ArtifactStore`'s doc comment. `input.projectId` and the sha256 are
    // enough for an operator to correlate this line with the deploy it feeds
    // without also handing out access to the artifact.
    this.options.onProgress?.(
      `artifact ${artifact.sizeBytes} bytes, sha256 ${artifact.sha256} (job ${input.projectId})`,
    );

    const siteUrl = await this.deploy({
      workspaceId: input.projectId,
      artifactUrl: artifact.url,
      artifactSha256: artifact.sha256,
      commitSha: input.commitSha,
      // Carried on the deploy rather than sent as a second callback: the
      // deploy is the moment "your change is live" becomes true, and it is
      // already the one place every publishing path in the product converges
      // on, which is what makes the notice fire once and only once.
      ...(input.changeRequestId
        ? { changeRequestId: input.changeRequestId }
        : {}),
      ...(typeof input.siteVersion === 'number'
        ? { siteVersion: input.siteVersion }
        : {}),
    });

    return {
      // No pull request exists in this mode, and pretending otherwise would
      // put a dead github.com link on the job. The artifact URL is the honest
      // answer to "what did this build produce".
      pullRequestUrl: artifact.url,
      stagingUrl:
        siteUrl ??
        this.options.stagingUrlTemplate.replace(
          '{projectId}',
          input.projectId.toLowerCase(),
        ),
    };
  }

  private async deploy(body: {
    workspaceId: string;
    artifactUrl: string;
    artifactSha256: string;
    commitSha: string;
    changeRequestId?: string;
    siteVersion?: number;
  }): Promise<string | null> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const url = `${this.options.flowstarterMainUrl.replace(/\/$/, '')}/api/internal/build/deploy`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.sharedSecret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 120_000),
      });
    } catch (error) {
      throw new LocalPublishError(
        `deploy request to ${url} failed: ${
          error instanceof Error ? error.message : 'unknown transport error'
        }`,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new LocalPublishError(
        `flowstarter-main rejected the deploy with ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    let parsed: DeployResponse;
    try {
      parsed = JSON.parse(text) as DeployResponse;
    } catch {
      throw new LocalPublishError('deploy response was not JSON');
    }
    if (parsed.deployment?.status && parsed.deployment.status !== 'live') {
      throw new LocalPublishError(
        `deploy finished as "${parsed.deployment.status}": ${
          parsed.deployment.detail ?? 'no detail'
        }`,
      );
    }
    return parsed.siteUrl ?? null;
  }
}

/**
 * `injectCalCom` and `injectLeadCapture` are pure `FileMap` transforms, and the
 * archive carries binary entries the map has no room for. Only text entries are
 * handed to them, and only the ones they changed are written back.
 *
 * Both always run, link or endpoint or not: with none, each removes the block
 * already in the output rather than leaving it be, which is the behaviour a
 * client with no booking link, or a build whose token could not be resolved,
 * actually needs.
 */
function withIntegrations(
  files: readonly ArchiveFile[],
  config: { calComUrl: string | null; leadCaptureEndpoint: string | null },
): ArchiveFile[] {
  const map: FileMap = {};
  for (const file of files) {
    if (file.encoding !== 'base64') map[file.path] = file.content;
  }
  const injected = injectLeadCapture(
    injectCalCom(map, config.calComUrl),
    config.leadCaptureEndpoint,
  );
  return files.map((file) =>
    file.encoding !== 'base64' && injected[file.path] !== undefined
      ? { path: file.path, content: injected[file.path] as string }
      : file,
  );
}
