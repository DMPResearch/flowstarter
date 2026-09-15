/**
 * Which step a phase is, decided from the phase and nothing else.
 *
 * The pipeline already announces its phases as prose, and those strings are
 * load-bearing elsewhere (the operator board buckets a job into a column from
 * the first word of the newest one). Rather than invent a second vocabulary
 * and keep the two in step by hand, this table reads the phase the pipeline
 * already emits and says which `kind` and which `subject` it is.
 *
 * A phase with no row falls through to the first-word rule, which is the same
 * shape the board's own `PHASE_COLUMN` uses. A phase that matches neither is
 * `thinking` about `site`: the least the timeline can say while still being
 * true, and never a guess at a name.
 */
import type { AgentActivityKind, ActivitySubject } from './events';

export interface PhaseActivity {
  kind: AgentActivityKind;
  subject: ActivitySubject;
}

/**
 * Exact phase strings, in the order the pipeline says them. Prefix matched,
 * longest first, so the templated ones ("Live, in version 3", "Applying 2
 * notes from the team") land on the row they belong to.
 */
const PHASE_RULES: ReadonlyArray<readonly [string, PhaseActivity]> = [
  // Preview generation
  [
    'Learning your voice and visual direction',
    { kind: 'thinking', subject: 'brief' },
  ],
  [
    'Choosing the best starting design',
    { kind: 'searching', subject: 'template.library' },
  ],
  ['Preparing your selected design', { kind: 'building', subject: 'site' }],
  [
    'Painting artwork for your trade',
    { kind: 'building', subject: 'image.site' },
  ],
  [
    'Personalizing the site with your business',
    { kind: 'editing', subject: 'site' },
  ],
  ['Polishing voice and honesty', { kind: 'editing', subject: 'content.site' }],
  ['Refining the personalization', { kind: 'repairing', subject: 'site' }],
  ['Placing your own photos', { kind: 'editing', subject: 'image.site' }],
  [
    'Choosing the right hero image',
    { kind: 'editing', subject: 'section.hero' },
  ],
  ['Placing your brand imagery', { kind: 'editing', subject: 'image.site' }],
  ['Repairing the styles', { kind: 'repairing', subject: 'style.site' }],
  ['Checking the preview', { kind: 'checking', subject: 'gate.build' }],
  ['Repairing the preview', { kind: 'repairing', subject: 'preview' }],
  ['Preparing the preview teaser', { kind: 'building', subject: 'preview' }],
  ['Publishing your live preview', { kind: 'publishing', subject: 'preview' }],
  ['Reviewing the rendered preview', { kind: 'checking', subject: 'preview' }],
  ['Repairing rendered issues', { kind: 'repairing', subject: 'preview' }],

  // Full site build, change request and rebuild
  ['Preparing a clean worktree', { kind: 'building', subject: 'site' }],
  ['Materializing', { kind: 'building', subject: 'site' }],
  [
    "Checking the client's approved changes survived",
    { kind: 'checking', subject: 'gate.changes' },
  ],
  [
    'Checking the paid change is on the site',
    { kind: 'checking', subject: 'gate.changes' },
  ],
  [
    'Checking the work section against the brief',
    { kind: 'checking', subject: 'gate.brief' },
  ],
  [
    'Checking the change stayed inside the brief',
    { kind: 'checking', subject: 'gate.brief' },
  ],
  [
    'Checking the site matches the brief',
    { kind: 'checking', subject: 'gate.brief' },
  ],
  ['Checking for placeholder copy', { kind: 'checking', subject: 'gate.copy' }],
  [
    'Checking for placeholder images',
    { kind: 'checking', subject: 'gate.images' },
  ],
  [
    'Checking what the site asks the browser to do',
    { kind: 'checking', subject: 'gate.markup' },
  ],
  ['Checking the repaired build', { kind: 'checking', subject: 'gate.build' }],
  ['Checking the build', { kind: 'checking', subject: 'gate.build' }],
  ['Agents expanding the site', { kind: 'editing', subject: 'site' }],
  ['Agents making the change', { kind: 'editing', subject: 'site' }],
  ['Applying', { kind: 'editing', subject: 'site' }],
  ['Repairing the build', { kind: 'repairing', subject: 'gate.build' }],
  [
    "Restoring the client's approved changes",
    { kind: 'repairing', subject: 'gate.changes' },
  ],
  [
    'Putting the paid change back on the site',
    { kind: 'repairing', subject: 'gate.changes' },
  ],
  [
    'Cutting the site back to the brief',
    { kind: 'repairing', subject: 'gate.pages' },
  ],
  [
    'Removing only the pages the request did not ask for',
    { kind: 'repairing', subject: 'gate.pages' },
  ],
  ['Removing placeholder copy', { kind: 'repairing', subject: 'gate.copy' }],
  ['Removing invented projects', { kind: 'repairing', subject: 'gate.copy' }],
  [
    'Removing placeholder images',
    { kind: 'repairing', subject: 'gate.images' },
  ],
  [
    'Putting the client photograph in the right slot',
    { kind: 'editing', subject: 'image.site' },
  ],
  ['Removing unsafe markup', { kind: 'repairing', subject: 'gate.markup' }],
  ['Committing the site', { kind: 'publishing', subject: 'site' }],
  // The resumed deploy of an artifact a previous attempt already built and
  // gated. It is a publish, not a build: an operator watching a job that spent
  // no model time on this attempt must not read "generating" on the timeline.
  ['Redeploying the built site', { kind: 'publishing', subject: 'site' }],
  ['Publishing for review', { kind: 'publishing', subject: 'site' }],
  [
    'Saving the new version of the site',
    { kind: 'publishing', subject: 'site' },
  ],
  ['Publishing', { kind: 'publishing', subject: 'site' }],
  ['Handed to human QA', { kind: 'done', subject: 'site' }],
  ['Live', { kind: 'done', subject: 'site' }],
];

