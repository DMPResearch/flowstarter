export enum ProjectState {
  INTAKE = 'INTAKE',
  PREVIEW_READY = 'PREVIEW_READY',
  DEPOSIT_PAID = 'DEPOSIT_PAID',
  AGENTS_WORKING = 'AGENTS_WORKING',
  HUMAN_QA = 'HUMAN_QA',
  LIVE_SUBSCRIPTION = 'LIVE_SUBSCRIPTION',
}

export type SocialPlatform = 'instagram' | 'linkedin';

export interface SocialMediaTarget {
  platform: SocialPlatform;
  /** A handle such as `flowstarter` (without secrets or access tokens). */
  handle?: string;
  /** Canonical public profile URL supplied by the client. */
  profileUrl: string;
  scraper: {
    provider: string;
    jobId?: string;
    requestedAt?: string;
    status?: 'pending' | 'running' | 'complete' | 'failed';
  };
}

export interface BusinessIntakePayload {
  projectId: string;
  business: {
    name: string;
    niche: string;
    location: string;
    description?: string;
    targetAudience?: string;
    primaryGoal?: string;
    existingWebsiteUrl?: string;
    /**
     * The intake's page-count answer, verbatim: 'lt-5' | '5-7' | '8-15' |
     * '15+' | 'unsure'. It is the input to the page-set rule in
     * `page-set.ts`, which decides how many pages the build may emit. Absent
     * on briefs taken before the rule existed; those fall back to 'unsure'.
     */
    pageCount?: string;
  };
  socialMedia: SocialMediaTarget[];
  locale: string;
  submittedAt: string;
  consent: {
    publicProfileAnalysis: boolean;
    acceptedAt: string;
  };
  /** One or two sentences on what they actually sell, in their words. */
  offer?: string;
  /** Real products or projects. Empty array means "asked and they have none". */
  projects?: BriefProject[];
  /** Screens the client pointed at and said "like this". Reference only. */
  designReferences?: BriefAsset[];
  /** The client's own photographs: a portrait, the workplace, the product. */
  photos?: BriefPhoto[];
  /** The derived brand palette. Hex, already contrast-checked. */
  palette?: BriefPalette;
  /** Three adjectives and a one-line voice note. */
  tone?: BriefTone;
}

/**
 * The in-depth brief, as the client fills it on their dashboard after the
 * deposit.
 *
 * Every field here is optional on the payload for one reason: a brief taken
 * before today has none of them, and so does every payload a route or a test
 * builds by hand. Code that reads them must treat absence as "never asked"
 * and an empty array as "asked, and the answer was none". The two are
 * different answers and the page-set rule and the invented-project gate both
 * depend on telling them apart.
 */
export interface BriefAsset {
  /** `assets.id` in the app database, for provenance. */
  id: string;
  /** Site-rooted path the build reads, e.g. `/flowstarter-media/hero-1.png`. */
  publicPath: string;
  caption?: string;
  width?: number;
  height?: number;
}

export interface BriefProject {
  name: string;
  /** One line, the client's own words. */
  line?: string;
  /** Validated absolute https URL, or absent. */
  link?: string;
  screenshots?: BriefAsset[];
}

export type BriefPhotoKind = 'portrait' | 'team' | 'workplace' | 'product';

export interface BriefPhoto extends BriefAsset {
  kind: BriefPhotoKind;
}

/** Each role carries the value each page mode uses; see the app's brand-palette module. */
export interface BriefPaletteColour {
  base: string;
  onLight: string;
  onDark: string;
}

export interface BriefPalette {
  primary: BriefPaletteColour;
  secondary: BriefPaletteColour;
  accent: BriefPaletteColour;
  neutral: BriefPaletteColour;
  /** 'image' | 'tone' | 'default' - how much of this was the client's own material. */
  source: string;
}

export interface BriefTone {
  /** Exactly three, lowercase. */
  adjectives: string[];
  /** One line. Phrased by a model from the client's own words, never invented. */
  voice: string;
}

export interface ScrapedTextDocument {
  sourceId: string;
  platform: SocialPlatform | 'website' | 'intake';
  kind: 'bio' | 'post' | 'caption' | 'about' | 'intake_answer';
  text: string;
  publishedAt?: string;
  sourceUrl?: string;
}

export interface ScrapedImageToken {
  sourceId: string;
  /** Private S3 object key. Never place signed URLs in prompts or logs. */
  objectKey: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** Base64 is populated only in the transient analyzer worker. */
  base64?: string;
  altText?: string;
  sourceUrl?: string;
}

export interface ScrapeCorpus {
  projectId: string;
  documents: ScrapedTextDocument[];
  images: ScrapedImageToken[];
  completedAt: string;
}

export type HexColor = `#${string}`;

