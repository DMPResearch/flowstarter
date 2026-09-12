/**
 * The numbers behind the portrait rule, pinned.
 *
 * Every threshold in this module is a number an operator can change from the
 * environment without a deploy, which is the point of the module and also the
 * risk in it: a typo in a restart script is not a crash, it is a size floor
 * that quietly means something else. So the tests below are less about
 * arithmetic than about what a misconfigured deployment does. A blank, a
 * negative, a word where a number should be: each one has to land on the
 * documented default, because a funnel that renders with a sensible floor is
 * strictly better for the client than a funnel that will not render at all.
 *
 * The cross-over guard gets its own attention. An avatar floor above the
 * portrait floor is not a stricter policy, it is a rule with no middle, and a
 * rule with no middle is how a picture ends up simultaneously too small to be
 * an avatar and large enough to be a hero. That case collapses both numbers to
 * the defaults, and this file is where that promise is kept.
 *
 * Nothing here reads `process.env` at import time, so every fixture is a plain
 * object built inline and no test has to mutate global state to say what it
 * means.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AVATAR_EDGE_ENV_VAR,
  DEFAULT_AVATAR_EDGE,
  DEFAULT_MAX_PORTRAIT_BYTES,
  DEFAULT_PORTRAIT_EDGE,
  DEFAULT_PORTRAIT_PROVIDER_TIMEOUT_MS,
  DEFAULT_PORTRAIT_STATE_TTL_MS,
  DEFAULT_GITHUB_AVATAR_EDGE,
  DEFAULT_MAX_IMG_TAGS_SCANNED,
  DEFAULT_MAX_PORTRAIT_HTML_BYTES,
  DEFAULT_PORTRAIT_AUTO_TIMEOUT_MS,
  DEFAULT_PORTRAIT_HEADING_WINDOW_CHARS,
  GITHUB_AVATAR_EDGE_ENV_VAR,
  MAX_IMG_TAGS_SCANNED_ENV_VAR,
  MAX_PORTRAIT_BYTES_ENV_VAR,
  MAX_PORTRAIT_HTML_BYTES_ENV_VAR,
  PORTRAIT_AUTO_TIMEOUT_ENV_VAR,
  PORTRAIT_EDGE_ENV_VAR,
  PORTRAIT_HEADING_WINDOW_ENV_VAR,
  PORTRAIT_PROVIDERS,
  PORTRAIT_PROVIDER_ENV_VARS,
  PORTRAIT_PROVIDER_TIMEOUT_ENV_VAR,
  PORTRAIT_STATE_SECRET_ENV_VAR,
  PORTRAIT_STATE_TTL_ENV_VAR,
  configuredPortraitProviders,
  isPortraitProvider,
  portraitAutoBudgets,
  portraitBudgets,
  portraitProviderCredentials,
  portraitSizeFloors,
  portraitStateSecret,
  positiveIntFromEnv,
  type EnvLike,
} from '../portrait-config';
import {
  BLANK_CREDENTIAL,
  WHITESPACE_ONLY_CREDENTIAL,
  portraitTestCredentials,
  testCredential,
} from './portrait-test-credentials';

/**
 * A deployment with both providers wired up, minted per run and never
 * committed. See `portrait-test-credentials.ts` for why a fixture that merely
 * looks like a secret is still a problem worth removing.
 */
const BOTH_PROVIDERS: EnvLike = portraitTestCredentials();

const LINKEDIN_ID = BOTH_PROVIDERS.LINKEDIN_CLIENT_ID as string;
const LINKEDIN_SECRET = BOTH_PROVIDERS.LINKEDIN_CLIENT_SECRET as string;
const INSTAGRAM_ID = BOTH_PROVIDERS.INSTAGRAM_APP_ID as string;
const INSTAGRAM_SECRET = BOTH_PROVIDERS.INSTAGRAM_APP_SECRET as string;

