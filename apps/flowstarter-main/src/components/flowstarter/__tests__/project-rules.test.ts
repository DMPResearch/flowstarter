/**
 * The two rules the client project page is only as correct as.
 *
 * The payment gates mirror the server: the deposit window is the one
 * `/api/flowstarter/projects/[id]/deposit-checkout` accepts, and the balance
 * gate is the HUMAN_QA + `final_status = 'paid'` condition that
 * `productionActivationAllowed` in `lib/flowstarter/deposit-workflow.ts`
 * requires before a site may be activated.
 */
import { describe, expect, it } from 'vitest';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { balanceDue, depositDue, projectPayments } from '../project-payment';
import {
  PROJECT_STAGES,
  currentStage,
  projectStageIndex,
  projectStateFrom,
  stageStatus,
} from '../project-progress';
import {
  formatPreviewExpiry,
  resolvePreviewLink,
  resolveSiteLink,
} from '../site-link';

const WORKSPACE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

const priced = {
  final_value_minor: 250_000,
  billing_currency: 'eur',
  deposit_status: 'pending',
  final_status: 'pending',
};

describe('deposit gate', () => {
  it('opens only in PREVIEW_READY, with a quote, unpaid', () => {
    expect(
      depositDue({ ...priced, project_state: ProjectState.PREVIEW_READY })
    ).toBe(true);
    expect(depositDue({ ...priced, project_state: ProjectState.INTAKE })).toBe(
      false
    );
    expect(
      depositDue({
        ...priced,
        project_state: ProjectState.PREVIEW_READY,
        deposit_status: 'paid',
      })
    ).toBe(false);
    // No agreed price means nothing to charge 20% of.
    expect(
      depositDue({
        project_state: ProjectState.PREVIEW_READY,
        final_value_minor: null,
        setup_fee: null,
      })
    ).toBe(false);
  });

  it('splits the quote the same way the checkout does', () => {
    const payments = projectPayments(
      { ...priced, project_state: ProjectState.PREVIEW_READY },
      WORKSPACE
    );
    expect(payments.depositMinor).toBe(50_000);
    expect(payments.balanceMinor).toBe(200_000);
    expect(payments.depositMinor + payments.balanceMinor).toBe(
      payments.quoteMinor
    );
    expect(payments.due?.href).toBe(`/unlock/${WORKSPACE}`);
  });
});

describe('balance gate', () => {
  it('falls due at HUMAN_QA and not before', () => {
    for (const state of [
      ProjectState.INTAKE,
      ProjectState.PREVIEW_READY,
      ProjectState.DEPOSIT_PAID,
      ProjectState.AGENTS_WORKING,
      ProjectState.LIVE_SUBSCRIPTION,
    ]) {
      expect(balanceDue({ ...priced, project_state: state })).toBe(false);
    }
    expect(
      balanceDue({ ...priced, project_state: ProjectState.HUMAN_QA })
    ).toBe(true);
  });

  it('closes once final_status is paid', () => {
    expect(
      balanceDue({
        ...priced,
        project_state: ProjectState.HUMAN_QA,
        final_status: 'paid',
      })
    ).toBe(false);
  });

  it('sends the client to the invoice we already raised, when there is one', () => {
    const payments = projectPayments(
      {
        ...priced,
        project_state: ProjectState.HUMAN_QA,
        final_status: 'sent',
        final_invoice_url: 'https://invoice.stripe.com/i/abc',
      },
      WORKSPACE
    );
    expect(payments.due?.kind).toBe('balance');
    expect(payments.due?.href).toBe('https://invoice.stripe.com/i/abc');
  });

  it('falls back to the billing page when no invoice link is stored', () => {
    const payments = projectPayments(
      { ...priced, project_state: ProjectState.HUMAN_QA, final_status: 'sent' },
      WORKSPACE
    );
    expect(payments.due?.href).toBe('/account/billing');
  });
});

describe('stage copy', () => {
  it('covers all six states in transition order', () => {
    expect(PROJECT_STAGES.map((stage) => stage.state)).toEqual([
      ProjectState.INTAKE,
      ProjectState.PREVIEW_READY,
      ProjectState.DEPOSIT_PAID,
      ProjectState.AGENTS_WORKING,
      ProjectState.HUMAN_QA,
      ProjectState.LIVE_SUBSCRIPTION,
    ]);
    // Nothing user-facing may read like an enum.
    for (const stage of PROJECT_STAGES) {
      expect(stage.title).not.toMatch(/_/);
      expect(stage.label).not.toMatch(/_/);
    }
  });

  it('treats an unknown project_state as the first stage rather than blanking', () => {
    expect(projectStateFrom('SOMETHING_ELSE')).toBe(ProjectState.INTAKE);
    expect(projectStateFrom(null)).toBe(ProjectState.INTAKE);
    expect(projectStateFrom(ProjectState.HUMAN_QA)).toBe(ProjectState.HUMAN_QA);
  });

  it('places each stage relative to the current one', () => {
    expect(projectStageIndex(ProjectState.AGENTS_WORKING)).toBe(3);
    expect(currentStage(ProjectState.LIVE_SUBSCRIPTION).label).toBe('Live');
    expect(stageStatus(PROJECT_STAGES[0], ProjectState.HUMAN_QA)).toBe('done');
    expect(stageStatus(PROJECT_STAGES[4], ProjectState.HUMAN_QA)).toBe(
      'current'
    );
    expect(stageStatus(PROJECT_STAGES[5], ProjectState.HUMAN_QA)).toBe(
      'upcoming'
    );
  });
});

