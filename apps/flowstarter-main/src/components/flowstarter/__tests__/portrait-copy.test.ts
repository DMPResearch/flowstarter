/**
 * The lookup between the portrait rule and the words a client reads.
 *
 * Worth pinning because the whole point of the module is that nobody retypes a
 * sentence next to a branch. If a verdict, a source or a reason ever gains a
 * member without gaining a sentence, the surface has to show something
 * obviously wrong rather than something plausibly wrong, and these tests are
 * what says which.
 */
import { describe, expect, it } from 'vitest';
import en from '@/locales/en';
import {
  PORTRAIT_SOURCE_ORDER,
  type PortraitSizeVerdict,
  type PortraitSourceReason,
} from '@/lib/flowstarter/portrait-source';
import {
  portraitReasonText,
  portraitSourceText,
  portraitVerdictText,
} from '../portrait-copy';

/** Every reason the rule can produce. The type is the list. */
const REASONS: PortraitSourceReason[] = [
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

const VERDICTS: PortraitSizeVerdict[] = [
  'portrait',
  'avatar',
  'too_small',
  'unknown',
];

describe('portrait-copy', () => {
  // The sentence comes from the catalogue entry the rule's own key names, so
  // the two cannot be edited apart.
  it('reads each verdict out of the catalogue under the rule s key', () => {
    for (const verdict of VERDICTS) {
      expect(portraitVerdictText(verdict)).toBe(
        en[`portrait.verdict.${verdict}` as keyof typeof en]
      );
    }
  });

  it('reads each source name out of the catalogue under the rule s key', () => {
    for (const source of PORTRAIT_SOURCE_ORDER) {
      expect(portraitSourceText(source)).toBe(
        en[`portrait.source.${source}` as keyof typeof en]
      );
    }
  });

  it('reads every reason the rule can produce', () => {
    for (const reason of REASONS) {
      const text = portraitReasonText(reason);
      expect(text).toBe(en[`portrait.reason.${reason}` as keyof typeof en]);
      expect(text).not.toBe(`portrait.reason.${reason}`);
    }
  });

  // A member with no sentence shows its key. Ugly on screen and unmissable in
  // a test, which is the point: the alternative is an empty line, or worse the
  // previous member's words standing in for the new one.
  it('falls back to the key rather than inventing a sentence', () => {
    expect(portraitReasonText('made_up' as PortraitSourceReason)).toBe(
      'portrait.reason.made_up'
    );
  });
});