/** The two ways an operator can name the key the connect state is signed with. */
const EXPLICIT_STATE_SECRET = testCredential('portrait-state-explicit');
const LIVE_STATE_SECRET = testCredential('portrait-state-live');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('positiveIntFromEnv', () => {
  // The ordinary case: an operator set a number and we use it.
  it('takes a positive integer the operator actually set', () => {
    expect(positiveIntFromEnv('640', 400)).toBe(640);
  });

  // Zero is not a floor, it is the absence of one, so it cannot be a policy.
  it('refuses zero and falls back to the documented default', () => {
    expect(positiveIntFromEnv('0', 400)).toBe(400);
  });

  // A negative pixel count is a typo every time, never an intention.
  it('refuses a negative value', () => {
    expect(positiveIntFromEnv('-200', 400)).toBe(400);
  });

  // A word where a number belongs should leave a working funnel behind, not a
  // NaN that spreads into every comparison downstream.
  it('refuses a value that is not a number at all', () => {
    expect(positiveIntFromEnv('large', 400)).toBe(400);
  });

  // Nothing set is the normal case on a developer machine.
  it('uses the default when the variable is not set', () => {
    expect(positiveIntFromEnv(undefined, 400)).toBe(400);
  });

  // A variable set to spaces is set as far as the shell is concerned, and it
  // still has to mean "nothing" to us.
  it('treats a whitespace-only value as unset', () => {
    expect(positiveIntFromEnv('   ', 400)).toBe(400);
    expect(positiveIntFromEnv('\n\t', 400)).toBe(400);
  });

  // Surrounding whitespace is what a copied .env line looks like.
  it('trims before parsing so a padded value still counts', () => {
    expect(positiveIntFromEnv('  512  ', 400)).toBe(512);
  });
});

describe('portraitSizeFloors', () => {
  // With nothing set, the floors are the two numbers the templates and
  // `profile-picture.ts` already agree on.
  it('uses the documented defaults when neither variable is set', () => {
    expect(portraitSizeFloors({})).toEqual({
      portraitEdge: DEFAULT_PORTRAIT_EDGE,
      avatarEdge: DEFAULT_AVATAR_EDGE,
    });
  });

  // An operator running a demo on low-resolution stock photography needs to be
  // able to lower both without a deploy.
  it('takes both floors from the environment when both are set', () => {
    expect(
      portraitSizeFloors({
        [PORTRAIT_EDGE_ENV_VAR]: '600',
        [AVATAR_EDGE_ENV_VAR]: '120',
      })
    ).toEqual({ portraitEdge: 600, avatarEdge: 120 });
  });

  // One set and one not is an ordinary partial override, not a mistake.
  it('overrides one floor and defaults the other', () => {
    expect(portraitSizeFloors({ [PORTRAIT_EDGE_ENV_VAR]: '800' })).toEqual({
      portraitEdge: 800,
      avatarEdge: DEFAULT_AVATAR_EDGE,
    });
    expect(portraitSizeFloors({ [AVATAR_EDGE_ENV_VAR]: '64' })).toEqual({
      portraitEdge: DEFAULT_PORTRAIT_EDGE,
      avatarEdge: 64,
    });
  });

  // The load-bearing guard. An avatar floor above the portrait floor leaves no
  // band of sizes that is avatar-only, so the middle of the rule disappears and
  // a picture can be too small to be an avatar and big enough to be a hero at
  // the same time. A rule with no middle is worse for the client than the
  // default numbers, so BOTH collapse back rather than one being clamped to the
  // other and silently changing a floor the operator did set on purpose.
  it('collapses both floors to the defaults when the avatar floor crosses over the portrait floor', () => {
    expect(
      portraitSizeFloors({
        [PORTRAIT_EDGE_ENV_VAR]: '200',
        [AVATAR_EDGE_ENV_VAR]: '500',
      })
    ).toEqual({
      portraitEdge: DEFAULT_PORTRAIT_EDGE,
      avatarEdge: DEFAULT_AVATAR_EDGE,
    });
  });

  // Equal floors are coherent: there is simply no avatar-only band. That is a
  // policy somebody can mean, so it is left alone.
  it('leaves equal floors alone, because a zero-width middle is still a rule', () => {
    expect(
      portraitSizeFloors({
        [PORTRAIT_EDGE_ENV_VAR]: '300',
        [AVATAR_EDGE_ENV_VAR]: '300',
      })
    ).toEqual({ portraitEdge: 300, avatarEdge: 300 });
  });

  // A junk override should not be able to trip the cross-over guard either: it
  // is not set, so the defaults apply and the defaults do not cross over.
  it('falls back before it compares, so junk does not trigger the guard', () => {
    expect(
      portraitSizeFloors({
        [PORTRAIT_EDGE_ENV_VAR]: 'huge',
        [AVATAR_EDGE_ENV_VAR]: '-1',
      })
    ).toEqual({
      portraitEdge: DEFAULT_PORTRAIT_EDGE,
      avatarEdge: DEFAULT_AVATAR_EDGE,
    });
  });

  // No argument means the live environment, which is what every route does.
  it('reads the live environment when no environment is passed', () => {
    vi.stubEnv(PORTRAIT_EDGE_ENV_VAR, '900');
    vi.stubEnv(AVATAR_EDGE_ENV_VAR, '90');
    expect(portraitSizeFloors()).toEqual({
      portraitEdge: 900,
      avatarEdge: 90,
    });
  });
});

