/**
 * The canary intake: how the daily QA agent talks to the landing-page
 * discovery conversation without pretending to be a customer.
 *
 * Everything the QA lane types is in CANARY below. The business is called
 * "QA Canary Bakery" and the address is `qa-canary@flowstarter.invalid`
 * (`.invalid` is reserved by RFC 2606, so nothing can ever be delivered to
 * it), which is what makes the row this leaves behind identifiable from the
 * outside. See docs/daily-qa.md for what is and is not cleaned up.
 *
 * The turn primitives copy `e2e/support/record-funnel.mjs`, which is the only
 * other thing in this repository that drives the wizard end to end. In
 * particular they synchronise on the app's own cursor rather than on a sleep:
 * `DiscoveryWizard` autosaves `{ data, step, answered }` into sessionStorage
 * under `fs-discovery-draft-v1` after every turn, and `answered` is the list
 * of question ids the wizard considers done. Waiting on that is the only way
 * to know a turn landed, because the agent's reply is paced by a timer.
 *
 * Two answers are load-bearing and must not be "tidied up":
 *   - `businessName` is optional in the script but NOT optional here.
 *     `POST /api/discovery/preview/live` returns `{ skip: true }` when the
 *     business name is blank (see the route's own guard), and the wizard then
 *     steps down to the deterministic JSON preview. A blank name means the
 *     journey never observes a real generation.
 *   - `customIntegrations` is skipped on purpose. `recommendTier` reads any
 *     answer there as a custom-integration request and moves the brief off
 *     the standard build onto the "from" quote, which is not the path a
 *     first-time visitor takes.
 */
import { expect, type Locator, type Page } from '@playwright/test';

/** The wizard's sessionStorage autosave key. */
const DRAFT_KEY = 'fs-discovery-draft-v1';

/** Every question id the canary answers, in script order. */
export type IntakeQuestionId =
  | 'fullName'
  | 'email'
  | 'businessName'
  | 'description'
  | 'industry'
  | 'targetAudience'
  | 'links'
  | 'goal'
  | 'brandTone'
  | 'pageCount'
  | 'timeline'
  | 'commerceMode'
  | 'calComUrl'
  | 'customIntegrations'
  | 'selectedTier'
  | 'subscription';

/**
 * The canary's answers. Deliberately self-identifying: anyone who finds this
 * row in production should be able to tell in one line that a robot typed it.
 */
export const CANARY = {
  tag: 'qa-canary',
  fullName: 'QA Canary',
  email: 'qa-canary@flowstarter.invalid',
  businessName: 'QA Canary Bakery',
  description:
    'QA Canary Bakery is an automated daily QA canary, not a real business. ' +
    'It stands in for a small neighbourhood bakery selling sourdough bread ' +
    'and pastries so the intake conversation has something concrete to work ' +
    'with. Do not contact this lead.',
  industry: 'Hospitality & food',
  targetAudience:
    'Automated QA canary, no real audience. Stand-in: people who live within ' +
    'walking distance and buy bread in the morning.',
  goal: 'Get enquiries / leads',
  brandTone: 'Warm',
  pageCount: 'Under 5',
  timeline: 'Flexible',
  /** Suppresses the follow-up `catalogSize` question. */
  commerceMode: 'No products',
} as const;

/**
 * The wizard renders one dialog; every locator below is scoped to it.
 *
 * Not `getByRole('dialog').first()`: the landing page also mounts
 * `SupportBot.tsx`'s chat panel under `role="dialog"` once a visitor opens
 * it, so `.first()` on the bare role picked whichever dialog happened to
 * mount first rather than reliably this one. `[aria-modal="true"]`
 * disambiguates cheaply, without a per-candidate content filter re-querying
 * the composer on every action: `PreQualModal.tsx`'s dialog carries
 * `aria-modal="true"`, `SupportBot.tsx`'s carries `aria-modal="false"`. The
 * `data-testid` (`discovery-dialog`, set on the same element) is the
 * primary, forward-looking selector once it reaches production.
 */
export function conversation(page: Page): Locator {
  return page
    .getByTestId('discovery-dialog')
    .or(page.locator('[role="dialog"][aria-modal="true"]'));
}

/** The question ids the wizard has recorded as answered so far. */
async function answeredIds(page: Page): Promise<string[]> {
  return page.evaluate((key) => {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return [] as string[];
    try {
      return (JSON.parse(raw).answered ?? []) as string[];
    } catch {
      return [] as string[];
    }
  }, DRAFT_KEY);
}

/**
 * Block until the wizard has recorded `id` as answered.
 *
 * A turn is not done when the click returns: the agent's reply is paced
 * (`DEFAULT_PACE_MS`), and a rejected answer (a malformed email, say) leaves
 * the same question on screen with an error bubble under it. Polling the
 * cursor catches both, and the failure message names the question rather than
 * timing out on an anonymous locator.
 */
