'use client';

import { useMutation } from '@tanstack/react-query';

export interface ContactFormData {
  name: string;
  email: string;
  subject: string;
  company?: string;
  message: string;
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
