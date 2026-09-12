import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  PiSdkFlowstarterAgents,
  PiSessionAttemptError,
  type AgentBuildResult,
  type AgentTraceEntry,
} from './pi-sdk';
import { JobLogSink, type JobLogWriter } from './job-log';
import type { TemplateClassifier } from './template-classifier';
import { buildIntakeText } from './template-classifier';
import {
  injectPreviewTeaser,
  type PreviewTeaserOptions,
} from './preview-teaser';
import {
  materializeCachedAssets,
  type CachedAssetEntry,
  type CachedAssetFile,
} from './preview-assets';
import {
  generateSiteAssets,
  type GeneratedAssetEntry,
} from './generated-assets';
import { listSiteImageSlots } from './site-media';
import { assertSafeBusinessIntake } from './intake-guard';
import type { TemplateLibrary } from './template-library-mcp';
import {
  createPreviewWorkspace,
  materializeScaffold,
  SafeGitWorktreeManager,
  type GitWorktree,
} from './worktree';
import { ProjectState } from './types';
import type {
  ApprovedPreviewEdit,
  BrandConfig,
  BusinessIntakePayload,
  PreviewIntent,
  ScrapeCorpus,
  TemplateScaffold,
  TemplateScaffoldFile,
  TemplateSelection,
} from './types';
import {
  applyPageSetToScaffold,
  derivePageSet,
  describePageSet,
  findPageBudgetIssue,
  PAGE_BUDGET_EXCEEDED,
  type PageSet,
} from './page-set';
import {
  describePlaceholderFindings,
  findPlaceholderCopyInFiles,
  isEditableContentPath,
  PLACEHOLDER_COPY_SHIPPED,
} from './placeholder-copy';
import {
  describeInventedProjectFindings,
  findInventedProjects,
  INVENTED_PROJECT,
} from './invented-project';
import {
  stripPreviewTeaserFromFiles,
  TEASER_IN_PAID_BUILD,
} from './teaser-rule';
import { applyIntegrationsToWorkspace } from '../integrations';
import {
  isClientEditablePath,
  phrasesFromFiles,
  usablePhrases,
} from './preview-manifest';
import { readSiteWorkspaceFiles } from './site-manifest';
import {
  builtPageNames,
  changeRequestFeedback,
  changeRequestSummary,
  describeUnappliedChangeRequest,
  describeUncheckableChangeRequest,
  findChangeRequestPageIssue,
  findUnappliedChangeRequest,
  unappliedChangeRequestFeedback,
  CHANGE_REQUEST_NOT_APPLIED,
  type ChangeRequestIntent,
} from './change-request-build';

export interface SiteValidator {
  /** Trusted, operator-defined formatter/check/build commands run outside Pi. */
  validate(workspaceRoot: string, phase: 'preview' | 'full'): Promise<void>;
}

export interface PreviewPublisher {
  publish(input: {
    projectId: string;
    workspaceRoot: string;
    template: TemplateSelection;
    brandConfig: BrandConfig;
  }): Promise<{
    previewUrl: string;
    artifactUrl: string;
    files: TemplateScaffoldFile[];
    sandboxId?: string;
    teardown?: () => Promise<void>;
  }>;
}

export interface PreviewPipelineOptions {
  /**
   * Give the preview model the entire template source read-only. Pair with a
   * large-context budget model (the flash tier) so the agent understands the
   * design system without tool-call archaeology.
   */
  fullTemplateContext?: boolean;
  /**
   * The quality sweep: a second personalization pass for first-person voice,
   * no invented clients or metrics, no template stock copy left over.
   *
   * `true` runs it only when the mechanical residue check finds something to
   * fix (template sample copy surviving verbatim, or a collective "we/our"
   * voice), and hands the agent the exact findings. That check is what
   * decides; the pass costs as much as the first one and ran on every
   * preview before. `'always'` is the old behaviour.
   */
  qualitySweep?: boolean | 'always';
  /** Blur lower sections of the published preview behind an unlock chip. */
  teaser?: PreviewTeaserOptions | false;
  /**
   * Post-publish rendered audit. Receives the live preview URL; returns a
   * human-readable issue description (low-contrast text, viewport-scale
   * empty gaps, broken scheme) or undefined when the render is acceptable.
   * On an issue the pipeline runs one repair pass and republishes. The
   * auditor lives outside this package — it typically drives a headless
   * browser, which the worker runtime may not ship.
   */
  renderedAudit?: (previewUrl: string) => Promise<string | undefined>;
}

export interface PreviewPipelineResult {
  brandConfig: BrandConfig;
  template: TemplateSelection;
  previewUrl: string;
  artifactUrl: string;
  files: TemplateScaffoldFile[];
  sandboxId?: string;
  teardown?: () => Promise<void>;
  /**
   * Spend on generated site imagery for this run, in USD. Reported so the
   * caller can add it to the funnel budget it already meters LLM tokens
   * against; zero when the stage was skipped or every image failed.
   */
  generatedAssetsCostUsd: number;
}

export class PreviewGenerationPipeline {
  constructor(
    private readonly agents: PiSdkFlowstarterAgents,
    private readonly library: TemplateLibrary,
    private readonly validator: SiteValidator,
    private readonly publisher: PreviewPublisher,
    /**
     * Optional sigma-style deterministic selector. When its top match clears
     * the confidence gate the LLM selection call is skipped entirely; murky
     * intakes still go to the model.
     */
    private readonly templateClassifier?: TemplateClassifier,
    private readonly options: PreviewPipelineOptions = {},
  ) {}

