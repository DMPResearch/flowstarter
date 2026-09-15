/**
 * Which templates a personal site may be built from.
 *
 * The portfolio that started all of this was built from `professional-services`,
 * and that was not a bad roll of the embedding dice. It was the correct answer
 * to the question the pipeline actually asked: the brief said "Founder of
 * Flowstarter", the business name said "Flowstarter", and a founder of a
 * company with a name is a professional-services site. Every downstream
 * decision followed honestly from a classification that was wrong upstream.
 *
 * So template selection now reads the same single rule everything else does.
 * `person-questions.ts` in the app decides whether the visitor IS the
 * business; when it decides they are, the funnel asks them the person block,
 * and `intake.person` is present on the payload. That presence is the
 * server's own earlier classification, carried in the data rather than
 * guessed at again here, and this module is what makes it bind on the one
 * decision that shapes every page: which template the site starts from.
 *
 * Two properties are load-bearing:
 *
 * - **It narrows, it does not name.** There is no list of blessed slugs. A
 *   candidate is judged by its own descriptors through `siteKindFor`, the
 *   same rule that orders the pages and decides who gets asked about
 *   themselves, so a portfolio template added to the library tomorrow is
 *   covered without a code change and a services template cannot sneak in by
 *   being renamed.
 * - **It never leaves the pipeline with nothing.** A library that offers no
 *   portfolio template at all falls back to the full candidate list. A
 *   preview that cannot be built is worse than a preview built from the
 *   wrong starting design, and the rest of the gates still hold the content
 *   to the person.
 */

import { siteKindFor, type SiteKind } from './page-set';
import type { BusinessIntakePayload, TemplateCandidate } from './types';

/**
 * What a template is for, read off its own descriptors.
 *
 * The slug is included deliberately: `creative-portfolio` and
 * `dorin-portfolio` both say what they are in their names, and a template
 * whose description is thin should still be classified by the one string it
 * is guaranteed to have.
 */
export function templateKindFor(candidate: TemplateCandidate): SiteKind {
  const descriptors = [
    candidate.slug.replace(/-/g, ' '),
    candidate.displayName,
    candidate.description,
    candidate.category,
    ...(candidate.useCase ?? []),
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  return siteKindFor(descriptors);
}

/**
 * True when this brief describes a site whose subject is one person.
 *
 * Two ways in, and they are the same two the intake uses. The trade answers
 * it for a photographer or a designer; the person section answers it for
 * everybody else, because the funnel only ever asks the person block of a
 * visitor it has already read as being the business themselves.
 *
 * `person: undefined` is a workspace nobody asked, which is every brief taken
 * before the section existed. Those keep today's behaviour exactly.
 */
export function isPersonalPortfolio(intake: BusinessIntakePayload): boolean {
  if (intake.person) return true;
  const businessType = `${intake.business.niche} ${
    intake.business.description ?? ''
  }`;
  return siteKindFor(businessType) === 'portfolio';
}

/**
 * The candidates a personal site may actually be built from.
 *
 * Returns the input unchanged for a company brief, and for a personal one
 * whose library offers no portfolio template at all. Pure, and total: it
 * never returns an empty list for a non-empty input, which is the property
 * that lets the caller use it without a fallback of its own.
 */
export function candidatesForKind(
  candidates: readonly TemplateCandidate[],
  personal: boolean,
): TemplateCandidate[] {
  if (!personal) return [...candidates];
  const portfolio = candidates.filter(
    (candidate) => templateKindFor(candidate) === 'portfolio',
  );
  return portfolio.length > 0 ? portfolio : [...candidates];
}

/**
 * Whether the rule alone is allowed to settle the choice.
 *
 * For a personal site with portfolio templates available, yes: the decision
 * is between two or three templates that are all the right genre, and a
 * confidence gate that punts to a model is punting a decision the rule has
 * already narrowed to a safe set. The alternative is what shipped once, which
 * is a model handed the whole library and no reason not to pick a studio
 * layout.
 *
 * For anything else this returns false and the existing confidence gate and
 * model fallback run exactly as they did.
 */
export function ruleMaySettleTemplate(
  candidates: readonly TemplateCandidate[],
  personal: boolean,
): boolean {
  if (!personal) return false;
  return candidates.some(
    (candidate) => templateKindFor(candidate) === 'portfolio',
  );
}