describe('site link', () => {
  it('offers nothing until a deploy has happened', () => {
    expect(
      resolveSiteLink({ slug: 'acme', deployStatus: 'pending', hosts: [] })
    ).toBeNull();
    expect(
      resolveSiteLink({ slug: 'acme', deployStatus: 'failed', hosts: [] })
    ).toBeNull();
  });

  it('prefers the primary custom domain', () => {
    const link = resolveSiteLink({
      slug: 'acme',
      deployStatus: 'live',
      hosts: [
        { hostname: 'old.example', is_primary: false },
        { hostname: 'acmedental.ie', is_primary: true },
      ],
    });
    expect(link).toMatchObject({ kind: 'live', href: 'https://acmedental.ie' });
  });

  it("falls back to the site's own final hostname, never a preview name", () => {
    const link = resolveSiteLink({
      slug: 'acme',
      deployStatus: 'live',
      hosts: [],
      env: { NODE_ENV: 'production' },
    });
    expect(link?.kind).toBe('live');
    expect(link?.hostname).toBe('acme.flowstarter.net');
    expect(link?.href).toBe('https://acme.flowstarter.net');
    expect(link?.hostname).not.toContain('preview');
  });

  it('points at the local deploy agent when there is no public host', () => {
    // A full end-to-end run on one machine published the site to the local
    // deploy agent and the dashboard still offered
    // `<slug>.preview.flowstarter.dev`, a name that resolves nowhere. The one
    // link the client was given was the only thing in the flow that did not
    // work. `deployedSiteUrl` is what the deploy itself resolves, so the two
    // can no longer disagree.
    const link = resolveSiteLink({
      slug: 'acme',
      deployStatus: 'live',
      hosts: [],
      env: {
        NODE_ENV: 'development',
        FLOWSTARTER_LOCAL_SITE_BASE_URL: 'http://127.0.0.1:8842',
      },
    });
    expect(link).toMatchObject({
      kind: 'live',
      href: 'http://127.0.0.1:8842/acme/',
      hostname: '127.0.0.1:8842/acme',
    });
  });

  it('still prefers a real custom domain over the local agent', () => {
    const link = resolveSiteLink({
      slug: 'acme',
      deployStatus: 'live',
      hosts: [{ hostname: 'acmedental.ie', is_primary: true }],
      env: {
        NODE_ENV: 'development',
        FLOWSTARTER_LOCAL_SITE_BASE_URL: 'http://127.0.0.1:8842',
      },
    });
    expect(link).toMatchObject({ kind: 'live', href: 'https://acmedental.ie' });
  });

  it('offers nothing when there is no slug to derive from', () => {
    expect(
      resolveSiteLink({ slug: null, deployStatus: 'live', hosts: [] })
    ).toBeNull();
  });
});

/**
 * The preview link is a second link, not a fallback for the first.
 *
 * They are different things with different lifetimes, and the difference is
 * the whole hosting model: the site is permanent and unlocked, the preview is
 * temporary and blurred. Showing the preview URL without the date it stops
 * working is how a client ends up with a dead link and no explanation.
 */
describe('preview link', () => {
  const HOSTNAME = 'p-0123456789abcdef.preview.flowstarter.net';
  const NOW = new Date('2026-09-12T00:00:00.000Z');

  it('quotes the date the link stops working', () => {
    const link = resolvePreviewLink({
      hostname: HOSTNAME,
      expiresAt: '2026-09-26T09:30:00.000Z',
      deployStatus: 'live',
      now: NOW,
    });
    expect(link).toMatchObject({
      href: `https://${HOSTNAME}`,
      hostname: HOSTNAME,
      expired: false,
    });
    expect(link?.expiryNote).toBe(
      'Your preview link works until 26 September 2026'
    );
  });

  it('says so, without a link, once it has expired', () => {
    const link = resolvePreviewLink({
      hostname: HOSTNAME,
      expiresAt: '2026-09-01T00:00:00.000Z',
      deployStatus: 'live',
      now: NOW,
    });
    expect(link?.expired).toBe(true);
    expect(link?.expiryNote).toContain('expired');
    // And it does not claim the full site went with it.
    expect(link?.expiryNote).toContain('full site is not affected');
  });

  it('offers nothing for a preview that was never actually hosted', () => {
    for (const status of ['pending', 'failed', 'removed', null]) {
      expect(
        resolvePreviewLink({
          hostname: HOSTNAME,
          expiresAt: '2026-09-26T00:00:00.000Z',
          deployStatus: status,
          now: NOW,
        })
      ).toBeNull();
    }
  });

  it('offers nothing without a hostname or a readable expiry', () => {
    expect(
      resolvePreviewLink({
        hostname: null,
        expiresAt: '2026-09-26T00:00:00.000Z',
        deployStatus: 'live',
        now: NOW,
      })
    ).toBeNull();
    expect(
      resolvePreviewLink({
        hostname: HOSTNAME,
        expiresAt: 'not a date',
        deployStatus: 'live',
        now: NOW,
      })
    ).toBeNull();
  });

  it('formats the expiry in UTC, so it reads the same everywhere', () => {
    // The reaper works in UTC. A date that shifts by a day depending on where
    // the reader is sitting is a date we cannot be held to.
    expect(formatPreviewExpiry('2026-09-26T23:30:00.000Z')).toBe(
      '26 September 2026'
    );
    expect(formatPreviewExpiry('nonsense')).toBe('');
  });
});
