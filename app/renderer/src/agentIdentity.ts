export type AgentTypeTone = 'teal' | 'blue' | 'purple' | 'sky' | 'neutral'
export type AgentStateTone =
  | 'info'
  | 'success'
  | 'danger'
  | 'warning'
  | 'neutral'
  | 'muted'
  | 'purple'
export type AgentPipIcon = 'pip-fill' | 'pip-ring' | 'pip-pulse'

export type AgentTypeKey =
  | 'verification'
  | 'general-purpose'
  | 'implementor'
  | 'Explore'
  | 'coding-worker'
  | 'agent-mode-coding-worker'

export type AgentTypeMeta = {
  key: string
  label: string
  tone: AgentTypeTone
  color: string
  soft: string
  line: string
  compressedFrom?: string
}

export type AgentStateKey =
  | 'running'
  | 'background'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'waiting'
  | 'needs-you'
  | 'paused'
  | 'result-ready'
  | 'reviewed'
  | 'attention'
  | 'resumable'
  | 'stale'
  | 'resumed'

export type AgentStateMeta = {
  key: AgentStateKey
  label: string
  tone: AgentStateTone
  color: string
  icon: AgentPipIcon
  attention: boolean
}

/**
 * A worker's identity as the UI reads it. There is deliberately NO `@`-prefixed
 * form here: the at-sign is the ENGINE's mention syntax and the operator ruled
 * (2026-08-21) that it never reaches the screen. Where a summary sentence has to
 * be searched for `@name`, the needle is built at that one site and the name is
 * rendered bare.
 */
export type AgentIdentity = {
  hasName: boolean
  name: string | null
  type: string | null
  description: string | null
  id: string | null
}

export type AgentDisplayVocabulary = {
  identity: AgentIdentity
  type: AgentTypeMeta | null
  state: AgentStateMeta
}

export const AGENT_TYPE_META = {
  verification: {
    key: 'verification',
    label: 'Verification',
    tone: 'teal',
    color: '#5eead4',
    soft: 'rgba(94,234,212,0.10)',
    line: 'rgba(94,234,212,0.26)',
  },
  'general-purpose': {
    key: 'general-purpose',
    label: 'General-purpose',
    tone: 'blue',
    color: '#93c5fd',
    soft: 'rgba(147,197,253,0.10)',
    line: 'rgba(147,197,253,0.26)',
  },
  implementor: {
    key: 'implementor',
    label: 'Implementor',
    tone: 'purple',
    color: '#c4b5fd',
    soft: 'rgba(196,181,253,0.10)',
    line: 'rgba(196,181,253,0.26)',
  },
  Explore: {
    key: 'Explore',
    label: 'Explore',
    tone: 'sky',
    color: '#7dd3fc',
    soft: 'rgba(125,211,252,0.10)',
    line: 'rgba(125,211,252,0.26)',
  },
  'coding-worker': {
    key: 'coding-worker',
    label: 'Coding worker',
    tone: 'purple',
    color: '#a78bfa',
    soft: 'rgba(167,139,250,0.10)',
    line: 'rgba(167,139,250,0.24)',
  },
  'agent-mode-coding-worker': {
    key: 'agent-mode-coding-worker',
    label: 'Coding worker',
    tone: 'purple',
    color: '#a78bfa',
    soft: 'rgba(167,139,250,0.10)',
    line: 'rgba(167,139,250,0.24)',
    compressedFrom: 'agent-mode-coding-worker',
  },
} satisfies Record<AgentTypeKey, AgentTypeMeta>

