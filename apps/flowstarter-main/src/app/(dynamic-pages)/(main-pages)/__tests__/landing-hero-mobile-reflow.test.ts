import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const cssPath = path.resolve(
  __dirname,
  '../../../../../../../packages/flow-design-system/src/styles/landing.css'
);

const css = readFileSync(cssPath, 'utf8');

describe('Landing hero mobile reflow guard', () => {
  it('reserves space for brief field values on narrow screens so the hero does not jump while typing', () => {
    expect(css).toContain('@media (max-width: 768px)');
    expect(css).toContain('.ls-brief .ls-field .val');
    expect(css).toContain('display: block;');
    expect(css).toContain('line-height: 1.5;');
    expect(css).toContain('min-height: 3em;');
  });
});
