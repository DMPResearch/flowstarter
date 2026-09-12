'use client';

import { useMutation } from '@tanstack/react-query';

export interface ContactFormData {
  name: string;
  email: string;
  subject: string;
  company?: string;
  message: string;
  /** Honeypot — a real visitor never sees or fills this (see the `contact`
   * page's hidden input). A non-empty value is treated as a bot and the
   * route returns its normal success shape without inserting or notifying. */
  website?: string;
}

export function useContactForm() {
  return useMutation({
    mutationFn: async (
      data: ContactFormData
    ): Promise<{ success: boolean }> => {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to send message');
      }
      return res.json();
    },
  });
}
