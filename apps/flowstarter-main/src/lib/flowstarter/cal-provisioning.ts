/**
 * Giving a client a booking page of their own, on the Cal.com this platform
 * hosts itself.
 *
 * Until now a client had to go and get a Cal.com account, find their link, and
 * paste it into their dashboard. Most never did, so the booking page on the
 * site we built them was the one thing on it that did not work. This module is
 * the other half of that promise: when a workspace is claimed, the platform
 * creates the client's calendar for them — a user, weekday hours, one "Intro
 * call" event type, and the webhook that puts their bookings back on their own
 * dashboard — and stores the resulting link in `workspaces.cal_com_url`, the
 * same column a pasted link would have gone into. Everything downstream (the
 * built site, the embed, the bookings tile) is unchanged.
 *
 * HOW IT TALKS TO CAL. Directly to Cal's own Postgres, over loopback, as a
 * least-privilege role. That is a deliberate choice and not the obvious one:
 * Cal.com's HTTP API (`apps/api/v1`) is under the Cal.com Commercial License
 * and refuses every request in production without an Enterprise licence key,
 * and everything else Cal exposes wants a signed-in browser session. The whole
 * evaluation, the evidence, and what would change if Darius ever buys a
 * licence are written up in `docs/operations/cal.md`. The consequence to hold
 * in mind while reading this file: the SQL below is coupled to one pinned Cal
 * version, so the rules are kept pure and separate from the four statements
 * that touch Cal's tables, and those statements are listed in the runbook as
 * the thing to re-check on a Cal upgrade.
 *
 * SHAPE. Rules first, then a client interface, then one orchestrator:
 *
 *   - The rules are pure functions: what a username may be, what the booking
 *     URL is, which timezone and locale to use, what the weekday schedule is,
 *     what questions the booking form asks. They read config, never a network.
 *   - `CalProvisioningClient` is the four things this product does to Cal.
 *     `createCalPostgresClient` implements it over `pg`; a test passes a fake.
 *   - `provisionWorkspaceCalendar` sequences them, is idempotent, records what
 *     happened on the workspace, and never throws. A claim must not fail
 *     because a calendar could not be made.
 *
 * IDEMPOTENCY. Re-running is the normal case, not the exception: the claim
 * path calls this, the dashboard's retry button calls this, and a redelivered
 * Stripe webhook can call the claim path again. Every step finds what it made
 * last time — the user by email, the schedule by name, the event type by slug,
 * the webhook by its unique (user, subscriber URL) — so a second run changes
 * nothing and reports the same link.
 */