async function settled(
  page: Page,
  id: IntakeQuestionId,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen: string[] = [];
  while (Date.now() < deadline) {
    seen = await answeredIds(page);
    if (seen.includes(id)) return;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `The intake never recorded "${id}" as answered within ${timeoutMs} ms. ` +
      `Answered so far: ${seen.join(', ') || '(none)'}. ` +
      'Either the question was rejected (look for an agent error bubble) or ' +
      'the script changed shape.',
  );
}

/** Type an answer into the composer and send it. */
export async function say(
  page: Page,
  id: IntakeQuestionId,
  text: string,
): Promise<void> {
  const dialog = conversation(page);
  // One textarea serves every question; it is labelled, never test-id'd.
  await dialog.getByLabel('Your answer').fill(text);
  // `exact` matters: every answered turn renders an "Edit: <question>" button,
  // and one question's text contains the word "send".
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await settled(page, id);
}

/** Choose one option on a single-choice question. */
export async function tap(
  page: Page,
  id: IntakeQuestionId,
  label: string,
): Promise<void> {
  await conversation(page)
    .getByRole('button', { name: label, exact: true })
    .first()
    .click();
  await settled(page, id);
}

/** Choose options on a multi-select question and close it. */
export async function pick(
  page: Page,
  id: IntakeQuestionId,
  labels: readonly string[],
): Promise<void> {
  const dialog = conversation(page);
  for (const label of labels) {
    await dialog.getByRole('button', { name: label, exact: true }).first().click();
  }
  await dialog.getByRole('button', { name: "That's it", exact: true }).click();
  await settled(page, id);
}

/** Decline an optional question. */
export async function skip(page: Page, id: IntakeQuestionId): Promise<void> {
  await conversation(page)
    .getByRole('button', { name: 'Skip this one', exact: true })
    .first()
    .click();
  await settled(page, id);
}

/** Accept a panel step (the recommended build, the care plan). */
export async function confirmPanel(page: Page): Promise<void> {
  await conversation(page)
    .getByRole('button', { name: 'Looks good, carry on', exact: true })
    .click();
}

/**
 * Open the discovery conversation from the landing page.
 *
 * `?book=1` is the app's own deep link (BookingModalProvider opens the modal
 * and then rewrites the URL), but the QA journey clicks the button a visitor
 * would click, because the button being wired up is part of what is under
 * test.
 */
export async function openConversation(page: Page): Promise<Locator> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // The app has its own outage screen ("Database Offline"), and it replaces
  // the landing page wholesale. Caught here so the journey reports the outage
  // in one line instead of timing out on a locator and making somebody open a
  // trace to find out the site was down.
  const outage = page.getByRole('heading', { name: 'Database Offline' });
  if (await outage.isVisible().catch(() => false)) {
    throw new Error(
      'The landing page rendered the "Database Offline" screen instead of the site. ' +
        'Production cannot reach its database, so no visitor can start an intake. ' +
        'Check GET /api/health/database.',
    );
  }

  await page.getByTestId('open-discovery').click();
  const dialog = conversation(page);
  await expect(
    dialog,
    'Clicking the landing page CTA opened no discovery dialog',
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    dialog.getByLabel('Your answer'),
    'The discovery dialog opened without its composer, so the conversation cannot be answered',
  ).toBeVisible({ timeout: 30_000 });
  return dialog;
}

/**
 * Answer the whole scripted intake as the canary, leaving the wizard on the
 * live info-agent step.
 *
 * The order is the script's order. Optional questions the canary has nothing
 * honest to say to are skipped rather than filled with invented detail.
 */
export async function answerScriptedIntake(page: Page): Promise<void> {
  await say(page, 'fullName', CANARY.fullName);
  await say(page, 'email', CANARY.email);
  await say(page, 'businessName', CANARY.businessName);

  await say(page, 'description', CANARY.description);
  await tap(page, 'industry', CANARY.industry);
  await say(page, 'targetAudience', CANARY.targetAudience);
  // No public profiles exist for a canary, so there is nothing to paste.
  await skip(page, 'links');

  await pick(page, 'goal', [CANARY.goal]);
  await pick(page, 'brandTone', [CANARY.brandTone]);
  await tap(page, 'pageCount', CANARY.pageCount);
  await tap(page, 'timeline', CANARY.timeline);

  // "No products" also suppresses the follow-up catalogSize question.
  await tap(page, 'commerceMode', CANARY.commerceMode);
  await skip(page, 'calComUrl');
  // See the header: answering this one changes the quote.
  await skip(page, 'customIntegrations');

  await confirmPanel(page);
  await settled(page, 'selectedTier');

  // The care-plan cards carry no accessible name beyond their own copy.
  const dialog = conversation(page);
  const starterCare = dialog.getByText('Guided editor access').first();
  if (await starterCare.isVisible().catch(() => false)) {
    await starterCare.click();
    await confirmPanel(page);
    await settled(page, 'subscription');
  }
}
