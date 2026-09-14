/**
 * Where a Clerk sign-in ticket is allowed to land.
 *
 * A sign-in ticket is a bearer credential: whoever holds it becomes the user
 * who minted it, operator accounts included. `isSafeRedirectUrl` in this same
 * package answers a much weaker question — "is this a page on our platform?" —
 * and answers it `true` for every generated client site, because those are
 * served at `{slug}.{platformDomain}` and share the platform's last two
 * hostname labels. Handing a ticket to one of those is handing the tenant the
 * session of whoever clicked the link.
 *
 * So credentials get their own rule, and it is an allow-list, not a shape
 * test. Only origins the operator runs may receive a ticket:
 *
 *   - the app itself,
 *   - the editor,
 *   - the template library,
 *   - in development only, the loopback/LAN origins named explicitly in the
 *     environment.
 *
 * Everything else is refused, including the three shapes that look like the
 * platform and are not the operator: tenant sites (`{slug}.{domain}`),
 * hosted previews (`*.preview.*`) and PR slots (`pr-<n>.staging.*`). Those
 * three are refused a second time, independently of the allow-list, so a
 * mistyped `AUTH_TRANSFER_*_ORIGIN` cannot reopen the hole by naming one.
 *
 * The module is pure. Every decision is a function of the candidate URL and an
 * environment record; `readAuthTransferEnvFromProcess()` is the only thing
 * that reads `process.env`, and callers may pass their own record instead.
 */

import { resolvePlatformDomain } from './index';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** The three operator-owned surfaces a signed-in person can be handed to. */
export type AuthTransferSurface = 'app' | 'editor' | 'library';

/** Why a destination was refused. Logged; never shown to the visitor. */
export type AuthTransferRefusal =
  /** Not a parsable absolute URL, or carries an encoded path separator. */
  | 'malformed'
  /** `http:` outside development, or any scheme that is not http(s). */
  | 'insecure-scheme'
  /** `https://editor.example@attacker.example`: an authority in disguise. */
  | 'embedded-credentials'
  /** Parses fine, but no operator surface answers on that origin. */
  | 'untrusted-origin'
  /** Operator origin, but the path is not one a ticket may land on. */
  | 'path-not-allowed';

/** One entry of the allow-list: an origin plus the paths it will accept. */
export interface AuthTransferOrigin {
  readonly surface: AuthTransferSurface;
  /** Scheme + host + port, exactly as `URL.origin` renders it. */
  readonly origin: string;
  /**
   * Path prefixes a ticket may land on, matched on segment boundaries, so
   * `/admin` admits `/admin` and `/admin/dashboard` but never `/adminx`.
   * The single prefix `'/'` means the whole origin, and is only given to a
   * surface where every page is an operator page.
   */
  readonly pathPrefixes: readonly string[];
}

export type AuthTransferDecision =
  | {
      readonly allowed: true;
      /** The normalised destination. Use this, not the caller's string. */
      readonly url: string;
      readonly origin: string;
      readonly surface: AuthTransferSurface;
    }
  | {
      readonly allowed: false;
      readonly reason: AuthTransferRefusal;
      /**
       * The origin that was refused, for the log line. `null` when the
       * candidate did not parse far enough to have one.
       */
      readonly origin: string | null;
    };

/**
 * Everything the policy needs to know about the process it runs in.
 * Passed explicitly by tests and by any caller that validates its own env;
 * `readAuthTransferEnvFromProcess()` fills it from `process.env` otherwise.
 */
export interface AuthTransferEnvInput {
  /** `FLOWSTARTER_ENV`. Authoritative when set. */
  readonly flowstarterEnv?: string;
  /** `NODE_ENV`. Consulted only when `flowstarterEnv` is absent. */
  readonly nodeEnv?: string;
  /** `PLATFORM_DOMAIN` / `NEXT_PUBLIC_PLATFORM_DOMAIN`. */
  readonly platformDomain?: string;
  /** `AUTH_TRANSFER_APP_ORIGIN`, else `NEXT_PUBLIC_SITE_URL`/`NEXT_PUBLIC_APP_URL`. */
  readonly appOrigin?: string;
  /** `AUTH_TRANSFER_EDITOR_ORIGIN`, else `NEXT_PUBLIC_EDITOR_URL`. */
  readonly editorOrigin?: string;
  /** `AUTH_TRANSFER_LIBRARY_ORIGIN`. */
  readonly libraryOrigin?: string;
}

// ---------------------------------------------------------------------------
// Environment names
// ---------------------------------------------------------------------------