export const AGENT_STATE_META = {
  running: {
    key: 'running',
    label: 'Running',
    tone: 'info',
    color: '#60a5fa',
    icon: 'pip-pulse',
    attention: false,
  },
  background: {
    key: 'background',
    label: 'In background',
    tone: 'info',
    color: '#60a5fa',
    icon: 'pip-ring',
    attention: false,
  },
  completed: {
    key: 'completed',
    label: 'Completed',
    tone: 'success',
    color: '#4ade80',
    icon: 'pip-fill',
    attention: false,
  },
  failed: {
    key: 'failed',
    label: 'Failed',
    tone: 'danger',
    color: '#f87171',
    icon: 'pip-fill',
    attention: false,
  },
  stopped: {
    key: 'stopped',
    label: 'Stopped',
    tone: 'warning',
    color: '#fbbf24',
    icon: 'pip-ring',
    attention: false,
  },
  waiting: {
    key: 'waiting',
    label: 'Waiting on the assistant',
    tone: 'purple',
    color: '#c084fc',
    icon: 'pip-ring',
    attention: false,
  },
  'needs-you': {
    key: 'needs-you',
    label: 'Needs you',
    tone: 'warning',
    color: '#fbbf24',
    icon: 'pip-fill',
    attention: true,
  },
  paused: {
    key: 'paused',
    label: 'Paused',
    tone: 'neutral',
    color: '#a8a29e',
    icon: 'pip-ring',
    attention: false,
  },
  'result-ready': {
    key: 'result-ready',
    label: 'Result ready',
    tone: 'success',
    color: '#4ade80',
    icon: 'pip-ring',
    attention: true,
  },
  reviewed: {
    key: 'reviewed',
    label: 'Reviewed',
    tone: 'neutral',
    color: '#a1a1aa',
    icon: 'pip-ring',
    attention: false,
  },
  attention: {
    key: 'attention',
    label: 'Attention',
    tone: 'warning',
    color: '#fbbf24',
    icon: 'pip-fill',
    attention: true,
  },
  resumable: {
    key: 'resumable',
    label: 'Resumable',
    tone: 'neutral',
    color: '#a1a1aa',
    icon: 'pip-ring',
    attention: false,
  },
  stale: {
    key: 'stale',
    label: 'Stale',
    tone: 'muted',
    color: '#71717a',
    icon: 'pip-ring',
    attention: false,
  },
  resumed: {
    key: 'resumed',
    label: 'Resumed',
    tone: 'info',
    color: '#60a5fa',
    icon: 'pip-ring',
    attention: false,
  },
} satisfies Record<AgentStateKey, AgentStateMeta>

// Prototype-only agent-identity fields deliberately NOT wired into display
// vocabulary — they were fixture-backed, never derived from real frames:
// w.progress[] timelines, w.files lists, w.up/w.down counters, activity arrays
// not derived from nested frames, stats arrays not backed by result/task
// fields, MOCK_CODEX_LEASES account fixtures. deriveAgentState() ignores such
// extras by construction (asserted in agentIdentity.test.ts).

export function agentTypeMeta(type: string | null | undefined): AgentTypeMeta | null {
  if (!type) return null
  return Object.hasOwn(AGENT_TYPE_META, type)
    ? AGENT_TYPE_META[type as AgentTypeKey]
    : {
      key: type,
      label: type,
      tone: 'neutral',
      color: '#a1a1aa',
      soft: 'rgba(161,161,170,0.08)',
      line: 'rgba(161,161,170,0.22)',
    }
}

export function agentStateMeta(state: AgentStateKey): AgentStateMeta {
  return AGENT_STATE_META[state]
}

/**
 * Compressed lifecycle word for tight list/card contexts (P4-32b — the
 * prototype's `agentTranscriptStateWord`, `AgentIdentity.jsx:146`, and the same
 * compression `WStatusText`'s list mode applies, `OrchestratorMode.jsx:46`).
 *
 * A row in a list has no room for "Result ready" or "In background", and the
 * distinctions those labels draw are not the ones a scanning reader needs: every
 * settled outcome reads "done" and every in-flight one "running". The two handoff
 * states stay APART here, though, because they differ in who owes the next move:
 * `waiting` is on the assistant, `needs-you` is on the reader. Compressing them
 * to one word is what let a blocked subagent read as an ask on the user.
 * The full `agentStateMeta().label` stays the vocabulary
 * for a standalone state chip; this is only the crowded case. Tone still comes
 * from `agentStateMeta`, so nothing about the colour vocabulary forks here.
 */
