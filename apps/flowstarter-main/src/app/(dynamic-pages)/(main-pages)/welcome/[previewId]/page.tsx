/**
 * Where Stripe returns a guest who just paid their deposit.
 *
 * Public, and deliberately thin. At the moment this renders, the account may
 * not exist yet: Stripe redirects the browser and delivers the webhook
 * independently, and the webhook is the thing that mints the Clerk user, claims
 * the preview and sends the credentials. A page that promised "your account is
 * ready, sign in" would be wrong roughly half the time.
 *
 * So it promises only what is already true: the payment went through, the build
 * is starting, and the way in arrives by email. No workspace lookup, because
 * finding nothing here means "the webhook has not landed yet", not "something
 * broke", and there is no honest way to tell those apart from this side.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Your build has started',
  description: 'Your deposit is in and your website build is underway.',
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function GuestWelcomePage({
  params,
}: {
  params: Promise<{ previewId: string }>;
}) {
  const { previewId } = await params;
  if (!UUID.test(previewId)) notFound();

  return (
    <main className="ls-scope ls-section ls-section--pad ls-unlock-main">
      <div className="ls-mesh" aria-hidden />
      <div className="ls-grain" aria-hidden />
      <div className="ls-container ls-unlock">
        <p className="ls-eyebrow">Deposit received</p>
        <h1 className="ls-display ls-unlock__title">
          <span className="line">Your build has started.</span>
          <span className="line flourish mt-2">Check your email.</span>
        </h1>
        <p className="ls-body ls-body--lead ls-unlock__lead">
          The deposit went through and the agents are building the full site
          from the preview you approved. Nothing else is needed from you right
          now.
        </p>

        <ol className="ls-unlock__steps">
          <li className="ls-card ls-unlock__step">
            <span className="ls-unlock__step-n">01</span>
            <div>
              <h2 className="ls-unlock__step-title">We emailed you a way in</h2>
              <p className="ls-body">
                It goes to the address you paid with. If you did not have a
                Flowstarter account, that email has a temporary password, and
                you will be asked to choose your own the first time you sign in.
              </p>
            </div>
          </li>
          <li className="ls-card ls-unlock__step">
            <span className="ls-unlock__step-n">02</span>
            <div>
              <h2 className="ls-unlock__step-title">
                The build runs while you wait
              </h2>
              <p className="ls-body">
                You can follow it from your dashboard once you are signed in.
                The remaining 80% is only due when the finished site is
                approved.
              </p>
            </div>
          </li>
        </ol>

        <p className="ls-body ls-unlock__lead">
          The email can take a couple of minutes. If it has not arrived, look in
          spam, then{' '}
          <Link href="/contact" className="underline underline-offset-2">
            tell us
          </Link>{' '}
          and we will resend it.
        </p>
      </div>
    </main>
  );
}
