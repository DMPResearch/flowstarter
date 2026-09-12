/**
 * Where a client's face may come from, and what may be done with it.
 *
 * This module is unusual in that its branches are not implementation detail:
 * every member of `PortraitSourceReason` is a sentence somebody is shown in the
 * intake or on the brief about why we do or do not have a picture of them, and
 * every member of `PortraitSizeVerdict` is a promise about where that picture
 * will be placed. Two reasons that read the same are two reasons the client
 * cannot act on differently, so there is a test here for each one, by name.
 *
 * Three things in particular are pinned rather than left to read off the code.
 *
 * First, the boundaries. The floors are inclusive: a picture measured at
 * exactly the portrait floor is a portrait, and a picture one pixel under it is
 * an avatar. A test that only checks "well above" and "well below" would pass
 * against a rule written with the wrong comparison, and the difference between
 * the two is whether a 400px headshot fills a hero or hides in a byline.
 *
 * Second, the order in which Instagram's preconditions are checked. A personal
 * account is a fact about the account, not a step the person has not taken yet,
 * so it is reported ahead of "not connected". Telling somebody to press a
 * button that cannot work for them is worse than telling them why it cannot.
 *
 * Third, `maxRenderEdge`. "Never upscaled" is a rule that only exists if it
 * travels to the template as a number. The measured Instagram public case, 100
 * pixels square, is the case that rule was written for, and it is asserted here
 * exactly: avatar only, and a hundred pixels of render budget, no more.
 *
 * Everything below is a plain object. The module is pure, so no fixture needs a
 * network, a clock or a database to say what it means.
 */
import { describe, expect, it } from 'vitest';

import type { PortraitSizeFloors } from '../portrait-config';
import {
  PORTRAIT_SOURCE_ORDER,
  isConsentedSource,
  isFetchablePictureUrl,
  judgePortraitSources,
  longEdgeOf,
  placementsFor,
  portraitReasonCopyKey,
  portraitSourceCopyKey,
  portraitVerdictCopyKey,
  shouldRunAutomaticSources,
  sizeVerdictFor,
  type PortraitCandidate,
  type PortraitObservations,
  type PortraitPicture,
  type PortraitSourceId,
  type PortraitSourceReason,
  type PortraitSizeVerdict,
} from '../portrait-source';

/**
 * The shipped floors, written out rather than imported, so a change to the
 * defaults in `portrait-config.ts` shows up as a decision here rather than as a
 * silent rewrite of every boundary assertion below.
 */
const FLOORS: PortraitSizeFloors = { portraitEdge: 400, avatarEdge: 96 };

/** A picture URL of the shape LinkedIn's CDN actually serves. */
const CDN_URL = 'https://media.licdn.com/dms/image/v2/headshot.jpg';

function picture(
  width: number | null,
  height: number | null,
  url: string = CDN_URL
): PortraitPicture {
  return { url, width, height };
}

function judge(observations: PortraitObservations) {
  return judgePortraitSources(observations, FLOORS);
}

function candidateFor(
  observations: PortraitObservations,
  source: PortraitSourceId
): PortraitCandidate {
  const found = judge(observations).candidates.find(
    (candidate) => candidate.source === source
  );
  if (!found) throw new Error(`no candidate was produced for ${source}`);
  return found;
}

/** Every reason the module may report. The closed set, written out. */
const ALL_REASONS: readonly PortraitSourceReason[] = [
  'usable',
  'not_offered',
  'not_configured',
  'not_connected',
  'no_picture',
  'personal_account',
  'no_github_handle',
  'not_a_person',
  'not_public_url',
  'below_avatar_floor',
  'size_unknown',
];

/** Every size verdict the module may report. */
const ALL_VERDICTS: readonly PortraitSizeVerdict[] = [
  'portrait',
  'avatar',
  'too_small',
  'unknown',
];