export interface BrandConfig {
  schemaVersion: '1.0';
  colors: {
    primary: HexColor;
    onPrimary: HexColor;
    secondary: HexColor;
    onSecondary: HexColor;
    accent: HexColor;
    onAccent: HexColor;
    background: HexColor;
    surface: HexColor;
    text: HexColor;
    mutedText: HexColor;
  };
  typography: {
    headingFont: string;
    bodyFont: string;
    fallbackStack: string;
    source: 'google_fonts' | 'system';
  };
  voice: {
    /** All matrix values are normalized from 0 to 1. */
    formality: number;
    warmth: number;
    energy: number;
    playfulness: number;
    directness: number;
    adjectives: [string, string, string];
    avoidPhrases: string[];
    sampleHeadline: string;
    sampleBody: string;
    primaryCta: string;
  };
  ideas: {
    positioning: string;
    heroAngle: string;
    sections: Array<{
      id: string;
      purpose: string;
      evidenceSourceIds: string[];
    }>;
    contentThemes: string[];
  };
  evidence: {
    textSourceIds: string[];
    imageSourceIds: string[];
    assumptions: string[];
  };
}

export type BillingCadence = 'monthly' | 'yearly';

export interface ProjectBillingGate {
  currency: string;
  finalValueMinor: number;
  depositPercent: 20;
  balancePercent: 80;
  depositPaymentIntentId?: string;
  depositPaidAt?: string;
  balancePaymentIntentId?: string;
  balancePaidAt?: string;
  subscription?: {
    stripeSubscriptionId: string;
    cadence: BillingCadence;
    status: 'trialing' | 'active' | 'past_due' | 'canceled';
  };
}

export interface ProjectLifecycle {
  projectId: string;
  state: ProjectState;
  billing: ProjectBillingGate;
  brandConfig?: BrandConfig;
  template?: {
    slug: string;
    version: string;
    selectionReason: string;
  };
  previewUrl?: string;
  build?: {
    branch: string;
    worktreePath: string;
    pullRequestUrl?: string;
    stagingUrl?: string;
  };
  production?: {
    deploymentId: string;
    url: string;
    customDomain?: string;
  };
  updatedAt: string;
}

export interface TemplateCandidate {
  slug: string;
  displayName: string;
  description: string;
  category: string;
  useCase: string[];
  fileCount: number;
  totalLOC: number;
}

export interface TemplateSelection {
  slug: string;
  reason: string;
  matchedSignals: string[];
  confidence: number;
}

export interface TemplateScaffoldFile {
  path: string;
  content: string;
  /** Present for binary assets (images, fonts); content is then base64. */
  encoding?: 'base64';
  type: 'file';
}

export interface TemplateScaffold {
  template: {
    metadata: TemplateCandidate & { features?: string[] };
    config: Record<string, unknown>;
  };
  files: TemplateScaffoldFile[];
}

export interface InlineEditRequest {
  projectId: string;
  targetId: string;
  originalContent: string;
  instruction: string;
  requestedBy: string;
}

export interface InlineEditResult {
  targetId: string;
  originalContent: string;
  replacementContent: string;
}

export interface MaintenanceRequest {
  projectId: string;
  requestedBy: string;
  requestedCapability: Exclude<
    import('./editor-policy').EditorCapability,
    'content'
  >;
  instruction: string;
  status: 'queued' | 'in_review' | 'completed' | 'declined';
  createdAt: string;
}

/**
 * One free change the client made to their preview before they paid, as the
 * preview's edit runner actually applied it.
 *
 * `instruction` is the client's own sentence. `addedPhrases` is the machine's
 * answer to it: the concrete lines of text the runner introduced, computed by
 * diffing the preview workspace before and after the edit. The instruction is
 * what the build agent is told to preserve; the phrases are what the build is
 * checked against, because a phrase is a fact about the files and a sentence
 * is an intention.
 */
export interface ApprovedPreviewEdit {
  /** 1-based position in the order the client asked for them. */
  index: number;
  /** Verbatim, as the client phrased it. */
  instruction: string;
  /** Preview-workspace-relative paths the edit runner changed. */
  changedPaths: string[];
  /** Text the edit introduced, verbatim, for the build to preserve. */
  addedPhrases: string[];
  /** ISO timestamp the edit was applied. */
  appliedAt: string;
}

/** The few brief facts a build needs to recognise the site it is continuing. */
export interface PreviewBriefSnapshot {
  businessName: string;
  niche: string;
  location: string;
  description?: string;
  targetAudience?: string;
  primaryGoal?: string;
  locale?: string;
}

/**
 * What the client approved, carried from the preview into the paid build.
 *
 * The build already seeds its worktree from the preview manifest, so this is
 * not the mechanism by which the edits arrive — it is the record of what the
 * client was promised, so the build agent can be told about it and the built
 * output can be checked for it. Without this a build can silently regenerate
 * a page and drop a change the client watched land.
 */
export interface PreviewIntent {
  /** `funnel_previews.preview_id` of the preview the workspace claimed. */
  previewId: string;
  /** Where the approved manifest lives, as a reference rather than a copy. */
  manifest: {
    /** Stable id form, e.g. `funnel_previews:<previewId>`. */
    ref: string;
    /** Storage path of the packaged preview, when one was uploaded. */
    artifactPath: string | null;
    templateSlug: string | null;
    fileCount: number;
  };
  /** The free edits, oldest first. Empty when the client changed nothing. */
  edits: ApprovedPreviewEdit[];
  brief: PreviewBriefSnapshot;
  /** ISO timestamp the intent was derived. */
  capturedAt: string;
}