import { randomBytes, randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { CAL_RESERVED_SEGMENTS } from './cal-link';
import { CAL_TRIGGER_EVENTS, generateCalWebhookSecret } from './cal-webhook';
import { calWebhookUrl } from './cal-integration';

type SupabaseServiceClient = SupabaseClient<Database>;

// ─── Config ────────────────────────────────────────────────────────────────

export interface CalProvisioningConfig {
  /** Public origin of the platform's Cal.com, no trailing slash. */
  baseUrl: string;
  /** Postgres URL for Cal's own database. Empty when not configured. */
  databaseUrl: string;
  /** Title of the one event type every client gets. */
  eventTitle: string;
  /** Its slug, which is also the last segment of every booking URL. */
  eventSlug: string;
  /** Its description, shown above the calendar. */
  eventDescription: string;
  /** Its length in minutes. */
  eventLengthMinutes: number;
  /** The name Cal shows for the availability schedule. */
  scheduleName: string;
  /** Days of the week that are bookable, 0 = Sunday, as Cal stores them. */
  weekdays: readonly number[];
  /** Bookable hours on those days, `HH:MM`, in the workspace's timezone. */
  dayStart: string;
  dayEnd: string;
  /** Used when the intake did not say. */
  defaultTimeZone: string;
  defaultLocale: string;
  /** The extra question the booking form asks, beyond Cal's own fields. */
  bookingQuestionLabel: string;
}

/**
 * Defaults live here, next to the names, and every one of them is overridable
 * from the environment — the same pattern as `ROUTING_THRESHOLDS` in
 * routing-rules.ts. A number buried in the SQL below would be much harder to
 * change than a documented env var, and the length of an intro call is exactly
 * the kind of thing that gets changed by a business decision, not a commit.
 */
const DEFAULTS = {
  eventTitle: 'Intro call',
  eventSlug: 'intro-call',
  eventDescription: 'A first conversation about your project.',
  eventLengthMinutes: 30,
  scheduleName: 'Working hours',
  weekdays: '1,2,3,4,5',
  dayStart: '09:00',
  dayEnd: '17:00',
  timeZone: 'Europe/Bucharest',
  locale: 'en',
  bookingQuestionLabel: 'What would you like to cover?',
} as const;

/** `HH:MM`, 24 hour. Anything else falls back rather than reaching Postgres. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

function envTime(raw: string | undefined, fallback: string): string {
  const value = raw?.trim() ?? '';
  return TIME_OF_DAY.test(value) ? value : fallback;
}

function envMinutes(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value <= 24 * 60
    ? value
    : fallback;
}

/**
 * Weekdays as Cal stores them: 0 is Sunday. Parsed from a comma list so a
 * business that takes Saturday bookings needs an env change, not a deploy of
 * new code.
 */
function envWeekdays(raw: string | undefined, fallback: string): number[] {
  const parse = (value: string) =>
    value
      .split(',')
      // Blank parts are dropped before `Number` sees them: `Number('')` is 0,
      // which is Sunday, so an empty variable would otherwise configure a
      // calendar that is open on Sundays and shut the rest of the week.
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => Number(part))
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  const parsed = parse(raw?.trim() || '');
  const days = parsed.length > 0 ? parsed : parse(fallback);
  return Array.from(new Set(days)).sort((a, b) => a - b);
}

export function calProvisioningConfig(
  env: Record<string, string | undefined> = process.env
): CalProvisioningConfig {
  return {
    baseUrl: (env.CAL_BASE_URL?.trim() || '').replace(/\/+$/, ''),
    databaseUrl: env.CAL_DATABASE_URL?.trim() || '',
    eventTitle: env.CAL_EVENT_TITLE?.trim() || DEFAULTS.eventTitle,
    eventSlug: calSlug(env.CAL_EVENT_SLUG?.trim() || DEFAULTS.eventSlug),
    eventDescription:
      env.CAL_EVENT_DESCRIPTION?.trim() || DEFAULTS.eventDescription,
    eventLengthMinutes: envMinutes(
      env.CAL_EVENT_LENGTH_MINUTES,
      DEFAULTS.eventLengthMinutes
    ),
    scheduleName: env.CAL_SCHEDULE_NAME?.trim() || DEFAULTS.scheduleName,
    weekdays: envWeekdays(env.CAL_WEEKDAYS, DEFAULTS.weekdays),
    dayStart: envTime(env.CAL_DAY_START, DEFAULTS.dayStart),
    dayEnd: envTime(env.CAL_DAY_END, DEFAULTS.dayEnd),
    defaultTimeZone: env.CAL_DEFAULT_TIMEZONE?.trim() || DEFAULTS.timeZone,
    defaultLocale: env.CAL_DEFAULT_LOCALE?.trim() || DEFAULTS.locale,
    bookingQuestionLabel:
      env.CAL_BOOKING_QUESTION?.trim() || DEFAULTS.bookingQuestionLabel,
  };
}

/**
 * True when this environment can provision at all.
 *
 * Both halves are needed and they fail differently: with no `CAL_BASE_URL`
 * there is no link to store, and with no `CAL_DATABASE_URL` there is nothing
 * to write to. A laptop has neither, which is why a developer's claim does not
 * try and does not fail.
 */
export function isCalProvisioningConfigured(
  config: CalProvisioningConfig
): boolean {
  return Boolean(config.baseUrl && config.databaseUrl);
}

