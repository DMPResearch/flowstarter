# Portraits from a client's own social pages

Where a client's photograph comes from, what may be done with it once we have
it, and the two developer apps that have to exist before any of it is switched
on.

The whole feature is governed by one rule: scraping behind a login is not
acceptable. Not difficult, unacceptable. Everything below follows from that.
The two sources that produce a real, full-size portrait are the two where the
person themselves presses a button and authorises it at the provider, LinkedIn
and Instagram. Everything else we look at is public by the publisher's own
choice, and everything that is neither is not used at all.

The rules live in `apps/flowstarter-main/src/lib/flowstarter/portrait-source.ts`
(the priority order and the reasons), `portrait-config.ts` (every number and
credential name) and `portrait-connect.ts` (the provider endpoints and the
state signing). Those three files are the source of truth; this document
explains them and adds nothing they do not say.

## What the networks actually do, measured 2026-09-13

These are measurements against the real endpoints, not assumptions, and they
are the entire reason the priority order is what it is.

- `instagram.com/<handle>`, logged out, serves an `og:image` of 100x100, and
  serves it only to a crawler user agent (`facebookexternalhit/1.1`). A hundred
  pixels is a favicon with a face on it.
- `www.instagram.com/api/v1/users/web_profile_info` answers 401 without a
  session. The endpoint that used to carry the full-size picture is gone for
  anonymous readers.
- The unsigned full-size Instagram CDN URL answers 403. The signature is the
  access control, and guessing at it is not a source, it is a break-in attempt.
- `linkedin.com/in/<handle>`, logged out, is a login wall. There is no public
  LinkedIn portrait at any size.
- Gravatar had nothing for the test email. It is not modelled, because a source
  that answered for nobody is a branch with no evidence behind it.

## The sources, in priority order

`PORTRAIT_SOURCE_ORDER` is the rule. The judge walks the list in order and the
first usable candidate is the chosen one, so reordering that array is the whole
of reordering the preference. Every source is reported either way, usable or
not, with the reason, because the reason is what the client is shown as a
sentence about their own photograph.

| #   | Source                | What it needs                                                                                                                                                                                       | What it returns                                                                                                      | Size                                                         | Consented                                      | When it is unavailable                                                                                                                                                                 |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `linkedin-openid`     | `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`, and the person pressing Connect. Scopes `openid profile email`, no app review.                                                                   | `sub`, `name`, `picture` and `email` from `https://api.linkedin.com/v2/userinfo`.                                    | Full size, as LinkedIn holds it. Measured before placement.  | Yes. The person authorised it at the provider. | `not_configured` (no credentials in this deployment, so no button), `not_connected` (button not pressed yet), `no_picture` (account has none).                                         |
| 2   | `instagram-login`     | `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET`, the person pressing Connect, and a business or creator account. Scope `instagram_business_basic`.                                                    | `user_id`, `username`, `name`, `account_type` and `profile_picture_url` from `https://graph.instagram.com/v23.0/me`. | Full size, as Instagram holds it. Measured before placement. | Yes. The person authorised it at the provider. | `not_configured`, `personal_account` (terminal, see below), `not_connected`, `no_picture`. The account type is checked before the connection, deliberately.                            |
| 3   | `github-avatar`       | A GitHub profile actually named by the one link or by the brief. No credential. We do not guess a handle from a name.                                                                               | The public avatar.                                                                                                   | 460px, public, no credential.                                | No. `rights_confirmed_at` stays null.          | `no_github_handle` (nobody named one).                                                                                                                                                 |
| 4   | `website-about`       | The client's own site, offered to us, with an `og:image` or an image on an about page, and something on the page saying the image is a person: alt text or a nearby heading matching the full name. | Whatever the page holds.                                                                                             | Whatever it is. Measured like any other.                     | No. `rights_confirmed_at` stays null.          | `not_offered` (no site given), `no_picture`, `not_a_person` (an image nothing identifies is usually a logo or a storefront, and a logo in a portrait slot is worse than an empty one). |
| 5   | `instagram-public-og` | The handle. Served only to a crawler user agent, as measured above.                                                                                                                                 | The 100x100 `og:image`.                                                                                              | 100x100. Avatar only, forever.                               | No. `rights_confirmed_at` stays null.          | `not_offered`, `no_picture`.                                                                                                                                                           |

Three more reasons apply to every row, because they are about the picture
rather than about the source: `not_public_url` when the URL is not one we are
willing to request (it must be `https`, must carry no credentials in the URL,
and must not be a loopback, link-local or private host), `size_unknown` when we
hold a URL but nothing has measured it, and `below_avatar_floor` when it was
measured and is smaller than the avatar floor. We do not place what we have not
measured.

