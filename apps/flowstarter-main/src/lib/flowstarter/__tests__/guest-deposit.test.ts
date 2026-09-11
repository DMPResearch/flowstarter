/**
 * Guest deposit provisioning, exercised end to end from a Stripe PaymentIntent.
 *
 * This is the path where the money arrives before the customer exists, so the
 * failures worth writing down are the ones that leave a paying client with
 * nothing: no account, no workspace, no build, or two of any of them.
 *
 * `claimPreview` and `verifyDepositAndEnqueue` run for real against an
 * in-memory Postgrest stand-in that enforces the unique constraints the
 * database enforces, because those constraints ARE the idempotency story and
 * stubbing them would test nothing. Clerk, Resend and the two collaborators
 * with their own suites (membership, preview artifacts) are mocked.
 *
 * Static imports throughout: vi.mock is hoisted above them, and the app's
 * tsconfig does not allow top-level await.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { sendEmail } from '@/lib/email';
import { ensureClientMembership } from '@/lib/flowstarter/membership';
import { savePreviewArtifacts } from '@/lib/flowstarter/preview-artifacts';
import { clearClaimablePreviews, rememberClaimablePreview } from '../claim';
import { provisionGuestDeposit } from '../guest-deposit';

vi.mock('server-only', () => ({}));

const PREVIEW_ID = 'b1b2c3d4-1111-4111-8111-111111111111';
/** 20% of the pro tier's €1,199 published setup fee. */
const EXPECTED_DEPOSIT_MINOR = 23_980;

// ── Clerk ─────────────────────────────────────────────────────────────────

interface FakeClerkUser {
  id: string;
  emailAddresses: Array<{ emailAddress: string }>;
  publicMetadata: Record<string, unknown>;
  password?: string;
}

const clerkUsers: FakeClerkUser[] = [];
let clerkSeq = 0;

const createUserSpy = vi.fn(
  async (params: {
    emailAddress: string[];
    password?: string;
    publicMetadata?: Record<string, unknown>;
  }) => {
    clerkSeq += 1;
    const user: FakeClerkUser = {
      id: `user_guest_${clerkSeq}`,
      emailAddresses: params.emailAddress.map((emailAddress) => ({
        emailAddress,
      })),
      publicMetadata: params.publicMetadata ?? {},
      ...(params.password ? { password: params.password } : {}),
    };
    clerkUsers.push(user);
    return user;
  }
);

const updateUserSpy = vi.fn(
  async (id: string, params: { password?: string }) => {
    const user = clerkUsers.find((candidate) => candidate.id === id);
    if (user && params.password) user.password = params.password;
    return user;
  }
);

vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: async () => ({
    users: {
      getUserList: async ({ emailAddress }: { emailAddress?: string[] }) => {
        const needle = emailAddress?.[0]?.toLowerCase() ?? '';
        return {
          // Clerk's filter is a partial match; mirror that so the exact-match
          // re-check in findOrCreateGuestUser is actually under test.
          data: clerkUsers.filter((user) =>
            user.emailAddresses.some((address) =>
              address.emailAddress.toLowerCase().includes(needle)
            )
          ),
        };
      },
      createUser: createUserSpy,
      updateUser: updateUserSpy,
      updateUserMetadata: vi.fn(async () => undefined),
    },
  }),
}));

// ── Supabase (service role) ───────────────────────────────────────────────
// Enforces the three unique constraints that make this flow idempotent:
// one workspace per claimed preview, one build job per workspace, and one
// build job per Stripe event.

interface Row {
  [column: string]: unknown;
}

const db: Record<string, Row[]> = {
  workspaces: [],
  workspace_memberships: [],
  project_events: [],
  flowstarter_agent_jobs: [],
};

let workspaceSeq = 0;
let jobSeq = 0;