  async run(input: {
    intake: BusinessIntakePayload;
    corpus: ScrapeCorpus;
    cachedAssets: Array<{ sourceId: string; publicPath: string }>;
    /**
     * Client media bytes (scraped brand photos) the trusted orchestrator
     * writes into public/flowstarter-assets/ after scaffolding; the resulting
     * entries are merged into cachedAssets for the agent.
     */
    cachedAssetFiles?: CachedAssetFile[];
    /**
     * The funnel is over its soft spending threshold. Optional extras that
     * cost money — currently the generated site imagery — are dropped, and
     * the preview falls back to the template's own artwork.
     */
    budgetDegraded?: boolean;
    /**
     * True only when the workspace has a booking link that already passed
     * validation. It is the whole of rule 5 in `page-set.ts`: with it false
     * the booking page is never scaffolded, never linked, and every "book"
     * call to action points at the contact page instead.
     */
    hasBookingLink?: boolean;
    /**
     * Epoch ms by which the run must be published. Optional passes (the
     * quality sweep, the image and integrity repairs) are skipped once too
     * little of it is left for them to finish, so a slow first pass costs
     * polish rather than the preview.
     */
    deadlineAt?: number;
    onPhase?: (phase: string) => void;
  }): Promise<PreviewPipelineResult> {
    assertSafeBusinessIntake(input.intake);
    // An optional pass that runs out of clock is abandoned, not fatal: the
    // preview ships with what is on disk. Anything else it throws is real.
    const optional = async (
      pass: string,
      run: () => Promise<AgentBuildResult>,
    ): Promise<AgentBuildResult | undefined> => {
      try {
        return await run();
      } catch (error) {
        if (!isOutOfTime(error)) throw error;
        console.warn(
          `[deadline] abandoned "${pass}": ${
            error instanceof Error ? error.message : 'out of time'
          }`,
        );
        return undefined;
      }
    };
    const roomFor = (pass: string): boolean => {
      if (input.deadlineAt === undefined) return true;
      const left = input.deadlineAt - Date.now();
      if (left >= OPTIONAL_PASS_MIN_MS) return true;
      console.info(
        `[deadline] skipped "${pass}": ${Math.round(left / 1000)}s left of the run`,
      );
      return false;
    };
    input.onPhase?.('Learning your voice and visual direction');

    // The sigma classifier reads the intake only, so template selection does
    // not have to wait for the vision pass to finish. Racing them removes the
    // classifier and the scaffold download from the critical path entirely;
    // a murky intake still falls back to the model, which does need the brand
    // config and so runs after it.
    const deterministicSelection = this.templateClassifier
      ? this.classifyTemplate(input.intake).catch(() => undefined)
      : Promise.resolve(undefined);

    const [brandConfig, classified] = await Promise.all([
      this.agents.analyzeBrand(input.intake, input.corpus),
      deterministicSelection,
    ]);

    input.onPhase?.('Choosing the best starting design');
    const template =
      classified ??
      (await this.agents.selectTemplate({
        intake: input.intake,
        brandConfig,
        library: this.library,
      }));
    input.onPhase?.('Preparing your selected design');
    // The page set is decided here, deterministically, before a model ever
    // sees the workspace. A template ships seven pages and a booking page
    // whatever the brief asked for; this is what keeps a four-page brief from
    // becoming a seven-page site and what stops a `/book` page existing for a
    // client who has no booking link.
    const pageSet = derivePageSet({
      pageCount: input.intake.business.pageCount ?? null,
      businessType: `${input.intake.business.niche} ${input.intake.business.description ?? ''}`,
      hasBookingLink: input.hasBookingLink ?? false,
      // Rule 6 needs to tell "no projects" from "never asked", so a brief
      // without the question stays null rather than counting as zero.
      projectCount: input.intake.projects?.length ?? null,
    });
    const scaffold = prunedScaffold(
      await this.library.scaffold(template.slug),
      pageSet,
    );
    const workspace = await createPreviewWorkspace(scaffold);
    try {
      const cachedAssets = [
        ...input.cachedAssets,
        ...(await materializeCachedAssets(
          workspace.root,
          input.cachedAssetFiles ?? [],
        )),
      ];
      // Brand-matched imagery, painted from this brief. Best-effort by
      // design: the stage swallows its own failures and an empty result just
      // means the template keeps the artwork it shipped with.
      const generated = await generateSiteAssets({
        workspaceRoot: workspace.root,
        brief: {
          industry: input.intake.business.niche,
          ...(input.intake.business.description === undefined
            ? {}
            : { description: input.intake.business.description }),
          ...(input.intake.business.targetAudience === undefined
            ? {}
            : { targetAudience: input.intake.business.targetAudience }),
          brandTone: brandConfig.voice.adjectives,
          location: input.intake.business.location,
        },
        slots: await listSiteImageSlots(workspace.root),
        assetLibrary: extractAssetLibraryEntries(scaffold.template.config),
        hasClientMedia: cachedAssets.length > 0,
        ...(input.budgetDegraded === undefined
          ? {}
          : { budgetDegraded: input.budgetDegraded }),
        ...(input.onPhase ? { onPhase: input.onPhase } : {}),
      }).catch((error: unknown) => {
        // Nothing in this stage may cost a client their preview.
        console.warn(
          `[generated-assets] stage skipped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { entries: [] as GeneratedAssetEntry[], costUsd: 0 };
      });

      const personalize = (feedback?: string) =>
        this.agents.buildPreview({
          workspaceRoot: workspace.root,
          intake: input.intake,
          brandConfig,
          templateSlug: template.slug,
          cachedAssets,
          generatedAssets: generated.entries,
          templateConfig: scaffold.template.config,
          feedback,
          fullTemplateContext: this.options.fullTemplateContext,
        });

      input.onPhase?.('Personalizing the site with your business');
      let build = await personalize();
      if (build.timedOut) {
        console.warn(
          `[preview] personalization timed out after writing ${build.changedPaths.length} file(s); continuing with what is on disk`,
        );
      }
      if (this.options.qualitySweep && roomFor('quality sweep')) {
        const residue =
          this.options.qualitySweep === 'always'
            ? undefined
            : await findTemplateResidue(workspace.root, scaffold.files);
        if (this.options.qualitySweep === 'always' || residue) {
          // Logged so the residue rule can be calibrated against real runs:
          // what it flags is what the sweep costs five minutes to fix.
          if (residue) console.info(`[quality-sweep] ${residue.slice(0, 600)}`);
          input.onPhase?.('Polishing voice and honesty');
          const sweep = await optional('quality sweep', () =>
            personalize(
              residue
                ? `${QUALITY_SWEEP_FEEDBACK} ${residue}`
                : QUALITY_SWEEP_FEEDBACK,
            ),
          );
          if (sweep && sweep.changedPaths.length > 0) {
            build = {
              ...sweep,
              changedPaths: Array.from(
                new Set([...build.changedPaths, ...sweep.changedPaths]),
              ),
            };
          }
        }
      }
      let issue = await findPersonalizationIssue(
        workspace.root,
        input.intake,
        build,
      );
      // Bounded repair loop. One pass used to be the whole allowance, and a
      // session that ends without writing (this model family's favourite
      // failure) then cost the client the preview on the very next check.
      // Two passes with the same deterministic feedback is cheap: the template
      // context is cached, and the alternative is a failed job.
      for (
        let repairs = 0;
        issue &&
        repairs < MAX_PERSONALIZATION_REPAIRS &&
        roomFor('personalization repair');
        repairs += 1
      ) {
        input.onPhase?.('Refining the personalization');
        const repair = await personalize(issue);
        // Re-check against everything written so far, not just this pass. A
        // repair that correctly concludes there is nothing left to change
        // reports no changed files, and judging it alone would fail a preview
        // that is actually fine.
        build = {
          ...repair,
          changedPaths: Array.from(
            new Set([...build.changedPaths, ...repair.changedPaths]),
          ),
        };
        issue = await findPersonalizationIssue(
          workspace.root,
          input.intake,
          build,
        );
      }
      if (issue) {
        throw new Error(`Preview personalization failed: ${issue}`);
      }

      // The honesty gate. The quality sweep above already *flags* leftover
      // template copy and sends the agent back once; it never refused to ship
      // what came back, which is how a contact page telling the visitor the
      // form is not wired up reached a paying client. This one fails.
      // Scoped to the files the preview agent may write, so it never fails a
      // preview for markup the agent is barred from touching.
      const editableFiles = async () =>
        (await collectSiteTextFiles(workspace.root)).filter((file) =>
          isEditableContentPath(file.path),
        );
      let placeholder = findPlaceholderCopyIssue(await editableFiles(), {
        hasBookingLink: input.hasBookingLink ?? false,
      });
      if (placeholder && roomFor('placeholder copy repair')) {
        input.onPhase?.('Removing placeholder copy');
        const feedback = placeholder;
        const repair = await optional('placeholder copy repair', () =>
          personalize(feedback),
        );
        if (repair) {
          build = {
            ...repair,
            changedPaths: Array.from(
              new Set([...build.changedPaths, ...repair.changedPaths]),
            ),
          };
        }
        placeholder = findPlaceholderCopyIssue(await editableFiles(), {
          hasBookingLink: input.hasBookingLink ?? false,
        });
      }
      if (placeholder) throw new Error(placeholder);

      // Soft checks on image placement. Both run one repair pass at most and
      // never fail the pipeline: a stubborn image slot must not cost the
      // client their whole preview.
      const mediaIssue = await findClientMediaIssue(
        workspace.root,
        cachedAssets,
        build,
      );
      if (mediaIssue && roomFor('client media repair')) {
        input.onPhase?.('Placing your own photos');
        build =
          (await optional('client media repair', () =>
            personalize(mediaIssue),
          )) ?? build;
      }

      const heroIssue = await findHeroAssetIssue(
        workspace.root,
        cachedAssets,
        build,
      );
      if (heroIssue && roomFor('hero image repair')) {
        input.onPhase?.('Choosing the right hero image');
        build =
          (await optional('hero image repair', () => personalize(heroIssue))) ??
          build;
      }

      // Artwork was generated for this brief; a preview that still shows the
      // template's stock art anyway is the defect the whole stage exists to
      // remove. Same contract as the two checks above: one repair pass, soft.
      const generatedIssue = await findGeneratedAssetIssue(
        workspace.root,
        generated.entries,
      );
      if (generatedIssue && roomFor('brand imagery repair')) {
        input.onPhase?.('Placing your brand imagery');
        build =
          (await optional('brand imagery repair', () =>
            personalize(generatedIssue),
          )) ?? build;
      }

      // Mechanical integrity gate on the files the agent is allowed to edit.
      // A style file with a broken declaration or a content JSON that does
      // not parse fails `astro dev` at publish time, minutes from now, with
      // a stack trace instead of a preview. Checked here, it costs one
      // bounded repair pass; if the agent cannot fix it, the file goes back
      // to the template's own version and the preview ships without the
      // custom palette rather than not at all.
      let integrity = await findWorkspaceIntegrityIssue(
        workspace.root,
        scaffold.files,
      );
      if (integrity) {
        if (roomFor('style repair')) {
          input.onPhase?.('Repairing the styles');
          const feedback = integrity.feedback;
          await optional('style repair', () => personalize(feedback));
          integrity = await findWorkspaceIntegrityIssue(
            workspace.root,
            scaffold.files,
          );
        }
        if (integrity) {
          await restoreScaffoldFiles(
            workspace.root,
            scaffold.files,
            integrity.paths,
          );
          console.warn(
            `[integrity] restored ${integrity.paths.join(', ')} from the template. ${integrity.feedback.slice(-700)}`,
          );
        }
      }

      input.onPhase?.('Checking the preview');
      try {
        await this.validator.validate(workspace.root, 'preview');
      } catch (error) {
        input.onPhase?.('Repairing the preview');
        const detail =
          error instanceof Error ? error.message.slice(0, 2_000) : 'unknown';
        await personalize(
          `Automated validation of your previous file changes failed: ${detail}. Repair the workspace files so validation passes.`,
        );
        await this.validator.validate(workspace.root, 'preview');
      }
      // The only place the teaser is ever injected, and it is inside
      // PreviewGenerationPipeline: a funnel preview, by construction. The
      // paid paths strip it back out of the seed they inherit and the
      // worker's validator fails a build that still carries it. See
      // `teaser-rule.ts` for the rule in full.
      if (this.options.teaser !== false && this.options.teaser !== undefined) {
        input.onPhase?.('Preparing the preview teaser');
        await injectPreviewTeaser(workspace.root, this.options.teaser);
      }
      input.onPhase?.('Publishing your live preview');
      let published = await this.publisher.publish({
        projectId: input.intake.projectId,
        workspaceRoot: workspace.root,
        template,
        brandConfig,
      });
      if (this.options.renderedAudit) {
        input.onPhase?.('Reviewing the rendered preview');
        let renderIssue: string | undefined;
        try {
          renderIssue = await this.options.renderedAudit(published.previewUrl);
        } catch (error) {
          // Auditor crashes must not cost the visitor their preview.
          console.warn(
            `[rendered-audit] skipped: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        if (renderIssue) {
          input.onPhase?.('Repairing rendered issues');
          await personalize(
            `A rendered review of the published preview found visual defects you must repair by editing content and style-token values only: ${renderIssue.slice(
              0,
              2_000,
            )}`,
          );
          await this.validator.validate(workspace.root, 'preview');
          await published.teardown?.().catch(() => undefined);
          published = await this.publisher.publish({
            projectId: input.intake.projectId,
            workspaceRoot: workspace.root,
            template,
            brandConfig,
          });
        }
      }
      return {
        brandConfig,
        template,
        ...published,
        generatedAssetsCostUsd: generated.costUsd,
      };
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  }

  /**
   * The deterministic half of template selection: intake text only, so it can
   * run while the brand agent is still looking at images. Returns undefined
   * when nothing clears the confidence gate, leaving the decision to the model.
   */
  private async classifyTemplate(
    intake: BusinessIntakePayload,
  ): Promise<TemplateSelection | undefined> {
    if (!this.templateClassifier) return undefined;
    const intakeText = buildIntakeText(intake.business);
    const candidates = await this.library.search(intakeText.slice(0, 280));
    const classified = await this.templateClassifier.classify(
      intakeText,
      candidates,
    );
    if (!classified.autoSelect) return undefined;
    const { slug, score, margin } = classified.autoSelect;
    return {
      slug,
      reason: `sigma classifier auto-selection (cosine ${score.toFixed(
        3,
      )}, margin ${margin.toFixed(3)} over runner-up)`,
      matchedSignals: ['sigma-embedding'],
      confidence: Math.min(0.99, score),
    };
  }
}

/**
 * The template's artwork manifest, reduced to what slot planning needs: a
 * path and its `kind`. Only used to spot the entries that depict a person, so
 * an entry missing a description still counts — unlike the richer projection
 * the preview prompt builds, dropping one here would silently un-exclude a
 * face.
 */
function extractAssetLibraryEntries(
  config: Record<string, unknown> | undefined,
): Array<{ path?: string; kind?: string }> | undefined {
  const entries = config?.assetLibrary;
  if (!Array.isArray(entries)) return undefined;
  return entries
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === 'object',
    )
    .map((entry) => ({
      ...(typeof entry.path === 'string' ? { path: entry.path } : {}),
      ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
    }));
}

/** Repair passes the personalization check may send the agent back for. */
const MAX_PERSONALIZATION_REPAIRS = 2;

/** An optional model pass is not started with less run time than this left. */
const OPTIONAL_PASS_MIN_MS = 150_000;

/** The clock, not the model: a timed-out attempt or a refused one. */
function isOutOfTime(error: unknown): boolean {
  if (error instanceof PiSessionAttemptError) return error.kind === 'timeout';
  return error instanceof Error && error.name === 'PiRunDeadlineExceededError';
}

/** Keys whose value describes an image, not the business: alt text stays. */
const IMAGE_TEXT_KEY = /(^|[_-])(alt|imagealt|imagedescription)$/i;

/**
 * A stylesheet with every closed `/* … *\/` comment replaced.
 *
 * Scanned, not matched. Both of the patterns that did this before (the lazy
 * `\/\*[\s\S]*?\*\/` and the unrolled loop that replaced it) cost time
 * quadratic in the length of a stylesheet the model truncated mid-write,
 * because every unterminated `/*` sends the engine back to try again from the
 * next one. Two `indexOf` calls per comment cannot.
 *
 * The rule is the one the regex had: a comment runs to the first `*\/` after
 * it, comments do not nest, and an unterminated `/*` is left exactly as it is
 * along with everything after it.
 */
export function stripBlockComments(source: string, replacement = ''): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const open = source.indexOf('/*', cursor);
    if (open === -1) break;
    const close = source.indexOf('*/', open + 2);
    if (close === -1) break;
    out += source.slice(cursor, open) + replacement;
    cursor = close + 2;
  }
  return out + source.slice(cursor);
}

/** Every character JavaScript's `\s` matches, as a set. */
const WHITESPACE = new Set(
  ' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff',
);

/** The characters JavaScript's `.` refuses to match. */
const LINE_TERMINATORS = new Set('\n\r\u2028\u2029');

/** `\w`, for a word boundary. */
function isWordCharacter(char: string | undefined): boolean {
  return (
    char !== undefined &&
    ((char >= 'a' && char <= 'z') ||
      (char >= 'A' && char <= 'Z') ||
      (char >= '0' && char <= '9') ||
      char === '_')
  );
}

/** `[\w-]`: what a CSS property name is made of. */
function isPropertyNameCharacter(char: string | undefined): boolean {
  return char === '-' || isWordCharacter(char);
}

/**
 * Every `property: value;` in a stylesheet reduced to `property:_;`.
 *
 * Scanned, not matched. `/([\w-]+)\s*:\s*[^;{}]*;/g` says the same thing,
 * but the name run, the blanks after the colon and the value class all
 * overlap, so a property name that is a long row of `-` made the engine
 * retry from every character in it. The rules are that pattern's: a name of
 * word characters and dashes, blanks, a colon, blanks, then everything up to
 * the first `;`, and no rewrite at all when a `{` or `}` arrives first.
 */
export function collapseDeclarationValues(css: string): string {
  let out = '';
  let kept = 0;
  let index = 0;
  while (index < css.length) {
    if (!isPropertyNameCharacter(css[index])) {
      index += 1;
      continue;
    }
    // The name is the whole run. Starting anywhere inside it would put a name
    // character where the colon has to be, so those starts cannot match and
    // the scan skips past them rather than retrying each one.
    let nameEnd = index;
    while (isPropertyNameCharacter(css[nameEnd])) nameEnd += 1;

    let cursor = nameEnd;
    while (cursor < css.length && WHITESPACE.has(css[cursor]!)) cursor += 1;
    if (css[cursor] !== ':') {
      index = nameEnd;
      continue;
    }
    cursor += 1;
    while (
      cursor < css.length &&
      css[cursor] !== ';' &&
      css[cursor] !== '{' &&
      css[cursor] !== '}'
    ) {
      cursor += 1;
    }
    if (css[cursor] !== ';') {
      index = nameEnd;
      continue;
    }
    out += `${css.slice(kept, nameEnd)}:_;`;
    kept = cursor + 1;
    index = cursor + 1;
  }
  return out + css.slice(kept);
}

