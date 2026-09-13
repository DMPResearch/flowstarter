/**
 * The environment a local preview's child process is allowed to see.
 *
 * `astro dev` over a generated site is tenant code executing. When it was
 * spawned with `env: process.env` it inherited everything this app holds — the
 * Supabase service-role key, the Clerk secret, the Stripe key, every provider
 * token — and a site's build-time module only has to read `process.env` to
 * have them. The environment rule in `local-preview-guard.ts` says *whether*
 * such a child may be spawned at all; this says what it gets to know when it
 * is.
 *
 * It is an allow-list, not a deny-list, for the reason every scrubbing rule
 * ends up being one: a deny-list is correct only until the next secret is
 * added to this app's environment, and nobody remembers to come back here.
 * Anything not named below is simply absent from the child.
 */

/**
 * What a Node toolchain genuinely needs to start: where its binaries are,
 * where it may write, and the locale it prints in. `NODE_ENV` is on the list
 * because Astro and Vite branch on it and a preview that thinks it is a
 * production build serves the wrong thing.
 */
export const PREVIEW_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'NODE_ENV',
  'SHELL',
  'TMPDIR',
  'TZ',
  'LANG',
  'LC_ALL',
  // Windows cannot spawn a process at all without these.
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
];

/**
 * The preview's own settings. They are the flag that permitted this child in
 * the first place and the host it advertises itself on, so they are values the
 * preview is entitled to and the only Flowstarter variables it gets.
 */
export const PREVIEW_ENV_PASSTHROUGH: readonly string[] = [
  'FLOWSTARTER_LOCAL_PREVIEW',
  'FLOWSTARTER_LOCAL_PREVIEW_HOST',
];

/** Settings every preview child gets, whatever the host's environment says. */
const PREVIEW_ENV_FIXED: Record<string, string> = {
  // Nothing about a preview should phone an analytics endpoint or open an
  // interactive prompt on a server.
  CI: '1',
  ASTRO_TELEMETRY_DISABLED: '1',
  DO_NOT_TRACK: '1',
};

/**
 * The assembled environment for a preview child process.
 *
 * Built from an allow-list rather than filtered out of `process.env`, so the
 * result is exactly the keys named above and whatever the caller adds
 * explicitly — a preview-specific value such as a port belongs in `extra`, not
 * in a new exception to the list.
 */
export function scrubbedPreviewEnv(
  env: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const child: Record<string, string> = { ...PREVIEW_ENV_FIXED };
  for (const key of [...PREVIEW_ENV_ALLOWLIST, ...PREVIEW_ENV_PASSTHROUGH]) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) child[key] = value;
  }
  // This app's `environment.d.ts` declares NODE_ENV as always present, while a
  // scrubbed environment is assembled key by key and carries it only if the
  // host had it. The cast is the one place those two facts meet, rather than
  // at every call site.
  return { ...child, ...extra } as NodeJS.ProcessEnv;
}
