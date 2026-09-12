/**
 * The six project states, in client language.
 *
 * `ProjectState` is the machine's vocabulary — INTAKE, AGENTS_WORKING — and it
 * is exactly the wrong thing to show someone who paid us to build them a
 * website. This maps each state to a title and a sentence a non-technical
 * client can act on, in the one order the state machine allows
 * (see `packages/agentic-codegen/src/flowstarter/state-machine.ts`).
 */
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import type { ClientBuildSignal } from './project-build-signal';

export interface ProjectStage {
  state: ProjectState;
  /** Short label for the stepper. */
  label: string;
  /** Headline for the current stage. */
  title: string;
  /** One sentence telling the client what is happening and what is next. */
  detail: string;
}

/** In transition order. The stepper and the progress maths both rely on it. */
export const PROJECT_STAGES: readonly ProjectStage[] = [
  {
    state: ProjectState.INTAKE,
    label: 'Your details',
    title: "We're getting to know your business",
    detail:
      "We're collecting what we need to design your site: your business details, your photos, and what you want the site to do for you.",
  },
  {
    state: ProjectState.PREVIEW_READY,
    label: 'Preview ready',
    title: 'Your preview is ready to look at',
    detail:
      "Have a look at the design we've put together. When you're happy, the deposit starts the full build.",
  },
  {
    state: ProjectState.DEPOSIT_PAID,
    label: 'Deposit paid',
    title: 'Thanks, your deposit is in',
    detail:
      'Your build is booked and about to start. Nothing is needed from you right now.',
  },
  {
    state: ProjectState.AGENTS_WORKING,
    label: 'Building',
    title: "We're building your site",
    detail:
      "Your pages, words and images are being put together now. If we need anything from you, we'll ask you here.",
  },
  {
    state: ProjectState.HUMAN_QA,
    label: 'Final checks',
    title: 'A person is checking every page',
    detail:
      'Someone on our team is going through the finished site before it goes live. This is when the balance falls due.',
  },
  {
    state: ProjectState.LIVE_SUBSCRIPTION,
    label: 'Live',
    title: 'Your site is live',
    detail:
      "It's published and we look after it from here. Message us any time you want something changed.",
  },
];

/** True when the string is one of the six states the machine knows. */
export function isProjectState(value: unknown): value is ProjectState {
  return (
    typeof value === 'string' &&
    PROJECT_STAGES.some((stage) => stage.state === value)
  );
}

/**
 * The state a row is in, defaulting to INTAKE.
 *
 * `workspaces.project_state` is a plain TEXT column, so a row written by an
 * older path (or by hand) can hold something outside the enum. Falling back to
 * the first stage keeps the page renderable instead of blanking the whole
 * progress panel over one bad string.
 */
export function projectStateFrom(value: unknown): ProjectState {
  return isProjectState(value) ? value : ProjectState.INTAKE;
}

/** Position of a state in the six-stage sequence. Never -1. */
export function projectStageIndex(state: ProjectState): number {
  const index = PROJECT_STAGES.findIndex((stage) => stage.state === state);
  return index < 0 ? 0 : index;
}

/** The stage a project is currently sitting in. */
export function currentStage(state: ProjectState): ProjectStage {
  return PROJECT_STAGES[projectStageIndex(state)];
}

export type StageStatus = 'done' | 'current' | 'upcoming';

/** Where each stage sits relative to the project's current state. */
export function stageStatus(
  stage: ProjectStage,
  state: ProjectState
): StageStatus {
  const here = projectStageIndex(state);
  const mine = projectStageIndex(stage.state);
  if (mine < here) return 'done';
  if (mine === here) return 'current';
  return 'upcoming';
}

/**
 * What the client reads at the top of their dashboard, with the build's own
 * health folded in.
 *
 * The stage copy above is written for a project that is moving. A project
 * whose build failed is sitting in DEPOSIT_PAID because the worker put it back
 * there for a retry, so it reads its way into "your build is booked and about
 * to start" and stays there. That sentence is the one thing a client in this
 * state must not be told, so a build that has stopped or stalled replaces the
 * title and the sentence with what is actually true: it stopped, a person has
 * it, and nothing is being asked of them.
 *
 * Only the words change. The stepper still shows the stage the project is in,
 * because inventing a seventh stage would mean inventing a seventh state, and
 * the state machine is the state machine.
 *
 * The third case is the opposite of the other two: a build that is waiting on
 * the client's own brief. Nothing is wrong with it, nobody is looking at it,
 * and the one thing it must not say is the DEPOSIT_PAID stage's "Nothing is
 * needed from you right now", which is precisely what it would say without
 * this branch.
 */
export function stageCopy(
  state: ProjectState,
  signal?: ClientBuildSignal | null
): { title: string; detail: string } {
  const stage = currentStage(state);
  if (!signal) return { title: stage.title, detail: stage.detail };
  if (signal.attention === 'failed') {
    return {
      title: 'Your build needs a second look',
      detail:
        'Your build stopped before it finished and a person on our team is ' +
        'checking it now. Nothing is needed from you, and nothing you have ' +
        'paid is affected. We will email you as soon as it is moving again.',
    };
  }
  // The one case here where something IS needed from the client, which is why
  // it cannot borrow either of the other two sentences: both of them promise
  // that nothing is. Calm, specific, and it names the page rather than asking
  // them to go looking for it.
  if (signal.attention === 'waiting_on_brief') {
    return {
      title: 'We are waiting on your brief',
      detail:
        'Your build is queued and starts by itself as soon as we know what ' +
        'to put on the site. Open Your brief on this page and tell us what ' +
        'you offer and what you have made. It takes about ten minutes and ' +
        'nothing happens until it is done.',
    };
  }
  return {
    title: 'Your build has not moved for a while',
    detail:
      'Your build has been sitting longer than it should and a person on our ' +
      'team is looking at it. Nothing is needed from you. We will email you ' +
      'as soon as it is moving again.',
  };
}
