'use client';

import { useState, type FormEvent } from 'react';

/**
 * Connect, change or disconnect one workspace's Cal.com calendar.
 *
 * Everything this component knows about what a valid link is, it learns from
 * the server: it posts the paste and renders whatever came back, error string
 * included. A second copy of the rules in the browser would be a second thing
 * to keep in step, and the server has to check anyway.
 *
 * The webhook block only appears once a calendar is connected, because it is a
 * five minute job the client cannot start until they have something to point
 * Cal.com at, and putting it on screen before then is a step they cannot do.
 */
export interface BookingConnection {
  connected: boolean;
  calComUrl: string;
  embedSrc: string | null;
  webhookUrl: string;
  webhookSecret: string | null;
}

export function BookingSettingsForm({
  workspaceId,
  initialConnection,
}: {
  workspaceId: string;
  initialConnection: BookingConnection;
}) {
  const [connection, setConnection] = useState(initialConnection);
  const [value, setValue] = useState(initialConnection.calComUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function send(method: 'PATCH' | 'DELETE') {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/client/booking/${workspaceId}`, {
        method,
        ...(method === 'PATCH'
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ calComUrl: value }),
            }
          : {}),
      });
      const json = (await res.json().catch(() => ({}))) as Partial<
        BookingConnection & { error: string }
      >;
      if (!res.ok) {
        setError(json.error ?? 'Could not save your booking link.');
        return;
      }
      apply(json);
      setSaved(true);
    } catch {
      setError('Could not reach the server. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  function apply(json: Partial<BookingConnection>) {
    const next: BookingConnection = {
      connected: Boolean(json.connected),
      calComUrl: json.calComUrl ?? '',
      embedSrc: json.embedSrc ?? null,
      webhookUrl: json.webhookUrl ?? connection.webhookUrl,
      webhookSecret: json.webhookSecret ?? null,
    };
    setConnection(next);
    setValue(next.calComUrl);
  }

  /**
   * Ask the platform to make this client a calendar of their own.
   *
   * The claim already does this, so most clients never press it; the ones who
   * do are the ones whose first attempt failed, or who were claimed before the
   * platform hosted calendars at all. It is idempotent on the server, so a
   * second press finds the same page rather than making another one.
   *
   * `ok: false` is a 200 with a sentence in it, which is why the failure is
   * read out of the body rather than off the status: the server has told the
   * client why, and that sentence is more use than "something went wrong".
   * The connection is then re-read rather than assembled from the result,
   * because the embed and the signing secret are the booking page's to
   * compute and this component has no business guessing at either.
   */
  async function provision() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/client/booking/${workspaceId}`, {
        method: 'POST',
      });
      const json = (await res.json().catch(() => ({}))) as Partial<{
        ok: boolean;
        reason: string;
        error: string;
      }>;
      if (!res.ok || !json.ok) {
        setError(
          json.reason ?? json.error ?? 'Could not set up your booking page.'
        );
        return;
      }
      const reread = await fetch(`/api/client/booking/${workspaceId}`);
      if (reread.ok) {
        apply((await reread.json()) as Partial<BookingConnection>);
      }
      setSaved(true);
    } catch {
      setError('Could not reach the server. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send('PATCH');
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4"
        data-testid="booking-settings-form"
      >
        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-[var(--fs-ink)]">
            Cal.com booking link
          </span>
          <input
            type="text"
            name="calComUrl"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
            placeholder="https://cal.com/your-name/intro"
            autoComplete="off"
            data-testid="booking-cal-url"
            className="rounded-xl border border-[var(--fs-glass-edge)] bg-white/80 px-4 py-3 text-sm text-[var(--fs-ink)] outline-none focus:border-[var(--purple-primary)]"
          />
          <span className="text-xs text-[var(--fs-ink)]/60">
            Only cal.com links work here. This embeds on your site&apos;s
            booking page for this project only.
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            data-testid="booking-save"
            className="w-fit rounded-xl bg-[var(--purple-primary)] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busy ? 'Saving' : connection.connected ? 'Update link' : 'Connect'}
          </button>
          {connection.connected ? (
            <button
              type="button"
              disabled={busy}
              data-testid="booking-disconnect"
              onClick={() => void send('DELETE')}
              className="w-fit rounded-xl border border-[var(--fs-glass-edge)] px-5 py-2.5 text-sm font-semibold text-[var(--fs-ink)] disabled:opacity-60"
            >
              Disconnect
            </button>
          ) : null}
        </div>
      </form>

      {/* Outside the form on purpose: both the paste and the "make me one"
          button below report through the same two lines, so a client always
          reads the outcome of whatever they just pressed in one place. */}
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-sm text-emerald-700" data-testid="booking-saved">
          Saved.
        </p>
      ) : null}

      <section
        className="flex flex-col gap-3 rounded-2xl border border-[var(--fs-glass-edge)] bg-white/60 px-5 py-5"
        data-testid="booking-provision"
      >
        <h2 className="text-sm font-semibold text-[var(--fs-ink)]">
          Or let us make you one
        </h2>
        <p className="text-sm text-[var(--fs-ink)]/70">
          We can make the booking page for you, on our own calendar, and put it
          straight onto your site. Nothing to sign up for: we email you a link
          to set a password once it is ready, and you change your hours from
          there.
        </p>
        <button
          type="button"
          disabled={busy}
          data-testid="booking-provision-button"
          onClick={() => void provision()}
          className="w-fit rounded-xl border border-[var(--fs-glass-edge)] px-5 py-2.5 text-sm font-semibold text-[var(--fs-ink)] disabled:opacity-60"
        >
          {busy
            ? 'Setting up'
            : connection.connected
            ? 'Set it up again'
            : 'Set up my booking page'}
        </button>
      </section>

      {connection.connected ? (
        <WebhookInstructions
          webhookUrl={connection.webhookUrl}
          webhookSecret={connection.webhookSecret}
        />
      ) : null}
    </div>
  );
}

