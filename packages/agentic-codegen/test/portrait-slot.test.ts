import { describe, expect, it } from 'vitest';
import {
  allowedPlacements,
  buildPortraitFrom,
  DEFAULT_PORTRAIT_EDGE,
  findPortraitSlotFindings,
  findPortraitSlotIssue,
  describePortraitSlotIssue,
  describePortraitSlotRepair,
  placementForSlot,
  portraitSlotsInFiles,
  PORTRAIT_MISPLACED,
  PORTRAIT_SLOT_UNFILLED,
  PORTRAIT_UPSCALED,
  type BuildPortrait,
} from '../src/flowstarter/portrait-slot';
import { findPlaceholderImageIssue } from '../src/flowstarter/workflows';

/** The Instagram case: a real picture of the client, 100 pixels square. */
const AVATAR_PORTRAIT: BuildPortrait = {
  publicPath: '/flowstarter-media/portrait-7.jpg',
  verdict: 'avatar',
  longEdge: 100,
};

/** The LinkedIn case: the person pressed the button and we got a real one. */
const FULL_PORTRAIT: BuildPortrait = {
  publicPath: '/flowstarter-media/portrait-7.jpg',
  verdict: 'portrait',
  longEdge: 1200,
};

const CONTENT = 'src/content/content.md';
const LABELS = 'src/content/site-labels.md';

function file(path: string, content: string) {
  return { path, content };
}

describe('placementForSlot', () => {
  it('reads an avatar key as an avatar slot, whatever section it sits in', () => {
    expect(placementForSlot({ section: 'general', key: 'avatar' })).toBe(
      'avatar',
    );
  });

  it('reads an authorImage key as an avatar slot', () => {
    expect(placementForSlot({ section: 'blog', key: 'authorImage' })).toBe(
      'avatar',
    );
  });

  it('reads a testimonials section as an avatar slot on the section alone', () => {
    expect(placementForSlot({ section: 'testimonials', key: 'image' })).toBe(
      'avatar',
    );
  });

  it('reads a hero section as the hero slot', () => {
    expect(placementForSlot({ section: 'hero', key: 'image' })).toBe('hero');
  });

  it('reads an aboutStory section as the about slot', () => {
    expect(placementForSlot({ section: 'aboutStory', key: 'image' })).toBe(
      'about',
    );
  });

  it('falls through to about for a section no pattern recognises', () => {
    // The fall-through answers "what would a portrait be if it were put
    // here": a body-width picture down the page, never a hero. It does not
    // make the slot one a portrait is owed, which is asserted below.
    expect(placementForSlot({ section: 'sparkle', key: 'image' })).toBe(
      'about',
    );
  });
});

describe('allowedPlacements', () => {
  it('lets a full-size portrait go anywhere, smallest included', () => {
    expect(allowedPlacements('portrait')).toEqual(['hero', 'about', 'avatar']);
  });

  it('lets a picture below the floor be an avatar and nothing else', () => {
    expect(allowedPlacements('avatar')).toEqual(['avatar']);
  });
});

describe('portraitSlotsInFiles', () => {
  it('reads both content file names and reports the 1-based line', () => {
    const slots = portraitSlotsInFiles([
      file(
        CONTENT,
        ['---', 'hero:', '  image: "/images/hero.png"', '---'].join('\n'),
      ),
      file(
        LABELS,
        ['aboutMe:', '  image: "/images/about-me-photo.svg"'].join('\n'),
      ),
    ]);
    expect(slots.map((slot) => [slot.file, slot.line, slot.section])).toEqual([
      [CONTENT, 3, 'hero'],
      [LABELS, 2, 'aboutMe'],
    ]);
  });

  it('ignores a file that is not one of the template content files', () => {
    expect(
      portraitSlotsInFiles([
        file(
          'src/pages/index.astro',
          'const hero = { image: "/images/hero.png" };',
        ),
        file('dist/index.html', '<img src="/images/hero.png" />'),
      ]),
    ).toEqual([]);
  });

  it('ignores a key whose value is not an image path', () => {
    // Some templates reuse `logo` for a text wordmark.
    const slots = portraitSlotsInFiles([
      file(
        CONTENT,
        ['brand:', '  logo: "Halden Joinery"', '  image: "/images/x.png"'].join(
          '\n',
        ),
      ),
    ]);
    expect(slots).toHaveLength(1);
    expect(slots[0]?.currentPath).toBe('/images/x.png');
  });
});

