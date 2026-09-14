/**
 * The agent activity timeline: the event, the rules that shape it, and the
 * recorder that writes it. Nothing here renders anything; the design system
 * owns the drawing and the app owns the words.
 */
export {
  ACTIVITY_SUBJECTS,
  AGENT_ACTIVITY_KINDS,
  UnsafeActivityEventError,
  assertSafeEvent,
  isAgentActivityEvent,
  looksLikeSecret,
  parseActivityEvents,
  projectForClient,
  type ActivitySubject,
  type AgentActivityEvent,
  type AgentActivityKind,
} from './events';

export {
  subjectForFailureCode,
  subjectForPath,
  subjectsForPaths,
} from './friendly-names';

export {
  ACTIVITY_CHIP_MAX,
  TOOL_ACTIVITY_KIND,
  activityForPhase,
  activityForToolCall,
  type PhaseActivity,
} from './phase-rules';

export {
  activityStatus,
  collapseActivity,
  summariseActivity,
  type ActivitySummary,
  type AgentActivityItem,
  type CollapseOptions,
} from './collapse';

export {
  ACTIVITY_MAX_EVENTS,
  ACTIVITY_MIN_INTERVAL_MS,
  ActivityRecorder,
  type ActivityRecorderOptions,
  type ActivityToolSink,
  type AgentActivitySink,
} from './recorder';