/**
 * Every quoted string in a stylesheet replaced by an empty one, so a brace or
 * a colon inside `content: "{"` is not read as syntax.
 *
 * Scanned, not matched. The pattern was
 * `/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g`, and an unclosed quote sent it
 * back to try again from every escape inside, which is quadratic on a file
 * full of `\"`. One pass finds the same strings: a run of plain characters
 * and backslash escapes, ending at the matching quote. A backslash before a
 * line terminator is not an escape, because `.` does not match one, so a
 * string that reaches one is unterminated and is left alone.
 */
export function blankStringLiterals(css: string): string {
  let out = '';
  let kept = 0;
  let index = 0;
  while (index < css.length) {
    const quote = css[index];
    if (quote !== '"' && quote !== "'") {
      index += 1;
      continue;
    }
    let cursor = index + 1;
    let closed = false;
    while (cursor < css.length) {
      const char = css[cursor]!;
      if (char === quote) {
        closed = true;
        break;
      }
      if (char !== '\\') {
        cursor += 1;
        continue;
      }
      const escaped = css[cursor + 1];
      if (escaped === undefined || LINE_TERMINATORS.has(escaped)) break;
      cursor += 2;
    }
    if (!closed) {
      index += 1;
      continue;
    }
    out += `${css.slice(kept, index)}""`;
    kept = cursor + 1;
    index = cursor + 1;
  }
  return out + css.slice(kept);
}

/**
 * A stylesheet reduced to its structure: comments gone, whitespace folded,
 * every declaration value replaced by a placeholder. Two files with the same
 * skeleton differ only in values, which is exactly what the preview agent is
 * allowed to change. A missing semicolon, an unbalanced brace or a new
 * selector all change the skeleton.
 */
export function cssSkeleton(css: string): string {
  return collapseDeclarationValues(stripBlockComments(css))
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,>+~])\s*/g, '$1')
    .trim();
}

/**
 * Where two skeletons stop agreeing, as a short excerpt of each. Named in
 * the repair feedback so the agent fixes the line rather than guessing, and
 * logged so a check that fires on something harmless can be recognised.
 */
export function firstSkeletonDifference(
  expected: string,
  actual: string,
): { expected: string; actual: string } {
  let index = 0;
  while (
    index < expected.length &&
    index < actual.length &&
    expected[index] === actual[index]
  ) {
    index += 1;
  }
  const from = Math.max(0, index - 40);
  return {
    expected: expected.slice(from, index + 60),
    actual: actual.slice(from, index + 60),
  };
}

/**
 * Would `astro dev` refuse this stylesheet? Checked without a CSS parser:
 * comments, strings and url() bodies are blanked, then braces must balance
 * (a file the model truncated mid-write is the usual way they do not) and
 * every declaration in a leaf block must be one `property: value` (two
 * declarations that lost the semicolon between them are the other usual
 * way). Returns a one-line reason, or undefined when the file is sound.
 */
export function cssSyntaxIssue(css: string): string | undefined {
  const cleaned = blankStringLiterals(stripBlockComments(css, ' ')).replace(
    /url\([^)]*\)/gi,
    'url()',
  );
  const opens: number[] = [];
  for (let index = 0; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (char === '{') {
      opens.push(index + 1);
      continue;
    }
    if (char !== '}') continue;
    const start = opens.pop();
    if (start === undefined) return `a stray "}" with no matching "{"`;
    const body = cleaned.slice(start, index);
    if (body.includes('{')) continue; // an at-rule wrapper; its blocks were checked
    for (const chunk of body.split(';')) {
      const declaration = chunk.trim();
      if (!declaration) continue;
      const colon = declaration.indexOf(':');
      const property = colon === -1 ? '' : declaration.slice(0, colon).trim();
      let value = colon === -1 ? '' : declaration.slice(colon + 1).trim();
      // Colons inside parentheses are values (rgb(0 0 0 / 50%) is fine,
      // and so is anything a function takes); outside them they mean two
      // declarations ran together.
      for (let pass = 0; pass < 6 && /\(/.test(value); pass += 1) {
        value = value.replace(/\([^()]*\)/g, '');
      }
      if (!/^[\w-]+$/.test(property) || !value || value.includes(':')) {
        return `the declaration "${declaration.slice(0, 80)}" is malformed`;
      }
    }
  }
  if (opens.length > 0) {
    return `${opens.length} unclosed "{" (the file may have been cut off)`;
  }
  return undefined;
}

function isStyleFile(path: string): boolean {
  return path.startsWith('src/styles/') && path.endsWith('.css');
}

function isJsonContent(path: string): boolean {
  return (
    CONTENT_DIRECTORIES.some((dir) => path.startsWith(dir)) &&
    path.endsWith('.json')
  );
}

/**
 * The files the agent may edit, checked the way the build will check them:
 * style files keep the template's exact structure, JSON content parses.
 * Returns bounded repair feedback plus the offending paths, or undefined.
 */
export async function findWorkspaceIntegrityIssue(
  workspaceRoot: string,
  scaffoldFiles: readonly TemplateScaffoldFile[],
): Promise<{ feedback: string; paths: string[] } | undefined> {
  const problems: string[] = [];
  const paths: string[] = [];
  for (const file of scaffoldFiles) {
    if (file.encoding === 'base64') continue;
    const style = isStyleFile(file.path);
    const json = isJsonContent(file.path);
    if (!style && !json) continue;
    let current: string;
    try {
      current = await readFile(join(workspaceRoot, file.path), 'utf8');
    } catch {
      continue;
    }
    if (current === file.content) continue;
    if (style) {
      const syntax = cssSyntaxIssue(current);
      if (syntax) {
        paths.push(file.path);
        problems.push(
          `${file.path} would not parse: ${syntax}. Keep every selector, property and semicolon exactly as the template ships them and change values only.`,
        );
      } else {
        // Structure drifted but the file builds: the agent added or removed
        // a declaration the prompt told it not to touch. Worth a line in the
        // log to calibrate the prompt against, never worth the client's
        // palette.
        const expected = cssSkeleton(file.content);
        const actual = cssSkeleton(current);
        if (expected !== actual) {
          const where = firstSkeletonDifference(expected, actual);
          console.info(
            `[integrity] note ${file.path}: structure drifted but parses; template "${where.expected}" vs yours "${where.actual}"`,
          );
        }
      }
    }
    if (json) {
      try {
        JSON.parse(current);
      } catch (error) {
        paths.push(file.path);
        problems.push(
          `${file.path} is not valid JSON (${
            error instanceof Error ? error.message : 'parse error'
          }); keep the exact keys and nesting of the template and change values only.`,
        );
      }
    }
  }
  if (problems.length === 0) return undefined;
  return {
    feedback: `The workspace would not build: ${problems.join(' ')}`,
    paths,
  };
}

/** Puts the template's own version of each path back. */
async function restoreScaffoldFiles(
  workspaceRoot: string,
  scaffoldFiles: readonly TemplateScaffoldFile[],
  paths: readonly string[],
): Promise<void> {
  for (const file of scaffoldFiles) {
    if (!paths.includes(file.path) || file.encoding === 'base64') continue;
    await writeFile(join(workspaceRoot, file.path), file.content, 'utf8');
  }
}

/**
 * The template scaffold, cut down to the pages this brief buys.
 *
 * Exported because it is the only thing standing between a "Under 5" answer
 * and a seven-page site, and because it is what makes a `/book` page
 * impossible without a booking link: the page never reaches the workspace, so
 * no agent can personalize it and no build can emit it.
 */
export function prunedScaffold(
  scaffold: TemplateScaffold,
  pageSet: PageSet,
): TemplateScaffold {
  const pruned = applyPageSetToScaffold(scaffold.files, pageSet);
  if (pruned.removedPaths.length > 0 || pruned.rewrittenPaths.length > 0) {
    console.info(
      `[page-set] ${pageSet.kind} brief, budget ${pageSet.budget}, keeps ` +
        `${pageSet.allowed.join(', ')}; removed ${
          pruned.removedPaths.join(', ') || 'nothing'
        }; relinked ${pruned.rewrittenPaths.join(', ') || 'nothing'}`,
    );
  }
  return { ...scaffold, files: pruned.files };
}

/**
 * The placeholder-copy gate, over the files a site actually renders.
 *
 * The residue check next to it asks "did the agent rewrite the template's
 * sample copy". This asks a narrower and harder question: does the site make
 * a promise it cannot keep — a contact form that admits it is not wired, a
 * booking page naming a calendar the client does not have. The sentinel list
 * is in `placeholder-copy.ts`, hand-written and closed.
 */
export function findPlaceholderCopyIssue(
  files: readonly { path: string; content: string }[],
  options: { hasBookingLink?: boolean; editableOnly?: boolean } = {},
): string | undefined {
  const scanned = options.editableOnly
    ? files.filter((file) => isEditableContentPath(file.path))
    : files;
  const findings = findPlaceholderCopyInFiles(scanned, {
    hasBookingLink: options.hasBookingLink ?? false,
  });
  return findings.length > 0
    ? describePlaceholderFindings(findings)
    : undefined;
}

/**
 * The invented-project gate, over the files a site actually renders.
 *
 * The placeholder gate asks whether the site makes a promise it cannot keep.
 * This asks whether the site claims work that never happened: a case study
 * headed with a client the brief never mentioned. It has an opinion only when
 * the brief gave it a list of real projects to check against; with no list it
 * stays silent, because a brief that was never asked the question cannot be
 * failed for its answer.
 */
export function findInventedProjectIssue(
  files: readonly { path: string; content: string }[],
  briefProjectNames: readonly string[],
): string | undefined {
  const findings = findInventedProjects(files, briefProjectNames);
  return findings.length > 0
    ? describeInventedProjectFindings(findings, briefProjectNames)
    : undefined;
}

/** Where a template keeps the copy the agent is meant to rewrite. */
const CONTENT_DIRECTORIES = ['src/content/', 'src/data/'] as const;
/** Shorter strings are labels ("Home", "Book a call"): legitimately reusable. */
const MIN_SAMPLE_CHARS = 24;
/** Findings listed back to the agent; more is noise, not information. */
const MAX_RESIDUE_LISTED = 12;
/** "We/our" past this many times reads as a studio, not a person. */
const MAX_COLLECTIVE_VOICE = 4;
const COLLECTIVE_VOICE = /\b(we|our|ours|us)\b/gi;

/**
 * The template's own sample copy: every sentence-like value in its content
 * files. Anything on this list still present after personalization is demo
 * residue, whatever the agent's summary claims.
 */