/**
 * The same fallback shape the board uses: the first word of the phase decides.
 * A phase is written as a gerund by convention, so the first word is the verb.
 */
const KIND_BY_FIRST_WORD: Readonly<Record<string, AgentActivityKind>> = {
  preparing: 'building',
  materializing: 'building',
  painting: 'building',
  agents: 'editing',
  applying: 'editing',
  personalizing: 'editing',
  placing: 'editing',
  polishing: 'editing',
  checking: 'checking',
  reviewing: 'checking',
  repairing: 'repairing',
  refining: 'repairing',
  removing: 'repairing',
  restoring: 'repairing',
  cutting: 'repairing',
  putting: 'repairing',
  committing: 'publishing',
  publishing: 'publishing',
  redeploying: 'publishing',
  saving: 'publishing',
  live: 'done',
  handed: 'done',
  choosing: 'thinking',
  learning: 'thinking',
  starting: 'thinking',
};

/** The rule. Give it the phase the pipeline says, get the step it is. */
export function activityForPhase(phase: string): PhaseActivity {
  const trimmed = phase.trim();
  for (const [prefix, activity] of PHASE_RULES) {
    if (trimmed.startsWith(prefix)) return activity;
  }
  const firstWord = trimmed.split(/[\s,]+/)[0]?.toLowerCase() ?? '';
  const kind = KIND_BY_FIRST_WORD[firstWord];
  return { kind: kind ?? 'thinking', subject: 'site' };
}

/**
 * The tool calls the agent is allowed to make, and the step each one is.
 * The `subject` for a file tool comes from the path through the friendly-name
 * rule; these are the kinds, and the list is closed: a tool with no row here
 * produces no step at all rather than a step that says "ran a tool".
 */
export const TOOL_ACTIVITY_KIND: Readonly<
  Record<string, AgentActivityKind | undefined>
> = {
  read_file: 'reading',
  write_file: 'editing',
  edit_file: 'editing',
  modify_element_content: 'editing',
  search_flowstarter_templates: 'searching',
  get_flowstarter_template_details: 'searching',
};

/** Longest a chip may be before it is cut. Chips sit on one line. */
export const ACTIVITY_CHIP_MAX = 60;

/**
 * What a tool call looks like on the timeline, or `null` when the tool is not
 * one we narrate. Only two arguments are ever read: `path`, which the
 * friendly-name rule turns into a subject, and `query` / `slug`, which become
 * the chip. Nothing else in `args` is touched, because everything else in
 * `args` is the model's own text.
 */
export function activityForToolCall(
  toolName: string,
  args: unknown,
): { kind: AgentActivityKind; path?: string; chip?: string } | null {
  const kind = TOOL_ACTIVITY_KIND[toolName];
  if (!kind) return null;
  const record =
    args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const path = typeof record.path === 'string' ? record.path : undefined;
  const rawChip =
    typeof record.query === 'string'
      ? record.query
      : typeof record.slug === 'string'
        ? record.slug
        : undefined;
  const chip = rawChip ? rawChip.trim().slice(0, ACTIVITY_CHIP_MAX) : undefined;
  return { kind, ...(path ? { path } : {}), ...(chip ? { chip } : {}) };
}
