import 'server-only';
/**
 * The in-depth brief: the material a build is actually made from.
 *
 * The intake asks a handful of questions before the preview. Everything a
 * generator needs to write true sentences about a real business arrives after
 * the deposit, on the client's own dashboard, and lands here.
 *
 * GET: the brief as it stands, what is still missing, and the workspace's
 *        files so the form can show thumbnails for the ids it holds.
 * PUT: the whole brief at once, validated, then written, then re-judged.
 *
 * Both handlers call `requireWorkspaceAccess` first, before the body is read
 * and before a query runs. Everything underneath uses the service-role client,
 * which bypasses RLS, so that check is the entire tenant boundary. The table
 * itself is select-for-members and write-for-service-role, which is exactly
 * why this route exists rather than a client-side Supabase call.
 *
 * No model is involved at any point. `evaluateBriefReadiness` is a pure rule
 * and this route is the only thing that turns its verdict into `ready_at`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireWorkspaceAccess } from '@/lib/api-auth';
import {
  PERSON_FIELD_CAPS,
  MAX_TONE_WORDS,
  PERSON_LINK_KINDS,
  hasPersonStory,
  parsePerson,
  type BriefPerson,
} from '@flowstarter/agentic-codegen/src/flowstarter/person';
import { readSourcedBio } from '@/lib/flowstarter/person-source';
import {
  BRIEF_ROW_COLUMNS,
  EMPTY_BRIEF,
  briefSiteKind,
  briefViewFromRow,
  judgeBrief,
  photosFor,
  portraitFrom,
  type BriefProjectView,
  type BriefRow,
  type BriefView,
} from '@/lib/flowstarter/brief-data';
import {
  evaluateBriefReadiness,
  type BriefReadiness,
} from '@/lib/flowstarter/brief-readiness';
import {
  enqueueBuildOnBriefReady,
  type BriefReadyOutcome,
} from '@/lib/flowstarter/deposit-workflow';
import { uniqueSlug } from '@/lib/flowstarter/claim';
import type { PolicyNotice } from '@/lib/policy/copy';
import { screenAcceptableUse } from '@/lib/policy/gate';
import { briefSubject } from '@/lib/policy/subject';
import { withTenant } from '@/lib/tenancy';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  AssetUploadError,
  listWorkspaceAssets,
  recordAssetEvent,
  type ClientAsset,
} from '../../assets/asset-storage';

/** Reads and writes one tenant's rows; never statically rendered. */
export const dynamic = 'force-dynamic';

// ───────────────────────────────────────────────────────────────────────────
// The JSON contract
// ───────────────────────────────────────────────────────────────────────────

export interface BriefResponse {
  brief: BriefView;
  readiness: BriefReadiness;
  assets: ClientAsset[];
  /**
   * What saving this brief did to the build, when it did anything.
   *
   * Present on PUT only, and only once the brief is complete. It is the one
   * place a client can be told the truth in the same response as the save:
   * their build is no longer waiting on them.
   */
  build?: { outcome: BriefReadyOutcome; jobId: string | null };
  /**
   * Present when the acceptable-use gate parked this save. The brief is
   * saved either way; this says why no build started, in the words the client
   * reads, with the terms anchor and the contact link.
   */
  policy?: PolicyNotice;
}

// ───────────────────────────────────────────────────────────────────────────
// GET
// ───────────────────────────────────────────────────────────────────────────

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) return access.response;

  try {
    const supabase = createSupabaseServiceRoleClient();
    const tenant = withTenant(supabase, access.workspaceId);
    const { data, error } = await tenant
      .from('workspace_briefs')
      .select(BRIEF_ROW_COLUMNS)
      .maybeSingle<BriefRow>();
    if (error) throw error;

    const assets = await listWorkspaceAssets(access.workspaceId);
    const stored = briefViewFromRow(data, assets);
    // Read once, on the visit where it can actually be shown to them, and
    // filed so the next visit costs nothing. See `withProposedBio`.
    const brief = await withProposedBio(tenant, stored);
    return NextResponse.json({
      brief,
      readiness: judgeBrief(brief, assets),
      assets,
    } satisfies BriefResponse);
  } catch (error) {
    return failure(error);
  }
}

