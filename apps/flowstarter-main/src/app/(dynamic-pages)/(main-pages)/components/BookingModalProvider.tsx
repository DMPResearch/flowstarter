'use client';

import { useEffect, useState } from 'react';
import { useBookingModal } from './booking-modal-store';
import { PreQualModal } from './PreQualModalLazy';

export function BookingModalProvider() {
  const { isOpen, open, close } = useBookingModal();
  const [resumeTier, setResumeTier] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);

    if (params.get('book') === '1') {
      open();
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }

    // `?deposit=paid` used to land here too, from the pre-call booking
    // deposit's success redirect, and reopened the modal on the calendar
    // step. That deposit is gone (2026-09-14) and so is the redirect; the
    // discovery call is free and is booked on `/discovery-call`. What is left
    // is the guest BUILD deposit's cancel redirect, which still comes back
    // here so somebody who abandoned Stripe can pick the wizard back up.
    if (params.get('deposit') === 'cancelled') {
      open();
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [open]);

  return (
    <PreQualModal
      open={isOpen}
      onClose={() => {
        setResumeTier(null);
        close();
      }}
      source="page"
      initialPlan={resumeTier}
    />
  );
}
