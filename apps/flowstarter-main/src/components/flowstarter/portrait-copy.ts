/**
 * The words for a portrait verdict, a portrait source and a portrait reason,
 * looked up by the rule's own copy key.
 *
 * The rule and the sentence must not drift. `portrait-source.ts` decides that
 * a 100 pixel picture is an `avatar`, and somewhere a person has to be told
 * what that means for their site. If the component retyped that sentence next
 * to the branch, then the day the floor moves or a verdict is renamed the code
 * would keep working and the sentence would quietly become a lie.
 *
 * So the sentence is never written next to the rule. It is looked up by the
 * key the rule itself produces (`portraitVerdictCopyKey`,
 * `portraitSourceCopyKey`, `portraitReasonCopyKey`) against the one catalogue
 * in `src/locales/en.ts`. A verdict with no sentence therefore shows its key,
 * which is ugly on screen and obvious in a test, rather than showing nothing
 * or showing the previous verdict's words.
 *
 * This module is pure and has no React in it, so both the brief's client
 * component and a server surface can use it, and a test can assert the real
 * copy without rendering anything.
 */
import en from '@/locales/en';
import {
  portraitReasonCopyKey,
  portraitSourceCopyKey,
  portraitVerdictCopyKey,
  type PortraitSizeVerdict,
  type PortraitSourceId,
  type PortraitSourceReason,
} from '@/lib/flowstarter/portrait-source';

/**
 * `en` is declared `as const`, so its type is a union of literal keys and a
 * key computed at runtime cannot index it. The widening is here, once, rather
 * than at every call site.
 */
const catalogue = en as unknown as Record<string, string | undefined>;

/** The catalogue entry, or the key itself when nobody has written one yet. */
function textFor(key: string): string {
  return catalogue[key] ?? key;
}

/** "Big enough for the main photo on your site.", and the rest. */
export function portraitVerdictText(verdict: PortraitSizeVerdict): string {
  return textFor(portraitVerdictCopyKey(verdict));
}

/** The network named the way the client would name it: "LinkedIn". */
export function portraitSourceText(source: PortraitSourceId): string {
  return textFor(portraitSourceCopyKey(source));
}

/** Why a source did or did not give us a picture. */
export function portraitReasonText(reason: PortraitSourceReason): string {
  return textFor(portraitReasonCopyKey(reason));
}