describe('portraitBudgets', () => {
  // Nothing set is the shipped configuration, so the defaults are the contract.
  it('uses the documented defaults when nothing is set', () => {
    expect(portraitBudgets({})).toEqual({
      providerTimeoutMs: DEFAULT_PORTRAIT_PROVIDER_TIMEOUT_MS,
      stateTtlMs: DEFAULT_PORTRAIT_STATE_TTL_MS,
      maxBytes: DEFAULT_MAX_PORTRAIT_BYTES,
    });
  });

  // Each budget is independently tunable, because a slow provider and a large
  // picture are different problems on different days.
  it('takes every budget from the environment when they are set', () => {
    expect(
      portraitBudgets({
        [PORTRAIT_PROVIDER_TIMEOUT_ENV_VAR]: '1500',
        [PORTRAIT_STATE_TTL_ENV_VAR]: '60000',
        [MAX_PORTRAIT_BYTES_ENV_VAR]: '1048576',
      })
    ).toEqual({
      providerTimeoutMs: 1500,
      stateTtlMs: 60000,
      maxBytes: 1048576,
    });
  });

  // A budget of zero would mean "give up before you start", which is never what
  // somebody typing a zero meant.
  it('falls back per budget, so one bad value does not take the others down', () => {
    expect(
      portraitBudgets({
        [PORTRAIT_PROVIDER_TIMEOUT_ENV_VAR]: '0',
        [PORTRAIT_STATE_TTL_ENV_VAR]: '30000',
        [MAX_PORTRAIT_BYTES_ENV_VAR]: 'four megabytes',
      })
    ).toEqual({
      providerTimeoutMs: DEFAULT_PORTRAIT_PROVIDER_TIMEOUT_MS,
      stateTtlMs: 30000,
      maxBytes: DEFAULT_MAX_PORTRAIT_BYTES,
    });
  });

  // The route calls this with no argument, so the live environment path has to
  // work as well as the injected one.
  it('reads the live environment when no environment is passed', () => {
    vi.stubEnv(PORTRAIT_PROVIDER_TIMEOUT_ENV_VAR, '2222');
    vi.stubEnv(PORTRAIT_STATE_TTL_ENV_VAR, undefined);
    vi.stubEnv(MAX_PORTRAIT_BYTES_ENV_VAR, undefined);
    expect(portraitBudgets()).toEqual({
      providerTimeoutMs: 2222,
      stateTtlMs: DEFAULT_PORTRAIT_STATE_TTL_MS,
      maxBytes: DEFAULT_MAX_PORTRAIT_BYTES,
    });
  });
});

