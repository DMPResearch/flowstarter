import { ProjectState } from './types';

const ALLOWED_TRANSITIONS: Readonly<Record<ProjectState, readonly ProjectState[]>> = {
  [ProjectState.INTAKE]: [ProjectState.PREVIEW_READY],
  [ProjectState.PREVIEW_READY]: [ProjectState.DEPOSIT_PAID],
  [ProjectState.DEPOSIT_PAID]: [ProjectState.AGENTS_WORKING],
  [ProjectState.AGENTS_WORKING]: [ProjectState.HUMAN_QA],
  [ProjectState.HUMAN_QA]: [ProjectState.LIVE_SUBSCRIPTION],
  [ProjectState.LIVE_SUBSCRIPTION]: [],
};

export class InvalidProjectTransitionError extends Error {
  constructor(from: ProjectState, to: ProjectState) {
    super(`Invalid Flowstarter project transition: ${from} -> ${to}`);
    this.name = 'InvalidProjectTransitionError';
  }
}

export function canTransitionProject(from: ProjectState, to: ProjectState): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertProjectTransition(from: ProjectState, to: ProjectState): void {
  if (!canTransitionProject(from, to)) {
    throw new InvalidProjectTransitionError(from, to);
  }
}

/**
 * The deposit's share of the quote, as a whole percentage. This is the one
 * number that decides the split — `depositAmountMinor` computes off it, and
 * every place that states the percentage in copy (the preview step, the
 * unlock page, the deposit Checkout) reads it from here rather than writing
 * its own figure that could drift from what the Checkout actually charges.
 */
export const DEPOSIT_PERCENT = 20;

export function depositAmountMinor(finalValueMinor: number): number {
  assertPositiveMinorAmount(finalValueMinor, 'finalValueMinor');
  return Math.round(finalValueMinor * (DEPOSIT_PERCENT / 100));
}

export function balanceAmountMinor(finalValueMinor: number): number {
  assertPositiveMinorAmount(finalValueMinor, 'finalValueMinor');
  return finalValueMinor - depositAmountMinor(finalValueMinor);
}

function assertPositiveMinorAmount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer in the currency's minor unit`);
  }
}
