import { describe, expect, it } from 'vitest';
import {
  builtPageNames,
  changeRequestFeedback,
  changeRequestSummary,
  describeUnappliedChangeRequest,
  describeUncheckableChangeRequest,
  findChangeRequestPageIssue,
  findUnappliedChangeRequest,
  parseChangeRequestIntent,
  quotedRequestPhrases,
  unappliedChangeRequestFeedback,
  type ChangeRequestAsset,
  type ChangeRequestIntent,
} from '../src/flowstarter/change-request-build';

const CHANGE_ID = '72fe7f79-0e83-4cf6-9b4a-2502842b9a54';
const ASSET_ID = 'b104b1e0-6d4c-4a3e-9230-13cc17b426a0';

function asset(
  overrides: Partial<ChangeRequestAsset> = {},
): ChangeRequestAsset {
  return {
    assetId: ASSET_ID,
    publicPath: '/flowstarter-media/cr-b104b1e0.jpg',
    manifestPath: 'public/flowstarter-media/cr-b104b1e0.jpg',
    caption: 'The Flowstarter client dashboard',
    mime: 'image/jpeg',
    width: 1200,
    height: 750,
    ...overrides,
  };
}

function intent(
  overrides: Partial<ChangeRequestIntent> = {},
): ChangeRequestIntent {
  return {
    changeRequestId: CHANGE_ID,
    request:
      'The case study pages only show one picture each. Please add a small ' +
      'gallery section to the Flowstarter case study page with the three ' +
      'other screenshots I uploaded.',
    operatorNote: null,
    seedVersion: 4,
    assets: [asset()],
    ...overrides,
  };
}

describe('parseChangeRequestIntent', () => {
  it('reads the request, the note and the assets off a job payload', () => {
    const parsed = parseChangeRequestIntent({
      trigger: 'operator_build',
      changeRequest: {
        changeRequestId: CHANGE_ID,
        request: 'Add a gallery to the case study',
        operatorNote: 'Three across on desktop',
        seedVersion: 4,
        assets: [
          {
            assetId: ASSET_ID,
            publicPath: '/flowstarter-media/cr-b104b1e0.jpg',
            caption: 'The client dashboard',
            mime: 'image/jpeg',
            width: 1200,
            height: 750,
          },
        ],
      },
    });
    expect(parsed?.changeRequestId).toBe(CHANGE_ID);
    expect(parsed?.operatorNote).toBe('Three across on desktop');
    expect(parsed?.seedVersion).toBe(4);
    // The manifest path is derived rather than trusted, so a payload cannot
    // name a file outside the site's own media directory.
    expect(parsed?.assets[0]?.manifestPath).toBe(
      'public/flowstarter-media/cr-b104b1e0.jpg',
    );
  });

  it('returns null for a payload with no readable request', () => {
    expect(parseChangeRequestIntent(null)).toBeNull();
    expect(parseChangeRequestIntent({})).toBeNull();
    expect(parseChangeRequestIntent({ changeRequest: {} })).toBeNull();
    expect(
      parseChangeRequestIntent({
        changeRequest: { changeRequestId: CHANGE_ID, request: '   ' },
      }),
    ).toBeNull();
    expect(
      parseChangeRequestIntent({
        changeRequest: { changeRequestId: 'not-a-uuid', request: 'do a thing' },
      }),
    ).toBeNull();
  });

  it('drops an asset whose path is not under the site media directory', () => {
    const parsed = parseChangeRequestIntent({
      changeRequest: {
        changeRequestId: CHANGE_ID,
        request: 'Add a gallery',
        assets: [
          { assetId: ASSET_ID, publicPath: '/../../etc/passwd' },
          { assetId: ASSET_ID, publicPath: 'https://evil.example/x.jpg' },
          { assetId: 'nope', publicPath: '/flowstarter-media/a.jpg' },
          { assetId: ASSET_ID, publicPath: '/flowstarter-media/good.jpg' },
        ],
      },
    });
    expect(parsed?.assets.map((entry) => entry.publicPath)).toEqual([
      '/flowstarter-media/good.jpg',
    ]);
  });

  it('caps the assets a single request can carry', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      assetId: ASSET_ID,
      publicPath: `/flowstarter-media/a${index}.jpg`,
    }));
    const parsed = parseChangeRequestIntent({
      changeRequest: {
        changeRequestId: CHANGE_ID,
        request: 'Add them all',
        assets: many,
      },
    });
    expect(parsed?.assets).toHaveLength(12);
  });
});

