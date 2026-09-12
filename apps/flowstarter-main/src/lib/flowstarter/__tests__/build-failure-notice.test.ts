/**
 * The notice that did not exist on 2026-09-12.
 *
 * A client paid EUR 799 in full, their build was failed by a gate fourteen
 * minutes later, and `client-notices.ts` had no template for it. What the
 * product said to them instead, indefinitely, was that their build was about
 * to start.
 *
 * Two properties are pinned: it is one email per build job rather than per
 * workspace, so a re-dispatch that also fails is heard about; and it inherits
 * `notifyClientOnce`'s contract, so a caller rendering a page can await it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './fake-supabase';

vi.mock('server-only', () => ({}));

const sendEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

const db = createFakeSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

// Covered on its own in lib/ops/__tests__/send-ops-alert.test.ts; here it is
// a spy, so these tests only need to confirm a stopped build raises one.
const sendOpsAlert = vi.fn().mockResolvedValue({ sent: true });
vi.mock('@/lib/ops/send-ops-alert', () => ({
  sendOpsAlert: (...args: unknown[]) => sendOpsAlert(...args),
}));

import {
  CLIENT_EMAIL_EVENT,
  CLIENT_EMAIL_FAILED_EVENT,
} from '../client-notifications';
import { notifyClientBuildNeedsReview } from '../build-failure-notice';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const JOB = '74859ac5-6737-4dde-80ce-d82ef5e76a59';

beforeEach(() => {
  db.reset();
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ success: true });
  sendOpsAlert.mockClear();
  sendOpsAlert.mockResolvedValue({ sent: true });
  db.seed('workspaces', [
    {
      id: WORKSPACE,
      name: 'Darius workspace',
      client_email: 'darius@example.com',
      client_name: 'Darius',
      client_business_name: 'Darius Mihai Popescu',
    },
  ]);
});

describe('notifyClientBuildNeedsReview', () => {
  it('sends the second-look notice and records the job it was about', async () => {
    const result = await notifyClientBuildNeedsReview({
      workspaceId: WORKSPACE,
      jobId: JOB,
      errorCode: 'APPROVED_EDIT_DROPPED',
    });

    expect(result).toEqual({ sent: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sent = sendEmail.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      html: string;
    };
    expect(sent.to).toBe('darius@example.com');
    expect(sent.subject).toBe('Your build needs a second look');
    expect(sent.html).toContain('Darius Mihai Popescu');
    expect(sent.html).toContain('Nothing is needed from');
    // No error code, no job id, no gate name: the client is not an operator.
    expect(sent.html).not.toContain('APPROVED_EDIT_DROPPED');

    const events = db.rows('project_events') as Array<{
      kind: string;
      payload: Record<string, unknown>;
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe(CLIENT_EMAIL_EVENT);
    expect(events[0]?.payload).toMatchObject({
      notification: 'build_failed',
      dedupeKey: JOB,
      jobId: JOB,
      errorCode: 'APPROVED_EDIT_DROPPED',
    });
  });

  it('says it once, however many times the dashboard is opened', async () => {
    await notifyClientBuildNeedsReview({ workspaceId: WORKSPACE, jobId: JOB });
    const second = await notifyClientBuildNeedsReview({
      workspaceId: WORKSPACE,
      jobId: JOB,
    });

    expect(second).toEqual({ sent: false, reason: 'already_sent' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('says it again for a re-dispatched build that also stopped', async () => {
    await notifyClientBuildNeedsReview({ workspaceId: WORKSPACE, jobId: JOB });
    const retry = await notifyClientBuildNeedsReview({
      workspaceId: WORKSPACE,
      jobId: '99999999-9999-4999-8999-999999999999',
    });

    expect(retry).toEqual({ sent: true });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('leaves nothing under CLIENT_EMAIL_EVENT when the mailer refuses, so it can retry', async () => {
    sendEmail.mockResolvedValue({
      success: false,
      error: 'API key is invalid',
    });

    expect(
      await notifyClientBuildNeedsReview({ workspaceId: WORKSPACE, jobId: JOB })
    ).toEqual({ sent: false, reason: 'send_failed' });
    expect(
      db.rows('project_events').filter((row) => row.kind === CLIENT_EMAIL_EVENT)
    ).toEqual([]);
    // It IS recorded under the failed-attempt kind, so the history is not
    // lost even though the client-facing send can still be retried.
    expect(
      db
        .rows('project_events')
        .filter((row) => row.kind === CLIENT_EMAIL_FAILED_EVENT)
    ).toHaveLength(1);
  });

  it('accepts an injected client rather than making its own', async () => {
    const result = await notifyClientBuildNeedsReview({
      supabase: db.client as never,
      workspaceId: WORKSPACE,
      jobId: JOB,
    });

    expect(result).toEqual({ sent: true });
  });

  it('raises an operator alert for the stopped build, independent of whether the client email sent', async () => {
    await notifyClientBuildNeedsReview({
      workspaceId: WORKSPACE,
      jobId: JOB,
      errorCode: 'APPROVED_EDIT_DROPPED',
    });

    expect(sendOpsAlert).toHaveBeenCalledTimes(1);
    expect(sendOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'build_job_failed',
        discriminator: JOB,
        workspaceId: WORKSPACE,
        detail: expect.objectContaining({
          workspaceId: WORKSPACE,
          jobId: JOB,
          errorCode: 'APPROVED_EDIT_DROPPED',
        }),
      })
    );
  });

  it('still raises the operator alert even when the client email is a repeat', async () => {
    await notifyClientBuildNeedsReview({ workspaceId: WORKSPACE, jobId: JOB });
    sendOpsAlert.mockClear();
    await notifyClientBuildNeedsReview({ workspaceId: WORKSPACE, jobId: JOB });

    // notifyClientOnce dedupes the CLIENT email; the operator alert is a
    // different concern with its own dedupe window in sendOpsAlert itself,
    // so this function must still call it every time it runs.
    expect(sendOpsAlert).toHaveBeenCalledTimes(1);
  });
});