export function agentTranscriptStateWord(state: AgentStateKey): string {
  switch (state) {
    case 'running':
    case 'background':
    case 'resumed':
      return 'running'
    case 'waiting':
      return 'waiting'
    case 'needs-you':
      return 'needs you'
    case 'completed':
    case 'reviewed':
    case 'result-ready':
      return 'done'
    case 'failed':
    case 'attention':
      return 'failed'
    case 'stopped':
      return 'stopped'
    case 'paused':
      return 'paused'
    case 'resumable':
      return 'resumable'
    case 'stale':
      return 'stale'
    default: {
      // Closed-union tripwire: a new AgentStateKey must be given a word here.
      const exhaustive: never = state
      return exhaustive
    }
  }
}

/**
 * The one thing about a worker's run that still reaches its face: whether it is
 * moving. Motion, not colour or shape, so identity is untouched.
 *
 * Kept when the state colour left, because it is now the card's ONLY at-a-glance
 * mark of a live worker. Everything else a reader needs is words: the slot says
 * what a running worker is doing, `backgrounded` that it went away, the tool-call
 * count that it finished, and Failed and Stopped keep their own word.
 *
 * `isLaunchRecord` never pulses: a launch record is not reporting a run, it is
 * reporting that a run began.
 */
export function agentFacePulse(
  state: AgentStateKey,
  options: { isLaunchRecord: boolean },
): boolean {
  return !options.isLaunchRecord && state === 'running'
}

export function resolveAgentIdentity(data: AgentIdentitySource = {}): AgentIdentity {
  const nestedIdentity = record(data.identity)
  const rawName = firstString(
    data.handle,
    data.agentName,
    nestedIdentity?.agentName,
  )
  const name = rawName ? rawName.replace(/^@/, '') : null
  const type = firstString(data.agentType, data.role, data.subagent_type)
  const description = firstString(
    data.description,
    data.prompt,
    data.task,
    data.toolSummary,
    data.title,
    data.command,
  )
  const id = firstString(data.agentId, nestedIdentity?.agentId, data.id, data.sessionId)

  return {
    hasName: name !== null,
    name,
    type,
    description,
    id,
  }
}

export function deriveAgentModeWorkerState(
  worker: AgentModeWorkerSource,
): AgentStateKey {
  if (worker.origin === 'prior' && worker.resumable === true) return 'resumable'
  if (worker.origin === 'prior' && worker.resumable === false) return 'stale'
  if (worker.synthesisStatus === 'pending') return 'result-ready'
  if (worker.synthesisStatus === 'synthesized') return 'reviewed'
  if (worker.status === 'failed') return 'failed'
  if (worker.status === 'killed') return 'stopped'
  if (worker.status === 'completed') return 'completed'
  return 'running'
}

export function deriveTaskAgentState(task: TaskAgentSource): AgentStateKey {
  if (task.type === 'local_agent') {
    if (task.handoffStatus === 'blocked') {
      // A local_agent's blocked handoff (D2 `decisions/AGENT-CHROME.md`,
      // prototype OrchestratorMode.jsx `workerStateKey`:163) waits on the
      // assistant that delegated it, never on the user. The subagent's own
      // result text carries the blocker back to the parent conversation, which
      // is drained into a fresh turn with no human action
      // (`src/tasks/LocalAgentTask/LocalAgentTask.tsx:273` →
      // `app/sidecar/sidecarServer.ts:1209` / `src/hooks/useQueueProcessor.ts:48`).
      // This used to return the amber 'needs-you' unconditionally, which told
      // the user to act on a handoff already addressed to the model.
      return 'waiting'
    }
    if (task.status === 'running' && task.isBackgrounded === true) {
      return 'background'
    }
    if (typeof task.resumedAt === 'number' && task.status === 'running') {
      return 'resumed'
    }
    return stateFromTaskStatus(task.status, task.isBackgrounded)
  }

  if (task.type === 'in_process_teammate') {
    if (task.shutdownRequested) return 'stopped'
    if (task.awaitingPlanApproval) return 'needs-you'
    if (task.isIdle && task.status === 'running') return 'paused'
    return stateFromTaskStatus(task.status, false)
  }

  if (task.type === 'remote_agent') {
    if (task.ultraplanPhase === 'needs_input' || task.ultraplanPhase === 'plan_ready') {
      return 'needs-you'
    }
    return stateFromTaskStatus(task.status, false)
  }

  return stateFromTaskStatus(task.status, false)
}