describe('quotedRequestPhrases', () => {
  it('takes only what the client put in quotation marks', () => {
    expect(
      quotedRequestPhrases(
        'Please change the heading to "We build websites with AI agents" and ' +
          'leave the rest alone.',
      ),
    ).toEqual(['We build websites with AI agents']);
  });

  it('reads curly quotes the same as straight ones', () => {
    expect(
      quotedRequestPhrases(
        '“Booking made simple for busy clinics” should be the strapline',
      ),
    ).toEqual(['Booking made simple for busy clinics']);
  });

  it('refuses a quoted string that is not prose', () => {
    // The #98 lesson, applied a second time: a gate built on a file name, a
    // url or a timestamp can only ever fail a build that did the work.
    expect(quotedRequestPhrases('use "hero-image-2.png" for it')).toEqual([]);
    expect(
      quotedRequestPhrases('link it to "https://cal.com/darius/intro" please'),
    ).toEqual([]);
    expect(quotedRequestPhrases('the "pid" value')).toEqual([]);
  });

  it('finds nothing in an ordinary instruction', () => {
    expect(
      quotedRequestPhrases('Add a small gallery to the case study pages'),
    ).toEqual([]);
  });
});

describe('changeRequestFeedback', () => {
  it('states the request verbatim and names every asset path', () => {
    const prompt = changeRequestFeedback(
      intent({ operatorNote: 'Three across on desktop' }),
    );
    expect(prompt).toContain('PAID CHANGE REQUEST');
    expect(prompt).toContain('add a small gallery section');
    expect(prompt).toContain('Three across on desktop');
    expect(prompt).toContain('/flowstarter-media/cr-b104b1e0.jpg (1200x750)');
    expect(prompt).toContain('The Flowstarter client dashboard');
  });

  it('forbids inventing things and forbids adding images', () => {
    const prompt = changeRequestFeedback(intent());
    expect(prompt).toContain('Invent nothing');
    expect(prompt).toContain('Add no image file');
    expect(prompt).toContain('Do the request and nothing else');
  });

  it('refuses to describe an uncaptioned picture', () => {
    const prompt = changeRequestFeedback(
      intent({ assets: [asset({ caption: '' })] }),
    );
    expect(prompt).toContain('has no caption');
    expect(prompt).toContain('never claim what it depicts');
  });

  it('bars new images outright when no picture is attached', () => {
    const prompt = changeRequestFeedback(intent({ assets: [] }));
    expect(prompt).toContain('No client pictures are attached');
    expect(prompt).toContain('Do not add any image file');
  });
});

describe('changeRequestSummary', () => {
  it('names the seed version, the pictures and the request', () => {
    const line = changeRequestSummary(intent({ operatorNote: 'Three across' }));
    expect(line).toContain('version 4 of the published site');
    expect(line).toContain("1 of the client's own picture");
    expect(line).toContain('/flowstarter-media/cr-b104b1e0.jpg');
    expect(line).toContain('Team note: Three across');
  });

  it('says so when there is no saved version and no picture', () => {
    const line = changeRequestSummary(
      intent({ seedVersion: 0, assets: [], operatorNote: null }),
    );
    expect(line).toContain('the delivered site');
    expect(line).toContain('no pictures attached');
    expect(line).not.toContain('Team note');
  });
});