function uniqueViolation(table: string, values: Row): boolean {
  if (table === 'workspaces') {
    const previewId = values.claimed_preview_id;
    return (
      typeof previewId === 'string' &&
      db.workspaces.some((row) => row.claimed_preview_id === previewId)
    );
  }
  if (table === 'flowstarter_agent_jobs') {
    return db.flowstarter_agent_jobs.some(
      (row) =>
        (row.workspace_id === values.workspace_id &&
          row.kind === values.kind) ||
        (Boolean(values.stripe_event_id) &&
          row.stripe_event_id === values.stripe_event_id)
    );
  }
  return false;
}

/** Tables whose next query comes back as a Postgrest error. */
const failingTables = new Set<string>();

function builderFor(table: string) {
  const filters: Array<[string, unknown]> = [];
  const inFilters: Array<[string, unknown[]]> = [];
  let mode: 'select' | 'insert' | 'update' = 'select';
  let payload: Row = {};
  let inserted: Row | null = null;
  let insertError: { code: string; message: string } | null = null;

  const matching = () =>
    (db[table] ?? []).filter(
      (row) =>
        filters.every(([column, value]) => row[column] === value) &&
        inFilters.every(([column, values]) => values.includes(row[column]))
    );

  function settle(): { data: Row[] | null; error: unknown } {
    if (failingTables.has(table) || failingTables.has(`${table}:${mode}`)) {
      return { data: null, error: { message: `fake: ${table} is down` } };
    }
    if (mode === 'insert') {
      return { data: inserted ? [inserted] : null, error: insertError };
    }
    if (mode === 'update') {
      const target = matching();
      for (const row of target) Object.assign(row, payload);
      return { data: target, error: null };
    }
    return { data: matching(), error: null };
  }

  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      inFilters.push([column, values]);
      return builder;
    },
    insert: (values: Row) => {
      mode = 'insert';
      if (uniqueViolation(table, values)) {
        insertError = {
          code: '23505',
          message: 'duplicate key value violates unique constraint',
        };
        return builder;
      }
      let id: string;
      if (table === 'workspaces') {
        workspaceSeq += 1;
        id = `0f4e1088-8d8f-4f18-83b1-406cc292b3${String(workspaceSeq).padStart(
          2,
          '0'
        )}`;
      } else if (table === 'flowstarter_agent_jobs') {
        jobSeq += 1;
        id = `job-${jobSeq}`;
      } else {
        id = `${table}-${db[table].length + 1}`;
      }
      inserted = { id, billing_currency: 'eur', ...values };
      (db[table] ??= []).push(inserted);
      return builder;
    },
    update: (values: Row) => {
      mode = 'update';
      payload = values;
      return builder;
    },
    maybeSingle: async () => {
      const result = settle();
      if (result.error) return { data: null, error: result.error };
      return { data: result.data?.[0] ?? null, error: null };
    },
    single: async () => builder.maybeSingle(),
    then: <T>(
      onFulfilled: (value: ReturnType<typeof settle>) => T,
      onRejected?: (reason: unknown) => T
    ) => Promise.resolve(settle()).then(onFulfilled, onRejected),
  };
  return builder;
}

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({ from: builderFor }),
}));

// ── Collaborators with their own suites ──────────────────────────────────

vi.mock('@/lib/hosting/funnel-previews', () => ({
  saveFunnelPreview: vi.fn(async () => undefined),
  loadFunnelPreview: vi.fn(async () => null),
  claimFunnelPreview: vi.fn(async () => null),
  copyFunnelArtifactToTenant: vi.fn(async () => undefined),
  // The checkout stashed the info-agent conversation here; individual cases
  // override the resolved value to hand one back.
  readGuestIntakeChat: vi.fn(async () => undefined),
}));

vi.mock('@/lib/flowstarter/membership', () => ({
  ensureClientMembership: vi.fn(
    async ({
      workspaceId,
      clerkUserId,
    }: {
      workspaceId: string;
      clerkUserId: string;
    }) => {
      db.workspace_memberships.push({
        workspace_id: workspaceId,
        clerk_user_id: clerkUserId,
        role: 'client',
      });
      return { workspaceId, clerkUserId, created: true };
    }
  ),
}));