export function templateSampleStrings(
  files: readonly TemplateScaffoldFile[],
): Map<string, string[]> {
  const samples = new Map<string, string[]>();
  for (const file of files) {
    if (file.encoding === 'base64') continue;
    if (!CONTENT_DIRECTORIES.some((dir) => file.path.startsWith(dir))) continue;
    const found = new Set<string>();
    for (const rawLine of file.content.split('\n')) {
      // YAML `key: value`, `- value`, and block-scalar prose lines all reduce
      // to "the text after the structure", quotes stripped.
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line === '---') continue;
      const key = /^([\w.-]+):/.exec(line)?.[1];
      // Alt text describes the template's own artwork, which the preview
      // keeps by policy; asking the agent to rewrite it would be asking it
      // to lie about the picture.
      if (key && IMAGE_TEXT_KEY.test(key)) continue;
      const value = line
        .replace(/^-\s+/, '')
        .replace(/^[\w.-]+:\s*/, '')
        .replace(/^["']|["'],?$/g, '')
        .trim();
      if (value.length < MIN_SAMPLE_CHARS) continue;
      if (!value.includes(' ')) continue;
      if (/^(https?:\/\/|\/|mailto:|tel:)/i.test(value)) continue;
      if (/^[|>][-+]?$/.test(value)) continue;
      found.add(value);
    }
    if (found.size > 0) samples.set(file.path, Array.from(found));
  }
  return samples;
}

/**
 * The mechanical half of the quality sweep. Reads the personalized content
 * files and reports what a second pass must fix: template sentences that
 * survived verbatim, and a collective voice. Returns bounded feedback for
 * the agent, or undefined when there is nothing to send it back for.
 */
export async function findTemplateResidue(
  workspaceRoot: string,
  scaffoldFiles: readonly TemplateScaffoldFile[],
): Promise<string | undefined> {
  const samples = templateSampleStrings(scaffoldFiles);
  const survivors: string[] = [];
  let collectiveVoice = 0;
  for (const [path, strings] of Array.from(samples.entries())) {
    let content: string;
    try {
      content = await readFile(join(workspaceRoot, path), 'utf8');
    } catch {
      continue;
    }
    for (const sample of strings) {
      if (content.includes(sample)) survivors.push(`${path}: "${sample}"`);
    }
    collectiveVoice += content.match(COLLECTIVE_VOICE)?.length ?? 0;
  }
  const findings: string[] = [];
  if (survivors.length > 0) {
    findings.push(
      `Template sample copy still present verbatim (${survivors.length} string${
        survivors.length === 1 ? '' : 's'
      }); rewrite each for the client: ${survivors
        .slice(0, MAX_RESIDUE_LISTED)
        .join('; ')}${survivors.length > MAX_RESIDUE_LISTED ? '; …' : ''}.`,
    );
  }
  if (collectiveVoice > MAX_COLLECTIVE_VOICE) {
    findings.push(
      `The copy says we/our/us ${collectiveVoice} times; rewrite in first-person singular.`,
    );
  }
  return findings.length > 0 ? findings.join(' ') : undefined;
}

/**
 * Trusted post-session check that the agent actually personalized the
 * template. Returns bounded feedback for one repair pass, or undefined when
 * the work is acceptable.
 */
const QUALITY_SWEEP_FEEDBACK =
  'Quality sweep over every editable content file, changing only what breaks ' +
  'these rules: (1) the site speaks as one person — first-person singular ' +
  'everywhere; rewrite any we/our/us/studio/team voice. (2) Nothing invented ' +
  '— remove or rewrite fabricated clients, testimonials, case studies, ' +
  'metrics, awards or logos; ground every claim in the intake and brand ' +
  'evidence, or repurpose the section to describe real process or skills. ' +
  '(3) No template stock copy or placeholder text may remain anywhere, ' +
  'including subpages. (4) Length discipline: hero heading at most 8 words; ' +
  'hero supporting paragraph at most 45 words; CTA labels at most 4 words — ' +
  'long hero copy stretches the template on phones. Keep everything that ' +
  'already satisfies the rules.';

async function findPersonalizationIssue(
  workspaceRoot: string,
  intake: BusinessIntakePayload,
  build: AgentBuildResult,
): Promise<string | undefined> {
  if (build.changedPaths.length === 0) {
    return (
      'your session ended without modifying any file; rewrite the canonical ' +
      "content file with the client's real business content"
    );
  }
  const businessName = intake.business.name.trim();
  if (!businessName) return undefined;
  const needle = businessName.toLowerCase();
  for (const path of build.changedPaths) {
    try {
      const content = await readFile(join(workspaceRoot, path), 'utf8');
      if (content.toLowerCase().includes(needle)) return undefined;
    } catch {
      // A changed file may since be unreadable; keep scanning the rest.
    }
  }
  return (
    `the client's business name "${businessName}" does not appear in any ` +
    "file you changed; replace the template's sample brand copy with the " +
    "client's real content"
  );
}

/**
 * Trusted post-session check that the hero image is one the caller vouched
 * for. Aesthetic suitability is not something the orchestrator can judge from
 * bytes, so the gate is mechanical: only `heroEligible` client media may sit
 * in a hero slot, and everything else falls back to the template's own
 * art-directed asset.
 */
/** Content files a template renders its image slots from. */
const GENERATED_ASSET_CONTENT_FILES = [
  'src/content/site-labels.md',
  'src/content/content.md',
] as const;

/**
 * The check that makes generated imagery real rather than aspirational: every
 * generated asset must be referenced by the site's content files, or the
 * agent is sent back once with the exact list of what it left unplaced.
 * Exported for tests.
 */
export async function findGeneratedAssetIssue(
  workspaceRoot: string,
  generatedAssets: GeneratedAssetEntry[],
): Promise<string | undefined> {
  if (generatedAssets.length === 0) return undefined;

  let content = '';
  for (const file of GENERATED_ASSET_CONTENT_FILES) {
    try {
      content += await readFile(join(workspaceRoot, file), 'utf8');
    } catch {
      /* a template may keep only one of the two files */
    }
  }
  if (!content) return undefined;

  const unused = generatedAssets.filter(
    (asset) => !content.includes(asset.publicPath),
  );
  if (unused.length === 0) return undefined;

  const listed = unused
    .map(
      (asset) =>
        `${asset.publicPath} (${asset.role}, made for ${asset.slotId})`,
    )
    .join(', ');
  return (
    `brand-matched artwork was generated for this business and is not used: ${listed}. ` +
    "Set each slot's image path to the artwork generated for it, unless that " +
    "slot already shows the client's own photograph from /flowstarter-assets/. " +
    'Do not invent new slots and do not move any other image.'
  );
}

async function findHeroAssetIssue(
  workspaceRoot: string,
  cachedAssets: CachedAssetEntry[],
  build: AgentBuildResult,
): Promise<string | undefined> {
  const barred = cachedAssets.filter((asset) => !asset.heroEligible);
  const allowed = cachedAssets.filter((asset) => asset.heroEligible);
  if (barred.length === 0 && allowed.length === 0) return undefined;

  for (const path of build.changedPaths) {
    let content: string;
    try {
      content = await readFile(join(workspaceRoot, path), 'utf8');
    } catch {
      continue;
    }
    // The hero image key sits at the top of the template's content file; a
    // barred asset on that line is the failure this check exists to catch.
    const heroLine = content
      .split('\n')
      .find((line) =>
        /^\s{0,4}image:\s*["']?\/flowstarter-assets\//.test(line),
      );
    if (!heroLine) continue;
    const used = barred.find((asset) => heroLine.includes(asset.publicPath));
    if (!used) continue;
    return (
      `the hero image is ${used.publicPath}, which is not marked ` +
      '"heroEligible" and must not fill a hero slot. ' +
      (allowed.length > 0
        ? `Use ${allowed
            .map((asset) => asset.publicPath)
            .join(' or ')} instead.`
        : "Use the template's own art-directed asset, or leave the hero " +
          'image empty so the template renders its designed art panel.') +
      ` Keep ${used.publicPath} only in a secondary about, project, or mood slot.`
    );
  }

  // The client vouched for a photo and the hero still renders the template's
  // placeholder panel: their face is the strongest thing the page has.
  if (allowed.length > 0) {
    for (const path of build.changedPaths) {
      let content: string;
      try {
        content = await readFile(join(workspaceRoot, path), 'utf8');
      } catch {
        continue;
      }
      const heroLine = content
        .split('\n')
        .find((line) => /^\s{0,4}image:\s*["']/.test(line));
      if (!heroLine) continue;
      // The character after the opening quote must be real content, not the
      // closing quote: `image: ""` is an empty hero, not a filled one.
      const filled = /image:\s*(["'])\s*[^"'\s]/.test(heroLine);
      if (filled) return undefined;
      return (
        'the hero image is empty while the client supplied a hero-ready ' +
        `photo. Set the hero image to ${allowed
          .map((asset) => asset.publicPath)
          .join(' or ')} rather than leaving the template's placeholder panel.`
      );
    }
  }
  return undefined;
}

/**
 * Trusted post-session check that the client's own media made it into the
 * site. Returns bounded repair feedback, or undefined when at least one
 * cached asset is referenced (or there is none to place).
 */
async function findClientMediaIssue(
  workspaceRoot: string,
  cachedAssets: CachedAssetEntry[],
  build: AgentBuildResult,
): Promise<string | undefined> {
  if (cachedAssets.length === 0 || build.changedPaths.length === 0) {
    return undefined;
  }
  for (const path of build.changedPaths) {
    try {
      const content = await readFile(join(workspaceRoot, path), 'utf8');
      if (cachedAssets.some((asset) => content.includes(asset.publicPath))) {
        return undefined;
      }
    } catch {
      // A changed file may since be unreadable; keep scanning the rest.
    }
  }
  const available = cachedAssets
    .map((asset) => `${asset.publicPath} (source ${asset.sourceId})`)
    .join(', ');
  return (
    "none of the client's own photos appear anywhere in the site; per the " +
    "asset policy, use the client's photo for the primary portrait and " +
    'about-page slots (replacing demo-persona or abstract portrait art), and ' +
    `use further client media where the evidence matches. Available: ${available}`
  );
}

export interface FullSiteBuildJob {
  id: string;
  projectId: string;
  /**
   * Which of the three jobs this worker runs. FULL_SITE_BUILD is the paid
   * build: agents expand the approved preview and a human takes it from there.
   * SITE_REBUILD is the client's own published edit going live: the same
   * manifest column, no agents, no state move. CHANGE_REQUEST_BUILD is a paid
   * change request being done: one agent pass over the site the client already
   * has, seeded from the manifest their editor last wrote.
   */
  kind: 'FULL_SITE_BUILD' | 'SITE_REBUILD' | 'CHANGE_REQUEST_BUILD';
  projectState: ProjectState;
  intake: BusinessIntakePayload;
  brandConfig: BrandConfig;
  approvedPreviewFiles: TemplateScaffoldFile[];
  requiredIntegrations: string[];
  /**
   * Tenant Cal.com URL from `workspaces.cal_com_url`. Wired as a live embed
   * after the preview scaffold is materialized — preview files only carry a
   * blurred demo.
   */
  calComUrl?: string | null;
  /**
   * What the client approved in their preview before they paid, off the job
   * payload. Absent for an operator-created project, which has no preview.
   *
   * The worktree is already seeded from the approved manifest, so this is not
   * how the client's free changes arrive — it is how the build is held to
   * them: the agent is told to preserve each change verbatim, and the built
   * output is checked for the text each change introduced.
   */
  previewIntent?: PreviewIntent | null;
  /**
   * The paid change request this job exists to deliver, off the job payload.
   * Present only on CHANGE_REQUEST_BUILD, and the job fails without it rather
   * than running an agent against a site with no instruction.
   */
  changeRequest?: ChangeRequestIntent | null;
}

/** What the worker tells the operator board while a build is in flight. */
export type FullSiteBuildEventKind = 'phase' | 'log' | 'reply';

export interface FullSiteBuildEvent {
  kind: FullSiteBuildEventKind;
  body: string;
  payload?: Record<string, unknown>;
}

/** Something an operator said to the agents building a site. */
export interface OperatorNote {
  id: string;
  body: string;
  actor: string;
  createdAt: string;
}

export interface FullSiteBuildJobStore {
  claim(jobId: string): Promise<FullSiteBuildJob | null>;
  markAgentWorking(jobId: string, worktree: GitWorktree): Promise<void>;
  markHumanQa(
    jobId: string,
    result: { commitSha: string; pullRequestUrl: string; stagingUrl: string },
  ): Promise<void>;
  /**
   * A rebuild's worktree, recorded so an operator can find the tree that
   * produced a live site. Separate from `markAgentWorking` on purpose: that
   * one also moves the project into AGENTS_WORKING, and a client publishing a
   * word change must not drag a live project back into the build pipeline.
   */
  markRebuildStarted(jobId: string, worktree: GitWorktree): Promise<void>;
  /**
   * A rebuild that reached the host. Records the commit and the urls and
   * finishes the job; the project state is left exactly where it was.
   */
  markRebuilt(
    jobId: string,
    result: { commitSha: string; pullRequestUrl: string; stagingUrl: string },
  ): Promise<void>;
  /**
   * A change-request build's worktree. Like `markRebuildStarted` it moves no
   * project state: a client whose site is live and who has paid for one more
   * section has not gone back into the build pipeline.
   */
  markChangeRequestBuildStarted?(
    jobId: string,
    worktree: GitWorktree,
  ): Promise<void>;
  /**
   * The manifest the agents wrote, saved as the site's next version, before
   * anything is published. Returns the version number, which is what the
   * client is later told their change went live in.
   */
  saveChangeRequestVersion?(
    jobId: string,
    input: { changeRequestId: string; files: TemplateScaffoldFile[] },
  ): Promise<{ version: number }>;
  /**
   * The end of a change-request build: the version is marked published, the
   * job succeeds, and the request moves paid -> done with the version on it.
   *
   * Deliberately the last thing the job does. Everything before it is
   * repeatable, so a crash anywhere earlier leaves the request at `paid` and
   * an operator with a failed job to look at, which is the honest state. A
   * request must never read `done` for work that did not ship.
   */
  markChangeRequestBuilt?(
    jobId: string,
    result: {
      commitSha: string;
      pullRequestUrl: string;
      stagingUrl: string;
      changeRequestId: string;
      version: number;
    },
  ): Promise<void>;
  markFailed(
    jobId: string,
    error: { code: string; detail: string },
  ): Promise<void>;
  /**
   * Progress and agent replies for the operator watching the build. Optional
   * so a store without a conversation channel still builds, silently.
   */
  appendEvent?(jobId: string, event: FullSiteBuildEvent): Promise<void>;
  /**
   * Notes operators posted to this build after `after` (an ISO timestamp, or
   * null for all of them), oldest first. The worker reads them at pass
   * boundaries: a note cannot interrupt a running Pi session, so it lands in
   * the next pass instead.
   */
  readOperatorNotes?(
    jobId: string,
    after: string | null,
  ): Promise<OperatorNote[]>;
}

/** Longest a single event body may be; the table enforces the same cap. */
const BUILD_EVENT_BODY_MAX = 4_000;

/** How much of the agent's closing words the board shows. */
const REPLY_EXCERPT_MAX = 1_500;

/**
 * Does a "Summary" heading begin at `from`? Returns the index just past the
 * word, or -1.
 *
 * `from` is either 0 or the index of a newline. Past it come blanks, then an
 * optional run of `#` and more blanks, then the word on a word boundary. The
 * greedy runs never need to be walked back: nothing that may follow them
 * starts with a blank or a `#`.
 */
function summaryHeadingEnd(text: string, from: number): number {
  let cursor = from === 0 ? 0 : from + 1;
  while (cursor < text.length && WHITESPACE.has(text[cursor]!)) cursor += 1;
  if (text[cursor] === '#') {
    while (text[cursor] === '#') cursor += 1;
    while (cursor < text.length && WHITESPACE.has(text[cursor]!)) cursor += 1;
  }
  const word = text.slice(cursor, cursor + 7);
  if (word.toLowerCase() !== 'summary') return -1;
  return isWordCharacter(text[cursor + 7]) ? -1 : cursor + 7;
}

/**
 * Where the last "Summary" heading in a transcript starts, or -1.
 *
 * This was a single pattern carrying a negative lookahead over `[\s\S]*` to
 * mean "and no later one", which made it quadratic in the length of the
 * transcript it reads. Scanning line starts costs one pass instead.
 *
 * The index returned is the pattern's: a heading reached across blank lines
 * is reported from the first newline that reaches it, not from the word.
 */
function lastSummaryHeadingIndex(text: string): number {
  // Every place the old pattern could begin: the start of the text, then
  // each newline. `starts` keeps the ones that carry a heading, with the end
  // of the heading's line, which is where its lookahead began.
  const starts: Array<{ at: number; lineEnd: number }> = [];
  for (let from = 0; from !== -1; from = text.indexOf('\n', from + 1)) {
    const end = summaryHeadingEnd(text, from);
    if (end === -1) continue;
    const newline = text.indexOf('\n', end);
    starts.push({ at: from, lineEnd: newline === -1 ? text.length : newline });
  }
  if (starts.length === 0) return -1;

  // The lookahead held only where no heading began at or after the line's
  // end. Several starts can reach one heading (blank lines between them), so
  // this reports the earliest start of the last heading, as the pattern did.
  const latest = starts[starts.length - 1]!.at;
  for (const start of starts) {
    if (start.lineEnd > latest) return start.at;
  }
  return -1;
}

/**
 * The agent's reply for the board, from a session transcript that is every
 * text delta of every turn run together ("Let me look at... Let me check...").
 * The closing summary is what the operator wants, so this takes the tail:
 * from the last "Summary" heading when the agent wrote one, otherwise the
 * last stretch of text, cut at a sentence boundary.
 */
export function replyExcerpt(summary: string): string {
  // Trailing blanks off each line and blank lines dropped, by hand. The
  // `/\s+\n/g` this replaces let `\s+` overlap the `\n` after it, so a
  // transcript with a long whitespace run cost time quadratic in its length,
  // and a transcript is exactly what this is handed.
  const lines = summary.split('\n');
  const text = lines
    .filter(
      (line, index) =>
        index === 0 || index === lines.length - 1 || line.trim() !== '',
    )
    .map((line, index, kept) =>
      index === kept.length - 1 ? line : line.trimEnd(),
    )
    .join('\n')
    .trim();
  if (!text) return 'Pass finished without a summary.';
  const heading = lastSummaryHeadingIndex(text);
  let tail = heading >= 0 ? text.slice(heading).trim() : text;
  if (tail.length > REPLY_EXCERPT_MAX) {
    tail = tail.slice(-REPLY_EXCERPT_MAX);
    const boundary = tail.search(/[.!?]\s+[A-Z#*-]/);
    if (boundary > 0 && boundary < REPLY_EXCERPT_MAX / 2) {
      tail = tail.slice(boundary + 1).trim();
    }
  }
  return tail;
}

// ─── The client's approved free changes ────────────────────────────────────
//
// A visitor gets two free changes to their preview before the deposit is
// offered, and those changes are the last thing they see before they pay. The
// build seeds its worktree from the approved manifest, so the changes are
// already in the files the agent starts from; what follows exists because the
// agent then *expands* that site, and an expansion that rewrites a hero
// section can silently undo the one line the client asked for. Naming the
// changes in the prompt is the instruction; checking the built output for the
// text they introduced is the guarantee.

/** How many approved edits are ever folded into one prompt. */
export const APPROVED_EDITS_PER_PROMPT = 8;
/** Per-file read cap for the dropped-edit check; content files are far smaller. */
const APPROVED_CHECK_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** Total text the dropped-edit check will read out of a built site. */
const APPROVED_CHECK_TOTAL_MAX_BYTES = 48 * 1024 * 1024;

/** Directories that hold no authored site text and cost a lot to walk. */
const APPROVED_CHECK_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.astro',
  '.cache',
  '.vercel',
  '.netlify',
]);

/** Extensions whose bytes are not text and can never match a phrase. */
const APPROVED_CHECK_BINARY = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.bmp',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.pdf',
  '.mp4',
  '.webm',
  '.mp3',
  '.zip',
  '.gz',
  '.map',
]);

/**
 * The comparison form for every phrase check: whitespace collapsed and case
 * folded.
 *
 * Deliberately forgiving. A build that re-wraps a sentence across two lines,
 * re-indents it into a component, or title-cases a heading has kept the
 * client's change; failing a paid build over a line break would be the check
 * doing more harm than the bug it exists to catch. What it will not forgive is
 * the words being gone.
 */
export function normalizeApprovedPhrase(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The client's approved changes as the trusted feedback paragraph the build
 * agent receives, alongside any operator notes.
 *
 * The client's own sentence is quoted verbatim — it is the thing they were
 * promised — and the exact strings the preview's edit runner produced are
 * listed under it, because "preserve this" is only enforceable against text.
 */
export function approvedPreviewFeedback(
  edits: readonly ApprovedPreviewEdit[],
): string {
  const listed = edits.slice(0, APPROVED_EDITS_PER_PROMPT);
  if (listed.length === 0) return '';
  const lines = listed.map((edit, index) => {
    const asked = `${index + 1}. The client asked: "${edit.instruction
      .replace(/\s+/g, ' ')
      .trim()}"`;
    if (edit.addedPhrases.length === 0) return asked;
    const phrases = edit.addedPhrases
      .map((phrase) => `     - ${phrase.replace(/\s+/g, ' ').trim()}`)
      .join('\n');
    return `${asked}\n   The preview now contains this exact text, which must survive:\n${phrases}`;
  });
  return (
    'APPROVED PREVIEW CHANGES, trusted. The client made these changes to the ' +
    'preview and approved the result before paying; the files in this ' +
    'worktree already contain them:\n' +
    lines.join('\n') +
    '\nPreserve every quoted string above exactly as it is. You may move it ' +
    'into a different component or page, but you may not reword, shorten or ' +
    'drop it, and you may not replace it with generated copy.'
  );
}

/**
 * The line the operator's build conversation gets, so the changes the client
 * paid to keep are visible in the same place the build is watched.
 */
export function carriedApprovedEditsSummary(intent: PreviewIntent): string {
  if (intent.edits.length === 0) {
    return (
      `Building from approved preview ${intent.manifest.ref}. The client made ` +
      'no free changes to it.'
    );
  }
  const lines = intent.edits
    .slice(0, APPROVED_EDITS_PER_PROMPT)
    .map(
      (edit) =>
        `${edit.index}. "${edit.instruction.replace(/\s+/g, ' ').trim()}"` +
        (edit.changedPaths.length > 0
          ? ` (changed ${edit.changedPaths.join(', ')})`
          : ''),
    );
  return (
    `Building from approved preview ${intent.manifest.ref}, carrying ` +
    `${intent.edits.length} free change${
      intent.edits.length === 1 ? '' : 's'
    } the client made and approved:\n${lines.join('\n')}`
  );
}

/** How many phrases a re-derivation will read out of the approved preview. */
export const APPROVED_EDITS_PHRASE_LIMIT = 8;

/**
 * An approved edit with the evidence a build can actually be held to.
 *
 * `source` says where the phrases came from, and it is on the type because the
 * operator's board is told: a build whose evidence was re-derived is a build
 * seeded from a preview claimed before the phrase rules were fixed, and that
 * is worth a line in the conversation rather than a silent substitution.
 */
export interface ResolvedApprovedEdit {
  edit: ApprovedPreviewEdit;
  source: 'stored' | 'rederived' | 'none';
  note?: string;
}

/**
 * The evidence for one approved edit, in three falling steps.
 *
 * 1. The phrases the preview's edit runner stored, minus anything that is not
 *    prose. On a preview captured today that is all of them.
 * 2. Failing that, the prose in the files the edit is recorded as having
 *    changed, read out of the approved manifest the build was seeded from,
 *    content files first. Workspace `c009105e` was claimed on 2026-09-11 with
 *    eight lines of Astro dev-server state as its evidence; this is what lets
 *    it build without anybody hand-editing the row it stored.
 * 3. Failing that, nothing. An edit with nothing checkable behind it is not a
 *    reason to fail a build somebody paid for. It is a reason to say so.
 */
export function resolveApprovedEdit(
  approvedFiles: readonly TemplateScaffoldFile[],
  edit: ApprovedPreviewEdit,
): ResolvedApprovedEdit {
  const stored = usablePhrases(edit.addedPhrases);
  if (stored.length > 0) {
    return { edit: { ...edit, addedPhrases: stored }, source: 'stored' };
  }
  const paths = edit.changedPaths.filter((path) => isClientEditablePath(path));
  const rederived =
    paths.length > 0
      ? phrasesFromFiles(approvedFiles, {
          paths,
          limit: APPROVED_EDITS_PHRASE_LIMIT,
          instruction: edit.instruction,
        })
      : [];
  if (rederived.length > 0) {
    return {
      edit: { ...edit, addedPhrases: rederived },
      source: 'rederived',
      note:
        `Change #${edit.index} stored no text this build can be checked ` +
        `against, so ${rederived.length} phrase` +
        `${rederived.length === 1 ? ' was' : 's were'} re-read from the ` +
        `approved preview (${paths.join(', ')}). The check stands.`,
    };
  }
  return {
    edit: { ...edit, addedPhrases: [] },
    source: 'none',
    note:
      `Change #${edit.index} has no text this build can be checked against, ` +
      "so the approved-change check passes it. The client's instruction is " +
      'still in the brief the agents were given.',
  };
}

/** Every carried edit, resolved. Order is the order the client made them. */
export function resolveApprovedEdits(
  approvedFiles: readonly TemplateScaffoldFile[],
  edits: readonly ApprovedPreviewEdit[],
): ResolvedApprovedEdit[] {
  return edits.map((edit) => resolveApprovedEdit(approvedFiles, edit));
}

/** One approved change the built site no longer contains. */
export interface DroppedApprovedEdit {
  index: number;
  instruction: string;
  missingPhrases: string[];
}

/**
 * Approved changes whose text is not in the built site.
 *
 * Pure, and deliberately an AND over phrases rather than an OR: an edit is
 * dropped only when *every* phrase it introduced is gone. One phrase of a
 * multi-line change being reworded is normal editorial work by the expanding
 * agent; all of them disappearing is the change having been regenerated away,
 * which is the failure this exists to catch. `missingPhrases` still lists them
 * all, so the repair brief and the operator's error both name the specific
 * words that went missing.
 *
 * An edit with no usable phrases is never reported: there is nothing to check
 * it against, and a check that cannot be evaluated must not fail a build
 * somebody paid for. "Usable" is the same rule the preview derives phrases
 * under, applied again here, because a preview claimed before that rule
 * existed can still put a dev server's process id on a job payload and no
 * site will ever contain one.
 */
export function findDroppedApprovedEdits(
  files: ReadonlyArray<{ path: string; content: string }>,
  edits: readonly ApprovedPreviewEdit[],
): DroppedApprovedEdit[] {
  const haystack = files
    .map((file) => normalizeApprovedPhrase(file.content))
    .join('\n');
  const dropped: DroppedApprovedEdit[] = [];
  for (const edit of edits) {
    const checkable = usablePhrases(edit.addedPhrases);
    if (checkable.length === 0) continue;
    const missing = checkable.filter((phrase) => {
      const needle = normalizeApprovedPhrase(phrase);
      return needle.length > 0 && !haystack.includes(needle);
    });
    if (missing.length > 0 && missing.length === checkable.length) {
      dropped.push({
        index: edit.index,
        instruction: edit.instruction,
        missingPhrases: missing,
      });
    }
  }
  return dropped;
}

/** The repair brief for a build that dropped the client's approved change. */
export function droppedApprovedEditsFeedback(
  dropped: readonly DroppedApprovedEdit[],
): string {
  const lines = dropped.map(
    (entry) =>
      `${entry.index}. The client asked: "${entry.instruction
        .replace(/\s+/g, ' ')
        .trim()}" — this text is no longer anywhere in the site and must be ` +
      `put back verbatim:\n${entry.missingPhrases
        .map((phrase) => `     - ${phrase.replace(/\s+/g, ' ').trim()}`)
        .join('\n')}`,
  );
  return (
    'DROPPED CLIENT CHANGES, trusted. Your expansion removed text the client ' +
    'approved and paid to keep:\n' +
    lines.join('\n') +
    '\nRestore each string exactly, in the place on the site where it belongs, ' +
    'and change nothing else.'
  );
}

/** The error a build fails with when it could not keep an approved change. */
export const APPROVED_EDIT_DROPPED = 'APPROVED_EDIT_DROPPED';

/**
 * A failure that names its own operator-facing error code.
 *
 * Everything the build throws lands on the ledger as FULL_SITE_BUILD_FAILED,
 * which tells an operator only that something went wrong. A dropped client
 * change is a specific, actionable failure with a specific remedy, so it gets
 * its own code rather than being buried in a detail string.
 */
export class FullSiteBuildFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FullSiteBuildFailure';
  }
}

/**
 * Every text file under a directory, bounded.
 *
 * Bounded on both file and total size: this runs after a successful build, and
 * an unbounded read of a generated tree is how a check becomes the reason a
 * build fails.
 */
export async function collectSiteTextFiles(
  siteRoot: string,
): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (total > APPROVED_CHECK_TOTAL_MAX_BYTES) return;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (APPROVED_CHECK_SKIP_DIRS.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf('.');
      if (
        dot >= 0 &&
        APPROVED_CHECK_BINARY.has(entry.name.slice(dot).toLowerCase())
      )
        continue;
      try {
        const content = await readFile(absolute, 'utf8');
        if (content.length > APPROVED_CHECK_FILE_MAX_BYTES) continue;
        total += content.length;
        files.push({
          path: relative(siteRoot, absolute).split(sep).join('/'),
          content,
        });
      } catch {
        // An unreadable file cannot hold the client's words either way.
      }
    }
  };
  await walk(siteRoot);
  return files;
}

/**
 * What the build produced, for the dropped-edit check.
 *
 * The compiled output is the only honest place to ask whether the client's
 * words reached their site. Checking the worktree instead would pass every
 * time: the tree is *seeded* from the approved manifest, so the content file
 * carrying the client's headline is sitting there untouched even when the
 * agent has rewritten the page that used to read it. `dist/` is what a visitor
 * would be served, and `CommandSiteValidator` refuses a build that did not
 * produce one, so by the time this runs on a real job the directory is there.
 *
 * The fallback to the whole tree exists for the local stub-agent mode, which
 * compiles nothing. It is a weaker check — it catches a change that was
 * deleted outright, not one that was orphaned — and it is deliberately never
 * the path a paying build takes.
 */
export async function collectBuiltSiteText(
  siteRoot: string,
  outputDir = 'dist',
): Promise<Array<{ path: string; content: string }>> {
  const built = await collectSiteTextFiles(join(siteRoot, outputDir));
  if (built.length > 0) {
    return built.map((file) => ({
      path: `${outputDir}/${file.path}`,
      content: file.content,
    }));
  }
  return collectSiteTextFiles(siteRoot);
}

/** The most notes folded into one pass; a longer backlog waits for the next. */
export const OPERATOR_NOTES_PER_PASS = 8;

/**
 * Operator notes as the feedback paragraph the build agent receives. The
 * agent already knows FEEDBACK is trusted orchestrator input; this names the
 * source and asks for an accounting per note, so the reply on the board says
 * what happened to each.
 */
export function operatorNotesFeedback(notes: OperatorNote[]): string {
  const lines = notes
    .slice(0, OPERATOR_NOTES_PER_PASS)
    .map(
      (note, index) =>
        `${index + 1}. ${note.body.replace(/\s+/g, ' ').trim().slice(0, 1_500)}`,
    );
  return (
    'OPERATOR NOTES from the Flowstarter team, trusted, to apply in this pass ' +
    'to the files already in the worktree:\n' +
    lines.join('\n') +
    '\nApply each note, keep everything else as it is, and state in your ' +
    'summary what you changed for each numbered note.'
  );
}

/**
 * What turns a validated build into something a human can review.
 *
 * Two implementations exist. The GitHub one opens the internal draft PR that
 * gates HUMAN_QA. The local one packages the build output and deploys it, and
 * needs `siteRoot` (the directory that was actually built, not the worktree
 * root) and `calComUrl` (so a built tree whose source injection did not take
 * still gets the tenant's live embed rather than the blurred preview demo).
 * Both fields are optional so the GitHub publisher can ignore them.
 */
export interface PullRequestPublisher {
  create(input: {
    projectId: string;
    branch: string;
    worktreePath: string;
    commitSha: string;
    siteRoot?: string;
    calComUrl?: string | null;
    /**
     * Set when this publish is a paid change request going live, so the deploy
     * that puts it on the host can tell the client which request it was. It
     * rides here rather than on a second callback because the deploy is the
     * moment the sentence "your change is live" becomes true.
     */
    changeRequestId?: string | null;
    /** The `site_versions.version` being published, when there is one. */
    siteVersion?: number | null;
  }): Promise<{ pullRequestUrl: string; stagingUrl: string }>;
}

export interface FullSiteBuildWorkerOptions {
  /**
   * Called once, right after the job is claimed, with the writer that carries
   * this build's running log. The process hosting the worker registers it so
   * its own machine output — validator commands, publisher steps, queue
   * lifecycle — lands in the same conversation as the agents' work. The
   * writer stays usable after `run()` returns, so the host can log the
   * outcome; the host owns unregistering it.
   */
  onJobLog?: (jobId: string, log: JobLogWriter) => void;
}

/**
 * The agent's trace as a log line: tool calls carry the machine's vocabulary,
 * everything else the model's. Deterministic, so the log reads the same way
 * for every build.
 */
function traceLogLine(entry: AgentTraceEntry): {
  source: 'agent' | 'tool';
  text: string;
} {
  if (entry.kind === 'tool_call' || entry.kind === 'tool_result') {
    return { source: 'tool', text: entry.text };
  }
  return {
    source: 'agent',
    text: entry.kind === 'thinking' ? `(thinking) ${entry.text}` : entry.text,
  };
}

/** Long-running worker entrypoint invoked by the durable job dispatcher. */
export class FullSiteBuildWorker {
  constructor(
    private readonly store: FullSiteBuildJobStore,
    private readonly worktrees: SafeGitWorktreeManager,
    private readonly agents: PiSdkFlowstarterAgents,
    private readonly validator: SiteValidator,
    private readonly pullRequests: PullRequestPublisher,
    private readonly options: FullSiteBuildWorkerOptions = {},
  ) {}

  async run(jobId: string): Promise<void> {
    const job = await this.store.claim(jobId);
    if (!job) return;

    // The conversation channel never fails the build: a board that misses a
    // line is a nuisance, a site that is not built is a refund.
    const say = async (
      kind: FullSiteBuildEventKind,
      body: string,
      payload?: Record<string, unknown>,
    ) => {
      if (!this.store.appendEvent) return;
      try {
        await this.store.appendEvent(jobId, {
          kind,
          body: body.slice(0, BUILD_EVENT_BODY_MAX),
          ...(payload ? { payload } : {}),
        });
      } catch (error) {
        console.warn(
          `[full-site-build] could not record ${kind} for ${jobId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    };
    // The running log: the agents' narration, their tool calls, and whatever
    // the host process writes into it. Batched, so thousands of lines are
    // tens of rows; separate from `say` so the chat feed stays readable.
    const appendEvent = this.store.appendEvent?.bind(this.store);
    const log = appendEvent
      ? new JobLogSink({
          append: (event) => appendEvent(jobId, event),
          label: jobId,
        })
      : null;
    if (log) this.options.onJobLog?.(jobId, log);
    // A phase heading is a boundary: everything logged under the previous one
    // is written first, so the conversation reads in the order it happened.
    const phase = async (body: string) => {
      await log?.flush();
      await say('phase', body);
    };

    // A rebuild deliberately carries no `previewIntent` and runs no
    // dropped-edit check. It seeds from the same manifest column, but that
    // manifest is the one the client's own editor just wrote, and no agent
    // pass runs between seeding it and publishing it — there is nothing that
    // could drop a change, and a check would only be able to fail a publish
    // over text the client themselves removed. The continuity guarantee for
    // that path is the absence of an agent, not an assertion about one.
    if (job.kind === 'SITE_REBUILD') {
      await this.rebuild(job, say, log);
      return;
    }
    // A paid change request is the one path where agents touch a site that is
    // already the client's. It is not a rebuild (an agent does run) and it is
    // not a full build (the site exists, the deposit is long since paid and
    // the project is past DEPOSIT_PAID), so it gets its own leg rather than a
    // flag on one of theirs.
    if (job.kind === 'CHANGE_REQUEST_BUILD') {
      await this.changeRequestBuild(job, say, log);
      return;
    }
    if (job.projectState !== ProjectState.DEPOSIT_PAID) {
      await this.store.markFailed(jobId, {
        code: 'INVALID_PROJECT_STATE',
        detail: `Full build requires DEPOSIT_PAID, received ${job.projectState}`,
      });
      return;
    }

    // Notes are consumed in order, each at most once: the cursor is the
    // newest note the previous read returned.
    let notesAfter: string | null = null;
    const pendingNotes = async (): Promise<OperatorNote[]> => {
      if (!this.store.readOperatorNotes) return [];
      try {
        const notes = (await this.store.readOperatorNotes(jobId, notesAfter))
          .filter((note) => note.body.trim().length > 0)
          .slice(0, OPERATOR_NOTES_PER_PASS);
        const last = notes[notes.length - 1];
        if (last) notesAfter = last.createdAt;
        return notes;
      } catch (error) {
        console.warn(
          `[full-site-build] could not read operator notes for ${jobId}:`,
          error instanceof Error ? error.message : error,
        );
        return [];
      }
    };

    try {
      await phase('Preparing a clean worktree');
      // A retry starts from the approved preview, not from a previous
      // attempt's half-built tree.
      await this.worktrees.discard?.(job.projectId);
      const worktree = await this.worktrees.create(job.projectId);
      const siteRoot = join(worktree.path, 'generated-sites', job.projectId);
      await mkdir(siteRoot, { recursive: true, mode: 0o700 });
      await phase('Materializing the approved preview');
      // The same rule the preview was scaffolded under, re-applied here. The
      // preview is normally already pruned; this covers a preview taken
      // before the rule existed, and a workspace whose booking link changed
      // between the preview and the deposit.
      const pageSet = derivePageSet({
        pageCount: job.intake.business.pageCount ?? null,
        businessType: `${job.intake.business.niche} ${job.intake.business.description ?? ''}`,
        hasBookingLink: Boolean(job.calComUrl),
        projectCount: job.intake.projects?.length ?? null,
      });
      // The approved preview is the preview *after* the teaser was injected.
      // A paid build seeded from it inherits the blur and the "Unlock the
      // full site" chip, which is what shipped. The teaser belongs to the
      // funnel and is taken back out here, before the agent ever sees it.
      const seed = stripPreviewTeaserFromFiles(job.approvedPreviewFiles);
      if (seed.removedPaths.length > 0 || seed.cleanedPaths.length > 0) {
        await say(
          'log',
          'Removing the funnel preview teaser from the approved preview: ' +
            `${[...seed.removedPaths, ...seed.cleanedPaths].join(', ')}. ` +
            'This build is paid for, so nothing on it is blurred or locked.',
        );
      }
      const approvedFiles = applyPageSetToScaffold(seed.files, pageSet);
      if (approvedFiles.removedPaths.length > 0) {
        await say(
          'log',
          `The brief buys ${pageSet.allowed.join(', ')}; dropping ` +
            `${approvedFiles.removedPaths.join(', ')} before the agents start.`,
        );
      }
      await materializeScaffold(siteRoot, approvedFiles.files);
      // The client's free changes are in those files already. Say so on the
      // board: the operator watching this build should be able to read what
      // was promised without opening the preview, and a build that later drops
      // one of them fails against a line that is already in the conversation.
      const carriedEdits = job.previewIntent?.edits ?? [];
      if (job.previewIntent) {
        await say('log', carriedApprovedEditsSummary(job.previewIntent), {
          previewId: job.previewIntent.previewId,
          manifestRef: job.previewIntent.manifest.ref,
          carriedEdits: carriedEdits.length,
          instructions: carriedEdits.map((edit) => edit.instruction),
        });
      }
      // What the client approved, and the text this build can honestly be
      // held to. The two are not the same thing for any preview claimed
      // before the phrase rules were fixed, and the difference is said out
      // loud on the board rather than swallowed.
      const resolved = resolveApprovedEdits(approvedFiles.files, carriedEdits);
      for (const entry of resolved) {
        if (!entry.note) continue;
        await say('log', entry.note, {
          editIndex: entry.edit.index,
          phraseSource: entry.source,
        });
      }
      const approvedEdits = resolved.map((entry) => entry.edit);
      // Preview artifacts carry a blurred Cal demo only. Reconcile it here,
      // before the agent expands the site, unconditionally: a validated link
      // wires the live tenant embed, so the full build has a real calendar
      // and the agent does not invent one; no link removes the seeded demo
      // outright, the same way the teaser strip above removes its own
      // funnel-only artefact. Gating this behind `if (job.calComUrl)` is
      // exactly how the blurred demo shipped on a paid contact page once —
      // the workspace had no link, so nothing ever ran to take it back out.
      await applyIntegrationsToWorkspace(siteRoot, {
        booking: { provider: 'cal.com', url: job.calComUrl ?? null },
      });
      await this.store.markAgentWorking(jobId, worktree);
      // Every pass is given the approved changes, not only the first: the
      // repair and late-note passes rewrite files too, and "preserve this" has
      // to hold for those as much as for the expansion.
      const approvedFeedback = approvedPreviewFeedback(approvedEdits);
      const withApproved = (feedback?: string): string | undefined => {
        if (!approvedFeedback) return feedback;
        return feedback
          ? `${approvedFeedback}\n\n${feedback}`
          : approvedFeedback;
      };
      const onTrace = log
        ? (entry: AgentTraceEntry) => log.write(traceLogLine(entry))
        : undefined;
      const expand = (feedback?: string) =>
        this.agents.buildFullSite({
          workspaceRoot: siteRoot,
          projectId: job.projectId,
          intake: job.intake,
          brandConfig: job.brandConfig,
          requiredIntegrations: job.requiredIntegrations,
          pageSet: describePageSet(pageSet),
          ...(feedback ? { feedback } : {}),
          ...(onTrace ? { onTrace } : {}),
        });
      // One agent pass, reported: the phase it is, then what the agent said
      // when it finished. The summary is the agent's own words; the board
      // shows it as the agents' reply.
      const pass = async (label: string, feedback?: string) => {
        await phase(label);
        const build = await expand(feedback);
        // The pass's own log lands before its closing words.
        await log?.flush();
        await say('reply', replyExcerpt(build.summary), {
          changedPaths: build.changedPaths.length,
        });
        return build;
      };
      // The build is the gate, and its output is the best repair brief there
      // is: the file and line of a broken component. One bounded pass with
      // it, the way the preview pipeline repairs its own validation failures,
      // before a whole attempt is spent starting over from the preview.
      const check = async () => {
        await phase('Checking the build');
        try {
          await this.validator.validate(siteRoot, 'full');
        } catch (error) {
          const detail =
            error instanceof Error ? error.message.slice(0, 2_500) : 'unknown';
          await say('log', `The trusted build failed:\n${detail}`);
          await pass(
            'Repairing the build',
            withApproved(
              `The trusted build of your previous pass failed. Repair the files so it passes; the output was: ${detail}`,
            ),
          );
          await phase('Checking the repaired build');
          await this.validator.validate(siteRoot, 'full');
        }
      };

      const notes = await pendingNotes();
      const build = await pass(
        notes.length > 0
          ? `Agents expanding the site, with ${notes.length} note${
              notes.length === 1 ? '' : 's'
            } from the team`
          : 'Agents expanding the site',
        withApproved(
          notes.length > 0 ? operatorNotesFeedback(notes) : undefined,
        ),
      );
      if (build.changedPaths.length === 0) {
        throw new Error('Full-site agent finished without modifying any file');
      }
      await check();
      // Anything the team said while the agents were busy lands now, in one
      // dedicated pass that is checked like any other.
      const late = await pendingNotes();
      if (late.length > 0) {
        await pass(
          `Applying ${late.length} note${late.length === 1 ? '' : 's'} from the team`,
          withApproved(operatorNotesFeedback(late)),
        );
        await check();
      }
      // The last gate, and the only one that speaks for the client rather
      // than for the compiler: the site builds, but does it still say what
      // they were shown before they paid? One bounded repair pass, then the
      // job fails rather than handing QA a site that quietly lost a change.
      if (approvedEdits.some((edit) => edit.addedPhrases.length > 0)) {
        await phase("Checking the client's approved changes survived");
        let dropped = findDroppedApprovedEdits(
          await collectBuiltSiteText(siteRoot),
          approvedEdits,
        );
        if (dropped.length > 0) {
          await say(
            'log',
            `The build dropped ${dropped.length} change the client approved; ` +
              'asking the agents to restore it.',
            { dropped: dropped.map((entry) => entry.index) },
          );
          await pass(
            "Restoring the client's approved changes",
            withApproved(droppedApprovedEditsFeedback(dropped)),
          );
          await check();
          dropped = findDroppedApprovedEdits(
            await collectBuiltSiteText(siteRoot),
            approvedEdits,
          );
        }
        if (dropped.length > 0) {
          throw new FullSiteBuildFailure(
            APPROVED_EDIT_DROPPED,
            `The built site is missing ${dropped.length} change the client ` +
              'approved in their preview: ' +
              dropped
                .map(
                  (entry) =>
                    `#${entry.index} "${entry.instruction}" (missing: ${entry.missingPhrases.join(' | ')})`,
                )
                .join('; '),
          );
        }
      }

      // Two gates on what the build actually emitted, in the order a client
      // would notice them. Both get one repair pass and then fail the job:
      // the alternative is handing QA a site that is bigger than the brief or
      // that promises a calendar nobody owns, which is what shipped before.
      await phase('Checking the site matches the brief');
      const builtPaths = async () =>
        (await collectBuiltSiteText(siteRoot)).map((file) =>
          file.path.replace(/^dist\//, ''),
        );
      let pageIssue = findPageBudgetIssue(await builtPaths(), pageSet);
      if (pageIssue) {
        await say('log', pageIssue);
        await pass(
          'Cutting the site back to the brief',
          withApproved(pageIssue),
        );
        await check();
        pageIssue = findPageBudgetIssue(await builtPaths(), pageSet);
      }
      if (pageIssue) {
        throw new FullSiteBuildFailure(PAGE_BUDGET_EXCEEDED, pageIssue);
      }

      await phase('Checking for placeholder copy');
      const placeholderOptions = { hasBookingLink: Boolean(job.calComUrl) };
      let placeholderIssue = findPlaceholderCopyIssue(
        await collectBuiltSiteText(siteRoot),
        placeholderOptions,
      );
      if (placeholderIssue) {
        await say('log', placeholderIssue);
        await pass('Removing placeholder copy', withApproved(placeholderIssue));
        await check();
        placeholderIssue = findPlaceholderCopyIssue(
          await collectBuiltSiteText(siteRoot),
          placeholderOptions,
        );
      }
      if (placeholderIssue) {
        throw new FullSiteBuildFailure(
          PLACEHOLDER_COPY_SHIPPED,
          placeholderIssue,
        );
      }

      // The last output gate, and the one that protects the client's name
      // rather than the site's shape: every project the work section presents
      // has to be one the client actually told us about.
      const briefProjectNames = (job.intake.projects ?? []).map(
        (project) => project.name,
      );
      if (briefProjectNames.length > 0) {
        await phase('Checking the work section against the brief');
        let inventedIssue = findInventedProjectIssue(
          await collectBuiltSiteText(siteRoot),
          briefProjectNames,
        );
        if (inventedIssue) {
          await say('log', inventedIssue);
          await pass('Removing invented projects', withApproved(inventedIssue));
          await check();
          inventedIssue = findInventedProjectIssue(
            await collectBuiltSiteText(siteRoot),
            briefProjectNames,
          );
        }
        if (inventedIssue) {
          throw new FullSiteBuildFailure(INVENTED_PROJECT, inventedIssue);
        }
      }

      await phase('Committing the site');
      const commitSha = await this.worktrees.commit(
        worktree,
        `build: initialize Flowstarter site ${job.projectId.toLowerCase()}`,
      );
      await phase('Publishing for review');
      const published = await this.pullRequests.create({
        projectId: job.projectId,
        branch: worktree.branch,
        worktreePath: worktree.path,
        commitSha,
        siteRoot,
        calComUrl: job.calComUrl ?? null,
      });
      await this.store.markHumanQa(jobId, { commitSha, ...published });
      await phase('Handed to human QA');
    } catch (error) {
      await say(
        'log',
        `Build failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      await this.store.markFailed(jobId, {
        code:
          error instanceof FullSiteBuildFailure
            ? error.code
            : 'FULL_SITE_BUILD_FAILED',
        detail:
          error instanceof Error
            ? error.message.slice(0, 2_000)
            : 'Unknown build failure',
      });
      throw error;
    } finally {
      // Whatever the outcome, the last lines of work are on the record.
      await log?.flush();
    }
  }

  /**
   * A paid change request, done.
   *
   * This is the leg that did not exist, and its absence is why a client could
   * file a request the editor correctly refused, be quoted, accept, pay, and
   * then watch an operator press a button that moved a status and shipped
   * nothing. It is deliberately the narrowest agent pass in this file: the
   * site already exists, every page of it has been reviewed and paid for, and
   * the only thing being bought is the one change. So the seed is the manifest
   * the client's own editor last wrote, the prompt states the request in their
   * words, the client's own rights-confirmed pictures are already on disk with
   * the paths the prompt names, and the gates afterwards are the full build's
   * gates re-pointed at "did this do what was paid for and nothing else".
   *
   * Order matters at the end. The version is saved before the publish so the
   * number exists to tell the client, and the request is moved paid -> done
   * only after the deploy has succeeded. Anything that throws before that last
   * step leaves the request at `paid` and the job `failed`, which is the true
   * state; a request that reads `done` always means work that shipped.
   */
  private async changeRequestBuild(
    job: FullSiteBuildJob,
    say: (
      kind: FullSiteBuildEventKind,
      body: string,
      payload?: Record<string, unknown>,
    ) => Promise<void>,
    log: JobLogWriter | null,
  ): Promise<void> {
    const jobId = job.id;
    const phase = async (body: string) => {
      await log?.flush();
      await say('phase', body);
    };

    // The same two states a rebuild is valid from, for the same reason: this
    // edits a site the client already has, and before the deposit build has
    // produced one there is nothing to change.
    if (
      job.projectState !== ProjectState.HUMAN_QA &&
      job.projectState !== ProjectState.LIVE_SUBSCRIPTION
    ) {
      await this.store.markFailed(jobId, {
        code: 'INVALID_PROJECT_STATE',
        detail:
          'A change request build requires HUMAN_QA or LIVE_SUBSCRIPTION, ' +
          `received ${job.projectState}`,
      });
      return;
    }
    const intent = job.changeRequest;
    if (!intent) {
      // Running an agent over a paid client's live site with no instruction is
      // strictly worse than not running one, so this fails rather than guesses.
      await this.store.markFailed(jobId, {
        code: 'CHANGE_REQUEST_MISSING',
        detail:
          'The job payload carries no readable change request, so there is ' +
          'nothing to build. The request has been left at paid.',
      });
      return;
    }

    try {
      await phase('Preparing a clean worktree');
      await this.worktrees.discard?.(job.projectId);
      const worktree = await this.worktrees.create(job.projectId);
      const siteRoot = join(worktree.path, 'generated-sites', job.projectId);
      await mkdir(siteRoot, { recursive: true, mode: 0o700 });

      await phase('Materializing the site the client has');
      // The seed is the client's current published manifest, plus their own
      // pictures, which `claim()` has already folded in as real files. The
      // teaser has no business in it; a delivered site should never carry one,
      // and re-stripping costs nothing if it does not.
      const seeded = stripPreviewTeaserFromFiles(job.approvedPreviewFiles);
      await materializeScaffold(siteRoot, seeded.files);
      // Unconditional, for the same reason the teaser strip is: a workspace
      // with no booking link still needs the funnel's blurred cal-preview
      // demo taken back out, and gating this on `job.calComUrl` is exactly
      // how that demo shipped on a paid contact page (#100).
      await applyIntegrationsToWorkspace(siteRoot, {
        booking: { provider: 'cal.com', url: job.calComUrl ?? null },
      });
      const seedPages = builtPageNames(seeded.files.map((file) => file.path));
      await say('log', changeRequestSummary(intent), {
        changeRequestId: intent.changeRequestId,
        seedVersion: intent.seedVersion,
        assets: intent.assets.map((asset) => asset.publicPath),
      });
      await this.store.markChangeRequestBuildStarted?.(jobId, worktree);

      const brief = changeRequestFeedback(intent);
      const withRequest = (feedback?: string): string =>
        feedback ? `${brief}\n\n${feedback}` : brief;
      const onTrace = log
        ? (entry: AgentTraceEntry) => log.write(traceLogLine(entry))
        : undefined;
      const pass = async (label: string, feedback?: string) => {
        await phase(label);
        const built = await this.agents.buildFullSite({
          workspaceRoot: siteRoot,
          projectId: job.projectId,
          intake: job.intake,
          brandConfig: job.brandConfig,
          requiredIntegrations: job.requiredIntegrations,
          feedback: withRequest(feedback),
          ...(onTrace ? { onTrace } : {}),
        });
        await log?.flush();
        await say('reply', replyExcerpt(built.summary), {
          changedPaths: built.changedPaths.length,
        });
        return built;
      };
      // `validate` is where the asset-binary and preview-teaser gates live, so
      // a change request gets both of them for free and gets them on the bytes
      // that would have been deployed.
      const check = async () => {
        await phase('Checking the build');
        try {
          await this.validator.validate(siteRoot, 'full');
        } catch (error) {
          const detail =
            error instanceof Error ? error.message.slice(0, 2_500) : 'unknown';
          await say('log', `The trusted build failed:\n${detail}`);
          await pass(
            'Repairing the build',
            'The trusted build of your previous pass failed. Repair the ' +
              `files so it passes; the output was: ${detail}`,
          );
          await phase('Checking the repaired build');
          await this.validator.validate(siteRoot, 'full');
        }
      };

      const built = await pass('Agents making the change');
      if (built.changedPaths.length === 0) {
        throw new FullSiteBuildFailure(
          CHANGE_REQUEST_NOT_APPLIED,
          'The agents finished the change request without modifying any ' +
            'file, so nothing was delivered for it.',
        );
      }
      await check();

      const builtPaths = async () =>
        (await collectBuiltSiteText(siteRoot)).map((file) =>
          file.path.replace(/^dist\//, ''),
        );

      await phase('Checking the change stayed inside the brief');
      let pageIssue = findChangeRequestPageIssue(
        seedPages,
        builtPageNames(await builtPaths()),
      );
      if (pageIssue) {
        await say('log', pageIssue);
        await pass('Cutting back to what the request asked for', pageIssue);
        await check();
        pageIssue = findChangeRequestPageIssue(
          seedPages,
          builtPageNames(await builtPaths()),
        );
      }
      if (pageIssue) {
        throw new FullSiteBuildFailure(PAGE_BUDGET_EXCEEDED, pageIssue);
      }

      await phase('Checking for placeholder copy');
      const placeholderOptions = { hasBookingLink: Boolean(job.calComUrl) };
      let placeholderIssue = findPlaceholderCopyIssue(
        await collectBuiltSiteText(siteRoot),
        placeholderOptions,
      );
      if (placeholderIssue) {
        await say('log', placeholderIssue);
        await pass('Removing placeholder copy', placeholderIssue);
        await check();
        placeholderIssue = findPlaceholderCopyIssue(
          await collectBuiltSiteText(siteRoot),
          placeholderOptions,
        );
      }
      if (placeholderIssue) {
        throw new FullSiteBuildFailure(
          PLACEHOLDER_COPY_SHIPPED,
          placeholderIssue,
        );
      }

      // The gate that speaks for the client: their pictures are on the site
      // and the wording they quoted is on it. One repair pass, then the job
      // fails and the request stays paid, because a change that did not ship
      // must never be recorded as one that did.
      await phase('Checking the paid change is on the site');
      let missing = findUnappliedChangeRequest(
        await collectBuiltSiteText(siteRoot),
        intent,
      );
      if (missing === null && intent.assets.length === 0) {
        await say('log', describeUncheckableChangeRequest(intent));
      }
      if (missing) {
        await say(
          'log',
          'The built site does not carry the paid change yet; asking the ' +
            'agents to put it there.',
          {
            missingAssets: missing.missingAssets,
            missingPhrases: missing.missingPhrases.length,
          },
        );
        await pass(
          'Putting the paid change back on the site',
          unappliedChangeRequestFeedback(intent, missing),
        );
        await check();
        missing = findUnappliedChangeRequest(
          await collectBuiltSiteText(siteRoot),
          intent,
        );
      }
      if (missing) {
        throw new FullSiteBuildFailure(
          CHANGE_REQUEST_NOT_APPLIED,
          describeUnappliedChangeRequest(intent, missing),
        );
      }

      // The manifest is saved before anything is published, so the version the
      // client is told about exists before the sentence is true, and a deploy
      // that fails leaves a saved-but-unpublished version rather than a live
      // site nobody can name.
      await phase('Saving the new version of the site');
      const files = await readSiteWorkspaceFiles(siteRoot);
      const saved = await this.store.saveChangeRequestVersion?.(jobId, {
        changeRequestId: intent.changeRequestId,
        files,
      });
      if (!saved) {
        throw new FullSiteBuildFailure(
          CHANGE_REQUEST_NOT_APPLIED,
          'This worker cannot save a site version, so the finished change ' +
            'could not be recorded and was not published.',
        );
      }
      await say(
        'log',
        `Saved ${files.length} files as version ${saved.version} of the site.`,
        { version: saved.version, files: files.length },
      );

      await phase('Committing the site');
      const commitSha = await this.worktrees.commit(
        worktree,
        `build: apply paid change request to site ${job.projectId.toLowerCase()}`,
      );
      await phase('Publishing');
      const published = await this.pullRequests.create({
        projectId: job.projectId,
        branch: worktree.branch,
        worktreePath: worktree.path,
        commitSha,
        siteRoot,
        calComUrl: job.calComUrl ?? null,
        changeRequestId: intent.changeRequestId,
        siteVersion: saved.version,
      });
      await this.store.markChangeRequestBuilt?.(jobId, {
        commitSha,
        ...published,
        changeRequestId: intent.changeRequestId,
        version: saved.version,
      });
      await phase(`Live, in version ${saved.version}`);
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : 'Unknown change request build failure';
      await say('log', `Change request build failed: ${detail}`);
      await this.store.markFailed(jobId, {
        code:
          error instanceof FullSiteBuildFailure
            ? error.code
            : 'CHANGE_REQUEST_BUILD_FAILED',
        detail: detail.slice(0, 2_000),
      });
      throw error;
    } finally {
      await log?.flush();
    }
  }

  /**
   * A client's published edit, put live.
   *
   * Deliberately the plainest path in this file: the edited manifest is
   * already the site the client approved, word for word, so an agent pass here
   * could only disagree with them. The rebuild materializes those files,
   * proves they still build, commits, and hands the build output to the same
   * publisher a full build uses. Nothing else about the project moves: the
   * project_state a live site is in is a statement about the engagement, not
   * about this job, and a typo fix must not restate it.
   */
  private async rebuild(
    job: FullSiteBuildJob,
    say: (
      kind: FullSiteBuildEventKind,
      body: string,
      payload?: Record<string, unknown>,
    ) => Promise<void>,
    log: JobLogWriter | null,
  ): Promise<void> {
    const jobId = job.id;
    const phase = async (body: string) => {
      await log?.flush();
      await say('phase', body);
    };

    // A rebuild is the site the client already has, edited. Before the deposit
    // build has produced one there is nothing to rebuild, so the states that
    // mean "a site exists" are the states this is valid from.
    if (
      job.projectState !== ProjectState.HUMAN_QA &&
      job.projectState !== ProjectState.LIVE_SUBSCRIPTION
    ) {
      await this.store.markFailed(jobId, {
        code: 'INVALID_PROJECT_STATE',
        detail: `A rebuild requires HUMAN_QA or LIVE_SUBSCRIPTION, received ${job.projectState}`,
      });
      return;
    }

    try {
      await phase('Preparing a clean worktree');
      // Same discard-then-create as the full build: the tree a previous
      // publish left behind is not what this version says.
      await this.worktrees.discard?.(job.projectId);
      const worktree = await this.worktrees.create(job.projectId);
      const siteRoot = join(worktree.path, 'generated-sites', job.projectId);
      await mkdir(siteRoot, { recursive: true, mode: 0o700 });
      await phase('Materializing the published edit');
      // A client rebuild is as paid-for as the first build; the teaser has no
      // business in it either, whatever the stored manifest still carries.
      await materializeScaffold(
        siteRoot,
        stripPreviewTeaserFromFiles(job.approvedPreviewFiles).files,
      );
      // Same rule as the full build: reconcile the Cal.com block
      // unconditionally, whether or not this workspace has a link, so a
      // rebuild can never carry the funnel's blurred demo either.
      await applyIntegrationsToWorkspace(siteRoot, {
        booking: { provider: 'cal.com', url: job.calComUrl ?? null },
      });
      await this.store.markRebuildStarted(jobId, worktree);

      // One gate, no repair pass. An edit that does not build is a bug in the
      // editor's own guardrails, and the honest answer is to say so and leave
      // the live site alone rather than let an agent guess at a fix nobody
      // asked for.
      await phase('Checking the build');
      await this.validator.validate(siteRoot, 'full');

      await phase('Committing the site');
      const commitSha = await this.worktrees.commit(
        worktree,
        `build: publish client edit to site ${job.projectId.toLowerCase()}`,
      );
      await phase('Publishing');
      const published = await this.pullRequests.create({
        projectId: job.projectId,
        branch: worktree.branch,
        worktreePath: worktree.path,
        commitSha,
        siteRoot,
        calComUrl: job.calComUrl ?? null,
      });
      await this.store.markRebuilt(jobId, { commitSha, ...published });
      await phase('Live');
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : 'Unknown rebuild failure';
      await say('log', `Rebuild failed: ${detail}`);
      await this.store.markFailed(jobId, {
        code: 'SITE_REBUILD_FAILED',
        detail: detail.slice(0, 2_000),
      });
      throw error;
    } finally {
      await log?.flush();
    }
  }
}
