import { describe, expect, it } from 'vitest';
import {
  describeInventedProjectFindings,
  findInventedProjects,
  GENERIC_HEADINGS,
  INVENTED_PROJECT,
  headingMarkups,
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