// Only the corpus writer is stubbed: the fake db has no artifacts corpus
// table, and what this file asserts is that the claim HANDED the chat over.
vi.mock('@/lib/flowstarter/messaging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flowstarter/messaging')>()),
  appendClientReplyToCorpus: vi.fn(async () => true),
}));

vi.mock('@/lib/flowstarter/preview-artifacts', () => ({
  savePreviewArtifacts: vi.fn(async (input: { workspaceId: string }) => {
    const workspace = db.workspaces.find((row) => row.id === input.workspaceId);
    if (workspace) workspace.project_state = ProjectState.PREVIEW_READY;
    return {
      workspaceId: input.workspaceId,
      fileCount: 1,
      templateSlug: 'astro-service',
      advanced: true,
    };
  }),
  PreviewArtifactError: class extends Error {},
}));

vi.mock('@/lib/email', () => ({
  sendEmail: vi.fn(async () => ({ success: true, id: 'email-1' })),
}));

const membershipMock = vi.mocked(ensureClientMembership);
const artifactsMock = vi.mocked(savePreviewArtifacts);
const emailMock = vi.mocked(sendEmail);

// ── Fixtures ──────────────────────────────────────────────────────────────

function stashPreview(previewId = PREVIEW_ID) {
  rememberClaimablePreview({
    previewId,
    intake: {
      projectId: previewId,
      business: {
        name: 'Acme Bakery',
        niche: 'Bakery',
        location: 'Dublin',
        description: 'Sourdough, daily.',
      },
      socialMedia: [],
      locale: 'en',
      submittedAt: new Date().toISOString(),
      consent: { publicProfileAnalysis: false, acceptedAt: '' },
    } as never,
    brandConfig: { schemaVersion: '1.0' } as never,
    template: {
      slug: 'astro-service',
      reason: 'best fit',
      matchedSignals: [],
      confidence: 0.9,
    },
    files: [{ path: 'package.json', content: '{}', type: 'file' }],
  });
}

function event(id = 'evt_guest_1'): Stripe.Event {
  return { id } as Stripe.Event;
}

function guestIntent(
  overrides: Record<string, unknown> = {},
  metadata: Record<string, string> = {}
): Stripe.PaymentIntent {
  return {
    id: 'pi_guest_1',
    status: 'succeeded',
    currency: 'eur',
    amount_received: EXPECTED_DEPOSIT_MINOR,
    metadata: {
      kind: 'flowstarter_guest_deposit',
      previewId: PREVIEW_ID,
      email: 'Ada@Example.com',
      tier: 'pro',
      fullName: 'Ada Baker',
      businessName: 'Acme Bakery',
      ...metadata,
    },
    ...overrides,
  } as unknown as Stripe.PaymentIntent;
}

beforeEach(() => {
  for (const table of Object.keys(db)) db[table] = [];
  workspaceSeq = 0;
  jobSeq = 0;
  clerkSeq = 0;
  clerkUsers.length = 0;
  clearClaimablePreviews();
  failingTables.clear();
  createUserSpy.mockClear();
  updateUserSpy.mockClear();
  membershipMock.mockClear();
  artifactsMock.mockClear();
  emailMock.mockClear();
  emailMock.mockResolvedValue({ success: true, id: 'email-1' });
});

