import { describe, expect, it } from 'vitest';
import {
  builtPageNames,
  changeRequestFeedback,
  changeRequestSeedPages,
  changeRequestSummary,
  describeChangeRequestPageChange,
  describeUnappliedChangeRequest,
  describeUncheckableChangeRequest,
  diffChangeRequestPages,
  findChangeRequestPageIssue,
  findChangeRequestRepairDamage,
  findUnappliedChangeRequest,
  parseChangeRequestIntent,
  planChangeRequestPageRepair,
  quotedRequestPhrases,
  seedPageNames,
  unappliedChangeRequestFeedback,
  CHANGE_REQUEST_PAGE_BUDGET,
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
    assetSelection: 'named',
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

  it('reads the handover, and reads an old payload as the strict one', () => {
    const withSelection = parseChangeRequestIntent({
      changeRequest: {
        changeRequestId: CHANGE_ID,
        request: 'Fix the typo',
        assetSelection: 'library',
      },
    });
    expect(withSelection?.assetSelection).toBe('library');
    // Payloads written before this field existed carried assets a build was
    // required to place, so an absent or junk value stays required.
    for (const value of [undefined, null, 'everything', 7]) {
      expect(
        parseChangeRequestIntent({
          changeRequest: {
            changeRequestId: CHANGE_ID,
            request: 'Fix the typo',
            assetSelection: value,
          },
        })?.assetSelection,
      ).toBe('named');
    }
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
    expect(prompt).toContain('Never add or replace a file under public/');
    expect(prompt).toContain('Do the request and nothing else');
  });

  it('lets the agent obey the placeholder gate instead of only breaking it', () => {
    // Job 2716f978: the agent made the requested change correctly and the
    // build still failed, because the gate of record hashes `dist/` and the
    // only way to clear a template placeholder is to delete the file — which
    // rules 1 and 3 flatly forbade. A gate an agent is forbidden to obey is
    // not a gate, it is a trap.
    const prompt = changeRequestFeedback(intent());
    expect(prompt).toContain(
      'You may delete a file under public/ that the placeholder-image gate ' +
        'names by path',
    );
    expect(prompt).toContain('and only such a file');
    // The exception is written into rule 1 too, which is the rule that says
    // to leave every other file exactly as it is.
    expect(prompt).toContain('The one exception is rule 3');
    // And it says what to leave behind, so the agent does not invent a
    // replacement picture on its way out.
    expect(prompt).toContain('the typographic project tile');
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

  it('tells an agent to use every picture the request actually named', () => {
    const prompt = changeRequestFeedback(intent({ assetSelection: 'named' }));
    expect(prompt).toContain('Use every one of these pictures');
  });

  it('offers a library instead of demanding it be used', () => {
    const prompt = changeRequestFeedback(intent({ assetSelection: 'library' }));
    expect(prompt).toContain("THE CLIENT'S PICTURE LIBRARY");
    expect(prompt).toContain('available if the request calls for them');
    expect(prompt).toContain('leave the rest out');
    // The sentence that put unrelated photographs on a paid page.
    expect(prompt).not.toContain('Use every one of these pictures');
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

  it('never holds a build to a library it was only offered', () => {
    // Nothing in the request named this file, so a build that did not need
    // it has done nothing wrong and must not be failed for leaving it out.
    expect(
      findUnappliedChangeRequest(
        built('<p>the copy fix that was asked for</p>'),
        intent({
          assetSelection: 'library',
          request: 'Please fix the typo in the About heading',
        }),
      ),
    ).toBeNull();
  });

  it('still holds it to quoted wording when the library is offered', () => {
    const missing = findUnappliedChangeRequest(
      built('<h1>Something else</h1>'),
      intent({
        assetSelection: 'library',
        request: 'Make the heading say "We build websites with AI agents"',
      }),
    );
    expect(missing?.missingPhrases).toEqual([
      'We build websites with AI agents',
    ]);
    expect(missing?.missingAssets).toEqual([]);
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

/**
 * The manifest shape the four failed jobs of 2026-09-12 actually carried:
 * published Astro source, five routes, one of them dynamic with three content
 * entries behind it, plus the client's own pictures under `public/`. Not one
 * path in it ends in `.html`, which is the whole reason the gate read it as an
 * empty site and failed every paid change request against it.
 */
function seedManifestPaths(): string[] {
  return [
    'package.json',
    'astro.config.mjs',
    'src/pages/index.astro',
    'src/pages/about.astro',
    'src/pages/work.astro',
    'src/pages/contact.astro',
    'src/pages/case-studies/[slug].astro',
    'src/pages/_components/Nav.astro',
    'src/pages/api/contact.ts',
    'src/layouts/Base.astro',
    'src/components/Hero.astro',
    'src/content/case-studies/flowstarter.md',
    'src/content/case-studies/riverside.md',
    'src/content/case-studies/northwind.md',
    'src/content/config.ts',
    'src/styles/tokens.css',
    'public/robots.txt',
    'public/flowstarter-media/cr-b104b1e0.jpg',
  ];
}

/** The same five routes as a build of that manifest emits them. */
function builtManifestPaths(): string[] {
  return [
    'index.html',
    'about/index.html',
    'work/index.html',
    'contact/index.html',
    'case-studies/flowstarter/index.html',
    'case-studies/riverside/index.html',
    'case-studies/northwind/index.html',
    '_astro/app.Dk3s.css',
    'robots.txt',
  ];
}

describe('the seed page set, read off a published manifest', () => {
  it('names the five routes a real manifest carries', () => {
    expect(seedPageNames(seedManifestPaths())).toEqual([
      '(home)',
      'about',
      'case-studies',
      'contact',
      'work',
    ]);
  });

  it('collapses a dynamic route and its three entries to one section', () => {
    // Both sides collapse `case-studies/<slug>` to `case-studies`, so the
    // three content entries never read as three extra pages on either side.
    const seed = seedPageNames(seedManifestPaths());
    const built = builtPageNames(builtManifestPaths());
    expect(seed).toEqual(built);
    expect(built.filter((page) => page === 'case-studies')).toHaveLength(1);
  });

  it('ignores what Astro does not turn into a page', () => {
    expect(
      seedPageNames([
        'src/pages/_draft.astro',
        'src/pages/_partials/card.astro',
        'src/pages/api/contact.ts',
        'src/pages/[...catchall].astro',
        'src/content/blog/one.md',
        'public/about.astro',
      ]),
    ).toEqual([]);
  });

  it('reads a manifest that somehow holds built output as built output', () => {
    // The one thing an unreadable baseline must never become is "this site
    // had no pages", because that reading is what failed four paid builds.
    expect(changeRequestSeedPages(builtManifestPaths())).toEqual([
      '(home)',
      'about',
      'case-studies',
      'contact',
      'work',
    ]);
  });
});

describe('the budget, with the seed actually read', () => {
  const seed = seedPageNames(seedManifestPaths());

  it('passes the five-route site that used to fail on attempt 1', () => {
    expect(
      findChangeRequestPageIssue(seed, builtPageNames(builtManifestPaths())),
    ).toBeUndefined();
  });

  it('can never fail a request that only removes pages', () => {
    const built = builtPageNames(
      builtManifestPaths().filter(
        (path) => !path.startsWith('work/') && !path.startsWith('about/'),
      ),
    );
    expect(findChangeRequestPageIssue(seed, built)).toBeUndefined();
    expect(planChangeRequestPageRepair(seed, built).action).toBe('pass');
  });

  it('reports removed pages as removed and never as new', () => {
    const change = diffChangeRequestPages(seed, ['(home)', 'about', 'contact']);
    expect(change.removed).toEqual(['case-studies', 'work']);
    expect(change.added).toEqual([]);
    const line = describeChangeRequestPageChange(change);
    expect(line).toContain('removed 2 pages (case-studies, work)');
    expect(line).not.toContain('added');
  });

  it('says so plainly when nothing about the page set moved', () => {
    const change = diffChangeRequestPages(seed, seed);
    expect(describeChangeRequestPageChange(change)).toContain(
      'left all 5 pages of the site in place',
    );
  });

  it('names both halves when a build added and removed at once', () => {
    const line = describeChangeRequestPageChange(
      diffChangeRequestPages(seed, ['(home)', 'about', 'shop']),
    );
    expect(line).toContain('added 1 page (shop)');
    expect(line).toContain('removed 3 pages (case-studies, contact, work)');
  });

  it('takes the allowance from config rather than a literal', () => {
    const over = [
      ...seed,
      ...Array.from(
        { length: CHANGE_REQUEST_PAGE_BUDGET.newPageAllowance + 1 },
        (_unused, index) => `invented-${index}`,
      ),
    ];
    const inside = over.slice(0, over.length - 1);
    expect(findChangeRequestPageIssue(seed, inside)).toBeUndefined();
    expect(findChangeRequestPageIssue(seed, over)).toContain(
      `At most ${CHANGE_REQUEST_PAGE_BUDGET.newPageAllowance} new pages`,
    );
  });

  it('mentions the routes a runaway build also dropped', () => {
    const issue = findChangeRequestPageIssue(seed, [
      '(home)',
      'blog',
      'shop',
      'pricing',
      'careers',
    ]);
    expect(issue).toContain('It also removed 4 the site already had');
  });
});

describe('the repair plan, which may never point at a paid route', () => {
  const seed = seedPageNames(seedManifestPaths());

  it('names only the pages this pass invented, and protects the rest', () => {
    const plan = planChangeRequestPageRepair(seed, [
      ...seed,
      'blog',
      'shop',
      'pricing',
    ]);
    expect(plan.action).toBe('repair');
    if (plan.action !== 'repair') return;
    expect(plan.removePages).toEqual(['blog', 'shop', 'pricing']);
    expect(plan.protectedPages).toEqual(seed);
    expect(plan.instruction).toContain(
      'Delete only these pages, which this pass created and the request did ' +
        'not ask for: blog, shop, pricing.',
    );
    // The sentence that cost a client their case-study route is gone, and
    // every seed route is named as untouchable in its place.
    expect(plan.instruction).not.toContain(
      'Remove the pages the request did not ask for',
    );
    expect(plan.instruction).toContain('not emptied, not rewritten');
    for (const page of seed) {
      expect(plan.instruction).toContain(page);
      expect(plan.removePages).not.toContain(page);
    }
    expect(plan.instruction).toContain('Do not touch robots.txt');
  });

  it('fails instead of repairing when approved routes are already gone', () => {
    const plan = planChangeRequestPageRepair(seed, [
      '(home)',
      'about',
      'blog',
      'shop',
      'pricing',
    ]);
    expect(plan.action).toBe('fail');
    expect(plan.summary).toContain('the client had already paid for');
    expect(plan.summary).toContain('case-studies, contact, work');
    expect(plan.summary).toContain('The request stays paid.');
  });

  it('leaves a build inside the allowance alone', () => {
    const plan = planChangeRequestPageRepair(seed, [...seed, 'workshops']);
    expect(plan.action).toBe('pass');
    expect(plan.summary).toContain('added 1 page (workshops)');
  });
});

describe('the post-repair diff, against what the repair actually did', () => {
  const seedPaths = seedManifestPaths();
  const before = [
    {
      path: 'src/pages/case-studies/[slug].astro',
      content: 'x'.repeat(7_400),
    },
    { path: 'src/pages/work.astro', content: 'y'.repeat(3_000) },
    { path: 'src/pages/contact.astro', content: 'z'.repeat(900) },
    { path: 'public/robots.txt', content: 'User-agent: *\nAllow: /\n' },
  ];

  it('refuses the 355-byte stub the real repair left behind', () => {
    const damage = findChangeRequestRepairDamage(seedPaths, before, [
      { path: 'src/pages/case-studies/[slug].astro', content: 'x'.repeat(355) },
      { path: 'src/pages/work.astro', content: 'y'.repeat(3_000) },
      { path: 'public/robots.txt', content: 'User-agent: *\nAllow: /\n' },
    ]);
    expect(damage).toContain('emptied route file');
    expect(damage).toContain('src/pages/case-studies/[slug].astro');
    expect(damage).toContain('7400 bytes -> 355');
    expect(damage).toContain('deleted route file');
    expect(damage).toContain('src/pages/contact.astro');
    expect(damage).toContain('the request stays paid');
  });

  it('refuses a robots.txt pointing at a domain nobody owns', () => {
    const damage = findChangeRequestRepairDamage(
      seedPaths,
      before,
      before.map((file) =>
        file.path === 'public/robots.txt'
          ? {
              path: file.path,
              content:
                'User-agent: *\nAllow: /\n' +
                'Sitemap: https://darius-portfolio.com/sitemap.xml\n',
            }
          : file,
      ),
      { siteHostname: 'calm-path.flowstarter.net' },
    );
    expect(damage).toContain('a domain this site does not own');
    expect(damage).toContain('darius-portfolio.com');
  });

  it("allows the site's own hostname and a host that was already there", () => {
    expect(
      findChangeRequestRepairDamage(
        seedPaths,
        [
          ...before,
          {
            path: 'public/sitemap.xml',
            content: '<url><loc>https://calm-path.flowstarter.net/</loc></url>',
          },
        ],
        [
          ...before,
          {
            path: 'public/sitemap.xml',
            content:
              '<url><loc>https://calm-path.flowstarter.net/about</loc></url>',
          },
        ],
        { siteHostname: 'calm-path.flowstarter.net' },
      ),
    ).toBeUndefined();
  });

  it('lets a repair delete the pages this build invented', () => {
    // `shop.astro` is a route file and it is gone afterwards -- and that is
    // the repair doing precisely its job, because the seed never had it.
    expect(
      findChangeRequestRepairDamage(
        seedPaths,
        [...before, { path: 'src/pages/shop.astro', content: 'invented' }],
        before,
      ),
    ).toBeUndefined();
  });

  it('measures a binary file by its bytes, not its base64', () => {
    // A route file is never base64, but the diff walks a whole manifest and
    // must not read an encoded picture as though it had tripled in size.
    const encoded = {
      path: 'src/pages/index.astro',
      content: Buffer.from('a'.repeat(300)).toString('base64'),
      encoding: 'base64',
    };
    expect(
      findChangeRequestRepairDamage(seedPaths, [encoded], [encoded]),
    ).toBeUndefined();
  });
});

/**
 * The four jobs of 2026-09-12, replayed in shape.
 *
 * Workspace c009105e, jobs 4d4f3a40, f9e68f3c, 9f967a07 and 050d83b3 all died
 * on attempt 1 with PAGE_BUDGET_EXCEEDED against the same version-4 manifest.
 * This is that manifest at its real size, through the real gate.
 */
describe('the four failed jobs, replayed', () => {
  function versionFourManifest(): string[] {
    const paths = seedManifestPaths();
    // 110 files, the size the real one was: the extra 92 are components,
    // styles and pictures, none of which is a route.
    for (let index = paths.length; index < 110; index += 1) {
      paths.push(
        index % 2 === 0
          ? `src/components/Block${index}.astro`
          : `public/flowstarter-media/shot-${index}.jpg`,
      );
    }
    return paths;
  }

  const seed = changeRequestSeedPages(versionFourManifest());

  it('reads five routes off a 110-file manifest, not zero', () => {
    expect(versionFourManifest()).toHaveLength(110);
    expect(seed).toEqual([
      '(home)',
      'about',
      'case-studies',
      'contact',
      'work',
    ]);
  });

  it('passes the gallery request that failed four times', () => {
    const built = builtPageNames(builtManifestPaths());
    const plan = planChangeRequestPageRepair(seed, built);
    expect(findChangeRequestPageIssue(seed, built)).toBeUndefined();
    expect(plan.action).toBe('pass');
  });

  it('passes a removal request against the same site', () => {
    const built = builtPageNames(
      builtManifestPaths().filter((path) => !path.startsWith('work/')),
    );
    const plan = planChangeRequestPageRepair(seed, built);
    expect(findChangeRequestPageIssue(seed, built)).toBeUndefined();
    expect(plan.action).toBe('pass');
    expect(plan.summary).toContain('removed 1 page (work)');
  });

  it('still catches the failure the gate exists for', () => {
    const built = ['(home)', 'blog', 'shop', 'pricing', 'careers', 'team'];
    expect(findChangeRequestPageIssue(seed, built)).toContain(
      'added 5 new pages',
    );
  });
});