describe('portraitProviderCredentials', () => {
  // The happy case, and the only one where a button may be live.
  it('reports a provider configured when both halves are present', () => {
    expect(portraitProviderCredentials('linkedin', BOTH_PROVIDERS)).toEqual({
      provider: 'linkedin',
      clientId: LINKEDIN_ID,
      clientSecret: LINKEDIN_SECRET,
      configured: true,
    });
    expect(portraitProviderCredentials('instagram', BOTH_PROVIDERS)).toEqual({
      provider: 'instagram',
      clientId: INSTAGRAM_ID,
      clientSecret: INSTAGRAM_SECRET,
      configured: true,
    });
  });

  // Half a credential cannot complete an exchange, so it must not light a
  // button that will fail after the person has left our site.
  it('refuses to call a provider configured on the id alone', () => {
    const credentials = portraitProviderCredentials('linkedin', {
      LINKEDIN_CLIENT_ID: LINKEDIN_ID,
    });
    expect(credentials.clientId).toBe(LINKEDIN_ID);
    expect(credentials.clientSecret).toBe('');
    expect(credentials.configured).toBe(false);
  });

  // The same on the other side: a secret with nothing to identify us with.
  it('refuses to call a provider configured on the secret alone', () => {
    const credentials = portraitProviderCredentials('instagram', {
      INSTAGRAM_APP_SECRET: INSTAGRAM_SECRET,
    });
    expect(credentials.clientId).toBe('');
    expect(credentials.clientSecret).toBe(INSTAGRAM_SECRET);
    expect(credentials.configured).toBe(false);
  });

  // A developer machine with nothing set at all.
  it('reports nothing configured when neither half is set', () => {
    expect(portraitProviderCredentials('linkedin', {})).toEqual({
      provider: 'linkedin',
      clientId: '',
      clientSecret: '',
      configured: false,
    });
  });

  // A variable set to spaces is the shape a half-finished .env has, and it has
  // to count as absent rather than as a credential made of whitespace.
  it('treats whitespace-only credentials as absent', () => {
    const credentials = portraitProviderCredentials('linkedin', {
      LINKEDIN_CLIENT_ID: BLANK_CREDENTIAL,
      LINKEDIN_CLIENT_SECRET: WHITESPACE_ONLY_CREDENTIAL,
    });
    expect(credentials.clientId).toBe('');
    expect(credentials.clientSecret).toBe('');
    expect(credentials.configured).toBe(false);
  });

  // Surrounding whitespace on a real value is a copy-paste artefact, and the
  // exchange would fail byte for byte if we sent it on.
  it('trims a credential that was pasted with padding', () => {
    const credentials = portraitProviderCredentials('instagram', {
      INSTAGRAM_APP_ID: `  ${INSTAGRAM_ID}\n`,
      INSTAGRAM_APP_SECRET: ` ${INSTAGRAM_SECRET} `,
    });
    expect(credentials.clientId).toBe(INSTAGRAM_ID);
    expect(credentials.clientSecret).toBe(INSTAGRAM_SECRET);
    expect(credentials.configured).toBe(true);
  });

  // The env names are the contract between the docs, the .env.example and the
  // disabled-button copy, so they are worth pinning by name.
  it('reads the env names the documentation promises', () => {
    expect(PORTRAIT_PROVIDER_ENV_VARS.linkedin).toEqual({
      id: 'LINKEDIN_CLIENT_ID',
      secret: 'LINKEDIN_CLIENT_SECRET',
    });
    expect(PORTRAIT_PROVIDER_ENV_VARS.instagram).toEqual({
      id: 'INSTAGRAM_APP_ID',
      secret: 'INSTAGRAM_APP_SECRET',
    });
  });

  // The route reads credentials with no environment argument.
  it('reads the live environment when no environment is passed', () => {
    vi.stubEnv('LINKEDIN_CLIENT_ID', 'live-id');
    vi.stubEnv('LINKEDIN_CLIENT_SECRET', 'live-secret');
    expect(portraitProviderCredentials('linkedin')).toEqual({
      provider: 'linkedin',
      clientId: 'live-id',
      clientSecret: 'live-secret',
      configured: true,
    });
  });
});

describe('configuredPortraitProviders', () => {
  // What the intake reads to decide which buttons are live.
  it('lists both providers when both are wired up', () => {
    expect(configuredPortraitProviders(BOTH_PROVIDERS)).toEqual([
      'linkedin',
      'instagram',
    ]);
  });

  // A deployment with one provider is the common staging shape.
  it('lists only the provider that has both halves', () => {
    expect(
      configuredPortraitProviders({
        LINKEDIN_CLIENT_ID: LINKEDIN_ID,
        LINKEDIN_CLIENT_SECRET: LINKEDIN_SECRET,
        INSTAGRAM_APP_ID: INSTAGRAM_ID,
      })
    ).toEqual(['linkedin']);
  });

  // An id with no secret anywhere is not a provider we can offer.
  it('lists nothing when only ids are set', () => {
    expect(
      configuredPortraitProviders({
        LINKEDIN_CLIENT_ID: LINKEDIN_ID,
        INSTAGRAM_APP_ID: INSTAGRAM_ID,
      })
    ).toEqual([]);
  });

  // Only secrets is the mirror image, and just as unusable.
  it('lists nothing when only secrets are set', () => {
    expect(
      configuredPortraitProviders({
        LINKEDIN_CLIENT_SECRET: LINKEDIN_SECRET,
        INSTAGRAM_APP_SECRET: INSTAGRAM_SECRET,
      })
    ).toEqual([]);
  });

  // The empty deployment, which is what a new developer clones into.
  it('lists nothing when the environment is empty', () => {
    expect(configuredPortraitProviders({})).toEqual([]);
  });

  // Whitespace is not a credential, so it must not light a button.
  it('lists nothing when the credentials are whitespace', () => {
    expect(
      configuredPortraitProviders({
        LINKEDIN_CLIENT_ID: WHITESPACE_ONLY_CREDENTIAL,
        LINKEDIN_CLIENT_SECRET: WHITESPACE_ONLY_CREDENTIAL,
      })
    ).toEqual([]);
  });

  // The result is sent to a browser, so it must carry names and never values.
  it('returns names only, never a credential value', () => {
    const providers = configuredPortraitProviders(BOTH_PROVIDERS);
    expect(JSON.stringify(providers)).not.toContain(LINKEDIN_SECRET);
    expect(JSON.stringify(providers)).not.toContain(INSTAGRAM_SECRET);
  });

  // The intake calls this with no argument.
  it('reads the live environment when no environment is passed', () => {
    vi.stubEnv('LINKEDIN_CLIENT_ID', 'live-id');
    vi.stubEnv('LINKEDIN_CLIENT_SECRET', 'live-secret');
    vi.stubEnv('INSTAGRAM_APP_ID', undefined);
    vi.stubEnv('INSTAGRAM_APP_SECRET', undefined);
    expect(configuredPortraitProviders()).toEqual(['linkedin']);
  });
});

