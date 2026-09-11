import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  contrastRatioFromRgb,
  formatRenderedAuditFeedback,
  parseCssRgb,
  relativeLuminance,
  renderedAuditEnabled,
} from '../rendered-preview-audit';

describe('rendered preview contrast helpers', () => {
  it('parses comma and space rgb() forms', () => {
    expect(parseCssRgb('rgb(10, 20, 30)')).toEqual({
      r: 10,
      g: 20,
      b: 30,
      a: 1,
    });
    expect(parseCssRgb('rgba(10, 20, 30, 0.4)')).toEqual({
      r: 10,
      g: 20,
      b: 30,
      a: 0.4,
    });
    expect(parseCssRgb('rgb(10 20 30 / 80%)')).toEqual({
      r: 10,
      g: 20,
      b: 30,
      a: 0.8,
    });
  });

  it('flags near-black copy on a dark green hero', () => {
    const ratio = contrastRatioFromRgb('rgb(34, 34, 34)', 'rgb(18, 48, 36)');
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeLessThan(2.5);
  });

  it('accepts white copy on that same green', () => {
    const ratio = contrastRatioFromRgb('rgb(255, 255, 255)', 'rgb(18, 48, 36)');
    expect(ratio).toBeGreaterThan(4.5);
  });

  it('treats white as much brighter than black', () => {
    expect(relativeLuminance(255, 255, 255)).toBeGreaterThan(
      relativeLuminance(0, 0, 0)
    );
  });

  it('turns defect rows into a style-only repair brief', () => {
    expect(formatRenderedAuditFeedback([])).toBeUndefined();
    const brief = formatRenderedAuditFeedback([
      'near-invisible text (contrast 1.21) in <section>: "A STEADY SPACE"',
      'near-invisible text (contrast 1.21) in <section>: "A STEADY SPACE"',
    ]);
    expect(brief).toMatch(/style tokens/);
    expect(brief).toMatch(/Do not rewrite copy/);
    expect(brief?.split(' | ')).toHaveLength(1);
  });
});

describe('renderedAuditEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is on unless explicitly disabled', () => {
    expect(renderedAuditEnabled({})).toBe(true);
    expect(renderedAuditEnabled({ FLOWSTARTER_RENDERED_AUDIT: 'false' })).toBe(
      false
    );
    expect(renderedAuditEnabled({ FLOWSTARTER_RENDERED_AUDIT: '0' })).toBe(
      false
    );
  });
});