/** Overrides the app origin a ticket may land on. */
export const AUTH_TRANSFER_APP_ORIGIN_ENV = 'AUTH_TRANSFER_APP_ORIGIN';
/** Overrides the editor origin a ticket may land on. */
export const AUTH_TRANSFER_EDITOR_ORIGIN_ENV = 'AUTH_TRANSFER_EDITOR_ORIGIN';
/** Overrides the template-library origin a ticket may land on. */
export const AUTH_TRANSFER_LIBRARY_ORIGIN_ENV = 'AUTH_TRANSFER_LIBRARY_ORIGIN';

/**
 * The subdomain labels the operator's own surfaces answer on, under whichever
 * domain `resolvePlatformDomain()` picked. `code` and `editor` are both the
 * editor: the app has been reached on each of them and Clerk's satellite list
 * carries both.
 */
const EDITOR_SUBDOMAINS = ['code', 'editor'] as const;
const LIBRARY_SUBDOMAIN = 'library';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * A ticket belongs on a page a person is about to look at. An API endpoint
 * would receive it as a bearer credential and log it, so no surface accepts
 * one there, whatever its own allow-list says.
 */
const REFUSED_PATH_PREFIXES = ['/api'] as const;

/**
 * The authenticated surfaces of the main app. Its marketing pages need no
 * ticket, so they do not get one.
 */
const APP_PATH_PREFIXES = [
  '/admin',
  '/dashboard',
  '/projects',
  '/unlock',
] as const;

/**
 * The editor is an operator tool end to end: a returning deep link can be any
 * thread, draft or settings page, and enumerating them here would only mean
 * breaking the return path the next time a route is added.
 */
const EDITOR_PATH_PREFIXES = ['/'] as const;

/** Every library page is a public gallery page served by the operator. */
const LIBRARY_PATH_PREFIXES = ['/'] as const;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Reads the policy's inputs from the real environment. Kept to one function so
 * the rest of the module stays pure and testable without env stubbing.
 */
export function readAuthTransferEnvFromProcess(
  source: Record<string, string | undefined> = typeof process !== 'undefined'
    ? process.env
    : {},
): AuthTransferEnvInput {
  return {
    flowstarterEnv: source.FLOWSTARTER_ENV,
    nodeEnv: source.NODE_ENV,
    platformDomain:
      source.PLATFORM_DOMAIN || source.NEXT_PUBLIC_PLATFORM_DOMAIN || undefined,
    appOrigin:
      source[AUTH_TRANSFER_APP_ORIGIN_ENV] ||
      source.NEXT_PUBLIC_SITE_URL ||
      source.NEXT_PUBLIC_APP_URL ||
      undefined,
    editorOrigin:
      source[AUTH_TRANSFER_EDITOR_ORIGIN_ENV] ||
      source.NEXT_PUBLIC_EDITOR_URL ||
      undefined,
    libraryOrigin: source[AUTH_TRANSFER_LIBRARY_ORIGIN_ENV] || undefined,
  };
}

/**
 * `true` only for a real development process. Staging runs with
 * `NODE_ENV=production` and names itself through `FLOWSTARTER_ENV`, so it
 * lands here as "not development" either way — which is the point: the
 * loopback exception below must never be live on a deployed host.
 */
function isDevelopmentEnvironment(env: AuthTransferEnvInput): boolean {
  if (env.flowstarterEnv) return env.flowstarterEnv === 'development';
  return env.nodeEnv !== 'production' && env.nodeEnv !== 'staging';
}

// ---------------------------------------------------------------------------
// Hostnames that are never the operator
// ---------------------------------------------------------------------------

/** `pr-7.staging.flowstarter.dev`: a per-pull-request staging slot. */
const PR_SLOT_LABEL = /^pr-\d+$/;

/** The label every hosted preview host carries: `p-<id>.preview.<domain>`. */
const PREVIEW_LABEL = 'preview';

/**
 * Hosts the operator does not control the contents of, however much they look
 * like the platform: generated client sites, hosted previews and PR slots.
 *
 * Client sites are the reason this exists. They are served at
 * `{slug}.{platformDomain}` from tenant-authored output, so the platform's own
 * "same root domain" test calls them trusted. Here they are refused twice:
 * once because no allow-list entry names them, and once by this predicate,
 * which also runs over configured origins so a typo in
 * `AUTH_TRANSFER_EDITOR_ORIGIN` cannot admit one.
 */
function isNeverOperatorOwned(hostname: string): boolean {
  const labels = hostname.trim().toLowerCase().split('.');
  if (labels.includes(PREVIEW_LABEL)) return true;
  return labels.some((label) => PR_SLOT_LABEL.test(label));
}

