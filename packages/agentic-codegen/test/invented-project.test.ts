import { describe, expect, it } from 'vitest';
import {
  describeInventedProjectFindings,
  findInventedProjects,
  GENERIC_HEADINGS,
  INVENTED_PROJECT,
  headingMarkups,
  isNameShapedHeading,
} from '../src/flowstarter/invented-project';

/** A built work page carrying the headings under test. */
function workPage(...headings: string[]) {
  return {
    path: 'dist/work/index.html',
    content:
      '<html><body><main>' +
      headings.map((heading) => `<h2>${heading}</h2>`).join('') +
      '</main></body></html>',
  };
}

describe('findInventedProjects', () => {
  it('says nothing when the brief never listed a project', () => {
    // An empty list is "we were never told", and a gate that guessed here
    // would fail every brief taken before the dashboard asked the question.
    expect(findInventedProjects([workPage('Northwind Bank')], [])).toEqual([]);
    expect(findInventedProjects([workPage('Northwind Bank')], ['  '])).toEqual(
      [],
    );
  });

  it('accepts a heading that is one of the brief projects', () => {
    expect(
      findInventedProjects([workPage('Ereno')], ['Ereno', 'Halden Studio']),
    ).toEqual([]);
  });

  it('accepts a project name written out for the page', () => {
    expect(
      findInventedProjects([workPage('Ereno, a calm inbox')], ['Ereno']),
    ).toEqual([]);
    expect(
      findInventedProjects([workPage('Halden')], ['Halden Studio']),
    ).toEqual([]);
  });

  it('accepts every generic section label', () => {
    for (const label of GENERIC_HEADINGS) {
      expect(findInventedProjects([workPage(label)], ['Ereno'])).toEqual([]);
    }
    // Capitalisation and punctuation are how a template writes a label, not
    // how two labels differ.
    expect(
      findInventedProjects([workPage('Selected Work.')], ['Ereno']),
    ).toEqual([]);
  });

  it('finds an invented project and names the page it is on', () => {
    const findings = findInventedProjects(
      [workPage('Ereno', 'Northwind Bank')],
      ['Ereno'],
    );
    expect(findings).toEqual([
      { path: 'dist/work/index.html', heading: 'Northwind Bank' },
    ]);
  });

  it('reads a heading through its markup and its entities', () => {
    const findings = findInventedProjects(
      [
        {
          path: 'dist/case-studies/northwind/index.html',
          content: '<h3><span>Northwind</span> &amp;  Sons</h3>',
        },
      ],
      ['Ereno'],
    );
    expect(findings[0]?.heading).toBe('Northwind & Sons');
  });

  it('ignores anything that is not a built page', () => {
    expect(
      findInventedProjects(
        [
          {
            path: 'dist/work/index.json',
            content: '<h2>Northwind Bank</h2>',
          },
          { path: 'src/pages/work.astro', content: '<h2>Northwind Bank</h2>' },
        ],
        ['Ereno'],
      ),
    ).toEqual([]);
  });

  it('ignores pages outside the work section', () => {
    expect(
      findInventedProjects(
        [
          { path: 'dist/about/index.html', content: '<h2>Northwind Bank</h2>' },
          { path: 'dist/index.html', content: '<h2>How we work</h2>' },
        ],
        ['Ereno'],
      ),
    ).toEqual([]);
  });

  it('judges a one-page site only inside its marked work section', () => {
    const files = [
      {
        path: 'dist/index.html',
        content:
          '<section id="hero"><h2>How we work</h2></section>' +
          '<section id="work"><h2>Ereno</h2><h2>Northwind Bank</h2></section>' +
          '<section id="contact"><h2>Why founders call us</h2></section>',
      },
    ];
    expect(findInventedProjects(files, ['Ereno'])).toEqual([
      { path: 'dist/index.html', heading: 'Northwind Bank' },
    ]);
  });
});

/**
 * Job `7508bf52`, attempt 2 (2026-09-15): a correct site — the client's own
 * headline, the three real projects, nothing invented — was failed anyway on
 * "Selected projects" (a section label one word away from three entries
 * already on `GENERIC_HEADINGS`) and on the closing CTA sentence. Neither
 * heading is a project name, and the site named exactly the three projects
 * the brief listed: `Flowstarter`, `Ereno`, `DMPResearch`.
 */
describe('the false positive from job 7508bf52', () => {
  const names = ['Flowstarter', 'Ereno', 'DMPResearch'];

  it('accepts the section label the gate flagged, not on the allowlist by exact string', () => {
    expect(GENERIC_HEADINGS.has('selected projects')).toBe(false);
    expect(
      findInventedProjects([workPage('Selected projects')], names),
    ).toEqual([]);
  });

  it('accepts the closing CTA sentence the gate flagged as a candidate name', () => {
    expect(
      findInventedProjects(
        [workPage('A site that earns trust, built fast and supervised by me.')],
        names,
      ),
    ).toEqual([]);
  });

  it('accepts the three real projects exactly as the brief writes them', () => {
    expect(
      findInventedProjects(
        [workPage('Flowstarter', 'Ereno', 'DMPResearch')],
        names,
      ),
    ).toEqual([]);
  });

  it('still fails the real invented name from earlier runs', () => {
    expect(findInventedProjects([workPage('Northwind Bank')], names)).toEqual([
      { path: 'dist/work/index.html', heading: 'Northwind Bank' },
    ]);
  });

  it('still fails a fabricated case study with a result percentage', () => {
    // The incident this whole gate exists for: a fourth study for a company
    // nobody has heard of. Short enough to be name-shaped, so the shape
    // rules alone must not be what stops it — matching the brief still has to.
    expect(
      findInventedProjects([workPage('Meridian Home Goods')], names),
    ).toEqual([
      { path: 'dist/work/index.html', heading: 'Meridian Home Goods' },
    ]);
  });

  it('accepts a Romanian section label built from the same grammar', () => {
    expect(
      findInventedProjects([workPage('Proiecte selectate')], names),
    ).toEqual([]);
    expect(findInventedProjects([workPage('Lucrări recente')], names)).toEqual(
      [],
    );
  });
});