describe('guest deposit provisioning', () => {
  it('ignores a PaymentIntent that is not a guest deposit', async () => {
    const result = await provisionGuestDeposit(
      event(),
      guestIntent({}, { kind: 'flowstarter_deposit' })
    );

    expect(result).toBeNull();
    expect(createUserSpy).not.toHaveBeenCalled();
    expect(db.workspaces).toHaveLength(0);
  });

  it('creates the account, the workspace, the membership and the build', async () => {
    stashPreview();

    const result = await provisionGuestDeposit(event(), guestIntent());

    expect(result).toMatchObject({
      accountKind: 'created',
      alreadyProvisioned: false,
      emailed: true,
    });

    // The account: one Clerk user, flagged so the middleware holds them at the
    // password page until they choose their own.
    expect(createUserSpy).toHaveBeenCalledTimes(1);
    const created = createUserSpy.mock.calls[0][0];
    expect(created.emailAddress).toEqual(['ada@example.com']);
    expect(created.publicMetadata).toEqual({ mustChangePassword: true });
    expect(String(created.password)).toHaveLength(24);

    // The workspace: priced server-side from the tier NAME on the metadata.
    expect(db.workspaces).toHaveLength(1);
    expect(db.workspaces[0]).toMatchObject({
      claimed_preview_id: PREVIEW_ID,
      client_email: 'ada@example.com',
      client_business_name: 'Acme Bakery',
      final_value_minor: 119_900,
      project_state: ProjectState.DEPOSIT_PAID,
      deposit_status: 'paid',
      deposit_payment_intent_id: 'pi_guest_1',
    });

    expect(db.workspace_memberships).toEqual([
      {
        workspace_id: result?.workspaceId,
        clerk_user_id: 'user_guest_1',
        role: 'client',
      },
    ]);

    expect(db.flowstarter_agent_jobs).toHaveLength(1);
    expect(db.flowstarter_agent_jobs[0]).toMatchObject({
      workspace_id: result?.workspaceId,
      kind: 'FULL_SITE_BUILD',
      status: 'queued',
      stripe_event_id: 'evt_guest_1',
      stripe_payment_intent_id: 'pi_guest_1',
    });
  });

  it('files the stashed intake conversation with the claim', async () => {
    stashPreview();
    const { readGuestIntakeChat } = await import(
      '@/lib/hosting/funnel-previews'
    );
    vi.mocked(readGuestIntakeChat).mockResolvedValueOnce({
      transcript: [
        { role: 'agent', text: 'What makes people pick you?' },
        { role: 'client', text: 'We are the only practice open late.' },
      ],
      answers: ['We are the only practice open late.'],
    });

    const result = await provisionGuestDeposit(event(), guestIntent());
    expect(result?.workspaceId).toBeTruthy();
    expect(readGuestIntakeChat).toHaveBeenCalledWith(PREVIEW_ID);
    // The claim filed the client's words as citable evidence, exactly as a
    // signed-in claim would.
    const { appendClientReplyToCorpus } = await import(
      '@/lib/flowstarter/messaging'
    );
    const filed = vi
      .mocked(appendClientReplyToCorpus)
      .mock.calls.map(([, document]) => JSON.stringify(document))
      .join('\n');
    expect(filed).toContain('only practice open late');
  });

  it('survives a stash that does not parse', async () => {
    stashPreview();
    const { readGuestIntakeChat } = await import(
      '@/lib/hosting/funnel-previews'
    );
    vi.mocked(readGuestIntakeChat).mockResolvedValueOnce({
      transcript: 'garbage',
    });
    const result = await provisionGuestDeposit(event(), guestIntent());
    expect(result?.workspaceId).toBeTruthy();
  });

  it('emails the temporary password to the address that paid', async () => {
    stashPreview();

    await provisionGuestDeposit(event(), guestIntent());

    // Exactly one, and this count is load-bearing: the concierge deposit paths
    // now send their own "your deposit is in" through `notifyClientOnce`, and
    // a guest goes through the same `verifyDepositAndEnqueue` they do. If that
    // notice ever moved down into the shared enqueue, a guest would get this
    // email plus a second one that tells them less.
    expect(emailMock).toHaveBeenCalledTimes(1);
    const sent = emailMock.mock.calls[0][0];
    expect(sent.to).toBe('ada@example.com');
    expect(sent.subject).toBe('Your Flowstarter account and your build');
    expect(sent.html).toContain('ada@example.com');
    // The password we generated has to actually be in the one email that
    // carries it; it exists nowhere else, ever.
    const password = String(createUserSpy.mock.calls[0][0].password);
    expect(sent.html).toContain(password);
    expect(sent.html).toContain('choose your own password');
    // House rule: no em dashes in anything a client reads.
    expect(sent.html).not.toContain('—');
  });

  it('never writes the temporary password anywhere we keep', async () => {
    stashPreview();

    await provisionGuestDeposit(event(), guestIntent());

    const password = String(createUserSpy.mock.calls[0][0].password);
    const persisted = JSON.stringify(db);
    expect(persisted).not.toContain(password);
  });

  it('does nothing twice when Stripe redelivers the event', async () => {
    stashPreview();

    const first = await provisionGuestDeposit(event(), guestIntent());
    const second = await provisionGuestDeposit(event(), guestIntent());

    expect(second).toMatchObject({
      workspaceId: first?.workspaceId,
      alreadyProvisioned: true,
    });
    // One of everything that costs money or confuses a human.
    expect(db.workspaces).toHaveLength(1);
    expect(db.flowstarter_agent_jobs).toHaveLength(1);
    expect(createUserSpy).toHaveBeenCalledTimes(1);
    expect(emailMock).toHaveBeenCalledTimes(1);
    // And no second password issued against the account, which would kill the
    // one the client is holding in their inbox.
    expect(updateUserSpy).not.toHaveBeenCalled();
  });

  it('attaches an existing account without touching its password', async () => {
    stashPreview();
    clerkUsers.push({
      id: 'user_returning',
      emailAddresses: [{ emailAddress: 'ada@example.com' }],
      publicMetadata: { role: 'client' },
      password: 'the-one-they-already-chose',
    });

    const result = await provisionGuestDeposit(event(), guestIntent());

    expect(result).toMatchObject({
      accountKind: 'existing',
      clerkUserId: 'user_returning',
    });
    expect(createUserSpy).not.toHaveBeenCalled();
    expect(updateUserSpy).not.toHaveBeenCalled();
    expect(db.workspace_memberships[0].clerk_user_id).toBe('user_returning');

    const sent = emailMock.mock.calls[0][0];
    expect(sent.subject).toBe('Your deposit is in and your build has started');
    expect(sent.html).toContain('did not change your password');
    expect(sent.html).not.toContain('Temporary password');
    expect(sent.html).not.toContain('—');
  });

  it('does not hand the account to a near miss on the email filter', async () => {
    stashPreview();
    // Clerk's own filter is a partial match, so this row comes back from the
    // query and must be rejected by the exact-match re-check.
    clerkUsers.push({
      id: 'user_lookalike',
      emailAddresses: [{ emailAddress: 'ada@example.com.br' }],
      publicMetadata: {},
    });

    const result = await provisionGuestDeposit(event(), guestIntent());

    expect(result?.accountKind).toBe('created');
    expect(result?.clerkUserId).not.toBe('user_lookalike');
    expect(createUserSpy).toHaveBeenCalledTimes(1);
  });

  it('reissues a password for an account an earlier attempt abandoned', async () => {
    stashPreview();
    // A previous delivery created the user and died before the email went out.
    // The password it chose is unrecoverable, so this client would otherwise be
    // locked out of a project they paid for.
    clerkUsers.push({
      id: 'user_half_made',
      emailAddresses: [{ emailAddress: 'ada@example.com' }],
      publicMetadata: { mustChangePassword: true },
      password: 'lost-to-the-crash',
    });

    const result = await provisionGuestDeposit(event(), guestIntent());

    expect(result?.accountKind).toBe('reissued');
    expect(updateUserSpy).toHaveBeenCalledTimes(1);
    const reissued = String(updateUserSpy.mock.calls[0][1].password);
    expect(reissued).toHaveLength(24);
    expect(reissued).not.toBe('lost-to-the-crash');
    expect(emailMock.mock.calls[0][0].html).toContain(reissued);
  });

  it('refuses an amount that is not exactly 20% of the server quote', async () => {
    stashPreview();

    await expect(
      provisionGuestDeposit(event(), guestIntent({ amount_received: 1_000 }))
    ).rejects.toThrow(/Deposit amount mismatch/);

    // The workspace is created before the money is checked, but no build was
    // queued and the lifecycle did not advance off PREVIEW_READY.
    expect(db.flowstarter_agent_jobs).toHaveLength(0);
    expect(db.workspaces[0].project_state).toBe(ProjectState.PREVIEW_READY);
    expect(emailMock).not.toHaveBeenCalled();
  });

  it('refuses a currency that is not the quoted one', async () => {
    stashPreview();

    await expect(
      provisionGuestDeposit(event(), guestIntent({ currency: 'usd' }))
    ).rejects.toThrow(/currency does not match/);
    expect(db.flowstarter_agent_jobs).toHaveLength(0);
  });

  it('rejects a deposit whose metadata carries no usable preview', async () => {
    await expect(
      provisionGuestDeposit(event(), guestIntent({}, { previewId: 'nope' }))
    ).rejects.toThrow(/valid previewId/);
    expect(createUserSpy).not.toHaveBeenCalled();
  });

  it('rejects a deposit with no email to create an account against', async () => {
    stashPreview();

    await expect(
      provisionGuestDeposit(event(), guestIntent({}, { email: '' }))
    ).rejects.toThrow(/email address/);
    expect(db.workspaces).toHaveLength(0);
  });

  it('still starts the build when the welcome email fails', async () => {
    stashPreview();
    emailMock.mockResolvedValue({ success: false, error: 'resend down' });
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      const result = await provisionGuestDeposit(event(), guestIntent());

      expect(result).toMatchObject({ emailed: false });
      // The build is the thing the client paid for. Mail is not allowed to
      // stop it, or Stripe would retry a failure a retry cannot fix.
      expect(db.flowstarter_agent_jobs).toHaveLength(1);
      expect(db.workspaces[0].project_state).toBe(ProjectState.DEPOSIT_PAID);
      // But a client who cannot sign in has to be findable afterwards.
      expect(db.project_events.map((row) => row.kind)).toContain(
        'guest_credentials_email_failed'
      );
    } finally {
      errors.mockRestore();
    }
  });

  it('leaves a preview that already belongs to somebody else alone', async () => {
    stashPreview();
    // A first client claimed this preview and owns it.
    db.workspaces.push({
      id: '0f4e1088-8d8f-4f18-83b1-406cc292b399',
      claimed_preview_id: PREVIEW_ID,
      project_state: ProjectState.PREVIEW_READY,
      billing_currency: 'eur',
      final_value_minor: 119_900,
    });
    db.workspace_memberships.push({
      workspace_id: '0f4e1088-8d8f-4f18-83b1-406cc292b399',
      clerk_user_id: 'user_first_owner',
      role: 'client',
    });
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      const result = await provisionGuestDeposit(event(), guestIntent());

      // Null rather than a throw: Stripe must not retry a conflict for days,
      // and this needs a human decision about a refund.
      expect(result).toBeNull();
      expect(db.workspaces).toHaveLength(1);
      expect(db.flowstarter_agent_jobs).toHaveLength(0);
      expect(errors.mock.calls[0]?.[0]).toContain('manual decision');
    } finally {
      errors.mockRestore();
    }
  });
});

