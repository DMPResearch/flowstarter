/**
 * E2E-shaped regression for the quick-intake preview-skip bug: fill in
 * exactly the four questions the quick intake still asks (full name, email,
 * what you do, one link) and nothing else — the state a real visitor is in
 * the instant `PreviewStep` mounts — and check the request `previewPayload()`
 * builds for `/api/discovery/preview/live`.
 *
 * PR #108 moved the business-name question behind the deposit without
 * updating `previewPayload()`, so `businessName` rode through empty and the
 * live route's businessName gate skipped every quick-intake preview. This
 * pins the fix at the one seam between "what the wizard knows" and "what the
 * network sees": no DOM, no fetch mock, no server — just the same pure
 * function `startLive` calls before it POSTs.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_DISCOVERY, type DiscoveryData } from '../discovery.logic';
import { previewPayload } from '../steps/PreviewStep';

/** Exactly the four quick-intake answers, and nothing the Brief later adds. */
function quickIntakeDraft(
  overrides: Partial<DiscoveryData> = {}
): DiscoveryData {
  return {
    ...EMPTY_DISCOVERY,
    fullName: 'Ana Pop',
    email: 'ana@example.com',
    description: 'A small yoga studio in the neighbourhood.',
    websiteUrl: 'https://sablefig.ro',
    ...overrides,
  };
}

describe('previewPayload — the four-question quick intake', () => {
  it('yields a non-empty businessName even though the quick intake never asks for one', () => {
    const payload = previewPayload(quickIntakeDraft());
    expect(payload.businessName.trim().length).toBeGreaterThan(0);
  });

  it('derives the business name from the one link when there is no Brief answer yet', () => {
    const payload = previewPayload(quickIntakeDraft());
    expect(payload.businessName).toBe('Sablefig');
  });

  it('falls back to the full name when the one link is a social profile, not a website', () => {
    const payload = previewPayload(
      quickIntakeDraft({
        websiteUrl: '',
        instagramUrl: 'https://instagram.com/sablefig.studio',
      })
    );
    expect(payload.businessName).toBe('Ana Pop');
  });

  it('carries the full name and email through unchanged', () => {
    const payload = previewPayload(quickIntakeDraft());
    expect(payload.fullName).toBe('Ana Pop');
    expect(payload.email).toBe('ana@example.com');
  });

  it('never overwrites a business name the Brief has already corrected', () => {
    const payload = previewPayload(
      quickIntakeDraft({ businessName: 'Sable Fig Studio' })
    );
    expect(payload.businessName).toBe('Sable Fig Studio');
  });
});