describe('portraitAutoBudgets', () => {
  // The shipped numbers for the three sources we fetch on the client's behalf.
  // Each one is a promise about how long somebody waits on a preview, so the
  // defaults are the contract rather than an implementation detail.
  it('uses the documented defaults when nothing is set', () => {
    expect(portraitAutoBudgets({})).toEqual({
      githubAvatarEdge: DEFAULT_GITHUB_AVATAR_EDGE,
      maxHtmlBytes: DEFAULT_MAX_PORTRAIT_HTML_BYTES,
      maxImgTags: DEFAULT_MAX_IMG_TAGS_SCANNED,
      headingWindowChars: DEFAULT_PORTRAIT_HEADING_WINDOW_CHARS,
      timeoutMs: DEFAULT_PORTRAIT_AUTO_TIMEOUT_MS,
    });
  });

  // An operator watching a slow demo needs to be able to cut every one of them
  // without waiting for a deploy.
  it('takes every budget from the environment when they are set', () => {
    expect(
      portraitAutoBudgets({
        [GITHUB_AVATAR_EDGE_ENV_VAR]: '200',
        [MAX_PORTRAIT_HTML_BYTES_ENV_VAR]: '400000',
        [MAX_IMG_TAGS_SCANNED_ENV_VAR]: '40',
        [PORTRAIT_HEADING_WINDOW_ENV_VAR]: '500',
        [PORTRAIT_AUTO_TIMEOUT_ENV_VAR]: '1000',
      })
    ).toEqual({
      githubAvatarEdge: 200,
      maxHtmlBytes: 400000,
      maxImgTags: 40,
      headingWindowChars: 500,
      timeoutMs: 1000,
    });
  });

  // A budget of zero would mean "scan nothing", which is a source silently
  // switched off rather than a source made faster.
  it('falls back per budget, so one bad value does not take the others down', () => {
    expect(
      portraitAutoBudgets({
        [GITHUB_AVATAR_EDGE_ENV_VAR]: '0',
        [MAX_PORTRAIT_HTML_BYTES_ENV_VAR]: 'a megabyte',
        [MAX_IMG_TAGS_SCANNED_ENV_VAR]: '-5',
        [PORTRAIT_HEADING_WINDOW_ENV_VAR]: '   ',
        [PORTRAIT_AUTO_TIMEOUT_ENV_VAR]: '2500',
      })
    ).toEqual({
      githubAvatarEdge: DEFAULT_GITHUB_AVATAR_EDGE,
      maxHtmlBytes: DEFAULT_MAX_PORTRAIT_HTML_BYTES,
      maxImgTags: DEFAULT_MAX_IMG_TAGS_SCANNED,
      headingWindowChars: DEFAULT_PORTRAIT_HEADING_WINDOW_CHARS,
      timeoutMs: 2500,
    });
  });

  // The brand-signals fetch calls this with no environment argument.
  it('reads the live environment when no environment is passed', () => {
    vi.stubEnv(PORTRAIT_AUTO_TIMEOUT_ENV_VAR, '3333');
    vi.stubEnv(GITHUB_AVATAR_EDGE_ENV_VAR, undefined);
    vi.stubEnv(MAX_PORTRAIT_HTML_BYTES_ENV_VAR, undefined);
    vi.stubEnv(MAX_IMG_TAGS_SCANNED_ENV_VAR, undefined);
    vi.stubEnv(PORTRAIT_HEADING_WINDOW_ENV_VAR, undefined);
    expect(portraitAutoBudgets()).toEqual({
      githubAvatarEdge: DEFAULT_GITHUB_AVATAR_EDGE,
      maxHtmlBytes: DEFAULT_MAX_PORTRAIT_HTML_BYTES,
      maxImgTags: DEFAULT_MAX_IMG_TAGS_SCANNED,
      headingWindowChars: DEFAULT_PORTRAIT_HEADING_WINDOW_CHARS,
      timeoutMs: 3333,
    });
  });

  // The GitHub edge is a size we ask for, not a size we may believe: the bytes
  // that come back are whatever the person uploaded, resized down to at most
  // that. Every picture is measured after it is downloaded, so this number must
  // never reach the placement rule.
  it('names the GitHub ask as a size to request, not a size to believe', () => {
    expect(DEFAULT_GITHUB_AVATAR_EDGE).toBe(460);
    expect(portraitAutoBudgets({}).githubAvatarEdge).toBe(
      DEFAULT_GITHUB_AVATAR_EDGE
    );
  });
});

