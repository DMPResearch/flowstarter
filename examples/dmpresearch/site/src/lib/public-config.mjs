import { z } from 'zod';

// Legacy anon keys remain useful with older local CLI stacks. This only guards
// build-time exposure; Supabase verifies the token signature on each request.
export function isPublicKey(value) {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return true;
  try {
    const parts = value.split('.');
    if (
      parts.length !== 3 ||
      parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    )
      return false;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload)).role === 'anon';
  } catch {
    return false;
  }
}

const publicConfigSchema = z.object({
  PUBLIC_SUPABASE_URL: z.url().refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(url.hostname)))
    );
  }),
  // Reject secret/service-role credentials before they can reach the bundle.
  PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().refine(isPublicKey),
  PUBLIC_TENANT_ID: z.uuid().transform((value) => value.toLowerCase()),
});

export function readPublicConfig(env) {
  const parsed = publicConfigSchema.safeParse(env);
  if (!parsed.success) {
    // Never include input values or Zod's complete error output in logs.
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path[0])),
    ];
    throw new Error(`Invalid public build configuration: ${fields.join(', ')}`);
  }
  return parsed.data;
}