// ---------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------

/**
 * Narrows an operator-configured origin string to something a ticket may be
 * sent to, or `undefined`.
 *
 * `https` always qualifies. `http` qualifies only in development, which is the
 * single place a developer's `http://localhost:3000` or LAN address has to
 * work; a deployed host never reaches that branch, because nothing deployed
 * resolves to `development`.
 */
function acceptConfiguredOrigin(
  raw: string | undefined,
  development: boolean,
): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }

  if (parsed.username !== '' || parsed.password !== '') return undefined;
  if (isNeverOperatorOwned(parsed.hostname)) return undefined;

  if (parsed.protocol === 'https:') return parsed.origin;
  if (parsed.protocol === 'http:' && development) return parsed.origin;
  return undefined;
}

function pushOrigin(
  into: AuthTransferOrigin[],
  entry: AuthTransferOrigin | undefined,
): void {
  if (!entry) return;
  if (into.some((existing) => existing.origin === entry.origin)) return;
  into.push(entry);
}

/**
 * The origins a sign-in ticket may be sent to in this environment, each with
 * the paths it accepts. Exported so the routes can log what they compared
 * against and the docs can be checked against the code.
 */
export function authTransferAllowList(
  env: AuthTransferEnvInput = readAuthTransferEnvFromProcess(),
): AuthTransferOrigin[] {
  const development = isDevelopmentEnvironment(env);
  const domain = resolvePlatformDomain({
    override: env.platformDomain,
    flowstarterEnv: env.flowstarterEnv,
    nodeEnv: env.nodeEnv,
  });

  const entries: AuthTransferOrigin[] = [];

  pushOrigin(entries, {
    surface: 'app',
    origin: `https://${domain}`,
    pathPrefixes: APP_PATH_PREFIXES,
  });
  for (const sub of EDITOR_SUBDOMAINS) {
    pushOrigin(entries, {
      surface: 'editor',
      origin: `https://${sub}.${domain}`,
      pathPrefixes: EDITOR_PATH_PREFIXES,
    });
  }
  pushOrigin(entries, {
    surface: 'library',
    origin: `https://${LIBRARY_SUBDOMAIN}.${domain}`,
    pathPrefixes: LIBRARY_PATH_PREFIXES,
  });

  const configured: ReadonlyArray<
    readonly [AuthTransferSurface, string | undefined, readonly string[]]
  > = [
    ['app', env.appOrigin, APP_PATH_PREFIXES],
    ['editor', env.editorOrigin, EDITOR_PATH_PREFIXES],
    ['library', env.libraryOrigin, LIBRARY_PATH_PREFIXES],
  ];

  for (const [surface, raw, pathPrefixes] of configured) {
    const origin = acceptConfiguredOrigin(raw, development);
    if (origin) pushOrigin(entries, { surface, origin, pathPrefixes });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * An encoded slash or backslash. `/%2f%2fattacker.example` survives a naive
 * prefix test and becomes `//attacker.example` once something decodes it.
 */
const ENCODED_SEPARATOR = /%2f|%5c/i;

function pathAllowed(pathname: string, prefixes: readonly string[]): boolean {
  const path = pathname === '' ? '/' : pathname;
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  if (REFUSED_PATH_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)))
    return false;
  return prefixes.some(
    (prefix) =>
      prefix === '/' || path === prefix || path.startsWith(`${prefix}/`),
  );
}

function refused(
  reason: AuthTransferRefusal,
  origin: string | null,
): AuthTransferDecision {
  return { allowed: false, reason, origin };
}

/**
 * Decides whether a Clerk sign-in ticket may be sent to `candidate`.
 *
 * This is the only rule the transfer routes may consult. `isSafeRedirectUrl`
 * stays for ordinary navigation, where the worst outcome is landing on the
 * wrong page of the platform; it must never gate a credential.
 */
