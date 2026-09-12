/**
 * The rules, the SQL client and the orchestrator behind a client's own booking
 * page.
 *
 * Three things are worth proving here, and they are the three that would cost
 * a client something real if they broke:
 *
 *   - Idempotency. Provisioning runs on claim, on a re-claim of the same
 *     preview, and on a button the client can press twice. A second run must
 *     find the first one's work — by email, by schedule name, by event slug, by
 *     the webhook's unique pair — and must not send a second email about a page
 *     they already have.
 *   - Names. Two businesses can be called the same thing, and Cal reserves a
 *     list of words for its own pages. A username that collides with either
 *     produces a booking link that 404s, which is worse than no link at all.
 *   - Failure. A claim is a paid moment. Every failure below must leave the
 *     workspace intact, the reason on the row for the tile to show, and the
 *     caller told — never an exception thrown into the claim.
 *
 * The SQL client is exercised against a recording `run` function rather than a
 * database: what matters is which statements are issued and with what values,
 * since the schema they speak to belongs to a pinned Cal.com image and is
 * checked against the real thing by the staging proof, not by a unit test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createFakeSupabase, type FakeDb } from './fake-supabase';
import {
  calBookingFields,
  calBookingUrl,
  calLocaleFor,
  calPasswordSetupUrl,
  calProvisioningConfig,
  calProvisioningStatus,
  calSlug,
  calTimeZoneFor,
  calUsernameFor,
  createCalPostgresClient,
  isCalProvisioningConfigured,
  openCalClient,
  provisionWorkspaceCalendar,
  type CalProvisionedNotice,
  type CalProvisioningClient,
  type CalProvisioningConfig,
  type CalQueryRunner,
} from '../cal-provisioning';

const poolEnd = vi.fn(async () => undefined);
const poolQuery = vi.fn(async () => ({ rows: [] }));

vi.mock('pg', () => ({
  Pool: class {
    query = poolQuery;
    end = poolEnd;
  },
}));

const config = (
  overrides: Partial<CalProvisioningConfig> = {}
): CalProvisioningConfig => ({
  ...calProvisioningConfig({
    CAL_BASE_URL: 'https://cal.flowstarter.dev',
    CAL_DATABASE_URL: 'postgresql://provisioner@127.0.0.1:5433/calcom',
  }),
  ...overrides,
});

describe('calProvisioningConfig', () => {
  it('falls back to documented defaults when nothing is set', () => {
    const parsed = calProvisioningConfig({});
    expect(parsed.baseUrl).toBe('');
    expect(parsed.databaseUrl).toBe('');
    expect(parsed.eventSlug).toBe('intro-call');
    expect(parsed.eventLengthMinutes).toBe(30);
    expect(parsed.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.dayStart).toBe('09:00');
    expect(parsed.dayEnd).toBe('17:00');
  });

  it('takes every knob from the environment', () => {
    const parsed = calProvisioningConfig({
      CAL_BASE_URL: 'https://cal.flowstarter.net/',
      CAL_DATABASE_URL: 'postgresql://x@127.0.0.1:5433/calcom',
      CAL_EVENT_TITLE: 'Discovery call',
      CAL_EVENT_SLUG: 'Discovery Call',
      CAL_EVENT_DESCRIPTION: 'Twenty minutes.',
      CAL_EVENT_LENGTH_MINUTES: '20',
      CAL_SCHEDULE_NAME: 'Office hours',
      CAL_WEEKDAYS: '1,3,5,5',
      CAL_DAY_START: '08:30',
      CAL_DAY_END: '16:00',
      CAL_DEFAULT_TIMEZONE: 'Europe/Berlin',
      CAL_DEFAULT_LOCALE: 'ro',
      CAL_BOOKING_QUESTION: 'What is the job?',
    });
    // The trailing slash is dropped so booking URLs never double up.
    expect(parsed.baseUrl).toBe('https://cal.flowstarter.net');
    expect(parsed.eventSlug).toBe('discovery-call');
    expect(parsed.eventLengthMinutes).toBe(20);
    expect(parsed.weekdays).toEqual([1, 3, 5]);
    expect(parsed.dayStart).toBe('08:30');
    expect(parsed.defaultLocale).toBe('ro');
    expect(parsed.bookingQuestionLabel).toBe('What is the job?');
  });

  it('ignores values that would reach Postgres as nonsense', () => {
    const parsed = calProvisioningConfig({
      CAL_EVENT_LENGTH_MINUTES: 'half an hour',
      CAL_WEEKDAYS: 'weekdays',
      CAL_DAY_START: '9am',
      CAL_DAY_END: '25:00',
    });
    expect(parsed.eventLengthMinutes).toBe(30);
    expect(parsed.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.dayStart).toBe('09:00');
    expect(parsed.dayEnd).toBe('17:00');
  });

  it('knows when this environment cannot provision at all', () => {
    expect(isCalProvisioningConfigured(calProvisioningConfig({}))).toBe(false);
    expect(
      isCalProvisioningConfigured(
        calProvisioningConfig({ CAL_BASE_URL: 'https://cal.flowstarter.dev' })
      )
    ).toBe(false);
    expect(isCalProvisioningConfigured(config())).toBe(true);
  });
});

describe('names', () => {
  it('reduces a workspace slug to something Cal will accept', () => {
    expect(calSlug('Ionescu Dental')).toBe('ionescu-dental');
    expect(calSlug('Șerban & Fiii')).toBe('serban-fiii');
    expect(calSlug('---')).toBe('');
    expect(calSlug('a'.repeat(80)).length).toBeLessThanOrEqual(40);
  });

  it('uses the workspace slug when it is free', () => {
    expect(
      calUsernameFor({ slug: 'ionescu-dental', workspaceId: 'ws-1' })
    ).toBe('ionescu-dental');
  });

  it('refuses a name that is one of Cal.com own pages', () => {
    // `cal.flowstarter.dev/settings` is a settings screen, not a calendar.
    expect(calUsernameFor({ slug: 'settings', workspaceId: 'ws-1' })).toBe(
      'settings-2'
    );
  });

  it('suffixes a collision rather than inventing a random name', () => {
    expect(
      calUsernameFor({
        slug: 'acme',
        workspaceId: 'ws-1',
        taken: new Set(['acme', 'acme-2']),
      })
    ).toBe('acme-3');
  });

  it('falls back to the workspace id when the slug carries nothing usable', () => {
    expect(
      calUsernameFor({ slug: '???', workspaceId: 'ab12cd34-0000-0000' })
    ).toBe('client-ab12cd34');
  });

  it('gives up on counting after a hundred namesakes', () => {
    const taken = new Set(['acme']);
    for (let n = 2; n < 100; n += 1) taken.add(`acme-${n}`);
    expect(
      calUsernameFor({ slug: 'acme', workspaceId: 'ab12cd34-0000', taken })
    ).toBe('acme-ab12cd34');
  });

  it('builds the booking and password URLs off the configured instance', () => {
    expect(calBookingUrl(config(), 'acme')).toBe(
      'https://cal.flowstarter.dev/acme/intro-call'
    );
    expect(calPasswordSetupUrl(config())).toBe(
      'https://cal.flowstarter.dev/auth/forgot-password'
    );
  });
});

describe('timezone and locale', () => {
  it('takes the timezone from the intake when it names a real one', () => {
    expect(calTimeZoneFor(config(), { timeZone: 'Europe/Madrid' })).toBe(
      'Europe/Madrid'
    );
    expect(calTimeZoneFor(config(), { timezone: 'America/New_York' })).toBe(
      'America/New_York'
    );
  });

  it('falls back to the configured default when the intake says nothing', () => {
    expect(calTimeZoneFor(config(), null)).toBe('Europe/Bucharest');
    expect(calTimeZoneFor(config(), {})).toBe('Europe/Bucharest');
  });

  it('treats a timezone Intl does not know as absent', () => {
    // Stored verbatim by Cal and used to render availability, so a typo would
    // quietly give a client a calendar in the wrong part of the world.
    expect(calTimeZoneFor(config(), { timeZone: 'Europe/Bucarest' })).toBe(
      'Europe/Bucharest'
    );
  });

  it('narrows a locale to the two letters Cal has messages for', () => {
    expect(calLocaleFor(config(), { locale: 'ro' })).toBe('ro');
    expect(calLocaleFor(config(), { language: 'en-GB' })).toBe('en');
    expect(calLocaleFor(config(), { locale: '??' })).toBe('en');
    expect(calLocaleFor(config(), null)).toBe('en');
  });

  it('asks one question on top of Cal own booking form', () => {
    const fields = calBookingFields(config()) as Array<Record<string, unknown>>;
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      name: 'what-to-cover',
      type: 'textarea',
      editable: 'user',
      required: false,
    });
  });
});

describe('calProvisioningStatus', () => {
  it('reports a provisioned page', () => {
    expect(
      calProvisioningStatus({ cal_provisioned_at: '2026-09-13T10:00:00Z' })
    ).toEqual({ state: 'provisioned', reason: null });
  });

  it('reports a failure with the reason the client can read', () => {
    expect(
      calProvisioningStatus({ cal_provisioning_error: 'Could not reach Cal.' })
    ).toEqual({ state: 'failed', reason: 'Could not reach Cal.' });
  });

  it('lets a later success win over an older stored error', () => {
    expect(
      calProvisioningStatus({
        cal_provisioned_at: '2026-09-13T10:00:00Z',
        cal_provisioning_error: 'Could not reach Cal.',
      }).state
    ).toBe('provisioned');
  });

  it('says nothing has happened yet rather than crying failure', () => {
    expect(calProvisioningStatus(null)).toEqual({
      state: 'not_yet',
      reason: null,
    });
    expect(calProvisioningStatus({}).state).toBe('not_yet');
  });
});

describe('the Postgres client', () => {
  interface Issued {
    text: string;
    values: readonly unknown[];
  }

  function recording(responses: Record<string, unknown[]>) {
    const issued: Issued[] = [];
    const run: CalQueryRunner = async (text, values) => {
      issued.push({ text, values });
      const key = Object.keys(responses).find((needle) =>
        text.includes(needle)
      );
      return { rows: (key ? responses[key] : []) as never[] };
    };
    return { issued, run };
  }

  it('finds an existing user by email, case insensitively', async () => {
    const { issued, run } = recording({
      'from users where lower(email)': [{ id: 7, username: 'acme' }],
    });
    const client = createCalPostgresClient({ run });
    await expect(client.findUserByEmail('Owner@Acme.test')).resolves.toEqual({
      id: 7,
      username: 'acme',
    });
    expect(issued[0].text).toContain('lower(email) = lower($1)');
    expect(issued[0].values).toEqual(['Owner@Acme.test']);
  });

  it('returns null when nobody has that email', async () => {
    const { run } = recording({});
    const client = createCalPostgresClient({ run });
    await expect(
      client.findUserByEmail('nobody@acme.test')
    ).resolves.toBeNull();
  });

  it('asks about no usernames when there are none to ask about', async () => {
    const { issued, run } = recording({});
    const client = createCalPostgresClient({ run });
    await expect(client.takenUsernames([])).resolves.toEqual(new Set());
    expect(issued).toHaveLength(0);
  });

  it('reads taken usernames back in lower case', async () => {
    const { run } = recording({
      'where username = any': [{ username: 'Acme' }, { username: null }],
    });
    const client = createCalPostgresClient({ run });
    await expect(client.takenUsernames(['acme'])).resolves.toEqual(
      new Set(['acme'])
    );
  });

  it('creates a user that is already onboarded and verified', async () => {
    const { issued, run } = recording({ 'insert into users': [{ id: 11 }] });
    const client = createCalPostgresClient({ run });
    await expect(
      client.createUser({
        email: 'owner@acme.test',
        username: 'acme',
        name: 'Acme Ltd',
        timeZone: 'Europe/Bucharest',
        locale: 'en',
      })
    ).resolves.toEqual({ id: 11, username: 'acme' });
    // Otherwise the client lands in Cal setup wizard instead of a calendar we
    // already filled in for them.
    expect(issued[0].text).toContain('true, now()');
  });

  it('keeps an existing schedule instead of making a second one', async () => {
    const { issued, run } = recording({
      'from "Schedule" where': [{ id: 4 }],
    });
    const client = createCalPostgresClient({ run });
    await expect(
      client.ensureSchedule(11, {
        name: 'Working hours',
        timeZone: 'Europe/Bucharest',
        weekdays: [1, 2, 3, 4, 5],
        dayStart: '09:00',
        dayEnd: '17:00',
      })
    ).resolves.toBe(4);
    expect(issued).toHaveLength(1);
  });

  it('creates hours and makes them the default only when there is none', async () => {
    const { issued, run } = recording({
      'insert into "Schedule"': [{ id: 5 }],
    });
    const client = createCalPostgresClient({ run });
    await expect(
      client.ensureSchedule(11, {
        name: 'Working hours',
        timeZone: 'Europe/Bucharest',
        weekdays: [1, 2, 3, 4, 5],
        dayStart: '09:00',
        dayEnd: '17:00',
      })
    ).resolves.toBe(5);
    expect(issued[2].values).toEqual([5, [1, 2, 3, 4, 5], '09:00', '17:00']);
    expect(issued[3].text).toContain('"defaultScheduleId" is null');
  });

  it('creates the event type and the join row Cal resolves bookings through', async () => {
    const { issued, run } = recording({
      'insert into "EventType"': [{ id: 21 }],
    });
    const client = createCalPostgresClient({ run });
    await expect(
      client.ensureEventType(11, {
        title: 'Intro call',
        slug: 'intro-call',
        description: 'A first conversation.',
        lengthMinutes: 30,
        scheduleId: 5,
        bookingFields: [] as never,
      })
    ).resolves.toBe(21);
    // Without this row the booking page 404s while the event type sits in the
    // database looking perfectly correct.
    const join = issued.at(-1);
    expect(join?.text).toContain('_user_eventtype');
    expect(join?.values).toEqual([21, 11]);
  });

  it('reuses an event type it made before', async () => {
    const { issued, run } = recording({
      'from "EventType" where': [{ id: 21 }],
    });
    const client = createCalPostgresClient({ run });
    await expect(
      client.ensureEventType(11, {
        title: 'Intro call',
        slug: 'intro-call',
        description: 'A first conversation.',
        lengthMinutes: 30,
        scheduleId: 5,
        bookingFields: [] as never,
      })
    ).resolves.toBe(21);
    expect(
      issued.some((query) => query.text.includes('insert into "EventType"'))
    ).toBe(false);
  });

  it('upserts the webhook on the pair Cal makes unique', async () => {
    const { issued, run } = recording({});
    const client = createCalPostgresClient({ run });
    await client.ensureWebhook(11, {
      subscriberUrl:
        'https://staging.flowstarter.dev/api/integrations/cal/ws-1',
      secret: 'a'.repeat(64),
      triggers: ['BOOKING_CREATED'],
    });
    expect(issued[0].text).toContain(
      'on conflict ("userId", "subscriberUrl") do update'
    );
    expect((issued[0].values as unknown[])[2]).toBe(
      'https://staging.flowstarter.dev/api/integrations/cal/ws-1'
    );
  });

  it('closes whatever it opened', async () => {
    const end = vi.fn(async () => undefined);
    const { run } = recording({});
    await createCalPostgresClient({ run, end }).close();
    expect(end).toHaveBeenCalledTimes(1);
    // A client built without an `end` (a test double) closes cleanly too.
    await expect(
      createCalPostgresClient({ run }).close()
    ).resolves.toBeUndefined();
  });
});

describe('openCalClient', () => {
  afterEach(() => {
    poolEnd.mockClear();
    poolQuery.mockClear();
  });

  it('refuses to open anything when the environment is not configured', async () => {
    await expect(openCalClient(calProvisioningConfig({}))).resolves.toBeNull();
  });

  it('opens a pooled client and hands it back closed-able', async () => {
    const client = await openCalClient(config());
    expect(client).not.toBeNull();
    await client?.findUserByEmail('owner@acme.test');
    expect(poolQuery).toHaveBeenCalledTimes(1);
    await client?.close();
    expect(poolEnd).toHaveBeenCalledTimes(1);
  });
});

// ─── The orchestrator ──────────────────────────────────────────────────────

function fakeClient(
  overrides: Partial<CalProvisioningClient> = {}
): CalProvisioningClient & {
  calls: string[];
} {
  const calls: string[] = [];
  const base: CalProvisioningClient = {
    async findUserByEmail() {
      calls.push('findUserByEmail');
      return null;
    },
    async takenUsernames() {
      calls.push('takenUsernames');
      return new Set<string>();
    },
    async createUser(input) {
      calls.push('createUser');
      return { id: 11, username: input.username };
    },
    async ensureSchedule() {
      calls.push('ensureSchedule');
      return 5;
    },
    async ensureEventType() {
      calls.push('ensureEventType');
      return 21;
    },
    async ensureWebhook() {
      calls.push('ensureWebhook');
    },
    async close() {
      calls.push('close');
    },
  };
  return Object.assign(base, overrides, { calls });
}

describe('provisionWorkspaceCalendar', () => {
  let db: FakeDb;
  let supabase: SupabaseClient<Database>;
  let warn: string[];
  let errors: string[];

  beforeEach(() => {
    db = createFakeSupabase();
    supabase = db.client as unknown as SupabaseClient<Database>;
    warn = [];
    errors = [];
    vi.spyOn(console, 'warn').mockImplementation((message?: unknown) => {
      warn.push(String(message));
    });
    vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
      errors.push(String(message));
    });
    db.seed('workspaces', [
      {
        id: 'ws-1',
        slug: 'ionescu-dental',
        name: 'Ionescu Dental',
        client_name: 'Andrei Ionescu',
        client_email: 'andrei@ionescu.test',
        client_business_name: 'Ionescu Dental',
        cal_com_url: null,
        cal_com_webhook_secret: null,
        cal_user_id: null,
        cal_event_type_id: null,
        cal_provisioned_at: null,
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const workspace = () => db.rows('workspaces')[0];

  it('does nothing, and calls it nothing, when there is no Cal to talk to', async () => {
    const result = await provisionWorkspaceCalendar({
      supabase,
      workspaceId: 'ws-1',
      config: calProvisioningConfig({}),
      client: fakeClient(),
    });
    expect(result).toEqual({
      ok: false,
      state: 'not_yet',
      reason: 'Booking pages are not set up in this environment yet.',
    });
    // A laptop claim must not leave the client looking at a failed booking page.
    expect(workspace().cal_provisioning_error).toBeUndefined();
  });

  it('provisions a booking page, stores the link and emails the client once', async () => {
    const notify = vi.fn(async (_notice: CalProvisionedNotice) => undefined);
    const client = fakeClient();
    const result = await provisionWorkspaceCalendar({
      supabase,
      workspaceId: 'ws-1',
      config: config(),
      client,
      notify,
      actor: 'claim',
      now: new Date('2026-09-13T10:00:00.000Z'),
    });

    expect(result).toMatchObject({
      ok: true,
      state: 'provisioned',
      bookingUrl: 'https://cal.flowstarter.dev/ionescu-dental/intro-call',
      username: 'ionescu-dental',
      calUserId: 11,
      calEventTypeId: 21,
      alreadyProvisioned: false,
    });
    expect(workspace().cal_com_url).toBe(
      'https://cal.flowstarter.dev/ionescu-dental/intro-call'
    );
    expect(workspace().cal_provisioned_at).toBe('2026-09-13T10:00:00.000Z');
    expect(String(workspace().cal_com_webhook_secret)).toHaveLength(64);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-1',
      bookingUrl: 'https://cal.flowstarter.dev/ionescu-dental/intro-call',
      passwordSetupUrl: 'https://cal.flowstarter.dev/auth/forgot-password',
    });
    expect(db.rows('project_events').map((row) => row.kind)).toEqual([
      'booking_cal_provisioned',
    ]);
  });

  it('finds the Cal user by email on a rerun and does not email again', async () => {
    const client = fakeClient({
      async findUserByEmail() {
        return { id: 11, username: 'ionescu-dental' };
      },
    });
    const notify = vi.fn(async () => undefined);
    Object.assign(workspace(), {
      cal_provisioned_at: '2026-09-13T09:00:00.000Z',
      cal_com_webhook_secret: 'b'.repeat(64),
    });

    const result = await provisionWorkspaceCalendar({
      supabase,
      workspaceId: 'ws-1',
      config: config(),
      client,
      notify,
    });

    expect(result).toMatchObject({ ok: true, alreadyProvisioned: true });
    expect(client.calls).not.toContain('createUser');
    expect(notify).not.toHaveBeenCalled();
    expect(db.rows('project_events')).toHaveLength(0);
    // The secret the client already pasted nowhere else is kept, not rotated.
    expect(workspace().cal_com_webhook_secret).toBe('b'.repeat(64));
  });

  it('names around a collision the instance already has', async () => {
    const client = fakeClient({
      async takenUsernames() {
        return new Set(['ionescu-dental']);
      },
    });
    const result = await provisionWorkspaceCalendar({
      supabase,
      workspaceId: 'ws-1',
      config: config(),
      client,
    });
    expect(result).toMatchObject({
      ok: true,
      username: 'ionescu-dental-2',
      bookingUrl: 'https://cal.flowstarter.dev/ionescu-dental-2/intro-call',
    });
  });

  it('refuses a workspace it cannot find', async () => {
    const result = await provisionWorkspaceCalendar({
      supabase,
      workspaceId: 'ws-missing',
      config: config(),
      client: fakeClient(),
    });
    expect(result).toEqual({
      ok: false,
      state: 'failed',
      reason: 'That project could not be found.',
    });
  });

  it('says so when the project has no email to make an account with', async () => {
    Object.assign(workspace(), { client_email: '   ' });
    const result = await provisionWorkspaceCalendar({
      supabase,
      workspaceId: 'ws-1',
      config: config(),
      client: fakeClient(),
    });
    expect(result.ok).toBe(false);
    expect(workspace().cal_provisioning_error).toContain('email address');
    expect(db.rows('project_events')[0].kind).toBe(
      'booking_cal_provision_failed'
    );
  });

  it('turns a connection failure into a sentence, keeps the detail off the tile', async () => {
    const client = fakeClient({
      async ensureSchedule() {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5433');
      },
    });
    const result = await provisionWorkspaceCalendar({
      supabase,
      workspaceId: 'ws-1',
      config: config(),
      client,
    });
    expect(result).toEqual({
      ok: false,
      state: 'failed',
      reason: 'The booking service could not be reached. We will try again.',
    });
    expect(workspace().cal_provisioning_error).toBe(
      'The booking service could not be reached. We will try again.'
    );
    // The operator still gets the real thing, in the log and nowhere else.
    expect(errors.join('\n')).toContain('ECONNREFUSED');
    expect(workspace().cal_com_url).toBeNull();
  });

  it('reads a unique violation as a name that is taken', async () => {
    const client = fakeClient({
      async createUser() {
        throw new Error('duplicate key value violates unique constraint');
      },
    });
    const result = await provisionWorkspaceCalendar({
      supabase,
      workspaceId: 'ws-1',
      config: config(),
      client,
    });
    expect(result).toMatchObject({
      state: 'failed',
      reason: 'That booking page name is already taken. We will try another.',
    });
  });

  it('falls back to a plain sentence for anything else', async () => {
    const client = fakeClient({
      async ensureWebhook() {
        throw new Error('relation "Webhook" does not exist');
      },
    });
    const result = await provisionWorkspaceCalendar({
      supabase,
      workspaceId: 'ws-1',
      config: config(),
      client,
    });
    expect(result).toMatchObject({
      state: 'failed',
      reason: 'We could not create the booking page. Support has been told.',
    });
  });

  it('fails rather than lies when the link cannot be written back', async () => {
    db.failing.add('workspaces');
    const result = await provisionWorkspaceCalendar({
      supabase,
      workspaceId: 'ws-1',
      config: config(),
      client: fakeClient(),
    });
    expect(result.ok).toBe(false);
  });

  it('lets a failed email cost the email and nothing else', async () => {
    const notify = vi.fn(async () => {
      throw new Error('resend is down');
    });
    const result = await provisionWorkspaceCalendar({
      supabase,
      workspaceId: 'ws-1',
      config: config(),
      client: fakeClient(),
      notify,
    });
    expect(result.ok).toBe(true);
    expect(warn.join('\n')).toContain('booking page ready email failed');
  });

  it('closes a client it opened itself, and leaves an injected one alone', async () => {
    const client = fakeClient();
    await provisionWorkspaceCalendar({
      supabase,
      workspaceId: 'ws-1',
      config: config(),
      client,
    });
    expect(client.calls).not.toContain('close');
  });

  it('stops when the environment cannot open a client', async () => {
    const result = await provisionWorkspaceCalendar({
      supabase,
      workspaceId: 'ws-1',
      // Configured enough to get past the first gate, but `openCalClient`
      // returns null for a config with no database URL.
      config: config({ databaseUrl: '' }),
    });
    expect(result.state).toBe('not_yet');
  });

  it('takes the workspace name when there is no business name', async () => {
    Object.assign(workspace(), { client_business_name: null });
    const client = fakeClient();
    const created: string[] = [];
    client.createUser = async (input) => {
      created.push(input.name);
      return { id: 11, username: input.username };
    };
    await provisionWorkspaceCalendar({
      supabase,
      workspaceId: 'ws-1',
      config: config(),
      client,
    });
    expect(created).toEqual(['Ionescu Dental']);
  });

  it('records a ledger event even when the ledger itself is unavailable', async () => {
    db.failing.add('project_events');
    const result = await provisionWorkspaceCalendar({
      supabase,
      workspaceId: 'ws-1',
      config: config(),
      client: fakeClient(),
    });
    expect(result.ok).toBe(true);
    expect(warn.join('\n')).toContain('could not record');
  });
});
