/**
 * The adapter: which implementation answers when nothing has been injected,
 * the seam that lets something else be injected, and the deterministic
 * assembly of what any implementation is shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const llmClassifyScope = vi.fn(async (_text: string) => ({
  scope: 'standard' as const,
  confidence: 0.9,
  evidence: [],
  classifier: 'llm',
}));
vi.mock('@/lib/ai/classify-scope', () => ({
  llmClassifyScope: (text: string) => llmClassifyScope(text),
}));

const sigmaScopeClassifier = vi.fn(async (_text: string) => ({
  scope: 'custom' as const,
  confidence: 0.95,
  evidence: [],
  classifier: 'sigma',
}));
vi.mock('@/lib/ai/classify-scope-sigma', () => ({
  sigmaScopeEnabled: () => process.env.SCOPE_SIGMA === '1',
  sigmaScopeClassifier: (text: string) => sigmaScopeClassifier(text),
}));

import {
  UNCLASSIFIED,
  classifyScope,
  occursVerbatim,
  resetScopeClassifier,
  scopeClassifierText,
  setScopeClassifier,
  verbatimEvidence,
} from '../scope-classifier';

beforeEach(() => {
  llmClassifyScope.mockClear();
  sigmaScopeClassifier.mockClear();
  delete process.env.SCOPE_SIGMA;
});

afterEach(() => {
  resetScopeClassifier();
  delete process.env.SCOPE_SIGMA;
});

describe('which implementation answers by default', () => {
  it('is the bounded model call, with the switch off', async () => {
    expect((await classifyScope('a bakery in Cluj')).classifier).toBe('llm');
    expect(sigmaScopeClassifier).not.toHaveBeenCalled();
  });

  it('is sigma, with the switch on', async () => {
    process.env.SCOPE_SIGMA = '1';
    expect((await classifyScope('a portal')).classifier).toBe('sigma');
    // sigma consults the model itself, as its injected second tier, so this
    // module must not also call it.
    expect(llmClassifyScope).not.toHaveBeenCalled();
  });

  it('reads the switch per call, so flipping it needs no redeploy', async () => {
    await classifyScope('one');
    process.env.SCOPE_SIGMA = '1';
    await classifyScope('two');
    delete process.env.SCOPE_SIGMA;
    await classifyScope('three');
    expect(llmClassifyScope).toHaveBeenCalledTimes(2);
    expect(sigmaScopeClassifier).toHaveBeenCalledTimes(1);
  });

  it('is not consulted at all once an implementation is injected', async () => {
    process.env.SCOPE_SIGMA = '1';
    setScopeClassifier(async () => UNCLASSIFIED);
    expect((await classifyScope('anything')).classifier).toBe('none');
    expect(sigmaScopeClassifier).not.toHaveBeenCalled();
    expect(llmClassifyScope).not.toHaveBeenCalled();
  });
});

describe('the classifier seam', () => {
  it('routes every call through whatever implementation is installed', async () => {
    const sigma = vi.fn(async () => ({
      scope: 'custom' as const,
      confidence: 0.8,
      evidence: [],
      classifier: 'sigma:1',
    }));
    setScopeClassifier(sigma);

    const result = await classifyScope('a brief');
    expect(sigma).toHaveBeenCalledWith('a brief');
    expect(result.classifier).toBe('sigma:1');
  });

  it('goes back to the default implementation when the override is cleared', async () => {
    setScopeClassifier(async () => UNCLASSIFIED);
    expect((await classifyScope('x')).classifier).toBe('none');
    resetScopeClassifier();
    expect((await classifyScope('x')).classifier).toBe('llm');
  });
});

describe('scopeClassifierText', () => {
  const BASE = {
    fullName: 'Sarah Smith',
    email: 'sarah@example.com',
    description: 'A portal my customers log into',
  };

  it('carries the brief, the links and the title of the linked page', () => {
    const text = scopeClassifierText({
      ...BASE,
      instagramUrl: 'https://instagram.com/acme',
      websiteUrl: 'https://acme.example.com',
      linkTitle: 'Acme - Client Portal Login',
    });
    expect(text).toContain('A portal my customers log into');
    expect(text).toContain('https://instagram.com/acme');
    expect(text).toContain('https://acme.example.com');
    expect(text).toContain('Acme - Client Portal Login');
  });

  it('leaves the email out', () => {
    // Not evidence about scope, and it would make every brief's hash unique
    // and the classifier's cache useless.
    expect(scopeClassifierText(BASE)).not.toContain('sarah@example.com');
  });

  it('omits a field the visitor never filled in rather than labelling a blank', () => {
    const text = scopeClassifierText(BASE);
    expect(text).not.toContain('Links');
    expect(text).not.toContain('Title of the linked page');
    expect(text).not.toContain('site or software');
  });

  it('includes the clarifying answer once it exists', () => {
    const text = scopeClassifierText({
      ...BASE,
      clarification: 'Software my customers log into',
    });
    expect(text).toContain('Software my customers log into');
  });

  it('is stable: the same answers always assemble the same string', () => {
    const input = { ...BASE, websiteUrl: 'https://acme.example.com' };
    expect(scopeClassifierText(input)).toBe(scopeClassifierText({ ...input }));
  });

  it('caps any one field so a paste bomb is not more evidence', () => {
    const text = scopeClassifierText({
      ...BASE,
      description: 'x'.repeat(10_000),
    });
    expect(text.length).toBeLessThan(2_200);
  });
});

describe('occursVerbatim / verbatimEvidence, the shared defensive check', () => {
  const BRIEF = 'A Portal   my customers log into\nto track their orders';

  it('matches case-insensitively and across normalised whitespace', () => {
    expect(occursVerbatim('customers log into', BRIEF)).toBe(true);
    expect(occursVerbatim('CUSTOMERS LOG INTO', BRIEF)).toBe(true);
    expect(occursVerbatim('a portal my customers', BRIEF)).toBe(true);
  });

  it('rejects a fragment that is not actually in the source', () => {
    expect(occursVerbatim('confident:scope:custom-work:semantic', BRIEF)).toBe(
      false
    );
    expect(occursVerbatim('a client login area', BRIEF)).toBe(false);
  });

  it('rejects an empty or whitespace-only fragment rather than matching everything', () => {
    expect(occursVerbatim('', BRIEF)).toBe(false);
    expect(occursVerbatim('   ', BRIEF)).toBe(false);
  });

  it('filters a mixed list down to only the fragments the brief actually contains', () => {
    expect(
      verbatimEvidence(
        [
          'customers log into',
          'confident:scope:custom-work:semantic',
          'track their orders',
          'llm:2026-09-14.1',
        ],
        BRIEF
      )
    ).toEqual(['customers log into', 'track their orders']);
  });
});
