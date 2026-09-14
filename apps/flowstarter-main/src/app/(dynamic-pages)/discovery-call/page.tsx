/**
 * `/discovery-call` -- the one page the "book a call" copy points at.
 *
 * Until this existed, three marketing pages promised a call and each one opened
 * a modal that had nowhere to send anybody: `/contact`, `/help` and `/faq` all
 * said "book a call" and the site could not take a booking. The fix is not more
 * copy, it is one route that either shows the real calendar or admits there
 * isn't one and takes the enquiry instead.
 *
 * A server component because the decision is an environment fact
 * (`DMPRESEARCH_DISCOVERY_CAL_URL`, else `CAL_BASE_URL`), read once here and
 * handed down. The visitor's name and email are not prefilled on this route,
 * unlike the funnel's offer: somebody arriving from `/faq` has not told us
 * anything yet, and Cal's own form is the first place they will.
 */
import {
  discoveryCallBookingUrl,
  discoveryCallEmbedSrc,
} from '@/lib/flowstarter/discovery-call';
import { DiscoveryCallPage } from './DiscoveryCallPage';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <DiscoveryCallPage
      bookingUrl={discoveryCallBookingUrl()}
      embedSrc={discoveryCallEmbedSrc()}
    />
  );
}
