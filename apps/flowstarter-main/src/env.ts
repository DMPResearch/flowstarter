import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

export const env = createEnv({
  /*
   * ─── Server-side Environment Variables ───────────────────────────────
   * These are only available on the server and will throw if accessed
   * on the client.
   */
  server: {
    // Supabase
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    SUPABASE_PROJECT_REF: z.string().optional(),

    // Clerk Authentication
    CLERK_SECRET_KEY: z.string().min(1),
    CLERK_SUPABASE_TEMPLATE: z.string().default('supabase'),
    CLERK_WEBHOOK_SECRET: z.string().optional(),

    // AI Services
    OPENROUTER_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default('gpt-4o-mini'),
    AI_AUDIT_ENC_KEY: z.string().optional(),

    // GoDaddy Domain API
    GODADDY_API_KEY: z.string().optional(),
    GODADDY_API_SECRET: z.string().optional(),
    GODADDY_USE_PRODUCTION: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    // name.com Domain API
    NAME_COM_USERNAME: z.string().optional(),
    NAME_COM_TOKEN: z.string().optional(),
    NAME_COM_SANDBOX: z.string().optional(),

    // Cloudflare Nameservers (comma-separated)
    CLOUDFLARE_NAMESERVERS: z.string().optional(),

    // Cloudflare DNS API (Slice 2 — operator uses this to upsert client DNS records)
    // Token scope: Zone.Zone (read), Zone.DNS (edit). NOT the same as R2 keys below.
    CLOUDFLARE_API_TOKEN: z.string().optional(),
    CLOUDFLARE_DEFAULT_ZONE_ID: z.string().optional(),

    // Hetzner Cloud (Slice 2 — operator uses this to provision servers + Docker hosts)
    HETZNER_API_TOKEN: z.string().optional(),
    HETZNER_SSH_KEY_ID: z.string().optional(),

    // Hetzner operator service (Slice 2 — flowstarter-main calls this for long-running ops)
    HETZNER_OPERATOR_URL: z.string().url().optional(),
    HETZNER_OPERATOR_SECRET: z.string().optional(),

    // UploadThing (File Uploads)
    UPLOADTHING_SECRET: z.string().optional(),
    UPLOADTHING_APP_ID: z.string().optional(),

    // Upstash Redis (Rate Limiting)
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

    // Google OAuth & Analytics
    GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
    GOOGLE_ANALYTICS_CREDENTIALS: z.string().optional(),

    // Stripe Payments (concierge platform billing — NOT per-project client integrations)
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    // Stripe Product ID used for all concierge subscriptions. Create once in
    // the Stripe dashboard (e.g. "Flowstarter Concierge"), reuse for every
    // client. Per-client monthly amount lives on the Price, not the Product.
    STRIPE_CONCIERGE_PRODUCT_ID: z.string().optional(),

    // Email
    RESEND_API_KEY: z.string().optional(),

    // Linear
    LINEAR_API_KEY: z.string().optional(),

    // Calendly
    CALENDLY_CLIENT_ID: z.string().optional(),
    CALENDLY_CLIENT_SECRET: z.string().optional(),

    // Cloudflare R2 Storage
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),

    // Cross-app Communication
    INVITE_TOKEN_SECRET: z.string().optional(),

    // Runtime
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
    // Which environment this process is (see src/lib/supabase-target.ts).
    // Optional: NODE_ENV alone cannot name `staging`, so this is how a
    // staging deploy (which otherwise runs with NODE_ENV=production) says so.
    FLOWSTARTER_ENV: z
      .enum(['development', 'test', 'staging', 'production'])
      .optional(),
    // Explicit override to let development or staging point at a hosted
    // Supabase project. Unset (or anything other than '1') keeps the guard on.
    FLOWSTARTER_ALLOW_REMOTE_SUPABASE: z.enum(['1', '0']).optional(),
  },

  /*
   * ─── Client-side Environment Variables ───────────────────────────────
   * Exposed to the browser. Must use the `NEXT_PUBLIC_` prefix.
   */
  client: {
    // Supabase
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),

    // Clerk Authentication
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
    NEXT_PUBLIC_CLERK_SIGN_IN_URL: z.string().default('/login'),
    NEXT_PUBLIC_CLERK_SIGN_UP_URL: z.string().default('/sign-up'),
    NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL: z.string().default('/dashboard'),
    NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL: z.string().default('/dashboard'),

    // Stripe (publishable key is safe for client)
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),

    // Analytics
    NEXT_PUBLIC_GA_MEASUREMENT_ID: z.string().optional(),

    // Site Config
    NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
    NEXT_PUBLIC_APP_URL: z.string().url().optional(),
    /**
     * Comma-separated absolute origins for LAN / multi-port dev (Clerk + CORS).
     * Example: `http://192.168.1.5:3000,http://192.168.1.5:5733`
     */
    NEXT_PUBLIC_EXTRA_REDIRECT_ORIGINS: z.string().optional(),
    NEXT_PUBLIC_VERCEL_URL: z.string().optional(),
  },

  /*
   * ─── Runtime values ──────────────────────────────────────────────────
   * Map env vars to the schema. Required for tree-shaking in Next.js.
   * ⚠️  DO NOT put actual secret values here — these are read from
   *     `process.env` at runtime.
   */
  runtimeEnv: {
    // Server
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_PROJECT_REF: process.env.SUPABASE_PROJECT_REF,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    CLERK_SUPABASE_TEMPLATE: process.env.CLERK_SUPABASE_TEMPLATE,
    CLERK_WEBHOOK_SECRET: process.env.CLERK_WEBHOOK_SECRET,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    AI_AUDIT_ENC_KEY: process.env.AI_AUDIT_ENC_KEY,
    GODADDY_API_KEY: process.env.GODADDY_API_KEY,
    GODADDY_API_SECRET: process.env.GODADDY_API_SECRET,
    GODADDY_USE_PRODUCTION: process.env.GODADDY_USE_PRODUCTION,
    NAME_COM_USERNAME: process.env.NAME_COM_USERNAME,
    NAME_COM_TOKEN: process.env.NAME_COM_TOKEN,
    NAME_COM_SANDBOX: process.env.NAME_COM_SANDBOX,
    CLOUDFLARE_NAMESERVERS: process.env.CLOUDFLARE_NAMESERVERS,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_DEFAULT_ZONE_ID: process.env.CLOUDFLARE_DEFAULT_ZONE_ID,
    HETZNER_API_TOKEN: process.env.HETZNER_API_TOKEN,
    HETZNER_SSH_KEY_ID: process.env.HETZNER_SSH_KEY_ID,
    HETZNER_OPERATOR_URL: process.env.HETZNER_OPERATOR_URL,
    HETZNER_OPERATOR_SECRET: process.env.HETZNER_OPERATOR_SECRET,
    UPLOADTHING_SECRET: process.env.UPLOADTHING_SECRET,
    UPLOADTHING_APP_ID: process.env.UPLOADTHING_APP_ID,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_ANALYTICS_CREDENTIALS: process.env.GOOGLE_ANALYTICS_CREDENTIALS,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_CONCIERGE_PRODUCT_ID: process.env.STRIPE_CONCIERGE_PRODUCT_ID,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    LINEAR_API_KEY: process.env.LINEAR_API_KEY,
    CALENDLY_CLIENT_ID: process.env.CALENDLY_CLIENT_ID,
    CALENDLY_CLIENT_SECRET: process.env.CALENDLY_CLIENT_SECRET,
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    INVITE_TOKEN_SECRET: process.env.INVITE_TOKEN_SECRET,
    NODE_ENV: process.env.NODE_ENV,
    FLOWSTARTER_ENV: process.env.FLOWSTARTER_ENV,
    FLOWSTARTER_ALLOW_REMOTE_SUPABASE:
      process.env.FLOWSTARTER_ALLOW_REMOTE_SUPABASE,

    // Client
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_CLERK_SIGN_IN_URL: process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL,
    NEXT_PUBLIC_CLERK_SIGN_UP_URL: process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL,
    NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL:
      process.env.NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL,
    NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL:
      process.env.NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_GA_MEASUREMENT_ID: process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_EXTRA_REDIRECT_ORIGINS:
      process.env.NEXT_PUBLIC_EXTRA_REDIRECT_ORIGINS,
    NEXT_PUBLIC_VERCEL_URL: process.env.NEXT_PUBLIC_VERCEL_URL,
  },

  /**
   * Makes it so that empty strings are treated as undefined.
   * `SOME_VAR: z.string()` and `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,

  /**
   * Skip validation in Docker builds or CI where env vars aren't available.
   * Set SKIP_ENV_VALIDATION=1 to bypass.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