/**
 * The brief, with a bio proposal attached when there is one to make.
 *
 * Four conditions, and each one is a reason not to make a request:
 *
 *   - the client was asked the person questions at all;
 *   - they have not already written their own story, because a proposal
 *     underneath somebody's own sentences is noise, not help;
 *   - they consented to at least one link being read (`person-source.ts`
 *     enforces this again, and would read nothing here either way);
 *   - nothing has been proposed yet, so a client who dismissed one is not
 *     shown it again on every visit.
 *
 * Best effort in the strongest sense: the read cannot throw, a failure to
 * store the result is logged and swallowed, and the brief renders either way.
 * A client's own page being down must not be the reason their dashboard 500s.
 *
 * It runs on GET rather than on save because this is the one moment the
 * proposal can be put in front of the person whose bio it is. Nothing is
 * published from it: `adoptedAt` is null until they press the button, and the
 * builder is told in as many words not to use an unapproved one.
 */
async function withProposedBio(
  tenant: ReturnType<typeof withTenant>,
  brief: BriefView
): Promise<BriefView> {
  const person = brief.person;
  if (!person) return brief;
  if (person.sourcedBio) return brief;
  if (hasPersonStory(person)) return brief;
  if (person.links.every((link) => !link.consented)) return brief;

  const sourcedBio = await readSourcedBio({
    links: person.links,
    fullName: person.name,
    now: new Date(),
  });
  if (!sourcedBio) return brief;

  const withBio: BriefView = { ...brief, person: { ...person, sourcedBio } };
  const { error } = await tenant
    .from('workspace_briefs')
    .update({ person: withBio.person })
    .select('workspace_id');
  if (error) {
    // The proposal is still shown; it will simply be read again next time.
    console.error(
      '[api/client/brief] could not file the bio proposal: ' + error.message
    );
  }
  return withBio;
}

// ───────────────────────────────────────────────────────────────────────────
// PUT
// ───────────────────────────────────────────────────────────────────────────

/**
 * The person section, validated as the client's own words and nothing else.
 *
 * Every cap is the one `person.ts` declares, imported rather than restated,
 * so the form, this route and the build worker's defensive parse can never
 * disagree about how long an answer may be.
 *
 * `sourcedBio` is deliberately NOT accepted from the browser. It is a
 * quotation read off somebody's public page together with the record of where
 * it came from; a client may approve it or reject it, but they may not post
 * one, because a bio the server never fetched has no provenance and
 * provenance is the entire point of the field.
 */
const PersonSchema = z.object({
  name: z.string().max(PERSON_FIELD_CAPS.name).optional().default(''),
  headline: z.string().max(PERSON_FIELD_CAPS.headline).optional().default(''),
  story: z.string().max(PERSON_FIELD_CAPS.story).optional().default(''),
  howIWork: z.string().max(PERSON_FIELD_CAPS.howIWork).optional().default(''),
  values: z.string().max(PERSON_FIELD_CAPS.values).optional().default(''),
  feel: z.string().max(PERSON_FIELD_CAPS.feel).optional().default(''),
  toneWords: z
    .array(z.string().max(PERSON_FIELD_CAPS.toneWord))
    .max(MAX_TONE_WORDS)
    .optional()
    .default([]),
  links: z
    .array(
      z.object({
        kind: z.enum(PERSON_LINK_KINDS),
        url: z.string().max(PERSON_FIELD_CAPS.linkUrl),
        consented: z.boolean().optional().default(false),
      })
    )
    .max(PERSON_LINK_KINDS.length)
    .optional()
    .default([]),
  proudestWork: z
    .string()
    .max(PERSON_FIELD_CAPS.proudestWork)
    .optional()
    .default(''),
  activity: z
    .object({
      what: z
        .string()
        .max(PERSON_FIELD_CAPS.activityWhat)
        .optional()
        .default(''),
      who: z.string().max(PERSON_FIELD_CAPS.activityWho).optional().default(''),
      typical: z
        .string()
        .max(PERSON_FIELD_CAPS.activityTypical)
        .optional()
        .default(''),
      knownFor: z
        .string()
        .max(PERSON_FIELD_CAPS.activityKnownFor)
        .optional()
        .default(''),
      years: z
        .string()
        .max(PERSON_FIELD_CAPS.activityYears)
        .optional()
        .default(''),
    })
    .optional()
    .default({}),
  /**
   * The client's verdict on a bio we proposed from one of their own pages.
   *
   * A boolean, not the text: the excerpt, its source and its URL stay exactly
   * as the server wrote them and only the approval moves. `true` stamps
   * `adoptedAt` and lets the words be published; `false` clears it back to a
   * proposal. Absent leaves the verdict alone.
   */
  adoptSourcedBio: z.boolean().optional(),
});