// ─── Rules ─────────────────────────────────────────────────────────────────

/** The longest handle Cal's own booking URLs are comfortable with. */
const MAX_USERNAME = 40;

/**
 * A workspace slug, reduced to something Cal will accept as a username.
 *
 * Cal usernames are slugified the same way ours are, so this is mostly a
 * narrowing: lower case, ASCII letters, digits and single hyphens, no leading
 * or trailing hyphen. Empty input yields empty output; the caller decides what
 * to do about that, because the fallback belongs to the workspace, not here.
 */
export function calSlug(raw: string): string {
  return (raw ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_USERNAME)
    .replace(/-+$/g, '');
}

export interface CalUsernameInput {
  /** The workspace's own slug, which is what the client will recognise. */
  slug: string;
  /** Fallback when the slug reduces to nothing, e.g. a non-Latin name. */
  workspaceId: string;
  /** Usernames already taken on the instance, lower case. */
  taken?: ReadonlySet<string>;
}

/**
 * The Cal username for a workspace.
 *
 * Three things decide it, in order:
 *
 *   - the workspace slug, because the client has already seen it in their own
 *     dashboard URL and it names their business;
 *   - Cal's reserved words, because `cal.flowstarter.dev/settings` is not a
 *     booking page and a client handed that link would be handed a 404;
 *   - collisions, because two clients can genuinely be called the same thing.
 *     The loser gets a numeric suffix rather than a random string: `acme-2` is
 *     something a person can read out over the phone.
 *
 * The workspace id's first segment is the last resort. It is ugly and it is
 * unique, which is the right trade for a name nothing else can produce.
 */
export function calUsernameFor(input: CalUsernameInput): string {
  const taken = input.taken ?? new Set<string>();
  const base =
    calSlug(input.slug) || `client-${calSlug(input.workspaceId).slice(0, 8)}`;
  const acceptable = (candidate: string) =>
    candidate.length > 0 &&
    !CAL_RESERVED_SEGMENTS.has(candidate) &&
    !taken.has(candidate);

  if (acceptable(base)) return base;

  // Two digits is enough for a hundred businesses with one name; past that the
  // workspace id below is the honest answer rather than a longer counter.
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (acceptable(candidate)) return candidate;
  }
  return `${base}-${calSlug(input.workspaceId).slice(0, 8)}`;
}

/**
 * The link that goes in `workspaces.cal_com_url` and onto the built site.
 *
 * Always the event type, never the bare handle: a client's site should open on
 * the thing being booked, and `parseCalLink` accepts both so the difference is
 * ours to choose.
 */
export function calBookingUrl(
  config: CalProvisioningConfig,
  username: string
): string {
  return `${config.baseUrl}/${username}/${config.eventSlug}`;
}

/** Where a client goes to set the password for the account we made them. */
export function calPasswordSetupUrl(config: CalProvisioningConfig): string {
  return `${config.baseUrl}/auth/forgot-password`;
}

/**
 * The timezone for the client's calendar.
 *
 * Intake does not ask for one today, so this reads whatever a future intake
 * might file (`timeZone`, or `timezone` as people actually spell it) and falls
 * back to the configured default. A value that `Intl` does not recognise is
 * treated as absent: Cal stores the string verbatim and renders availability
 * from it, so a typo would silently give a client a calendar in the wrong part
 * of the world.
 */
export function calTimeZoneFor(
  config: CalProvisioningConfig,
  intake: Record<string, unknown> | null | undefined
): string {
  const raw =
    pickString(intake, 'timeZone') ??
    pickString(intake, 'timezone') ??
    pickString(intake, 'time_zone');
  if (raw && isKnownTimeZone(raw)) return raw;
  return config.defaultTimeZone;
}