`personal_account` is the one that needs saying out loud to the client. A
personal Instagram account cannot be read by any API since Basic Display was
retired. That is a fact about the account, not a transient failure, so it is
not something a retry fixes; the only remedy is for the account holder to
switch to a creator or business account.

## The size floor

Placement is arithmetic over the longest edge of the picture, in pixels.

- At or above the **portrait floor**, a picture may be the hero image or the
  about portrait. It may also be used as an avatar, because scaling a large
  picture down is fine.
- Below the portrait floor but at or above the **avatar floor**, it may be used
  only as a small round avatar: an about-section byline, a testimonial-style
  signature. It is never upscaled. The candidate carries the picture's own
  longest edge as the largest edge it may be rendered at, so "never upscaled"
  reaches the template as a number rather than as a note in a comment.
- Below the avatar floor it is not used on the site at all.

| Floor    | Env var                                | Default | Why that number                                                                                                                                     |
| -------- | -------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portrait | `FLOWSTARTER_PORTRAIT_MIN_EDGE`        | 400     | The number `profile-picture.ts` already used for the same judgement, kept so the two rules cannot disagree about one file.                          |
| Avatar   | `FLOWSTARTER_PORTRAIT_AVATAR_MIN_EDGE` | 96      | The size the templates render a byline avatar at. Instagram's public OpenGraph picture is 100 square, which is the case this floor exists to admit. |

An avatar floor set above the portrait floor is nonsense rather than a policy,
so a pair that crosses over collapses back to both defaults instead of
producing a rule with no middle. A value that does not parse as a positive
integer is also the default: a typo should give an operator a working funnel
and a floor that still means something, not a page that will not render.

## What Darius has to create

Nothing in this feature works until these two apps exist. Until then the
connect buttons render disabled and every other source still runs, so the flow
is never broken, only missing its two best sources.

### A LinkedIn app