/**
 * The whole brief, every time. A patch endpoint would mean deciding what an
 * absent `projects` key meant, and "the client cleared the list" and "the
 * client's browser did not send the field" must never be the same request.
 */
const BodySchema = z.object({
  offer: z.string().max(2000),
  /**
   * The client's own business name. Optional so a caller that predates the
   * field is not rejected; '' means "unset", not "call it nothing" —
   * `applyBusinessNameToWorkspace` below never renames the workspace to an
   * empty string.
   */
  businessName: z.string().max(200).optional().default(''),
  projects: z
    .array(
      z.object({
        name: z.string().trim().max(80),
        line: z.string().max(200).optional().default(''),
        link: z.string().max(500).optional().default(''),
        screenshotAssetIds: z
          .array(z.string().uuid())
          .max(6)
          .optional()
          .default([]),
      })
    )
    .max(12),
  noProjects: z.boolean(),
  designReferenceAssetIds: z.array(z.string().uuid()).max(8),
  photoAssetIds: z.array(z.string().uuid()).max(12),
  /**
   * Which photo is the portrait, or null for none. Optional so a caller that
   * predates the field is not rejected; `undefined` leaves the current
   * portrait alone, `null` clears it.
   */
  portraitAssetId: z.string().uuid().nullable().optional(),
  /**
   * The client's own page-count answer. Optional and nullable for the same
   * reason `portraitAssetId` is: a caller that predates the control sends
   * neither, and clearing the selection is a real state, not an omission.
   */
  pageCount: z
    .enum(['lt-5', '5-7', '8-15', '15+', 'unsure'])
    .nullable()
    .optional(),
  /**
   * Who the client is, in their own words.
   *
   * Optional and nullable, and the three states are three different answers:
   * `undefined` leaves whatever is stored alone (a caller that predates the
   * section, or a save of only the photographs), `null` clears it back to
   * "never asked", and an object is the client's answers including the empty
   * ones. The readiness rule blocks a portfolio that has been asked and has
   * neither a story nor a portrait, so collapsing absent into empty here
   * would start blocking every brief taken before today.
   */
  person: PersonSchema.nullable().optional(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) return access.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Invalid request' },
      { status: 400 }
    );
  }
  const body = parsed.data;

  // "I have no past work to show" and a list of past work are two answers to
  // one question. Saving either of them would be guessing which one the client
  // meant, and the guess decides whether their site gets a work page.
  if (body.noProjects && body.projects.length > 0) {
    return NextResponse.json(
      {
        error:
          'noProjects and projects disagree: you have said there is no past ' +
          'work to show and also listed some. Untick the box or clear the list.',
      },
      { status: 400 }
    );
  }

  // A link goes on the client's own site, in public, under their name. An
  // `http:` or `javascript:` link would be published as written, so the check
  // is here rather than in the browser where it can be skipped.
  const badLink = body.projects.findIndex((project) => {
    const link = project.link.trim();
    return link.length > 0 && !isHttpsUrl(link);
  });
  if (badLink >= 0) {
    // Named, because "one of your links is wrong" in a list of twelve is not
    // a message a client can act on.
    const project = body.projects[badLink];
    return NextResponse.json(
      {
        error: `The link on "${
          project.name.trim() || `project ${badLink + 1}`
        }" is not a full web address. It needs to start with https://`,
      },
      { status: 400 }
    );
  }

  try {
    const supabase = createSupabaseServiceRoleClient();
    const tenant = withTenant(supabase, access.workspaceId);

    // Every id named anywhere in the body has to be this workspace's own file.
    // `withTenant` pins workspace_id on the query, so a stranger's id simply
    // does not come back, and the whole request is refused rather than quietly
    // saving the subset we recognised: a client who sees "saved" must not have
    // lost half of what they sent.
    const referenced = referencedAssetIds(body);
    if (referenced.length > 0) {
      const { data: ownedRows, error: ownedError } = await tenant
        .from('assets')
        .select('id')
        .in('id', referenced);
      if (ownedError) throw ownedError;
      const owned = new Set(
        ((ownedRows ?? []) as unknown as Array<{ id: string }>).map(
          (row) => row.id
        )
      );
      if (owned.size !== referenced.length) {
        // 404, not 403, for the same reason the rights route uses it: the
        // response must not confirm to a prober that an id it does not own is
        // nonetheless real.
        return NextResponse.json(
          { error: 'Those files are not on this project', code: 'NOT_FOUND' },
          { status: 404 }
        );
      }
    }

    // A portrait that is not one of the photographs would be invisible in the
    // form and would still satisfy the portrait rule.
    if (
      typeof body.portraitAssetId === 'string' &&
      !body.photoAssetIds.includes(body.portraitAssetId)
    ) {
      return NextResponse.json(
        {
          error:
            'The portrait has to be one of the photos you sent for the site.',
        },
        { status: 400 }
      );
    }

    // One instant for the whole save, so `updated_at`, a `ready_at`
    // transition and a bio approval all agree about when this happened.
    const now = new Date().toISOString();

    // The current row is read before the write because `ready_at` is a
    // transition, not a value: it must keep the instant the brief first became
    // complete rather than moving every time a comma is saved.
    // `person` comes back with `ready_at` because the merge below has to keep
    // the parts of it the browser is not allowed to send: a sourced bio, the
    // page it was read from and the instant it was fetched. A save that
    // dropped those would silently destroy the provenance of a quotation
    // already on somebody's website.
    const { data: current, error: currentError } = await tenant
      .from('workspace_briefs')
      .select('ready_at, override_at, person')
      .maybeSingle<{
        ready_at: string | null;
        override_at: string | null;
        person: unknown;
      }>();
    if (currentError) throw currentError;

    const person = mergePerson(parsePerson(current?.person), body.person, now);

    if (body.portraitAssetId !== undefined) {
      await applyPortrait(tenant, body.portraitAssetId, body.photoAssetIds);
    }

    // Read after the portrait write, so readiness is judged on the kinds that
    // are now stored rather than the ones that were.
    const assets = await listWorkspaceAssets(access.workspaceId);
    const projects = body.projects.map(normaliseProject);
    const readiness = evaluateBriefReadiness({
      offer: body.offer,
      // A brief that carries a person section is a brief whose intake
      // classified this visitor as a person-site: the funnel only ever asks
      // the person block of one. `briefSiteKind` is that rule, stated once,
      // so the readiness gate and the page-set rule cannot disagree about
      // what kind of site this is.
      siteKind: briefSiteKind({ ...EMPTY_BRIEF, person }),
      person,
      projects,
      noProjects: body.noProjects,
      designReferenceAssetIds: body.designReferenceAssetIds,
      photos: photosFor(body.photoAssetIds, assets),
    });

    // `ready_at` is the flag the build worker waits on, which is the whole
    // reason a client cannot write this column directly: a form post must not
    // be able to start a build. It is set the first time the rule says the
    // brief is complete, kept as-is while it stays complete, and cleared the
    // moment it stops being complete so a half-emptied brief cannot build.
    // `override_at` is never touched here. Only an operator writes that, and a
    // client overruling their own gate would make the gate decorative.
    const readyAt = readiness.ready ? current?.ready_at ?? now : null;

    const { error: writeError } = await tenant.from('workspace_briefs').upsert(
      {
        offer: body.offer,
        business_name: body.businessName,
        projects,
        no_projects: body.noProjects,
        design_reference_asset_ids: body.designReferenceAssetIds,
        photo_asset_ids: body.photoAssetIds,
        page_count: body.pageCount ?? null,
        person,
        ready_at: readyAt,
        updated_at: now,
      },
      // The primary key, so a second save is an update and never a duplicate.
      { onConflict: 'workspace_id' }
    );
    if (writeError) throw writeError;

    // The name on the brief is the client's own correction, and it is
    // allowed to rename the workspace itself: the value `deriveBusinessName`
    // guessed at claim time is exactly that, a guess, and this is where the
    // client gets the last word. Best effort by design -- a rename that fails
    // must not fail a save the readiness checklist already reported as
    // succeeded, so a query error here is logged and swallowed rather than
    // thrown.
    await applyBusinessNameToWorkspace(
      supabase,
      access.workspaceId,
      body.businessName
    ).catch((error) => {
      console.error(
        `[api/client/brief] could not rename workspace ${access.workspaceId} ` +
          'from the brief: ' +
          (error instanceof Error ? error.message : 'unknown error')
      );
    });

    // Counts only. The offer and the project descriptions are the client's own
    // words about their business; an audit trail does not need them and every
    // copy of them is another place they can leak from.
    await recordAssetEvent(access.workspaceId, 'brief_updated', access.userId, {
      offerChars: body.offer.trim().length,
      projectCount: projects.length,
      noProjects: body.noProjects,
      designReferenceCount: body.designReferenceAssetIds.length,
      photoCount: body.photoAssetIds.length,
      // Flags, never the sentences. The story is what the client wrote about
      // their own life and an audit trail does not need a copy of it.
      personAsked: person !== null,
      personStoryChars: (person?.story ?? '').trim().length,
      personToneWords: person?.toneWords.length ?? 0,
      sourcedBioAdopted: Boolean(person?.sourcedBio?.adoptedAt),
      ready: readiness.ready,
      completeness: readiness.completeness,
      missing: readiness.missing.map((entry) => entry.code),
    });

    // The whole point of `ready_at`. Before this call the column was written
    // and nothing read it until the next time a worker happened to be nudged
    // about a job it had already refused -- which, for a client who paid on
    // Monday and finished their brief on Thursday, was never. The build is
    // started here, on the transition, by the same helper the deposit uses.
    //
    // Idempotent and safe to call on every complete save: a build already
    // queued, running or finished is recognised, and the function never
    // throws, so a nudge that fails cannot fail a save the client watched
    // succeed. The worker's own reconciliation sweep is the backstop.
    //
    // Except when the acceptable-use gate says otherwise. The four quick
    // questions before the preview describe a business in a sentence; the
    // brief is where the client writes what they actually sell, and it is the
    // only place a clean intake can turn into a prohibited offer. So the brief
    // is screened on its own words, and a workspace the gate stops is parked
    // for an operator instead of dispatching a paid build nobody may publish.
    //
    // The brief itself is already saved. The client's writing is their own and
    // losing it would be a second injury; what stops is the build.
    const screening = await screenAcceptableUse({
      surface: 'brief',
      text: briefSubject({ offer: body.offer, projects }),
      workspaceId: access.workspaceId,
      actor: access.userId,
      // Post-deposit surface: a refusal here is a person's call, not a
      // threshold's. See `refusalBecomesReview` in the gate.
      refusalBecomesReview: true,
    });
    if (screening.blocked) {
      await parkForReview(supabase, access.workspaceId);
    }

    const build =
      readyAt && !screening.blocked
        ? await enqueueBuildOnBriefReady({ workspaceId: access.workspaceId })
        : null;

    const refreshed = await listWorkspaceAssets(access.workspaceId);
    return NextResponse.json({
      brief: {
        offer: body.offer,
        businessName: body.businessName,
        projects,
        noProjects: body.noProjects,
        designReferenceAssetIds: body.designReferenceAssetIds,
        photoAssetIds: body.photoAssetIds,
        portraitAssetId: portraitFrom(body.photoAssetIds, refreshed),
        readyAt,
        overrideAt: current?.override_at ?? null,
        pageCount: body.pageCount ?? null,
        person,
      },
      readiness,
      assets: refreshed,
      ...(build
        ? { build: { outcome: build.outcome, jobId: build.jobId } }
        : {}),
      ...(screening.notice ? { policy: screening.notice } : {}),
    } satisfies BriefResponse);
  } catch (error) {
    return failure(error);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * The person section the row should now hold.
 *
 * Three rules, and every one of them exists because of a way a naive save
 * would lose something the client cannot get back:
 *
 * - **Absent leaves it alone.** A browser that predates the section, or a
 *   save of only the photographs, sends no `person` key. Treating that as
 *   "clear it" would wipe an answered section on an unrelated save.
 * - **The provenance is the server's.** `sourcedBio` is never accepted from
 *   the browser: the excerpt, the page it was read from and the instant it
 *   was fetched are carried over from the stored row untouched. Only the
 *   client's verdict moves, and it moves through `adoptSourcedBio`.
 * - **Null is an answer.** An explicit `null` clears the section back to
 *   "never asked", which is the only way a client who was asked by mistake
 *   can stop being blocked by a rule meant for somebody else.
 */
function mergePerson(
  stored: BriefPerson | null,
  submitted: z.infer<typeof PersonSchema> | null | undefined,
  now: string
): BriefPerson | null {
  if (submitted === undefined) return stored;
  if (submitted === null) return null;

  const bio = stored?.sourcedBio ?? null;
  const adopted =
    submitted.adoptSourcedBio === undefined
      ? bio?.adoptedAt ?? null
      : submitted.adoptSourcedBio
      ? bio?.adoptedAt ?? now
      : null;

  return {
    name: submitted.name,
    headline: submitted.headline,
    story: submitted.story,
    howIWork: submitted.howIWork,
    values: submitted.values,
    feel: submitted.feel,
    toneWords: submitted.toneWords,
    links: submitted.links,
    proudestWork: submitted.proudestWork,
    activity: {
      what: submitted.activity.what,
      who: submitted.activity.who,
      typical: submitted.activity.typical,
      knownFor: submitted.activity.knownFor,
      years: submitted.activity.years,
    },
    sourcedBio: bio ? { ...bio, adoptedAt: adopted } : null,
  };
}

/**
 * Put the workspace on the operator's desk.
 *
 * `internal_review` is the concierge stage that already means "a human at
 * Flowstarter is looking at this before it goes further", which is exactly
 * what an acceptable-use hold is. Reusing it keeps the board one board: the
 * operator finds the workspace where they already look, with the policy card
 * and its evidence on the project page.
 *
 * Never throws into the caller. The hold that actually stops the build is the
 * open `policy_reviews` row and the skipped dispatch above; this is the flag
 * that makes it visible, and failing the client's save because a stage column
 * would not write would be the wrong trade.
 */
async function parkForReview(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  workspaceId: string
): Promise<void> {
  const { error } = await supabase
    .from('workspaces')
    .update({ concierge_stage: 'internal_review' })
    .eq('id', workspaceId);
  if (error) {
    console.error(
      `[policy] could not park ${workspaceId} for review; the build is still held`,
      error
    );
  }
}

/**
 * An absolute `https:` address and nothing else. Local on purpose: the intake
 * has its own URL rules for its own reasons, and a shared helper would make a
 * change there silently change what this route publishes.
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function normaliseProject(project: {
  name: string;
  line: string;
  link: string;
  screenshotAssetIds: string[];
}): BriefProjectView {
  return {
    name: project.name.trim(),
    line: project.line.trim(),
    link: project.link.trim(),
    screenshotAssetIds: project.screenshotAssetIds,
  };
}

/** Every asset id the body names, once each. */
function referencedAssetIds(body: z.infer<typeof BodySchema>): string[] {
  const ids = new Set<string>([
    ...body.designReferenceAssetIds,
    ...body.photoAssetIds,
  ]);
  for (const project of body.projects) {
    for (const id of project.screenshotAssetIds) ids.add(id);
  }
  if (typeof body.portraitAssetId === 'string') ids.add(body.portraitAssetId);
  return Array.from(ids);
}

/**
 * Marks one photograph as the portrait and unmarks the others.
 *
 * `kind` is the only column this route writes on `assets`, and only over ids
 * the caller has already been proved to own.
 */
async function applyPortrait(
  tenant: ReturnType<typeof withTenant>,
  portraitAssetId: string | null,
  photoAssetIds: string[]
): Promise<void> {
  const demoted = photoAssetIds.filter((id) => id !== portraitAssetId);
  if (demoted.length > 0) {
    const { error } = await tenant
      .from('assets')
      .update({ kind: null })
      .in('id', demoted)
      .eq('kind', 'portrait');
    if (error) throw error;
  }
  if (portraitAssetId) {
    const { error } = await tenant
      .from('assets')
      .update({ kind: 'portrait' })
      .eq('id', portraitAssetId);
    if (error) throw error;
  }
}

/**
 * Renames the workspace to the brief's business name, and reslugs it too --
 * but only while nobody has published the site yet.
 *
 * `workspaces` is keyed by `id`, not `workspace_id`, so this reads and writes
 * it directly with the service-role client rather than through `withTenant`,
 * the same way `claim.ts` does. A no-op on an empty name (nothing to rename
 * to) and on a name that already matches (nothing changed), so an ordinary
 * save of the offer or a photo — the vast majority of PUTs — never queries
 * either table this touches.
 *
 * The slug is the published URL once a site has gone live once
 * (`site_versions.published_at`), so reslugging after that would 404 a link
 * somebody may already have shared. The name still updates in that case —
 * it is what the next build's site title reads — only the slug is frozen.
 */
async function applyBusinessNameToWorkspace(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  workspaceId: string,
  businessName: string
): Promise<void> {
  const trimmedName = businessName.trim();
  if (!trimmedName) return;

  const { data: workspace, error: workspaceError } = await supabase
    .from('workspaces')
    .select('name')
    .eq('id', workspaceId)
    .maybeSingle<{ name: string }>();
  if (workspaceError) throw workspaceError;
  if (!workspace || workspace.name === trimmedName) return;

  // Filtered in JS rather than with a `.not(...)` clause: a version row's
  // `published_at` is null far more often than not (only one version is ever
  // published at a time -- see `markVersionPublished`), so this is a small
  // in-memory scan, not an unbounded query.
  const { data: versionRows, error: publishedError } = await supabase
    .from('site_versions')
    .select('published_at')
    .eq('workspace_id', workspaceId);
  if (publishedError) throw publishedError;
  const published = (versionRows ?? []).some(
    (row: { published_at: string | null }) => row.published_at
  );

  const update: { name: string; slug?: string } = { name: trimmedName };
  if (!published) update.slug = uniqueSlug(trimmedName);

  const { error: updateError } = await supabase
    .from('workspaces')
    .update(update)
    .eq('id', workspaceId);
  if (updateError) throw updateError;
}

/**
 * An `AssetUploadError` was raised deliberately and its text is meant for the
 * client. Anything else may carry a storage key or a connection string, so
 * only its shape crosses the wire.
 */
function failure(error: unknown): NextResponse {
  if (error instanceof AssetUploadError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status }
    );
  }
  console.error('[api/client/brief] failed', error);
  return NextResponse.json({ error: 'Request failed' }, { status: 500 });
}