/** The locale Cal renders the booking page in. */
export function calLocaleFor(
  config: CalProvisioningConfig,
  intake: Record<string, unknown> | null | undefined
): string {
  const raw = pickString(intake, 'locale') ?? pickString(intake, 'language');
  // Two letters is the whole of what Cal's locale column is used for here, and
  // it keeps `en-GB` from being stored as a locale Cal has no messages for.
  const code = raw?.trim().slice(0, 2).toLowerCase() ?? '';
  return /^[a-z]{2}$/.test(code) ? code : config.defaultLocale;
}

function pickString(
  source: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isKnownTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The questions the booking form asks on top of Cal's own.
 *
 * Cal merges this array with its system fields (name, email, notes, guests),
 * so only the extra one is listed. `editable: 'user'` is what makes it show up
 * on the public booking page and stay editable by the client afterwards.
 */
export function calBookingFields(config: CalProvisioningConfig): Json {
  return [
    {
      name: 'what-to-cover',
      type: 'textarea',
      label: config.bookingQuestionLabel,
      required: false,
      editable: 'user',
      sources: [{ id: 'user', type: 'user', label: 'User' }],
    },
  ] as unknown as Json;
}

// ─── Provisioning state, as the dashboard reads it ─────────────────────────

export type CalProvisioningState = 'provisioned' | 'not_yet' | 'failed';

export interface CalProvisioningRow {
  cal_com_url?: string | null;
  cal_provisioned_at?: string | null;
  cal_provisioning_error?: string | null;
}

export interface CalProvisioningStatus {
  state: CalProvisioningState;
  /** Only ever set when the state is `failed`. One sentence, for a client. */
  reason: string | null;
}

/**
 * What the bookings tile says about provisioning.
 *
 * A successful run wins over a stored error: the error column is the last
 * failure, and a later success is the truth. A workspace that was never tried
 * is `not_yet` rather than a failure, because nothing went wrong — the client
 * simply has not got there yet, or this environment does not provision at all.
 */
export function calProvisioningStatus(
  row: CalProvisioningRow | null | undefined
): CalProvisioningStatus {
  if (row?.cal_provisioned_at) return { state: 'provisioned', reason: null };
  const error = row?.cal_provisioning_error?.trim();
  if (error) return { state: 'failed', reason: error };
  return { state: 'not_yet', reason: null };
}

// ─── The client ────────────────────────────────────────────────────────────

export interface CalUserRecord {
  id: number;
  username: string;
}

export interface CalCreateUserInput {
  email: string;
  username: string;
  name: string;
  timeZone: string;
  locale: string;
}

export interface CalScheduleInput {
  name: string;
  timeZone: string;
  weekdays: readonly number[];
  dayStart: string;
  dayEnd: string;
}

export interface CalEventTypeInput {
  title: string;
  slug: string;
  description: string;
  lengthMinutes: number;
  scheduleId: number;
  bookingFields: Json;
}

export interface CalWebhookInput {
  subscriberUrl: string;
  secret: string;
  triggers: readonly string[];
}

/**
 * Everything this product does to Cal, as five questions and answers.
 *
 * Narrow on purpose. The orchestrator below sequences these and knows nothing
 * about SQL; a test gives it a fake and exercises every branch without a
 * database; and if Cal ever ships a licence-free API worth using, one new
 * implementation of this interface is the whole of the change.
 */
export interface CalProvisioningClient {
  findUserByEmail(email: string): Promise<CalUserRecord | null>;
  takenUsernames(candidates: readonly string[]): Promise<ReadonlySet<string>>;
  createUser(input: CalCreateUserInput): Promise<CalUserRecord>;
  ensureSchedule(userId: number, input: CalScheduleInput): Promise<number>;
  ensureEventType(userId: number, input: CalEventTypeInput): Promise<number>;
  ensureWebhook(userId: number, input: CalWebhookInput): Promise<void>;
  close(): Promise<void>;
}

/** The one thing the Postgres client needs, so a test can stand in for it. */
export type CalQueryRunner = <Row = Record<string, unknown>>(
  text: string,
  values: readonly unknown[]
) => Promise<{ rows: Row[] }>;

/**
 * Opens a pooled connection to Cal's database.
 *
 * `pg` is imported lazily and only here: the rules above are imported by the
 * dashboard and by tests, and neither should pull a TCP driver into its bundle
 * to ask what a username may be.
 */
async function pgRunner(
  databaseUrl: string
): Promise<{ run: CalQueryRunner; end: () => Promise<void> }> {
  const { Pool } = await import('pg');
  // One connection: provisioning is a handful of statements that happen once
  // per workspace, and a pool per call would leave sockets behind.
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  return {
    run: (text, values) =>
      pool.query(text, values as unknown[]) as unknown as Promise<{
        rows: never[];
      }>,
    end: () => pool.end(),
  };
}

/**
 * The Cal client, in SQL.
 *
 * THESE SIX STATEMENTS ARE THE COUPLING to Cal's schema, and they are the list
 * to re-read when the pinned image moves. Every one of them is parameterised;
 * none of them interpolates a value into the text.
 */
export function createCalPostgresClient(input: {
  run: CalQueryRunner;
  end?: () => Promise<void>;
}): CalProvisioningClient {
  const { run } = input;
  return {
    async findUserByEmail(email) {
      const { rows } = await run<{ id: number; username: string | null }>(
        'select id, username from users where lower(email) = lower($1) limit 1',
        [email]
      );
      const found = rows[0];
      return found ? { id: found.id, username: found.username ?? '' } : null;
    },

    async takenUsernames(candidates) {
      if (candidates.length === 0) return new Set<string>();
      const { rows } = await run<{ username: string | null }>(
        'select username from users where username = any($1::text[])',
        [candidates]
      );
      return new Set(
        rows
          .map((row) => row.username?.toLowerCase() ?? '')
          .filter((name) => name.length > 0)
      );
    },

    async createUser(user) {
      // `completedOnboarding` is true because we did the onboarding: the
      // account has hours and an event type before the client ever signs in,
      // and a false here would send them into Cal's setup wizard instead of
      // their calendar. `emailVerified` is set for the same reason — the
      // address came from a paid claim, not from a stranger typing it in.
      const { rows } = await run<{ id: number }>(
        `insert into users
           (uuid, email, username, name, "timeZone", locale,
            "completedOnboarding", "emailVerified", "identityProvider")
         values (gen_random_uuid(), $1, $2, $3, $4, $5, true, now(), 'CAL')
         returning id`,
        [user.email, user.username, user.name, user.timeZone, user.locale]
      );
      return { id: rows[0].id, username: user.username };
    },

    async ensureSchedule(userId, schedule) {
      const existing = await run<{ id: number }>(
        'select id from "Schedule" where "userId" = $1 and name = $2 limit 1',
        [userId, schedule.name]
      );
      if (existing.rows[0]) return existing.rows[0].id;

      const created = await run<{ id: number }>(
        'insert into "Schedule" ("userId", name, "timeZone") values ($1, $2, $3) returning id',
        [userId, schedule.name, schedule.timeZone]
      );
      const scheduleId = created.rows[0].id;
      await run(
        `insert into "Availability" ("scheduleId", days, "startTime", "endTime")
         values ($1, $2::int[], $3::time, $4::time)`,
        [scheduleId, schedule.weekdays, schedule.dayStart, schedule.dayEnd]
      );
      // Only when the user has none: a client who has since chosen their own
      // default schedule keeps it.
      await run(
        'update users set "defaultScheduleId" = $2 where id = $1 and "defaultScheduleId" is null',
        [userId, scheduleId]
      );
      return scheduleId;
    },

    async ensureEventType(userId, eventType) {
      const existing = await run<{ id: number }>(
        'select id from "EventType" where "userId" = $1 and slug = $2 limit 1',
        [userId, eventType.slug]
      );
      const eventTypeId = existing.rows[0]
        ? existing.rows[0].id
        : (
            await run<{ id: number }>(
              `insert into "EventType"
                 (title, slug, description, length, "userId", "scheduleId",
                  position, "bookingFields")
               values ($1, $2, $3, $4, $5, $6, 0, $7::jsonb)
               returning id`,
              [
                eventType.title,
                eventType.slug,
                eventType.description,
                eventType.lengthMinutes,
                userId,
                eventType.scheduleId,
                JSON.stringify(eventType.bookingFields),
              ]
            )
          ).rows[0].id;

      // The join row is not decoration. Cal resolves a public booking page by
      // the event type's `users` relation, not by its `userId` column: without
      // this row `/{username}/{slug}` answers 404 while the event type sits
      // there in the database looking correct. Measured on v6.2.0.
      await run(
        'insert into "_user_eventtype" ("A", "B") values ($1, $2) on conflict do nothing',
        [eventTypeId, userId]
      );
      return eventTypeId;
    },

    async ensureWebhook(userId, webhook) {
      // `(userId, subscriberUrl)` is unique in Cal's schema, which is what
      // makes re-running safe: the same workspace's endpoint is one row
      // forever, and its secret is refreshed rather than duplicated.
      await run(
        `insert into "Webhook"
           (id, "userId", "subscriberUrl", secret, active, "eventTriggers", version)
         values ($1, $2, $3, $4, true, $5::"WebhookTriggerEvents"[], '2021-10-20')
         on conflict ("userId", "subscriberUrl") do update
           set secret = excluded.secret,
               active = true,
               "eventTriggers" = excluded."eventTriggers"`,
        [
          randomUUID(),
          userId,
          webhook.subscriberUrl,
          webhook.secret,
          webhook.triggers,
        ]
      );
    },

    async close() {
      await input.end?.();
    },
  };
}

/** The client this environment provisions with, or null when it cannot. */
export async function openCalClient(
  config: CalProvisioningConfig
): Promise<CalProvisioningClient | null> {
  if (!isCalProvisioningConfigured(config)) return null;
  const { run, end } = await pgRunner(config.databaseUrl);
  return createCalPostgresClient({ run, end });
}

// ─── The orchestrator ──────────────────────────────────────────────────────

export interface ProvisionCalInput {
  supabase: SupabaseServiceClient;
  workspaceId: string;
  /** Defaults to the environment's. Injected by tests and by the retry route. */
  config?: CalProvisioningConfig;
  /** Defaults to a Postgres client opened from the config. */
  client?: CalProvisioningClient;
  /** Intake answers, for timezone and locale. Read, never required. */
  intake?: Record<string, unknown> | null;
  /** Who asked. Recorded on the ledger event. */
  actor?: string;
  /** Sends the "your booking page is ready" email. Injected by tests. */
  notify?: (input: CalProvisionedNotice) => Promise<unknown>;
  now?: Date;
}

export interface CalProvisionedNotice {
  supabase: SupabaseServiceClient;
  workspaceId: string;
  bookingUrl: string;
  passwordSetupUrl: string;
}

export type CalProvisionResult =
  | {
      ok: true;
      state: 'provisioned';
      bookingUrl: string;
      username: string;
      calUserId: number;
      calEventTypeId: number;
      /** True when this call found the work already done. */
      alreadyProvisioned: boolean;
    }
  | {
      ok: false;
      state: 'not_yet' | 'failed';
      reason: string;
    };

/** Reasons a run stopped, phrased for a client reading their own dashboard. */
const REASONS = {
  notConfigured: 'Booking pages are not set up in this environment yet.',
  missingWorkspace: 'That project could not be found.',
  missingEmail:
    'We need your email address on the project before we can make your booking page.',
} as const;

/**
 * Provision, or find, this workspace's booking page.
 *
 * Never throws. Every failure is caught, written to
 * `workspaces.cal_provisioning_error` for the tile to show, recorded on the
 * ledger for an operator, and returned — because the caller is a claim, and a
 * client who has just paid must get their project whatever Cal.com did.
 */
export async function provisionWorkspaceCalendar(
  input: ProvisionCalInput
): Promise<CalProvisionResult> {
  const config = input.config ?? calProvisioningConfig();
  const now = input.now ?? new Date();

  if (!isCalProvisioningConfigured(config)) {
    // Not a failure and not recorded as one: a laptop has no Cal instance, and
    // marking every locally claimed workspace as broken would be a lie the
    // dashboard then shows the client.
    return { ok: false, state: 'not_yet', reason: REASONS.notConfigured };
  }

  const { data: workspace, error: readError } = await input.supabase
    .from('workspaces')
    // One string literal, not a concatenation: supabase-js reads the select
    // list at the type level, and a joined string erases every column type.
    // eslint-disable-next-line max-len
    .select(
      'id, slug, name, client_name, client_email, client_business_name, cal_com_url, cal_com_webhook_secret, cal_user_id, cal_event_type_id, cal_provisioned_at'
    )
    .eq('id', input.workspaceId)
    .maybeSingle();

  if (readError || !workspace) {
    return { ok: false, state: 'failed', reason: REASONS.missingWorkspace };
  }

  const email = workspace.client_email?.trim() ?? '';
  if (!email) {
    await recordFailure(
      input.supabase,
      input.workspaceId,
      REASONS.missingEmail,
      input.actor
    );
    return { ok: false, state: 'failed', reason: REASONS.missingEmail };
  }

  let client = input.client ?? null;
  const ownsClient = client === null;
  try {
    client = client ?? (await openCalClient(config));
    if (!client) {
      return { ok: false, state: 'not_yet', reason: REASONS.notConfigured };
    }

    // 1. The user. Found by email first, which is what makes a rerun a no-op
    //    even when the workspace row lost its `cal_user_id`.
    const existing = await client.findUserByEmail(email);
    let username = existing?.username ?? '';
    let calUserId = existing?.id ?? 0;
    if (!existing) {
      const preferred = calUsernameFor({
        slug: workspace.slug ?? '',
        workspaceId: workspace.id,
      });
      const candidates = usernameCandidates(preferred);
      const taken = await client.takenUsernames(candidates);
      username = calUsernameFor({
        slug: workspace.slug ?? '',
        workspaceId: workspace.id,
        taken,
      });
      const created = await client.createUser({
        email,
        username,
        name:
          workspace.client_business_name?.trim() ||
          workspace.name?.trim() ||
          workspace.client_name?.trim() ||
          username,
        timeZone: calTimeZoneFor(config, input.intake),
        locale: calLocaleFor(config, input.intake),
      });
      calUserId = created.id;
    }

    // 2. Hours, 3. the event type, 4. the webhook back to us.
    const scheduleId = await client.ensureSchedule(calUserId, {
      name: config.scheduleName,
      timeZone: calTimeZoneFor(config, input.intake),
      weekdays: config.weekdays,
      dayStart: config.dayStart,
      dayEnd: config.dayEnd,
    });
    const calEventTypeId = await client.ensureEventType(calUserId, {
      title: config.eventTitle,
      slug: config.eventSlug,
      description: config.eventDescription,
      lengthMinutes: config.eventLengthMinutes,
      scheduleId,
      bookingFields: calBookingFields(config),
    });
    const secret =
      workspace.cal_com_webhook_secret?.trim() ||
      generateCalWebhookSecret(randomBytes);
    await client.ensureWebhook(calUserId, {
      subscriberUrl: calWebhookUrl(workspace.id),
      secret,
      triggers: CAL_TRIGGER_EVENTS,
    });

    const bookingUrl = calBookingUrl(config, username);
    const alreadyProvisioned = Boolean(workspace.cal_provisioned_at);

    const { error: writeError } = await input.supabase
      .from('workspaces')
      .update({
        cal_com_url: bookingUrl,
        cal_com_webhook_secret: secret,
        cal_user_id: calUserId,
        cal_event_type_id: calEventTypeId,
        cal_provisioned_at: now.toISOString(),
        cal_provisioning_error: null,
      })
      .eq('id', workspace.id);
    if (writeError) throw writeError;

    if (!alreadyProvisioned) {
      await recordEvent(
        input.supabase,
        workspace.id,
        'booking_cal_provisioned',
        {
          actor: input.actor ?? 'system',
          calComUrl: bookingUrl,
          calUserId,
          calEventTypeId,
        }
      );
      // The email is the client's only prompt to go and set a password on an
      // account they never asked for, so it is sent once, on the run that
      // actually created the page, and never on a retry that found it.
      await sendNotice(input, bookingUrl, config);
    }

    return {
      ok: true,
      state: 'provisioned',
      bookingUrl,
      username,
      calUserId,
      calEventTypeId,
      alreadyProvisioned,
    };
  } catch (error) {
    const reason = failureReason(error);
    await recordFailure(
      input.supabase,
      input.workspaceId,
      reason,
      input.actor,
      error
    );
    return { ok: false, state: 'failed', reason };
  } finally {
    if (ownsClient) {
      // A pool left open would keep the Node process alive after a one-shot
      // provision; a failure closing it is not worth failing the claim over.
      await client?.close().catch(() => undefined);
    }
  }
}

/** The handful of names a collision check needs to ask about. */
function usernameCandidates(base: string): string[] {
  const candidates = [base];
  for (let suffix = 2; suffix < 100; suffix += 1) {
    candidates.push(`${base}-${suffix}`);
  }
  return candidates;
}

/**
 * One sentence a client can read, out of whatever Cal or Postgres threw.
 *
 * Deliberately not the raw message: a connection string, a constraint name or
 * a stack trace is an operator's information, and it goes to the ledger and
 * the log rather than onto the client's dashboard.
 */
function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect/i.test(message)) {
    return 'The booking service could not be reached. We will try again.';
  }
  if (/duplicate key|unique constraint/i.test(message)) {
    return 'That booking page name is already taken. We will try another.';
  }
  return 'We could not create the booking page. Support has been told.';
}