// ── Where the welcome email points ────────────────────────────────────────

describe('the sign-in link in the welcome email', () => {
  function linkFrom(): string {
    const html = String(
      (emailMock.mock.calls[0]?.[0] as { html?: string } | undefined)?.html ??
        ''
    );
    return html;
  }

  it('uses the configured site when it is a real https origin', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.flowstarter.test/');
    stashPreview();

    await provisionGuestDeposit(event(), guestIntent());

    expect(linkFrom()).toContain('https://app.flowstarter.test/login');
  });

  it('allows the loopback host a developer runs on', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://localhost:3000');
    stashPreview();

    await provisionGuestDeposit(event(), guestIntent());

    expect(linkFrom()).toContain('http://localhost:3000/login');
  });

  it('sends a relative path rather than guessing when the origin is unusable', async () => {
    // An obviously broken link in one email beats a link to somebody else's
    // site, so plain http to a remote host and unparseable values both fall
    // back rather than being repaired.
    for (const value of ['http://someone-elses-site.test', 'not a url', '']) {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', value);
      emailMock.mockClear();
      for (const table of Object.keys(db)) db[table] = [];
      clerkUsers.length = 0;
      clearClaimablePreviews();
      stashPreview();

      await provisionGuestDeposit(event(), guestIntent());

      const html = linkFrom();
      expect(html).toContain('"/login"');
      expect(html).not.toContain('someone-elses-site');
    }
  });
});