describe('findPortraitSlotFindings', () => {
  it('says nothing at all when there is no portrait, however much template art there is', () => {
    // A build with no photograph renders initials, which is PR #110's
    // typographic fallback and the honest answer, not a defect.
    expect(
      findPortraitSlotFindings(
        [
          file(
            CONTENT,
            [
              'hero:',
              '  image: "/images/hero.png"',
              'about:',
              '  image: "/images/about-me-photo.svg"',
            ].join('\n'),
          ),
        ],
        null,
      ),
    ).toEqual([]);
  });

  it('fails a 100px picture put in the hero slot: it only fills one by being scaled up', () => {
    const findings = findPortraitSlotFindings(
      [
        file(
          CONTENT,
          ['hero:', `  image: "${AVATAR_PORTRAIT.publicPath}"`].join('\n'),
        ),
      ],
      AVATAR_PORTRAIT,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe(PORTRAIT_UPSCALED);
    expect(findings[0]?.placement).toBe('hero');
    expect(findings[0]?.slot.line).toBe(2);
  });

  it('is happy with the same picture in an avatar slot, which is what it is for', () => {
    expect(
      findPortraitSlotFindings(
        [
          file(
            CONTENT,
            [
              'testimonials:',
              `  - avatar: "${AVATAR_PORTRAIT.publicPath}"`,
            ].join('\n'),
          ),
        ],
        AVATAR_PORTRAIT,
      ),
    ).toEqual([]);
  });

  it('is happy with a full-size portrait in the hero slot', () => {
    expect(
      findPortraitSlotFindings(
        [
          file(
            CONTENT,
            ['hero:', `  image: "${FULL_PORTRAIT.publicPath}"`].join('\n'),
          ),
        ],
        FULL_PORTRAIT,
      ),
    ).toEqual([]);
  });

  it('fails an about slot still holding the template guide graphic while a portrait exists', () => {
    const findings = findPortraitSlotFindings(
      [
        file(
          CONTENT,
          ['about:', '  image: "/images/about-me-photo.svg"'].join('\n'),
        ),
      ],
      FULL_PORTRAIT,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe(PORTRAIT_SLOT_UNFILLED);
    expect(findings[0]?.slot.currentPath).toBe('/images/about-me-photo.svg');
  });

  it('leaves case-study and unnamed slots alone: a portrait is not owed to them', () => {
    expect(
      findPortraitSlotFindings(
        [
          file(
            CONTENT,
            [
              'caseStudies:',
              '  - image: "/images/boutique.png"',
              'sparkle:',
              '  image: "/images/masonry.png"',
            ].join('\n'),
          ),
        ],
        FULL_PORTRAIT,
      ),
    ).toEqual([]);
  });

  it('says nothing about a slot already holding other client media', () => {
    // Not the portrait, but not the template's art either: a photograph the
    // client uploaded for that slot is theirs and stays.
    expect(
      findPortraitSlotFindings(
        [
          file(
            CONTENT,
            ['about:', '  image: "/flowstarter-media/workshop-3.jpg"'].join(
              '\n',
            ),
          ),
        ],
        FULL_PORTRAIT,
      ),
    ).toEqual([]);
  });

  it('wants an avatar-verdict portrait in the byline, not the about slot', () => {
    const findings = findPortraitSlotFindings(
      [
        file(
          CONTENT,
          [
            'about:',
            '  image: "/images/about-me-photo.svg"',
            'testimonials:',
            '  - avatar: "/images/face.png"',
          ].join('\n'),
        ),
      ],
      AVATAR_PORTRAIT,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.placement).toBe('avatar');
    expect(findings[0]?.slot.line).toBe(4);
  });

  it('sorts findings by file then line, whatever order the caller collected in', () => {
    const findings = findPortraitSlotFindings(
      [
        file(
          LABELS,
          ['testimonials:', '  - avatar: "/images/face.png"'].join('\n'),
        ),
        file(
          CONTENT,
          [
            'hero:',
            `  image: "${AVATAR_PORTRAIT.publicPath}"`,
            'team:',
            '  - avatar: "/images/studio-portrait.svg"',
          ].join('\n'),
        ),
      ],
      AVATAR_PORTRAIT,
    );
    expect(
      findings.map((finding) => `${finding.slot.file}#${finding.slot.line}`),
    ).toEqual([`${CONTENT}#2`, `${CONTENT}#4`, `${LABELS}#2`]);
  });
});

describe('findPortraitSlotIssue', () => {
  it('is undefined for a site that placed the picture properly', () => {
    expect(
      findPortraitSlotIssue(
        [
          file(
            CONTENT,
            ['about:', `  image: "${FULL_PORTRAIT.publicPath}"`].join('\n'),
          ),
        ],
        FULL_PORTRAIT,
      ),
    ).toBeUndefined();
  });

  it('is undefined when there is no portrait to misplace', () => {
    expect(
      findPortraitSlotIssue(
        [
          file(
            CONTENT,
            ['about:', '  image: "/images/about-me-photo.svg"'].join('\n'),
          ),
        ],
        null,
      ),
    ).toBeUndefined();
  });

  it('names the code, the file, the line, the size and the remedy', () => {
    const message = findPortraitSlotIssue(
      [
        file(
          CONTENT,
          ['hero:', `  image: "${AVATAR_PORTRAIT.publicPath}"`].join('\n'),
        ),
      ],
      AVATAR_PORTRAIT,
    );
    expect(message?.startsWith(PORTRAIT_UPSCALED)).toBe(true);
    expect(message).toContain(CONTENT);
    expect(message).toContain('line 2');
    expect(message).toContain('100px');
    expect(message).toContain('avatar');
    // House style for anything an agent or the job log is shown: no em dash.
    expect(message).not.toContain('\u2014');
  });

  it('lists at most eight slots and counts the rest', () => {
    const lines = ['team:'];
    for (let index = 0; index < 9; index += 1) {
      lines.push(`  - avatar: "/images/face-${index}.png"`);
    }
    const message = findPortraitSlotIssue(
      [file(CONTENT, lines.join('\n'))],
      AVATAR_PORTRAIT,
    );
    expect(message).toContain('face-7.png');
    expect(message).not.toContain('face-8.png');
    expect(message).toContain('and 1 more');
  });

  it('carries both codes when a site manages both defects at once', () => {
    const message = findPortraitSlotIssue(
      [
        file(
          CONTENT,
          [
            'hero:',
            `  image: "${AVATAR_PORTRAIT.publicPath}"`,
            'testimonials:',
            '  - avatar: "/images/face.png"',
          ].join('\n'),
        ),
      ],
      AVATAR_PORTRAIT,
    );
    expect(message).toContain(PORTRAIT_UPSCALED);
    expect(message).toContain(PORTRAIT_SLOT_UNFILLED);
  });
});

describe('buildPortraitFrom', () => {
  const floors = { portraitEdge: DEFAULT_PORTRAIT_EDGE };

  it('mirrors the app: 400 is the hero and about floor', () => {
    expect(DEFAULT_PORTRAIT_EDGE).toBe(400);
  });

  it('reads a full-size picture as a portrait', () => {
    expect(
      buildPortraitFrom(
        {
          portrait: {
            publicPath: '/flowstarter-media/portrait-7.jpg',
            width: 1200,
            height: 1200,
          },
        },
        floors,
      ),
    ).toEqual({
      publicPath: '/flowstarter-media/portrait-7.jpg',
      verdict: 'portrait',
      longEdge: 1200,
    });
  });

  it('reads Instagram’s 100 square public picture as an avatar', () => {
    expect(
      buildPortraitFrom(
        {
          portrait: {
            publicPath: '/flowstarter-media/portrait-7.jpg',
            width: 100,
            height: 100,
          },
        },
        floors,
      )?.verdict,
    ).toBe('avatar');
  });

  it('takes the longest edge, not the width', () => {
    expect(
      buildPortraitFrom(
        {
          portrait: {
            publicPath: '/flowstarter-media/portrait-7.jpg',
            width: 300,
            height: 900,
          },
        },
        floors,
      )?.longEdge,
    ).toBe(900);
  });

  it('refuses a path outside the client media directory', () => {
    expect(
      buildPortraitFrom(
        {
          portrait: {
            publicPath: '/images/about-me-photo.svg',
            width: 1200,
            height: 1200,
          },
        },
        floors,
      ),
    ).toBeNull();
  });

  it('refuses a picture nobody measured', () => {
    expect(
      buildPortraitFrom(
        { portrait: { publicPath: '/flowstarter-media/portrait-7.jpg' } },
        floors,
      ),
    ).toBeNull();
    expect(
      buildPortraitFrom(
        {
          portrait: {
            publicPath: '/flowstarter-media/portrait-7.jpg',
            width: 'big',
            height: 0,
          },
        },
        floors,
      ),
    ).toBeNull();
  });

  it('refuses a payload with no portrait at all', () => {
    expect(buildPortraitFrom(null, floors)).toBeNull();
    expect(buildPortraitFrom(undefined, floors)).toBeNull();
    expect(buildPortraitFrom({ portrait: null }, floors)).toBeNull();
    expect(
      buildPortraitFrom({ portrait: { publicPath: 7 } }, floors),
    ).toBeNull();
  });
});

describe('the image gate, beside #128 rather than inside it', () => {
  const built = [
    file(
      'dist/about/index.html',
      '<img src="/images/about-me-photo.svg" alt="About" />',
    ),
  ];

  /**
   * #128 turned `findPlaceholderImageIssue` into a one-argument wrapper and
   * stopped calling it from FULL_SITE_BUILD, which is why the portrait check
   * is no longer a parameter on it. A portrait check hidden inside a function
   * the build no longer calls is a gate that silently does not run, and that
   * is the failure this block exists to make impossible to reintroduce.
   */
  it('is exactly what #128 wrote, and takes no portrait', () => {
    const message = findPlaceholderImageIssue(built);
    expect(message).toContain('PLACEHOLDER_IMAGE_SHIPPED');
    expect(message).toContain('dist/about/index.html');
    // Nothing about a portrait, because this function is not where that lives.
    expect(message).not.toContain('/flowstarter-media/');
    expect(findPlaceholderImageIssue.length).toBe(1);
  });

  it('is undefined for a site carrying no stand-in art', () => {
    const clean = [
      file('dist/index.html', '<img src="/images/hero.png" alt="" />'),
    ];
    expect(findPlaceholderImageIssue(clean)).toBeUndefined();
  });

  /**
   * The two halves answer about the same scan and stay out of each other's
   * way: #128's finds the template's own art, this one finds the client's
   * photograph in a slot it may not occupy. A site can have one, the other,
   * or both, and the build reports each in its own words.
   */
  it('finds the placement defect that #128 has no opinion about', () => {
    const files = [
      file(
        CONTENT,
        ['about:', '  image: "/images/about-me-photo.svg"'].join('\n'),
      ),
    ];
    // #128 sees nothing here: a content file is not compiled output, and the
    // path is one of its own known assets only once it reaches dist.
    const findings = findPortraitSlotFindings(files, FULL_PORTRAIT);
    expect(findings.map((finding) => finding.code)).toEqual([
      PORTRAIT_SLOT_UNFILLED,
    ]);
    const record = describePortraitSlotIssue(findings, FULL_PORTRAIT);
    expect(record).toContain(PORTRAIT_SLOT_UNFILLED);
    expect(record).toContain(FULL_PORTRAIT.publicPath);
    expect(record).toContain(`${CONTENT} line 2`);
  });

  it('says nothing at all when the build was given no photograph', () => {
    const files = [
      file(
        CONTENT,
        ['about:', '  image: "/images/about-me-photo.svg"'].join('\n'),
      ),
    ];
    // Which is #128's case, not this one: with no portrait the seed cleaner
    // takes the stand-in out and the site renders initials.
    expect(findPortraitSlotFindings(files, null)).toEqual([]);
    expect(findPortraitSlotIssue(files, null)).toBeUndefined();
  });

  /**
   * The split #128 made for its own pair, kept here: the record is read by a
   * person looking at a build that did not ship, the brief is read by an agent
   * being told what to change. A record that reads as an instruction gets
   * pasted into a changelog; a brief that reads as a complaint gets ignored.
   */
  it('keeps the failure record free of instructions, and the repair brief full of them', () => {
    const findings = findPortraitSlotFindings(
      [
        file(
          CONTENT,
          ['about:', '  image: "/images/about-me-photo.svg"'].join('\n'),
        ),
      ],
      FULL_PORTRAIT,
    );
    const record = describePortraitSlotIssue(findings, FULL_PORTRAIT);
    const brief = describePortraitSlotRepair(findings, FULL_PORTRAIT);

    expect(record).not.toContain('Put it in the');
    expect(brief).toContain('Put it in the');
    expect(brief).toContain('never scaled up');
    expect(brief).toContain(FULL_PORTRAIT.publicPath);
  });

  it('names its own failure code, because the remedy is the opposite of #128 s', () => {
    // #128: this art is not the client's, take it out. This: the art IS the
    // client's, it is in the wrong slot. One code for each.
    expect(PORTRAIT_MISPLACED).toBe('PORTRAIT_MISPLACED');
    expect(PORTRAIT_MISPLACED).not.toBe('PLACEHOLDER_IMAGE_SHIPPED');
  });
});