async function sendNotice(
  input: ProvisionCalInput,
  bookingUrl: string,
  config: CalProvisioningConfig
): Promise<void> {
  if (!input.notify) return;
  try {
    await input.notify({
      supabase: input.supabase,
      workspaceId: input.workspaceId,
      bookingUrl,
      passwordSetupUrl: calPasswordSetupUrl(config),
    });
  } catch (error) {
    console.warn(
      `[cal] booking page ready email failed for workspace ${input.workspaceId}: ` +
        (error instanceof Error ? error.message : 'unknown error')
    );
  }
}

async function recordFailure(
  supabase: SupabaseServiceClient,
  workspaceId: string,
  reason: string,
  actor: string | undefined,
  error?: unknown
): Promise<void> {
  console.error(
    `[cal] could not provision a booking page for workspace ${workspaceId}: ` +
      (error instanceof Error ? error.message : reason)
  );
  try {
    await supabase
      .from('workspaces')
      .update({ cal_provisioning_error: reason })
      .eq('id', workspaceId);
  } catch {
    // The tile losing its reason is not worth a second failure here.
  }
  await recordEvent(supabase, workspaceId, 'booking_cal_provision_failed', {
    actor: actor ?? 'system',
    reason,
  });
}

/** Best effort. A missing ledger row must not fail a provision that worked. */
async function recordEvent(
  supabase: SupabaseServiceClient,
  workspaceId: string,
  kind: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const { error } = await supabase.from('project_events').insert({
      workspace_id: workspaceId,
      kind,
      actor: String(payload.actor ?? 'system'),
      payload: payload as Json,
    });
    if (error) throw error;
  } catch (error) {
    console.warn(
      `[cal] could not record ${kind} for workspace ${workspaceId}: ` +
        (error instanceof Error ? error.message : 'unknown error')
    );
  }
}
