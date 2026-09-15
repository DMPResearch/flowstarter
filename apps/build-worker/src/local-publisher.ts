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
import {
  failureCodeForDeployCode,
  FullSiteBuildFailure,
  type BuiltArtifactRecord,
  type PackagedArtifact,
  type PullRequestPublisher,
} from '@flowstarter/agentic-codegen';
import {
  assertPublicPlatformOrigin,
  isLoopbackUrl,
  UnsafePlatformOriginError,
} from '@flowstarter/platform-config';
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

/** The structured half of a refusal from flowstarter-main's deploy route. */
interface DeployErrorBody {
  error?: string;
  /** `DeployError.code` — `workspace_unallocated`, `agent_error`, and so on. */
  code?: string;
}

export class LocalSitePublisher implements PullRequestPublisher {
  constructor(private readonly options: LocalSitePublisherOptions) {}

  async create(input: {
    projectId: string;
    branch: string;
    worktreePath: string;
    commitSha: string;
    siteRoot?: string;
    outputRoot?: string | null;
    calComUrl?: string | null;
    leadCaptureEndpoint?: string | null;
    changeRequestId?: string | null;
    siteVersion?: number | null;
    onArtifact?: (artifact: PackagedArtifact) => Promise<void>;
  }): Promise<{ pullRequestUrl: string; stagingUrl: string }> {
    // "The platform host" here means: this build is about to be deployed by
    // asking a *real* flowstarter-main to run `deploySite` — the same check
    // `deploySite`'s own deploy-agent URL makes, below in the app, for the
    // half of this rule that lives there. `flowstarterMainUrl` loopback is
    // exactly the one case a local publish is what it says on the tin: a
    // laptop with nothing provisioned, talking to its own dev server. Every
    // other value here — a staging or production flowstarter-main — means
    // this artifact is headed at a real host, and a loopback origin baked
    // into it (from a worker whose own environment was never told it was
    // publishing to one) is dead on arrival and its own CSP would refuse it
    // anyway — exactly what happened with `FLOWSTARTER_PUBLIC_APP_ORIGIN`
    // unset on a dev-stack worker whose `FLOWSTARTER_MAIN_URL` pointed at a
    // real deploy.
    const targetIsPlatformHost = !isLoopbackUrl(
      this.options.flowstarterMainUrl,
    );
    try {
      assertPublicPlatformOrigin({
        variable: 'FLOWSTARTER_PUBLIC_APP_ORIGIN',
        value: input.leadCaptureEndpoint,
        targetIsPlatformHost,
      });
      assertPublicPlatformOrigin({
        variable: 'the workspace Cal.com link',
        value: input.calComUrl,
        targetIsPlatformHost,
      });
    } catch (e) {
      if (e instanceof UnsafePlatformOriginError) {
        throw new LocalPublishError(e.message);
      }
      throw e;
    }

    const siteRoot = input.siteRoot ?? input.worktreePath;
    // The exported copy whenever there is one, which on every real build there
    // is: it is the version of the output the validator proved contained and
    // then copied somewhere no generated code can reach. Resolving the
    // worktree's own `dist/` again here would re-open the window the export
    // was made to close, because the worktree is still writable and this runs
    // minutes after the build.
    const outputDir =
      input.outputRoot ??
      (await resolveSiteOutputDir(siteRoot, this.options.outputDir));
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

    // Before the deploy, never after it. This is the only moment anything
    // outside this method knows a complete, gate-passed artifact exists, and
    // a deploy that fails a line below is exactly the case the record is for:
    // run 9 lost 6.7 MB of correct, gated output to a 409 and a 502 because
    // nothing had written this down.
    await input.onArtifact?.({
      url: artifact.url,
      path: artifact.path,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
    });

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
      stagingUrl: this.stagingUrl(input.projectId, siteUrl),
    };
  }

  /**
   * Deploy bytes a previous attempt already built, gated and packaged.
   *
   * Nothing is packed, nothing is injected and nothing is read off disk: the
   * tarball is already sitting in the artifact store this worker serves, and
   * the digest travelling with it is the one the gates ran against. The
   * deploy-agent verifies that digest before it extracts anything, so a
   * resumed deploy either puts exactly the audited site on the host or puts
   * nothing there at all.
   *
   * The Cal.com and lead-capture reconciliation `create` does is deliberately
   * absent, and is not missing: both are transforms over the *files*, and
   * these files already went through them on the attempt that packaged them.
   * Re-running them would need the file map back, which would need the build
   * back, which is the cost this whole path exists to avoid.
   */
  async deployArtifact(input: {
    projectId: string;
    artifact: BuiltArtifactRecord;
  }): Promise<{ pullRequestUrl: string; stagingUrl: string }> {
    this.options.onProgress?.(
      `redeploying artifact sha256 ${input.artifact.sha256} ` +
        `(${input.artifact.sizeBytes} bytes, job ${input.projectId})`,
    );
    const siteUrl = await this.deploy({
      workspaceId: input.projectId,
      artifactUrl: input.artifact.url,
      artifactSha256: input.artifact.sha256,
      commitSha: input.artifact.commitSha,
    });
    return {
      pullRequestUrl: input.artifact.url,
      stagingUrl: this.stagingUrl(input.projectId, siteUrl),
    };
  }

  /** The deploy's own answer when it gave one, the configured shape when not. */
  private stagingUrl(projectId: string, siteUrl: string | null): string {
    return (
      siteUrl ??
      this.options.stagingUrlTemplate.replace(
        '{projectId}',
        projectId.toLowerCase(),
      )
    );
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
      // A socket that never got an answer names no deploy-side code, and the
      // honest classification of "we could not reach the deploy at all" is
      // "try the deploy again".
      throw deployFailure(
        null,
        `deploy request to ${url} failed: ${
          error instanceof Error ? error.message : 'unknown transport error'
        }`,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      // The route answers a refusal as `{ error, code }`, and the code is the
      // whole classification. Reading the status or the prose instead is what
      // made a 409 `workspace_unallocated` — a workspace with no host, which
      // no number of retries can conjure — look like any other failed build.
      const code = deployErrorCode(text);
      throw deployFailure(
        code,
        `flowstarter-main rejected the deploy with ${response.status}` +
          `${code ? ` (${code})` : ''}: ${text.slice(0, 500)}`,
      );
    }
    let parsed: DeployResponse;
    try {
      parsed = JSON.parse(text) as DeployResponse;
    } catch {
      throw deployFailure(null, 'deploy response was not JSON');
    }
    if (parsed.deployment?.status && parsed.deployment.status !== 'live') {
      throw deployFailure(
        null,
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

/**
 * The deploy-side code out of a refusal body, or null when there is not one.
 *
 * Null is not a failure of parsing so much as a statement: this refusal did
 * not name a reason, so the rule treats it as the retryable kind. The
 * alternative — guessing a category from the status line or the prose — is the
 * behaviour being removed.
 */
function deployErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as DeployErrorBody;
    const code = typeof parsed.code === 'string' ? parsed.code.trim() : '';
    return code ? code : null;
  } catch {
    return null;
  }
}

/**
 * One deploy failure, carrying the code the ledger and the retry rule read.
 *
 * A `FullSiteBuildFailure` rather than a `LocalPublishError` because the code
 * is the point: `FullSiteBuildWorker` writes `error.code` straight onto the
 * job, `failure-policy.ts` decides retryability from it, and
 * `/api/internal/build/deploy` alerts an operator on the same rule. An
 * untyped throw would land as `FULL_SITE_BUILD_FAILED` and every one of those
 * three would be back to reading a message.
 */
function deployFailure(
  deployCode: string | null,
  message: string,
): FullSiteBuildFailure {
  return new FullSiteBuildFailure(
    failureCodeForDeployCode(deployCode),
    message,
  );
}