export function decideAuthTransferDestination(
  candidate: unknown,
  env: AuthTransferEnvInput = readAuthTransferEnvFromProcess(),
): AuthTransferDecision {
  if (typeof candidate !== 'string') return refused('malformed', null);

  const value = candidate.trim();
  if (value === '') return refused('malformed', null);
  // A backslash is an authority separator to browsers and a path character to
  // `URL`, so the two disagree about `https://editor.example\@attacker.example`.
  if (value.includes('\\')) return refused('malformed', null);
  if (ENCODED_SEPARATOR.test(value)) return refused('malformed', null);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return refused('malformed', null);
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return refused('embedded-credentials', parsed.origin);
  }

  // `https` everywhere. `http` is a development-only concession, and even
  // there it only gets as far as the allow-list, which carries an `http`
  // origin exactly when a developer named one in the environment.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return refused('insecure-scheme', null);
  }
  if (parsed.protocol === 'http:' && !isDevelopmentEnvironment(env)) {
    return refused('insecure-scheme', parsed.origin);
  }

  if (isNeverOperatorOwned(parsed.hostname)) {
    return refused('untrusted-origin', parsed.origin);
  }

  const entry = authTransferAllowList(env).find(
    (candidateEntry) => candidateEntry.origin === parsed.origin,
  );
  if (!entry) return refused('untrusted-origin', parsed.origin);

  if (!pathAllowed(parsed.pathname, entry.pathPrefixes)) {
    return refused('path-not-allowed', parsed.origin);
  }

  return {
    allowed: true,
    url: parsed.toString(),
    origin: parsed.origin,
    surface: entry.surface,
  };
}

// ---------------------------------------------------------------------------
// The operator's editor, on a tenant host
// ---------------------------------------------------------------------------

/**
 * A workspace slug, exactly as the editor's own `parseWorkspaceSlugFromHost`
 * will read it back off the Host header. Anything this refuses is a slug the
 * editor container would fail to route anyway.
 */
const WORKSPACE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/**
 * Where the editor answers on a workspace host. The deploy-agent's per-site
 * Caddy snippet routes `/editor/*` to the editor container
 * (`apps/deploy-agent/src/caddy-snippet.ts`), and the container's router reads
 * the workspace out of the preserved `Host`. So this path, on this host, is
 * the editor, and there is no second place it lives.
 */
const OPERATOR_EDITOR_PATH = '/editor/';

/**
 * The editor URL for one workspace, for an operator we are about to hand a
 * sign-in ticket to.
 *
 * This is deliberately NOT reachable through `decideAuthTransferDestination`,
 * and the difference is the whole point of the function.
 *
 * `decideAuthTransferDestination` answers "a browser handed me this URL; may I
 * mint a credential for it?", and its answer for `{slug}.{platformDomain}` is
 * an emphatic no -- twice over, by `isNeverOperatorOwned` and by the absence of
 * an allow-list entry. That refusal is correct and must stay: a client site is
 * tenant-authored output, and a page on one asking for a ticket is the exact
 * attack the policy was written for.
 *
 * This function answers a different question: "the server has decided to open
 * workspace X's editor for an operator; where is it?". The slug is not a
 * redirect the browser proposed, it is a column the server read, and the path
 * is a constant. Nothing a browser sends reaches this, which is a stronger
 * guarantee than an allow-list entry would have been -- adding
 * `{slug}.{domain}` to the allow-list would have re-opened the tenant-site hole
 * for every caller, to serve one caller that needs no list at all.
 *
 * `code.{domain}` and `editor.{domain}` remain on the allow-list for the
 * root-mounted editor deployment, which does not exist yet: the container's
 * router derives the workspace from the Host, so an editor at `code.{domain}`
 * would need a session-to-workspace map the router does not have. Until it
 * does, the tenant host is where the editor is, and this is how an operator
 * gets there.
 *
 * Returns the same {@link AuthTransferDecision} shape as the policy above, so
 * a caller handles a refusal identically either way.
 */
export function decideOperatorEditorDestination(
  slug: unknown,
  env: AuthTransferEnvInput = readAuthTransferEnvFromProcess(),
): AuthTransferDecision {
  if (typeof slug !== 'string') {
    return { allowed: false, reason: 'malformed', origin: null };
  }
  const normalized = slug.trim().toLowerCase();
  if (!WORKSPACE_SLUG.test(normalized)) {
    return { allowed: false, reason: 'malformed', origin: null };
  }
  const domain = resolvePlatformDomain({
    override: env.platformDomain,
    flowstarterEnv: env.flowstarterEnv,
    nodeEnv: env.nodeEnv,
  });
  const hostname = `${normalized}.${domain}`;
  // A slug that produces a `preview` or `pr-<n>` label is not a workspace we
  // own the contents of, whatever the workspaces table says. Same predicate
  // the policy above uses, asked for the same reason.
  if (isNeverOperatorOwned(hostname)) {
    return { allowed: false, reason: 'untrusted-origin', origin: `https://${hostname}` };
  }
  const development = isDevelopmentEnvironment(env);
  const scheme = development ? 'http' : 'https';
  const origin = `${scheme}://${hostname}`;
  return {
    allowed: true,
    url: `${origin}${OPERATOR_EDITOR_PATH}`,
    origin,
    surface: 'editor',
  };
}