describe('isPortraitProvider', () => {
  // A provider name arrives from a URL segment, so it is a string until this
  // function says otherwise.
  it('accepts the two providers we actually support', () => {
    expect(isPortraitProvider('linkedin')).toBe(true);
    expect(isPortraitProvider('instagram')).toBe(true);
    for (const provider of PORTRAIT_PROVIDERS) {
      expect(isPortraitProvider(provider)).toBe(true);
    }
  });

  // Anything else is a route we do not have, not a provider to try.
  it('refuses anything else, including near misses', () => {
    expect(isPortraitProvider('github')).toBe(false);
    expect(isPortraitProvider('LinkedIn')).toBe(false);
    expect(isPortraitProvider('')).toBe(false);
    expect(isPortraitProvider('linkedin ')).toBe(false);
  });
});

describe('portraitStateSecret', () => {
  // An explicit signing secret is the configuration we want, because it can be
  // rotated without touching a provider registration.
  it('prefers the explicit signing secret when one is set', () => {
    expect(
      portraitStateSecret('linkedin', {
        ...BOTH_PROVIDERS,
        [PORTRAIT_STATE_SECRET_ENV_VAR]: EXPLICIT_STATE_SECRET,
      })
    ).toBe(EXPLICIT_STATE_SECRET);
  });

  // Without one, the provider's own client secret is already a shared secret
  // that never reaches a browser, so it is a safe fallback rather than a
  // default that anybody could guess.
  it('falls back to the provider client secret, per provider', () => {
    expect(portraitStateSecret('linkedin', BOTH_PROVIDERS)).toBe(
      LINKEDIN_SECRET
    );
    expect(portraitStateSecret('instagram', BOTH_PROVIDERS)).toBe(
      INSTAGRAM_SECRET
    );
  });

  // A whitespace-only explicit secret is not a secret, so the fallback still
  // has to happen.
  it('ignores a whitespace-only explicit secret', () => {
    expect(
      portraitStateSecret('linkedin', {
        ...BOTH_PROVIDERS,
        [PORTRAIT_STATE_SECRET_ENV_VAR]: BLANK_CREDENTIAL,
      })
    ).toBe(LINKEDIN_SECRET);
  });

  // With nothing at all there is deliberately no default: the caller sees an
  // empty string and refuses to mint a state that anybody could forge.
  it('is empty when there is neither an explicit secret nor a client secret', () => {
    expect(portraitStateSecret('linkedin', {})).toBe('');
    expect(
      portraitStateSecret('instagram', { INSTAGRAM_APP_ID: INSTAGRAM_ID })
    ).toBe('');
  });

  // The connect route calls this with no environment argument.
  it('reads the live environment when no environment is passed', () => {
    vi.stubEnv(PORTRAIT_STATE_SECRET_ENV_VAR, LIVE_STATE_SECRET);
    expect(portraitStateSecret('instagram')).toBe(LIVE_STATE_SECRET);
  });
});
