/**
 * Builds the payload the public contact form (`/contact`) posts to
 * `POST /api/contact`. Kept as a pure function, separate from the page
 * component, so its shape can be asserted directly against the API's Zod
 * schema (`src/app/api/contact/route.ts`) in tests instead of drifting apart
 * silently.
 */
import type { ContactFormData } from '@/hooks/useContactForm';

export interface ContactFormFields {
  name: string;
  email: string;
  subject: string;
  message: string;
  /** Honeypot — see `ContactFormData['website']`. Omitted fields default to
   * empty, which is what a real visitor's untouched hidden input sends. */
  website?: string;
}

export function buildContactPayload(
  fields: ContactFormFields
): ContactFormData {
  return {
    name: fields.name,
    email: fields.email,
    subject: fields.subject,
    message: fields.message,
    website: fields.website ?? '',
  };
}