On [linkedin.com/developers](https://www.linkedin.com/developers/).

1. Create an app. LinkedIn requires the app to be associated with a LinkedIn
   Page, so there has to be one and you have to be an admin of it. Create the
   Page first if there is not one already.
2. On the Products tab, request **Sign In with LinkedIn using OpenID Connect**.
   It is self-serve: there is no app review and no wait, which is the whole
   reason this is the first source in the list.
3. On the Auth tab, add the redirect URL. It must match what we send byte for
   byte, including the scheme and the absence of a trailing slash:

   ```
   https://staging.flowstarter.dev/api/connect/linkedin/callback
   https://flowstarter.net/api/connect/linkedin/callback
   ```

   Add both to the same app, or create two apps, one per environment. If you
   create two, each environment gets its own client id and secret.

4. Copy the Client ID and Client Secret from the Auth tab into
   `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`.

The scopes we request are `openid profile email`, and nothing else. The
userinfo endpoint (`https://api.linkedin.com/v2/userinfo`) answers with the
OpenID Connect standard claims: `sub`, `name`, `picture` and `email`. A
**headline is not one of the standard claims**, so in practice the headline
field comes back empty. It is read when the provider happens to include it and
is simply missing otherwise. Nothing downstream treats it as required, and
nobody should plan a page around it being there.

### A Meta app

On [developers.facebook.com](https://developers.facebook.com/).

1. Create an app.
2. Add the **Instagram** product, and specifically the **Instagram API with
   Instagram Login** configuration. Not Instagram Basic Display, which is
   retired and which no longer reads anything.
3. Under **API setup with Instagram login**, set the OAuth redirect URI:

   ```
   https://staging.flowstarter.dev/api/connect/instagram/callback
   https://flowstarter.net/api/connect/instagram/callback
   ```

   Same rule as LinkedIn: byte for byte, no trailing slash.

4. The permission is `instagram_business_basic`. That is the only one we ask
   for.
5. Add the Instagram account as a tester under the app's roles, then accept the
   invitation from the Instagram account's own settings (Settings, Website
   permissions, Tester invites). Until the app is switched to Live mode, only
   testers can authorise it, so an untested account will bounce off the
   authorisation screen.
6. Copy the Instagram App ID and Instagram App Secret into `INSTAGRAM_APP_ID`
   and `INSTAGRAM_APP_SECRET`.

**The hard limitation, stated plainly: this works for business and creator
accounts only.** A personal Instagram account cannot be read by any API since
Basic Display was retired. There is no workaround, no fallback endpoint and no
retry that helps. The only remedy is for the account holder to switch the
account to a creator or business account, which is free and reversible, and
that is exactly what the client is told when `personal_account` comes back.

## Environment variables

All of these are read by `apps/flowstarter-main` only. Nothing here belongs in
`.env.shared.example`. On the box they go in `/etc/flowstarter/staging.env` and
`/etc/flowstarter/prod.env`; see `deploy/hetzner-staging/README.md`, "The
production env file".

| Env var                                    | Required                 | Default when unset                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LINKEDIN_CLIENT_ID`                       | For the LinkedIn button  | None. Half a credential is not one: both halves must be present.                                                                                                                                                                                                                                                       |
| `LINKEDIN_CLIENT_SECRET`                   | For the LinkedIn button  | None.                                                                                                                                                                                                                                                                                                                  |
| `INSTAGRAM_APP_ID`                         | For the Instagram button | None.                                                                                                                                                                                                                                                                                                                  |
| `INSTAGRAM_APP_SECRET`                     | For the Instagram button | None.                                                                                                                                                                                                                                                                                                                  |
| `FLOWSTARTER_PORTRAIT_MIN_EDGE`            | No                       | `400`. The hero and about-portrait floor.                                                                                                                                                                                                                                                                              |
| `FLOWSTARTER_PORTRAIT_AVATAR_MIN_EDGE`     | No                       | `96`. The avatar floor.                                                                                                                                                                                                                                                                                                |
| `FLOWSTARTER_PORTRAIT_PROVIDER_TIMEOUT_MS` | No                       | `6000`. How long we wait for a provider's token or profile endpoint.                                                                                                                                                                                                                                                   |
| `FLOWSTARTER_PORTRAIT_STATE_TTL_MS`        | No                       | `600000` (ten minutes). How long a signed connect state stays good.                                                                                                                                                                                                                                                    |
| `FLOWSTARTER_PORTRAIT_MAX_BYTES`           | No                       | `4194304` (4 MiB). A headshot, not a hero photograph.                                                                                                                                                                                                                                                                  |
| `FLOWSTARTER_PORTRAIT_STATE_SECRET`        | No                       | The provider's own client secret, which is already a shared secret between us and the provider and never reaches a browser. There is deliberately no default beyond that.                                                                                                                                              |
| `FLOWSTARTER_PORTRAIT_REDIRECT_BASE`       | Recommended on the box   | The request's own origin. Pin it per environment, because staging and production are different apps with different registered URLs while a request's origin is whatever host header reached us. A pull-request slot should pin the staging base rather than its own `pr-N` hostname, which is not registered anywhere. |

**When the credentials are unset**, nothing breaks. The intake asks
`configuredPortraitProviders` which providers this deployment can actually
offer, and it answers with names, never values, so it is safe to log and safe
to send to a browser. A provider with no credentials renders its connect button
disabled, with the copy `portrait.reason.not_configured` carries: "this
connection is not switched on yet". The judge files that source as
`not_configured` and moves on to the next one. The flow is never broken by a
missing credential, only absent a source.

The connect state is signed with an HMAC over a payload naming the provider,
the connection and the preview or workspace it belongs to, with an issue time
so a stolen state expires. A callback is a URL anybody can request, so without a
verified state an attacker's photograph can be made to land in a victim's
preview. A state that cannot be signed is not minted at all: the flow refuses
rather than producing a forgeable one.

## What we store, and why

Only the picture, the name and the headline.

The picture is downloaded into the tenant's assets bucket through the existing
asset pipeline, and the row records `source` (one of `linkedin`, `instagram`,
`github`), `source_url`, `fetched_at`, and the width and height we measured.
`funnel_assets` had no `source_url` and neither table recorded the time of the
fetch before `supabase/migrations/20260913120000_portrait_from_social.sql`; a
provider picture URL expires, so `fetched_at` is the only record of what the
account looked like at the time. The same migration stops the claim from
rounding `instagram` down to `social`, which used to throw away exactly the
fact a rights complaint would ask about.

The name and the headline go on the `portrait_connections` row alongside the
picture. The headline is usually empty, for the reasons in the LinkedIn section
above.

**The access token is used once and dropped.** It is never written to a row,
never logged and never returned to the caller. The product needs one picture
and two lines of text; holding a credential that could fetch more of somebody's
account would be storing a liability we have no use for.

**Consent** is tracked separately from placement. The connect action itself
writes `rights_confirmed_at`, because the person went to the provider, saw what
was being asked for, and approved it, and asking them a second question they
have already answered is not consent, it is friction. An automatic source
(`github-avatar`, `website-about`, `instagram-public-og`) leaves
`rights_confirmed_at` null until the client taps "Use this" on the brief.

`portrait_connections` is server-only. It is minted at the top of the funnel
where the visitor is still anonymous, so there is no tenant key a policy could
filter on: the protection is RLS on with zero policies, every grant to `anon`
and `authenticated` revoked, and the service role behind a route that already
holds the connection id. `apps/flowstarter-main/scripts/verify-rls-local.mjs`
is what proves it.