describe('PORTRAIT_SOURCE_ORDER', () => {
  // The array is the preference, so reordering it is the whole of reordering
  // which source wins. It is worth asserting it has not drifted.
  it('is the documented preference, best first', () => {
    expect(PORTRAIT_SOURCE_ORDER).toEqual([
      'linkedin-openid',
      'instagram-login',
      'github-avatar',
      'website-about',
      'instagram-public-og',
    ]);
  });

  // The brief prints the table in this order and numbers it, so the rank has to
  // be the 1-based position rather than an index the reader has to translate.
  it('is the order judgePortraitSources returns, with a 1-based rank', () => {
    const { candidates } = judge({});
    expect(candidates.map((candidate) => candidate.source)).toEqual([
      ...PORTRAIT_SOURCE_ORDER,
    ]);
    expect(candidates.map((candidate) => candidate.rank)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    candidates.forEach((candidate, index) => {
      expect(candidate.rank).toBe(index + 1);
      expect(candidate.source).toBe(PORTRAIT_SOURCE_ORDER[index]);
    });
  });
});

describe('isConsentedSource', () => {
  // Consent is not a placement question. It is true only where the person
  // themselves pressed a button, and that is exactly two of the five.
  it('is true only for the two flows the person authorised', () => {
    expect(isConsentedSource('linkedin-openid')).toBe(true);
    expect(isConsentedSource('instagram-login')).toBe(true);
    expect(isConsentedSource('github-avatar')).toBe(false);
    expect(isConsentedSource('website-about')).toBe(false);
    expect(isConsentedSource('instagram-public-og')).toBe(false);
  });
});

describe('isFetchablePictureUrl', () => {
  // The ordinary case: a provider CDN over https.
  it('accepts an https url on a public host', () => {
    expect(isFetchablePictureUrl(CDN_URL)).toBe(true);
    expect(
      isFetchablePictureUrl('https://avatars.githubusercontent.com/u/1?v=4')
    ).toBe(true);
  });

  // Plain http would let anybody on the path swap the photograph on its way to
  // a paying client's site.
  it('refuses plain http', () => {
    expect(isFetchablePictureUrl('http://media.licdn.com/headshot.jpg')).toBe(
      false
    );
  });

  // Credentials in the authority mean the URL is carrying somebody's password,
  // which is not something we forward from an untrusted source.
  it('refuses a url that carries credentials', () => {
    expect(
      isFetchablePictureUrl('https://user:pass@media.licdn.com/headshot.jpg')
    ).toBe(false);
  });

  // The rest of this block is one rule: a picture URL must not be able to point
  // our server at our own network. Each host is a real way that is attempted.
  it('refuses loopback', () => {
    expect(isFetchablePictureUrl('https://localhost/headshot.jpg')).toBe(false);
    expect(isFetchablePictureUrl('https://127.0.0.1/headshot.jpg')).toBe(false);
  });

  it('refuses the private ranges', () => {
    expect(isFetchablePictureUrl('https://10.0.0.7/headshot.jpg')).toBe(false);
    expect(isFetchablePictureUrl('https://192.168.1.20/headshot.jpg')).toBe(
      false
    );
  });

  // The cloud metadata endpoint is the specific address an SSRF is usually
  // aimed at, so it gets its own line.
  it('refuses the link-local metadata address', () => {
    expect(
      isFetchablePictureUrl('https://169.254.169.254/latest/meta-data/')
    ).toBe(false);
  });

  // The whole 172.16 to 172.31 block, including both ends, because a rule that
  // only covers the middle of a range is a rule with a hole in it.
  it('refuses every part of the 172.16 to 172.31 block', () => {
    for (const host of [
      '172.16.0.1',
      '172.19.4.4',
      '172.20.0.1',
      '172.29.9.9',
      '172.30.0.1',
      '172.31.255.254',
    ]) {
      expect(isFetchablePictureUrl(`https://${host}/headshot.jpg`)).toBe(false);
    }
  });

  // A host with no dot is an internal name on a container network, never a
  // public CDN.
  it('refuses a hostname with no dot in it', () => {
    expect(isFetchablePictureUrl('https://intranet/headshot.jpg')).toBe(false);
  });

  // A provider that hands us something that is not a URL at all gets a false,
  // not an exception thrown out of a pure rule.
  it('refuses a string that does not parse as a url', () => {
    expect(isFetchablePictureUrl('not a url')).toBe(false);
    expect(isFetchablePictureUrl('')).toBe(false);
  });
});

describe('longEdgeOf', () => {
  // Nothing to measure is not a zero, it is an absence, and the two lead to
  // different sentences for the client.
  it('is null when there is no picture', () => {
    expect(longEdgeOf(null)).toBeNull();
  });

  // A provider that reports zeroes has told us nothing, so it is the same
  // absence rather than a picture that is too small.
  it('is null when the dimensions are zero or unreported', () => {
    expect(longEdgeOf(picture(0, 0))).toBeNull();
    expect(longEdgeOf(picture(null, null))).toBeNull();
  });

  // Landscape and portrait both have to work: the rule is about the longest
  // edge, not about width.
  it('takes the longer edge whichever way round the picture is', () => {
    expect(longEdgeOf(picture(800, 600))).toBe(800);
    expect(longEdgeOf(picture(600, 900))).toBe(900);
    expect(longEdgeOf(picture(400, null))).toBe(400);
    expect(longEdgeOf(picture(null, 400))).toBe(400);
  });
});

describe('sizeVerdictFor', () => {
  // The floor is inclusive. A picture measured at exactly the portrait floor is
  // a portrait, because the floor is the size the templates were designed
  // against rather than a size to be safely above.
  it('calls a picture at exactly the portrait floor a portrait', () => {
    expect(sizeVerdictFor(400, FLOORS)).toBe('portrait');
    expect(sizeVerdictFor(2000, FLOORS)).toBe('portrait');
  });

  // One pixel under is an avatar, not a hero. This is the assertion that would
  // catch a comparison written the wrong way round.
  it('drops a picture one pixel under the portrait floor to avatar', () => {
    expect(sizeVerdictFor(399, FLOORS)).toBe('avatar');
  });

  // The avatar floor is inclusive for the same reason, and 96 is the size the
  // templates render a byline avatar at.
  it('calls a picture at exactly the avatar floor an avatar', () => {
    expect(sizeVerdictFor(96, FLOORS)).toBe('avatar');
  });

  // Under the avatar floor there is no slot at all, because the only way to
  // fill one would be to scale the picture up.
  it('calls a picture one pixel under the avatar floor too small', () => {
    expect(sizeVerdictFor(95, FLOORS)).toBe('too_small');
    expect(sizeVerdictFor(1, FLOORS)).toBe('too_small');
  });

  // We do not place what nobody has measured.
  it('calls an unmeasured picture unknown', () => {
    expect(sizeVerdictFor(null, FLOORS)).toBe('unknown');
  });
});

describe('placementsFor', () => {
  // A large picture scaled down is fine, so a portrait may also be the byline
  // avatar. That is why the portrait list contains all three.
  it('lets a portrait be the hero, the about image, or the avatar', () => {
    expect(placementsFor('portrait')).toEqual(['hero', 'about', 'avatar']);
  });

  // The rule that matters in the other direction: an avatar is never a hero,
  // because the only way to fill a hero with it is to upscale it.
  it('lets an avatar be an avatar and nothing else', () => {
    expect(placementsFor('avatar')).toEqual(['avatar']);
  });

  // Neither of the two remaining verdicts earns a slot on the site.
  it('gives a too-small or unmeasured picture nowhere to go', () => {
    expect(placementsFor('too_small')).toEqual([]);
    expect(placementsFor('unknown')).toEqual([]);
  });
});

describe('judgePortraitSources: the LinkedIn ladder', () => {
  // Nobody told us anything about LinkedIn. That is the top-of-funnel case and
  // it has to be a reason, never a throw.
  it('reports not_configured when there is no evidence at all', () => {
    const candidate = candidateFor({}, 'linkedin-openid');
    expect(candidate.reason).toBe('not_configured');
    expect(candidate.usable).toBe(false);
    expect(candidate.verdict).toBe('unknown');
    expect(candidate.placements).toEqual([]);
    expect(candidate.maxRenderEdge).toBeNull();
    expect(candidate.picture).toBeNull();
  });

  // A deployment with no credentials cannot show the button, so the reason has
  // to say that rather than blaming the person for not pressing it.
  it('reports not_configured when the deployment has no credentials', () => {
    const candidate = candidateFor(
      { linkedin: { configured: false, connected: false, picture: null } },
      'linkedin-openid'
    );
    expect(candidate.reason).toBe('not_configured');
  });

  // Configured but not connected is the one case where the next step really is
  // for the person to press a button, so it gets its own sentence.
  it('reports not_connected when the button exists and was not pressed', () => {
    const candidate = candidateFor(
      { linkedin: { configured: true, connected: false, picture: null } },
      'linkedin-openid'
    );
    expect(candidate.reason).toBe('not_connected');
    expect(candidate.usable).toBe(false);
  });

  // Connected and the account simply has no photograph on it. Nothing anybody
  // can do about it from here except add one on LinkedIn.
  it('reports no_picture when the connected account has none', () => {
    const candidate = candidateFor(
      { linkedin: { configured: true, connected: true, picture: null } },
      'linkedin-openid'
    );
    expect(candidate.reason).toBe('no_picture');
  });

  // An empty url is the same absence as no picture, just reported differently
  // by the provider.
  it('reports no_picture when the provider sent a blank url', () => {
    const candidate = candidateFor(
      {
        linkedin: {
          configured: true,
          connected: true,
          picture: picture(800, 800, '   '),
        },
      },
      'linkedin-openid'
    );
    expect(candidate.reason).toBe('no_picture');
  });

  // A URL we are not willing to request is a refusal on our side, so the reason
  // has to name the URL rather than the picture.
  it('reports not_public_url when the picture is on a host we will not request', () => {
    const candidate = candidateFor(
      {
        linkedin: {
          configured: true,
          connected: true,
          picture: picture(800, 800, 'https://169.254.169.254/headshot.jpg'),
        },
      },
      'linkedin-openid'
    );
    expect(candidate.reason).toBe('not_public_url');
    expect(candidate.usable).toBe(false);
    // The picture is still carried, so the brief can say what it declined.
    expect(candidate.picture?.url).toBe('https://169.254.169.254/headshot.jpg');
  });

  // A URL with no dimensions cannot justify a placement, and guessing at one is
  // how an upscaled headshot ends up on a paid site.
  it('reports size_unknown when we hold a url but no measurement', () => {
    const candidate = candidateFor(
      {
        linkedin: {
          configured: true,
          connected: true,
          picture: picture(null, null),
        },
      },
      'linkedin-openid'
    );
    expect(candidate.reason).toBe('size_unknown');
    expect(candidate.verdict).toBe('unknown');
    expect(candidate.maxRenderEdge).toBeNull();
    expect(candidate.picture).not.toBeNull();
  });

  // Measured and genuinely too small. The verdict is kept on the candidate even
  // though it is unusable, because "we found one, it was 50 pixels" is a more
  // useful sentence than "we found nothing".
  it('reports below_avatar_floor for a 50px picture, and keeps the verdict', () => {
    const candidate = candidateFor(
      {
        linkedin: {
          configured: true,
          connected: true,
          picture: picture(50, 50),
        },
      },
      'linkedin-openid'
    );
    expect(candidate.reason).toBe('below_avatar_floor');
    expect(candidate.verdict).toBe('too_small');
    expect(candidate.usable).toBe(false);
    expect(candidate.placements).toEqual([]);
    expect(candidate.maxRenderEdge).toBeNull();
  });

  // In the avatar band the picture earns exactly one slot, and the render
  // budget is the picture's own size so nothing scales it up.
  it('makes a 200px picture usable as an avatar and nothing more', () => {
    const candidate = candidateFor(
      {
        linkedin: {
          configured: true,
          connected: true,
          picture: picture(200, 200),
        },
      },
      'linkedin-openid'
    );
    expect(candidate.usable).toBe(true);
    expect(candidate.reason).toBe('usable');
    expect(candidate.verdict).toBe('avatar');
    expect(candidate.placements).toEqual(['avatar']);
    expect(candidate.maxRenderEdge).toBe(200);
    expect(candidate.consented).toBe(true);
  });

  // The case the whole feature exists for: a real, full-size, authorised
  // photograph that may be the hero.
  it('makes an 800px picture usable everywhere on the page', () => {
    const candidate = candidateFor(
      {
        linkedin: {
          configured: true,
          connected: true,
          picture: picture(800, 800),
        },
      },
      'linkedin-openid'
    );
    expect(candidate.usable).toBe(true);
    expect(candidate.reason).toBe('usable');
    expect(candidate.verdict).toBe('portrait');
    expect(candidate.placements).toEqual(['hero', 'about', 'avatar']);
    expect(candidate.maxRenderEdge).toBe(800);
    expect(candidate.consented).toBe(true);
  });
});

describe('judgePortraitSources: the Instagram login ladder', () => {
  // No evidence is the same no-button case as LinkedIn.
  it('reports not_configured when there is no evidence at all', () => {
    expect(candidateFor({}, 'instagram-login').reason).toBe('not_configured');
  });

  it('reports not_configured when the deployment has no credentials', () => {
    const candidate = candidateFor(
      {
        instagram: {
          configured: false,
          connected: false,
          picture: null,
          accountType: 'unknown',
        },
      },
      'instagram-login'
    );
    expect(candidate.reason).toBe('not_configured');
  });

  // The order of these two checks is the product decision. A personal account
  // cannot be read by any endpoint since Basic Display was retired, so it is a
  // fact about the account rather than a step the person has not taken yet.
  // Reporting not_connected here would tell them to press a button that cannot
  // work for them, which is worse than telling them why it cannot: the honest
  // next step is to convert the account, and only personal_account says so.
  it('reports personal_account ahead of not_connected for a personal account', () => {
    const candidate = candidateFor(
      {
        instagram: {
          configured: true,
          connected: false,
          picture: null,
          accountType: 'personal',
        },
      },
      'instagram-login'
    );
    expect(candidate.reason).toBe('personal_account');
    expect(candidate.reason).not.toBe('not_connected');
  });

  // The same reason once they have connected, because connecting does not
  // change what the API will return for a personal account.
  it('still reports personal_account after a personal account connects', () => {
    const candidate = candidateFor(
      {
        instagram: {
          configured: true,
          connected: true,
          picture: picture(800, 800),
          accountType: 'personal',
        },
      },
      'instagram-login'
    );
    expect(candidate.reason).toBe('personal_account');
    expect(candidate.usable).toBe(false);
  });

  // A business account that has not connected is the case where pressing the
  // button really does help.
  it('reports not_connected for a business account that has not connected', () => {
    const candidate = candidateFor(
      {
        instagram: {
          configured: true,
          connected: false,
          picture: null,
          accountType: 'business',
        },
      },
      'instagram-login'
    );
    expect(candidate.reason).toBe('not_connected');
  });

  // Business accounts are one of the two the scope actually reads.
  it('uses a full-size picture from a connected business account', () => {
    const candidate = candidateFor(
      {
        instagram: {
          configured: true,
          connected: true,
          picture: picture(640, 640, 'https://scontent.cdninstagram.com/p.jpg'),
          accountType: 'business',
        },
      },
      'instagram-login'
    );
    expect(candidate.usable).toBe(true);
    expect(candidate.verdict).toBe('portrait');
    expect(candidate.placements).toEqual(['hero', 'about', 'avatar']);
    expect(candidate.maxRenderEdge).toBe(640);
    expect(candidate.consented).toBe(true);
  });

  // Creator accounts are the other, and they must not be treated as personal.
  it('uses a picture from a connected creator account too', () => {
    const candidate = candidateFor(
      {
        instagram: {
          configured: true,
          connected: true,
          picture: picture(150, 150, 'https://scontent.cdninstagram.com/p.jpg'),
          accountType: 'creator',
        },
      },
      'instagram-login'
    );
    expect(candidate.usable).toBe(true);
    expect(candidate.verdict).toBe('avatar');
    expect(candidate.placements).toEqual(['avatar']);
  });

  // An account type Instagram did not name is not a personal account, so it is
  // allowed to proceed and be judged on the picture like any other.
  it('lets an unknown account type through to the picture judgement', () => {
    const candidate = candidateFor(
      {
        instagram: {
          configured: true,
          connected: true,
          picture: null,
          accountType: 'unknown',
        },
      },
      'instagram-login'
    );
    expect(candidate.reason).toBe('no_picture');
  });
});

describe('judgePortraitSources: the GitHub ladder', () => {
  // We do not guess a handle from somebody's name, so no handle is the end of
  // it and the reason says exactly that.
  it('reports no_github_handle when nobody named a profile', () => {
    const candidate = candidateFor({}, 'github-avatar');
    expect(candidate.reason).toBe('no_github_handle');
    expect(candidate.consented).toBe(false);
  });

  // An empty or whitespace handle is the shape a blank form field arrives in,
  // and it is the same absence.
  it('reports no_github_handle for an empty or whitespace handle', () => {
    expect(
      candidateFor(
        { github: { handle: null, picture: picture(460, 460) } },
        'github-avatar'
      ).reason
    ).toBe('no_github_handle');
    expect(
      candidateFor(
        { github: { handle: '', picture: picture(460, 460) } },
        'github-avatar'
      ).reason
    ).toBe('no_github_handle');
    expect(
      candidateFor(
        { github: { handle: '   ', picture: picture(460, 460) } },
        'github-avatar'
      ).reason
    ).toBe('no_github_handle');
  });

  // The measured GitHub avatar size, 460px, clears the portrait floor. This is
  // the automatic source that can actually produce a hero image.
  it('uses a named handle with a 460px avatar as a full portrait', () => {
    const candidate = candidateFor(
      {
        github: {
          handle: 'dmihai91',
          picture: picture(
            460,
            460,
            'https://avatars.githubusercontent.com/u/1?v=4'
          ),
        },
      },
      'github-avatar'
    );
    expect(candidate.usable).toBe(true);
    expect(candidate.verdict).toBe('portrait');
    expect(candidate.placements).toEqual(['hero', 'about', 'avatar']);
    expect(candidate.maxRenderEdge).toBe(460);
    // Nobody pressed a button for this one, so it is filed unconsented.
    expect(candidate.consented).toBe(false);
  });

  // A handle with no picture behind it is still a different sentence from a
  // handle nobody gave us.
  it('reports no_picture when the handle is known but the fetch found none', () => {
    expect(
      candidateFor(
        { github: { handle: 'dmihai91', picture: null } },
        'github-avatar'
      ).reason
    ).toBe('no_picture');
  });
});

describe('judgePortraitSources: the website ladder', () => {
  // The client never gave us a site, which is not the same as a site we looked
  // at and rejected.
  it('reports not_offered when there is no website evidence', () => {
    const candidate = candidateFor({}, 'website-about');
    expect(candidate.reason).toBe('not_offered');
    expect(candidate.usable).toBe(false);
  });

  // A site with nothing on it to use.
  it('reports no_picture when the site offered no image', () => {
    expect(
      candidateFor(
        { website: { picture: null, saysPerson: true } },
        'website-about'
      ).reason
    ).toBe('no_picture');
  });

  // The load-bearing line for this source. An og:image that nothing on the page
  // identifies as a person is usually a logo or a storefront, and a logo in a
  // portrait slot is worse than an empty one. The picture is still carried on
  // the candidate so the brief can say what it declined and why, rather than
  // reporting a silent nothing.
  it('reports not_a_person for an image the page never identified, and keeps it', () => {
    const logo = picture(1200, 630, 'https://flowstarter.net/og.png');
    const candidate = candidateFor(
      { website: { picture: logo, saysPerson: false } },
      'website-about'
    );
    expect(candidate.reason).toBe('not_a_person');
    expect(candidate.usable).toBe(false);
    expect(candidate.placements).toEqual([]);
    expect(candidate.picture).toEqual(logo);
  });

  // When the alt text or a nearby heading does name the person, the image is
  // judged on its size like any other.
  it('uses a large image the page identified as the person', () => {
    const candidate = candidateFor(
      {
        website: {
          picture: picture(1200, 1600, 'https://flowstarter.net/about/me.jpg'),
          saysPerson: true,
        },
      },
      'website-about'
    );
    expect(candidate.usable).toBe(true);
    expect(candidate.verdict).toBe('portrait');
    expect(candidate.maxRenderEdge).toBe(1600);
    expect(candidate.consented).toBe(false);
  });
});

describe('judgePortraitSources: the public Instagram og:image', () => {
  // Nobody gave us an Instagram handle to look at.
  it('reports not_offered when there is no public evidence', () => {
    expect(candidateFor({}, 'instagram-public-og').reason).toBe('not_offered');
  });

  // The real measured case, 2026-09-13: instagram.com serves a 100x100
  // og:image to a crawler and nothing larger. A hundred pixels is a favicon
  // with a face on it, which is why this source is last and why it can only
  // ever be an avatar.
  //
  // `maxRenderEdge` is the assertion that matters. "Never upscaled" is only a
  // rule if it travels to the template as a number: a comment in this module
  // cannot stop a hero slot from stretching a 100px picture, but a render
  // budget of exactly 100 can.
  it('makes the measured 100x100 public picture an avatar with a 100px render budget', () => {
    const candidate = candidateFor(
      {
        instagramPublic: {
          picture: picture(
            100,
            100,
            'https://scontent.cdninstagram.com/v/t51/og.jpg'
          ),
        },
      },
      'instagram-public-og'
    );
    expect(candidate.usable).toBe(true);
    expect(candidate.reason).toBe('usable');
    expect(candidate.verdict).toBe('avatar');
    expect(candidate.placements).toEqual(['avatar']);
    expect(candidate.maxRenderEdge).toBe(100);
    // Public by the publisher's own choice, but nobody pressed a button.
    expect(candidate.consented).toBe(false);
  });

  // The handle was offered and the crawl came back empty.
  it('reports no_picture when the public page had no og:image', () => {
    expect(
      candidateFor(
        { instagramPublic: { picture: null } },
        'instagram-public-og'
      ).reason
    ).toBe('no_picture');
  });
});

describe('the closed sets of reasons and verdicts', () => {
  /**
   * One fixture per reason, so the table below can prove the set is covered
   * rather than leaving it to a reader counting `it` blocks.
   */
  const REASON_CASES: Array<{
    reason: PortraitSourceReason;
    source: PortraitSourceId;
    observations: PortraitObservations;
  }> = [
    {
      reason: 'usable',
      source: 'linkedin-openid',
      observations: {
        linkedin: {
          configured: true,
          connected: true,
          picture: picture(800, 800),
        },
      },
    },
    {
      reason: 'not_offered',
      source: 'website-about',
      observations: {},
    },
    {
      reason: 'not_configured',
      source: 'linkedin-openid',
      observations: {
        linkedin: { configured: false, connected: false, picture: null },
      },
    },
    {
      reason: 'not_connected',
      source: 'linkedin-openid',
      observations: {
        linkedin: { configured: true, connected: false, picture: null },
      },
    },
    {
      reason: 'no_picture',
      source: 'linkedin-openid',
      observations: {
        linkedin: { configured: true, connected: true, picture: null },
      },
    },
    {
      reason: 'personal_account',
      source: 'instagram-login',
      observations: {
        instagram: {
          configured: true,
          connected: true,
          picture: picture(800, 800),
          accountType: 'personal',
        },
      },
    },
    {
      reason: 'no_github_handle',
      source: 'github-avatar',
      observations: { github: { handle: null, picture: null } },
    },
    {
      reason: 'not_a_person',
      source: 'website-about',
      observations: {
        website: { picture: picture(1200, 630), saysPerson: false },
      },
    },
    {
      reason: 'not_public_url',
      source: 'instagram-public-og',
      observations: {
        instagramPublic: {
          picture: picture(400, 400, 'https://10.0.0.7/og.jpg'),
        },
      },
    },
    {
      reason: 'below_avatar_floor',
      source: 'instagram-public-og',
      observations: { instagramPublic: { picture: picture(64, 64) } },
    },
    {
      reason: 'size_unknown',
      source: 'github-avatar',
      observations: {
        github: { handle: 'dmihai91', picture: picture(null, null) },
      },
    },
  ];

  // Every reason is a sentence somebody is shown, so every one needs a fixture
  // that produces it. This is the table that proves none was left behind.
  it.each(REASON_CASES)(
    'produces the reason $reason from a real observation set',
    ({ reason, source, observations }) => {
      expect(candidateFor(observations, source).reason).toBe(reason);
    }
  );

  // And the table itself has to be complete, or it proves nothing.
  it('covers every member of the reason set exactly once', () => {
    expect(REASON_CASES.map((entry) => entry.reason).sort()).toEqual(
      [...ALL_REASONS].sort()
    );
  });

  /** One fixture per verdict, on the same argument as the reasons. */
  const VERDICT_CASES: Array<{
    verdict: PortraitSizeVerdict;
    source: PortraitSourceId;
    observations: PortraitObservations;
  }> = [
    {
      verdict: 'portrait',
      source: 'github-avatar',
      observations: {
        github: { handle: 'dmihai91', picture: picture(460, 460) },
      },
    },
    {
      verdict: 'avatar',
      source: 'instagram-public-og',
      observations: { instagramPublic: { picture: picture(100, 100) } },
    },
    {
      verdict: 'too_small',
      source: 'instagram-public-og',
      observations: { instagramPublic: { picture: picture(50, 50) } },
    },
    {
      verdict: 'unknown',
      source: 'website-about',
      observations: {},
    },
  ];

  // The verdict is printed next to the picture on the brief, so each one has to
  // be reachable from a real observation set.
  it.each(VERDICT_CASES)(
    'produces the verdict $verdict from a real observation set',
    ({ verdict, source, observations }) => {
      expect(candidateFor(observations, source).verdict).toBe(verdict);
    }
  );

  it('covers every member of the verdict set exactly once', () => {
    expect(VERDICT_CASES.map((entry) => entry.verdict).sort()).toEqual(
      [...ALL_VERDICTS].sort()
    );
  });
});

describe('the chosen candidate', () => {
  // Priority is the point of the order. A consented, full-size LinkedIn picture
  // beats a hundred-pixel public crop even though both are usable.
  it('prefers LinkedIn over the public Instagram picture when both are usable', () => {
    const verdict = judge({
      linkedin: {
        configured: true,
        connected: true,
        picture: picture(800, 800),
      },
      instagramPublic: { picture: picture(100, 100) },
    });
    expect(verdict.chosen?.source).toBe('linkedin-openid');
    expect(verdict.chosen?.rank).toBe(1);
    expect(verdict.chosen?.verdict).toBe('portrait');
    // The others are still in the table, which is what the brief prints.
    expect(verdict.candidates).toHaveLength(5);
    expect(
      verdict.candidates.filter((candidate) => candidate.usable)
    ).toHaveLength(2);
  });

  // Being first in the order is not enough. An unusable higher source is
  // skipped rather than chosen and apologised for.
  it('falls through to GitHub when LinkedIn is unusable', () => {
    const verdict = judge({
      linkedin: { configured: true, connected: true, picture: picture(50, 50) },
      github: { handle: 'dmihai91', picture: picture(460, 460) },
    });
    expect(verdict.chosen?.source).toBe('github-avatar');
    expect(verdict.chosen?.rank).toBe(3);
  });

  // The commonest case at the top of the funnel, and it still has to produce a
  // full table so the client can see what we tried.
  it('is null when nothing is usable, and still returns the whole table', () => {
    const verdict = judge({});
    expect(verdict.chosen).toBeNull();
    expect(verdict.candidates).toHaveLength(5);
    expect(
      verdict.candidates.every((candidate) => candidate.usable === false)
    ).toBe(true);
  });

  // The chosen candidate is the object from the table, not a copy of it, so the
  // brief cannot show one thing and the builder use another.
  it('is the same candidate object the table carries', () => {
    const verdict = judge({
      instagramPublic: { picture: picture(100, 100) },
    });
    expect(verdict.chosen).toBe(
      verdict.candidates.find((candidate) => candidate.usable)
    );
  });
});

describe('consent on the candidate', () => {
  // Rights are tracked separately from placement. The three automatic sources
  // are filed unconsented and become publishable only when the client taps
  // "Use this" on the brief, so this flag must not follow usability.
  it('is true for the two connect flows and false for the three automatic ones', () => {
    const verdict = judge({
      linkedin: {
        configured: true,
        connected: true,
        picture: picture(800, 800),
      },
      instagram: {
        configured: true,
        connected: true,
        picture: picture(800, 800),
        accountType: 'business',
      },
      github: { handle: 'dmihai91', picture: picture(460, 460) },
      website: { picture: picture(900, 900), saysPerson: true },
      instagramPublic: { picture: picture(100, 100) },
    });
    const consentBySource = Object.fromEntries(
      verdict.candidates.map((candidate) => [
        candidate.source,
        candidate.consented,
      ])
    );
    expect(consentBySource).toEqual({
      'linkedin-openid': true,
      'instagram-login': true,
      'github-avatar': false,
      'website-about': false,
      'instagram-public-og': false,
    });
  });

  // The same flags on an empty observation set, because consent is a fact about
  // the source rather than about what it returned.
  it('reports the same consent when every source is unusable', () => {
    const verdict = judge({});
    expect(verdict.candidates.map((candidate) => candidate.consented)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('the copy keys', () => {
  // The intake and the brief print the same sentence from the same rule, which
  // only works if the key is derived rather than typed twice.
  it('names a reason key per reason', () => {
    expect(portraitReasonCopyKey('usable')).toBe('portrait.reason.usable');
    expect(portraitReasonCopyKey('personal_account')).toBe(
      'portrait.reason.personal_account'
    );
    for (const reason of ALL_REASONS) {
      expect(portraitReasonCopyKey(reason)).toBe(`portrait.reason.${reason}`);
    }
  });

  it('names a verdict key per verdict', () => {
    expect(portraitVerdictCopyKey('portrait')).toBe(
      'portrait.verdict.portrait'
    );
    expect(portraitVerdictCopyKey('too_small')).toBe(
      'portrait.verdict.too_small'
    );
    for (const verdict of ALL_VERDICTS) {
      expect(portraitVerdictCopyKey(verdict)).toBe(
        `portrait.verdict.${verdict}`
      );
    }
  });

  it('names a source key per source, for "we found this on LinkedIn"', () => {
    expect(portraitSourceCopyKey('linkedin-openid')).toBe(
      'portrait.source.linkedin-openid'
    );
    for (const source of PORTRAIT_SOURCE_ORDER) {
      expect(portraitSourceCopyKey(source)).toBe(`portrait.source.${source}`);
    }
  });
});

describe('shouldRunAutomaticSources', () => {
  // There is nothing to gain from crawling somebody's website once they have
  // handed us a full-size photograph on purpose.
  it('is false once a connected LinkedIn account yielded a full-size portrait', () => {
    expect(
      shouldRunAutomaticSources(
        {
          linkedin: {
            configured: true,
            connected: true,
            picture: picture(800, 800),
          },
        },
        FLOORS
      )
    ).toBe(false);
  });

  // The same for the other connect flow.
  it('is false once a connected Instagram business account yielded one', () => {
    expect(
      shouldRunAutomaticSources(
        {
          instagram: {
            configured: true,
            connected: true,
            picture: picture(640, 640),
            accountType: 'business',
          },
        },
        FLOORS
      )
    ).toBe(false);
  });

  // An avatar-sized picture is not the hero image, so the automatic sources are
  // still worth running: GitHub's 460px avatar might beat it.
  it('is true when the connected picture is only avatar-sized', () => {
    expect(
      shouldRunAutomaticSources(
        {
          linkedin: {
            configured: true,
            connected: true,
            picture: picture(200, 200),
          },
        },
        FLOORS
      )
    ).toBe(true);
  });

  // Nothing connected is the normal top-of-funnel case, and it is exactly when
  // the automatic sources earn their keep.
  it('is true when nothing is connected at all', () => {
    expect(shouldRunAutomaticSources({}, FLOORS)).toBe(true);
    expect(
      shouldRunAutomaticSources(
        {
          linkedin: { configured: true, connected: false, picture: null },
          instagram: {
            configured: true,
            connected: false,
            picture: null,
            accountType: 'business',
          },
        },
        FLOORS
      )
    ).toBe(true);
  });

  // A personal Instagram account never produces a portrait, so it must not be
  // able to switch the automatic sources off.
  it('is true for a personal Instagram account whatever picture it carries', () => {
    expect(
      shouldRunAutomaticSources(
        {
          instagram: {
            configured: true,
            connected: true,
            picture: picture(1200, 1200),
            accountType: 'personal',
          },
        },
        FLOORS
      )
    ).toBe(true);
  });
});