describe('findUnappliedChangeRequest', () => {
  const built = (content: string) => [{ path: 'dist/index.html', content }];

  it('passes when the asset path is referenced by the built site', () => {
    expect(
      findUnappliedChangeRequest(
        built('<img src="/flowstarter-media/cr-b104b1e0.jpg" alt="dashboard">'),
        intent(),
      ),
    ).toBeNull();
  });

  it('passes when the file is merely emitted, for a CSS background', () => {
    expect(
      findUnappliedChangeRequest(
        [
          { path: 'dist/index.html', content: '<p>no img tag here</p>' },
          {
            path: 'dist/flowstarter-media/cr-b104b1e0.jpg',
            content: 'binary',
          },
        ],
        intent(),
      ),
    ).toBeNull();
  });

  it('reports a picture the client paid for that is on no page', () => {
    const missing = findUnappliedChangeRequest(
      built('<p>a site with none of it</p>'),
      intent(),
    );
    expect(missing?.missingAssets).toEqual([
      '/flowstarter-media/cr-b104b1e0.jpg',
    ]);
  });

  it('reports wording the client quoted and the build dropped', () => {
    const missing = findUnappliedChangeRequest(
      built('<h1>Something else entirely</h1>'),
      intent({
        assets: [],
        request: 'Make the heading say "We build websites with AI agents"',
      }),
    );
    expect(missing?.missingPhrases).toEqual([
      'We build websites with AI agents',
    ]);
  });

  it('matches quoted wording across a reflow and a case change', () => {
    expect(
      findUnappliedChangeRequest(
        built('<h1>WE BUILD WEBSITES\n   WITH AI AGENTS</h1>'),
        intent({
          assets: [],
          request: 'Make the heading say "We build websites with AI agents"',
        }),
      ),
    ).toBeNull();
  });

  it('passes a request with nothing checkable rather than failing it', () => {
    // The whole of the #98 lesson in one assertion: a check that cannot be
    // evaluated must never fail a build somebody paid for.
    const nothing = intent({
      assets: [],
      request: 'Please make the contact page feel a bit warmer',
    });
    expect(
      findUnappliedChangeRequest(built('<p>anything</p>'), nothing),
    ).toBeNull();
    expect(describeUncheckableChangeRequest(nothing)).toContain(
      'nothing in the built site this check can be held to',
    );
  });
});

describe('the repair brief and the failure detail', () => {
  it('names the missing pictures and forbids inventing a substitute', () => {
    const missing = {
      missingAssets: ['/flowstarter-media/cr-b104b1e0.jpg'],
      missingPhrases: [],
    };
    const brief = unappliedChangeRequestFeedback(intent(), missing);
    expect(brief).toContain('UNDELIVERED PAID CHANGE');
    expect(brief).toContain('/flowstarter-media/cr-b104b1e0.jpg');
    expect(brief).toContain('Invent no project, image, client or claim');
  });

  it('says the request was left at paid', () => {
    const detail = describeUnappliedChangeRequest(intent(), {
      missingAssets: ['/flowstarter-media/cr-b104b1e0.jpg'],
      missingPhrases: ['We build websites'],
    });
    expect(detail).toContain('pictures not on the site');
    expect(detail).toContain('wording not on the site');
    expect(detail).toContain('left at paid');
  });
});

describe('the change request page budget', () => {
  it('reads top-level page names off a built output', () => {
    expect(
      builtPageNames([
        'index.html',
        'about/index.html',
        'work/index.html',
        'case-studies/flowstarter/index.html',
        'assets/app.css',
      ]),
    ).toEqual(['(home)', 'about', 'case-studies', 'work']);
  });

  it('allows the page the client just paid for', () => {
    expect(
      findChangeRequestPageIssue(
        ['(home)', 'about', 'contact'],
        ['(home)', 'about', 'contact', 'workshops'],
      ),
    ).toBeUndefined();
  });

  it('never fails a build for the pages the site already had', () => {
    const pages = ['(home)', 'about', 'contact', 'work', 'case-studies'];
    expect(findChangeRequestPageIssue(pages, pages)).toBeUndefined();
  });

  it('fires when a one-section ask came back as a new site', () => {
    const issue = findChangeRequestPageIssue(
      ['(home)', 'about'],
      ['(home)', 'about', 'blog', 'shop', 'pricing', 'careers'],
    );
    expect(issue).toContain('added 4 new pages');
    expect(issue).toContain('blog, shop, pricing, careers');
  });
});