export function deriveAgentToolState(tool: AgentToolSource): AgentStateKey {
  // A background launch's `tool_result` only ever says it started — the launch
  // ack, not a finish — so `status: 'success'` here does NOT mean completed.
  // Its real outcome is the separate task-notification (`hasCompletion`);
  // until that lands, a backgrounded agent reads as still running.
  if (tool.run_in_background === true && !tool.hasCompletion) {
    if (tool.status === 'cancelled') return 'stopped'
    return tool.status === 'error' ? 'failed' : 'background'
  }
  if (tool.hasCompletion) {
    if (tool.completionStatus === 'failed') return 'failed'
    if (tool.completionStatus === 'killed') return 'stopped'
    return 'completed'
  }
  if (tool.status === 'error') return 'failed'
  if (tool.status === 'cancelled') return 'stopped'
  if (tool.status === 'success') return 'completed'
  return 'running'
}

export function deriveAgentState(source: AgentDisplaySource): AgentStateKey {
  if (isAgentToolSource(source)) return deriveAgentToolState(source)
  if (isTaskAgentSource(source)) return deriveTaskAgentState(source)
  return deriveAgentModeWorkerState(source)
}

export function deriveAgentDisplayVocabulary(
  source: AgentDisplaySource,
): AgentDisplayVocabulary {
  const identity = resolveAgentIdentity(source)
  return {
    identity,
    type: agentTypeMeta(identity.type),
    state: agentStateMeta(deriveAgentState(source)),
  }
}

function stateFromTaskStatus(
  status: TaskAgentSource['status'],
  isBackgrounded: boolean | undefined,
): AgentStateKey {
  switch (status) {
    case 'pending':
      return isBackgrounded === false ? 'running' : 'background'
    case 'running':
      return isBackgrounded === true ? 'background' : 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'stopped'
    default:
      return 'stopped'
  }
}

type StringFields = Record<string, unknown>

type AgentIdentitySource = StringFields & {
  id?: string
  agentId?: string
  sessionId?: string
  handle?: string
  agentName?: string
  agentType?: string
  role?: string
  subagent_type?: string
  description?: string
  prompt?: string
  task?: string
  toolSummary?: string
  title?: string
  command?: string
  identity?: unknown
}

export type AgentModeWorkerSource = AgentIdentitySource & {
  status: 'running' | 'completed' | 'failed' | 'killed'
  synthesisStatus?: 'pending' | 'synthesized'
  origin?: 'current' | 'prior'
  resumable?: boolean
  role: string
  description: string
  worktreePath?: string | null
}

export type TaskAgentSource = AgentIdentitySource & {
  type: 'local_agent' | 'in_process_teammate' | 'remote_agent'
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed'
  isBackgrounded?: boolean
  handoffStatus?: 'done' | 'blocked'
  resumedAt?: number
  awaitingPlanApproval?: boolean
  shutdownRequested?: boolean
  isIdle?: boolean
  ultraplanPhase?: 'needs_input' | 'plan_ready'
}

export type AgentToolSource = AgentIdentitySource & {
  toolName: 'Agent' | 'Task'
  status: 'pending' | 'success' | 'error' | 'cancelled'
  run_in_background?: boolean
  /**
   * A background agent's `tool_result` only says it started (the launch ack),
   * not that the agent finished (`transcriptProjector.ts` `ToolUseRow.agentCompletion`
   * doc comment). Its real outcome lands later on a separate task-notification;
   * `hasCompletion` is whether that notification has arrived, `completionStatus`
   * its reported outcome (`completed` | `failed` | `killed` | …, or null when the
   * engine sent none). Both undefined for a foreground agent, whose `tool_result`
   * genuinely is the answer.
   */
  hasCompletion?: boolean
  completionStatus?: string | null
}

export type AgentDisplaySource =
  | AgentModeWorkerSource
  | TaskAgentSource
  | AgentToolSource

function isTaskAgentSource(source: AgentDisplaySource): source is TaskAgentSource {
  return 'type' in source && (
    source.type === 'local_agent' ||
    source.type === 'in_process_teammate' ||
    source.type === 'remote_agent'
  )
}

function isAgentToolSource(source: AgentDisplaySource): source is AgentToolSource {
  return 'toolName' in source && (source.toolName === 'Agent' || source.toolName === 'Task')
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
