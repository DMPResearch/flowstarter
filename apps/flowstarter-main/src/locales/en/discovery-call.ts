/**
 * Everything a visitor reads on the custom work branch of the funnel, plus the
 * `/discovery-call` page the marketing copy now links to, plus the operator's
 * lane on the pipeline board.
 *
 * Split out of `en.ts` for the reason `admin.ts` was: a section that arrives
 * whole is easier to read whole. Spread back in at the bottom of `en.ts`.
 *
 * The tone here is doing real work. This is the only place in the product
 * where somebody is told that the thing they came for is not the thing we
 * build, and there are two ways to get that wrong. Softening it ("we may be
 * able to help with some of that") wastes their time and ours. Apologising for
 * it invites them to argue. So it is said once, plainly, in the first sentence,
 * with the studio named and the next step attached, and then it is not said
 * again.
 */
export const discoveryCallKeys = {
  // ── The funnel's routing step ────────────────────────────────────────────
  'landing.discovery.scope.checking': 'Reading that back',
  'landing.discovery.scope.checkingBody':
    'One moment while we work out what you need.',

  /**
   * The one clarifying question, asked at most once, and only when the
   * classifier could not tell. Phrased as the difference a business owner can
   * answer without knowing our vocabulary: not "is this a web app", which only
   * tells us whether they have heard the phrase.
   */
  'landing.discovery.scope.question':
    'Is this a site that presents your business, or software your customers log into?',
  'landing.discovery.scope.answer.site': 'A site that presents my business',
  'landing.discovery.scope.answer.software': 'Software my customers log into',
  'landing.discovery.scope.answer.other': 'Something else. Let me explain',
  'landing.discovery.scope.answerPlaceholder':
    'In a sentence, what would somebody use it for?',
  'landing.discovery.scope.send': 'Send',

  // ── The offer ────────────────────────────────────────────────────────────
  'landing.discovery.scope.offer.title': 'This one is custom work',
  'landing.discovery.scope.offer.body':
    'What you have described is not a site that presents your business, it is software built for it. We do not start work like that from a form, and we are not going to build you a preview that pretends otherwise.',
  'landing.discovery.scope.offer.studio':
    'Work like this is handled by DMPResearch, Darius’s studio, and it is contracted after a call rather than bought off a page. Thirty minutes, nothing to prepare. You leave knowing what the work involves and what it costs, whether or not you go ahead with us.',
  /**
   * The same screen when the gate did not reach a custom verdict.
   *
   * It exists because the copy above was shown unconditionally, including to
   * visitors whose recorded scope was `unclear` and who had just tapped "a
   * site that presents my business". Being told, as a statement of fact, that
   * you said the opposite of what you said is not a tone problem, it is the
   * product lying about its own data.
   *
   * So this says only what is true at that point: we could not settle it, we
   * are not going to guess, and the call is how it gets settled. No verdict is
   * asserted and nothing is implied about what they described.
   */
  'landing.discovery.scope.review.title': 'Let us get this right first',
  'landing.discovery.scope.review.body':
    'We could not tell from your answers whether this is a site that presents your business or software built for it, and the two are different pieces of work with different prices. Rather than guess and build you the wrong one, we would rather ask.',

  'landing.discovery.scope.offer.cta': 'Pick a time',
  'landing.discovery.scope.offer.prefilled':
    'Your name and email are already filled in.',
  'landing.discovery.scope.offer.emailed':
    'We have emailed you a copy of this, so you can book later if now is not a good moment.',

  /** Shown instead of the calendar when no booking page is configured. */
  'landing.discovery.scope.offer.fallbackTitle': 'Tell us where to reach you',
  'landing.discovery.scope.offer.fallbackBody':
    'There is no calendar to show you here, so Darius will write to you himself to arrange the call.',
  'landing.discovery.scope.offer.fallbackCta': 'Send my project',

  // ── The /discovery-call page ─────────────────────────────────────────────
  'discoveryCall.meta.title': 'Book a discovery call | Flowstarter',
  'discoveryCall.meta.description':
    'Thirty minutes with Darius to scope custom work through DMPResearch. Nothing to prepare.',
  'discoveryCall.eyebrow': 'Discovery call',
  'discoveryCall.headlinePrefix': 'Thirty minutes.',
  'discoveryCall.headlineFlourish': 'No slides, no script.',
  'discoveryCall.sub':
    'A call to work out what you actually need and what it would take. Custom work is contracted through DMPResearch, Darius’s studio, after this call and not before it.',
  'discoveryCall.expect.title': 'What happens on the call',
  'discoveryCall.expect.one':
    'You describe the problem. We ask the questions that decide whether it is a week of work or a quarter.',
  'discoveryCall.expect.two':
    'We say plainly whether this is something we should build, and what it would cost.',
  'discoveryCall.expect.three':
    'If it is not a fit, we say so on the call and point you somewhere better. That happens and it is not a wasted half hour.',
  'discoveryCall.bookingTitle': 'Pick a time',
  'discoveryCall.bookingFallback':
    'The calendar is not loading. Use the form below and we will come back to you with times.',

  'discoveryCall.form.title': 'Tell us about your project',
  'discoveryCall.form.body':
    'There is no calendar to show you right now, so this reaches Darius directly and he arranges the call himself.',
  'discoveryCall.form.name': 'Your name',
  'discoveryCall.form.namePlaceholder': 'Sarah Smith',
  'discoveryCall.form.email': 'Email',
  'discoveryCall.form.emailPlaceholder': 'you@example.com',
  'discoveryCall.form.link': 'A link, if you have one',
  'discoveryCall.form.linkPlaceholder': 'https://your-site.com',
  'discoveryCall.form.description': 'What do you need built?',
  'discoveryCall.form.descriptionPlaceholder':
    'What it should do, and who would use it. A few sentences is plenty.',
  'discoveryCall.form.submit': 'Send my project',
  'discoveryCall.form.sending': 'Sending…',
  'discoveryCall.form.successTitle': 'We have it.',
  'discoveryCall.form.successBody':
    'Darius will write to you within one business day to arrange the call. Check your inbox for the confirmation.',
  'discoveryCall.form.error': 'Something went wrong. Please try again.',

  // ── The operator's lane ──────────────────────────────────────────────────
  'admin.customWork.lane.title': 'Custom work',
  'admin.customWork.lane.empty': 'No custom work leads',
  'admin.customWork.lane.waiting': 'waiting on a reply',
  'admin.customWork.card.evidence': 'Why it was routed here',
  'admin.customWork.card.classifier': 'Classified by',
  'admin.customWork.card.waitingFor': 'Waiting',
  'admin.customWork.card.contacted': 'Contacted',
  'admin.customWork.card.markContacted': 'Mark contacted',
  'admin.customWork.card.marking': 'Saving…',
  'admin.customWork.card.noConfirmation': 'Confirmation email did not send',
  'admin.customWork.card.viaForm': 'Came through the contact form',
  'admin.nav.customWork': 'Custom work',
} as const;