/**
 * The two strings a client pastes into Cal.com, and what to do with them.
 *
 * Written as steps rather than prose because that is how the person doing it
 * reads it, with Cal.com open in the other tab. The secret is shown in full:
 * it is theirs, it is only useful against their own workspace, and a masked
 * value they cannot copy would make the whole block useless.
 */
function WebhookInstructions({
  webhookUrl,
  webhookSecret,
}: {
  webhookUrl: string;
  webhookSecret: string | null;
}) {
  return (
    <section
      className="flex flex-col gap-3 rounded-2xl border border-[var(--fs-glass-edge)] bg-white/60 px-5 py-5"
      data-testid="booking-webhook-setup"
    >
      <h2 className="text-sm font-semibold text-[var(--fs-ink)]">
        Show your bookings on this dashboard
      </h2>
      <p className="text-sm text-[var(--fs-ink)]/70">
        Your calendar already works without this. Do these three things in
        Cal.com and your bookings will also appear here, so you can see what is
        coming up without leaving your project.
      </p>
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm text-[var(--fs-ink)]/80">
        <li>
          In Cal.com, open Settings, then Developer, then Webhooks, and add a
          new webhook.
        </li>
        <li>
          <p className="mb-1">Paste this as the subscriber URL:</p>
          <CopyField
            label="Webhook URL"
            value={webhookUrl}
            testId="booking-webhook-url"
          />
        </li>
        <li>
          <p className="mb-1">
            Paste this as the secret, and tick the events Booking created,
            Booking rescheduled and Booking cancelled:
          </p>
          <CopyField
            label="Signing secret"
            value={webhookSecret ?? ''}
            testId="booking-webhook-secret"
          />
        </li>
      </ol>
      <p className="text-xs text-[var(--fs-ink)]/60">
        Keep the secret to yourself. It is what proves a booking really came
        from your Cal.com account. Disconnecting clears it, and connecting again
        gives you a new one.
      </p>
    </section>
  );
}

function CopyField({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <code
        data-testid={testId}
        aria-label={label}
        className="flex-1 overflow-x-auto rounded-lg border border-[var(--fs-glass-edge)] bg-white px-3 py-2 font-mono text-xs text-[var(--fs-ink)]"
      >
        {value}
      </code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => setCopied(true),
            () => setCopied(false)
          );
        }}
        className="rounded-lg border border-[var(--fs-glass-edge)] px-3 py-2 text-xs font-semibold text-[var(--fs-ink)]"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