describe('isNameShapedHeading', () => {
  it('rejects terminal punctuation', () => {
    expect(isNameShapedHeading('Ereno.')).toBe(false);
    expect(isNameShapedHeading('Is this a project?')).toBe(false);
  });

  it('rejects a heading outside the configured word-count range', () => {
    expect(isNameShapedHeading('Flowstarter')).toBe(true);
    expect(isNameShapedHeading('Word two three four five six seven')).toBe(
      false,
    );
  });

  it('rejects a comma or a finite-verb word as sentence-shaped', () => {
    expect(isNameShapedHeading('Ereno, a calm inbox')).toBe(false);
    expect(isNameShapedHeading('This site was built fast')).toBe(false);
  });

  it('accepts a short noun phrase', () => {
    expect(isNameShapedHeading('Northwind Bank')).toBe(true);
    expect(isNameShapedHeading('DMPResearch')).toBe(true);
  });
});

describe('describeInventedProjectFindings', () => {
  it('names the offending headings and the projects the client actually has', () => {
    const message = describeInventedProjectFindings(
      [{ path: 'dist/work/index.html', heading: 'Northwind Bank' }],
      ['Ereno', 'Halden Studio'],
    );
    expect(message).toContain(INVENTED_PROJECT);
    expect(message).toContain('Northwind Bank');
    expect(message).toContain('dist/work/index.html');
    expect(message).toContain('Ereno, Halden Studio');
  });

  it('caps both lists at eight and counts the rest', () => {
    const findings = Array.from({ length: 11 }, (_, index) => ({
      path: 'dist/work/index.html',
      heading: `Invented ${index}`,
    }));
    const names = Array.from({ length: 12 }, (_, index) => `Project ${index}`);
    const message = describeInventedProjectFindings(findings, names);
    expect(message).toContain('Invented 7');
    expect(message).not.toContain('Invented 8');
    expect(message).toContain('and 3 more');
    expect(message).toContain('Project 7');
    expect(message).not.toContain('Project 8');
    expect(message).toContain('and 4 more');
  });
});

describe('headingMarkups', () => {
  it('finds h2 and h3 inner markup in order and ignores h1 and h4', () => {
    const html =
      '<h1>Title</h1><h2 class="x">Alpha <em>one</em></h2><p>x</p><H3>Beta</H3><h4>no</h4>';
    expect(headingMarkups(html)).toEqual(['Alpha <em>one</em>', 'Beta']);
  });

  it('stays linear on a long run of angle brackets', () => {
    const hostile = '<'.repeat(200_000) + '<h2>ok</h2>';
    const started = Date.now();
    expect(headingMarkups(hostile)).toEqual(['ok']);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

/**
 * "Asked, and they have none" is a stricter input than "nobody asked".
 *
 * Before the brief reached the build, `job.intake.projects` was always absent
 * and this gate therefore never ran at all -- which is how a paid portfolio
 * shipped with a fourth case study for a company nobody has heard of. Two
 * inputs now switch it on: a list of real names, and an explicit empty answer.
 * The third input, absence, must still switch it off, because failing a build
 * for having no data is worse than the defect.
 */
describe('the no-projects answer', () => {
  const files = [
    {
      path: 'dist/work/index.html',
      content:
        '<h2>Selected work</h2><h2>Northwind Bank</h2><h3>The result</h3>',
    },
  ];

  it('stays silent when nobody asked the client about their work', () => {
    expect(findInventedProjects(files, [])).toEqual([]);
    expect(findInventedProjects(files, [], { projectsKnown: false })).toEqual(
      [],
    );
  });

  it('rejects every project-shaped heading once the client has said they have none', () => {
    expect(findInventedProjects(files, [], { projectsKnown: true })).toEqual([
      { path: 'dist/work/index.html', heading: 'Northwind Bank' },
    ]);
  });

  it('still allows the closed list of generic section labels', () => {
    const generic = [
      {
        path: 'dist/work/index.html',
        content:
          '<h2>Selected work</h2><h2>Services</h2><h3>Get in touch</h3>' +
          '<h2>Frequently asked questions</h2>',
      },
    ];
    expect(findInventedProjects(generic, [], { projectsKnown: true })).toEqual(
      [],
    );
  });

  it('tells the agent to remove the section rather than rename it', () => {
    const message = describeInventedProjectFindings(
      [{ path: 'dist/work/index.html', heading: 'Northwind Bank' }],
      [],
    );
    expect(message).toContain('no past work to show');
    expect(message).toContain('Remove the work section entirely');
    expect(message).toContain('no stock photography');
    // The empty-list phrasing that would have shipped otherwise.
    expect(message).not.toContain('The only projects this client has are: .');
  });
});