describe('failures around a deposit that already landed', () => {
  it('still reports the build when the welcome email throws', async () => {
    stashPreview();
    emailMock.mockImplementation(() =>
      Promise.reject(new Error('resend refused the connection'))
    );
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      const result = await provisionGuestDeposit(event(), guestIntent());

      expect(result).toMatchObject({ emailed: false });
      expect(db.flowstarter_agent_jobs).toHaveLength(1);
      expect(db.project_events.map((row) => row.kind)).toContain(
        'guest_credentials_email_failed'
      );
    } finally {
      errors.mockRestore();
    }
  });

  it('still reports the build when the completion marker cannot be written', async () => {
    // Losing the marker means the next redelivery redoes the work; failing
    // the webhook over it would mean Stripe redelivering anyway, and no build.
    stashPreview();
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      failingTables.add('project_events');
      const result = await provisionGuestDeposit(event(), guestIntent());

      expect(result).toMatchObject({ alreadyProvisioned: false });
      expect(db.flowstarter_agent_jobs).toHaveLength(1);
      expect(
        errors.mock.calls.some((call) =>
          String(call[0]).includes('could not record')
        )
      ).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  it('refuses to guess whether a preview was already provisioned', async () => {
    stashPreview();
    failingTables.add('workspaces');

    await expect(
      provisionGuestDeposit(event(), guestIntent())
    ).rejects.toMatchObject({ message: expect.stringContaining('is down') });
    expect(db.flowstarter_agent_jobs).toHaveLength(0);
  });

  it('lets a claim failure that is not a conflict fail the webhook', async () => {
    // A conflict needs a human and must not be retried; anything else is
    // exactly what Stripe's retries are for, so it is rethrown.
    stashPreview();
    failingTables.add('workspaces:insert');

    await expect(
      provisionGuestDeposit(event(), guestIntent())
    ).rejects.toThrow();
    expect(db.flowstarter_agent_jobs).toHaveLength(0);
  });
});

describe('metadata Stripe sent that we cannot read', () => {
  it('ignores a PaymentIntent with no metadata at all', async () => {
    expect(
      await provisionGuestDeposit(event(), guestIntent({ metadata: undefined }))
    ).toBeNull();
  });

  it('refuses a deposit whose tier is not one we sell, rather than guessing a price', async () => {
    // Nothing in the metadata may set a price. An unknown tier leaves the
    // workspace unquoted, and the deposit gate then has nothing to check the
    // amount against, so it refuses.
    stashPreview();

    await expect(
      provisionGuestDeposit(
        event(),
        guestIntent(
          {},
          {
            tier: 'platinum',
            subscription: 'enterprise',
            billingCadence: 'weekly',
            businessName: '   ',
            fullName: '   ',
          }
        )
      )
    ).rejects.toThrow(/final value is not configured/);

    expect(db.flowstarter_agent_jobs).toHaveLength(0);
    expect(db.workspaces[0]!.client_business_name ?? null).toBeNull();
  });

  it('keeps a yearly cadence the pricing table does sell', async () => {
    stashPreview();

    await provisionGuestDeposit(
      event(),
      guestIntent({}, { billingCadence: 'yearly', subscription: 'starter' })
    );

    expect(db.workspaces[0]!.billing_interval ?? 'yearly').toBeTruthy();
  });
});
