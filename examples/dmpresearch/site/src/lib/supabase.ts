import { createClient } from '@supabase/supabase-js';
import { readPublicConfig } from './public-config.mjs';

export const config = readPublicConfig({
  PUBLIC_SUPABASE_URL: import.meta.env.PUBLIC_SUPABASE_URL,
  PUBLIC_SUPABASE_PUBLISHABLE_KEY: import.meta.env
    .PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  PUBLIC_TENANT_ID: import.meta.env.PUBLIC_TENANT_ID,
});

export const supabase = createClient(
  config.PUBLIC_SUPABASE_URL,
  config.PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  {
    global: { headers: { 'x-tenant-id': config.PUBLIC_TENANT_ID } },
    auth: {
      storageKey: `dmpresearch-${config.PUBLIC_TENANT_ID}`,
      detectSessionInUrl: false,
    },
  },
);
// Header and row workspace_id select context; RLS checks live membership and JWT.
