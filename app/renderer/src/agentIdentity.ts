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
  | 'blocked'
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

export type AgentIdentity = {
  hasName: boolean
  name: string | null
  handle: string | null
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
  blocked: {
    key: 'blocked',
    label: 'Needs input',
    tone: 'neutral',
    color: '#a8a29e',
    icon: 'pip-ring',
    attention: false,
  },
  waiting: {
    key: 'waiting',
    label: 'Waiting on orchestrator',
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

export const DROPPED_PROTOTYPE_AGENT_IDENTITY_FIELDS = [
  'w.progress[] fixture timelines',
  'w.files fixture file lists',
  'w.up / w.down fixture traffic counters',
  'activity arrays not derived from nested frames',
  'stats arrays not backed by result or task fields',
  'MOCK_CODEX_LEASES account fixtures',
] as const

export function agentTypeMeta(type: string | null | undefined): AgentTypeMeta | null {
  if (!type) return null
  return (
    AGENT_TYPE_META[type as AgentTypeKey] ?? {
      key: type,
      label: type,
      tone: 'neutral',
      color: '#a1a1aa',
      soft: 'rgba(161,161,170,0.08)',
      line: 'rgba(161,161,170,0.22)',
    }
  )
}

export function agentStateMeta(state: AgentStateKey): AgentStateMeta {
  return AGENT_STATE_META[state]
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
    handle: name ? `@${name}` : null,
    type,
    description,
    id,
  }
}

export type AgentStateDerivationOptions = {
  blockedOwner?: 'orchestrator' | 'user'
}

export function deriveAgentModeWorkerState(
  worker: AgentModeWorkerSource,
): AgentStateKey {
  if (worker.origin === 'prior' && worker.resumable === true) return 'resumable'
  if (worker.origin === 'prior' && worker.resumable === false) return 'stale'
  if (worker.synthesisStatus === 'pending') return 'result-ready'
  if (worker.synthesisStatus === 'synthesized') return 'reviewed'
  if (worker.status === 'failed' || worker.status === 'killed') return 'attention'
  if (worker.status === 'completed') return 'completed'
  return 'running'
}

export function deriveTaskAgentState(
  task: TaskAgentSource,
  options: AgentStateDerivationOptions = {},
): AgentStateKey {
  if (task.type === 'local_agent') {
    if (task.handoffStatus === 'blocked') {
      // Two-axis handoff (D2 `decisions/AGENT-CHROME.md`, prototype
      // OrchestratorMode.jsx `workerStateKey`:163): an orchestrator-owned blocked
      // worker is NEUTRAL — it fed a question back to the orchestrator's queue via
      // AskOrchestratorTool (`src/tasks/LocalAgentTask/LocalAgentTask.tsx:184`,
      // `AskOrchestratorTool.ts:83`), not to the human → 'waiting' ("Waiting on
      // orchestrator"). Only the solo case (no orchestrator to pick it up) escalates
      // to the amber 'needs-you'. This is the P4-8 wiring of the previously
      // unreachable `waiting` state (the AgentIdentity two-strikes rider); the gray
      // `blocked` meta survives as the transcript-card's own render remap
      // (`waiting`→`blocked`, AgentIdentity.jsx:170, deferred P4-8c).
      return options.blockedOwner === 'orchestrator' ? 'waiting' : 'needs-you'
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
  if (tool.status === 'error') return 'failed'
  if (tool.status === 'success') return 'completed'
  return tool.run_in_background === true ? 'background' : 'running'
}

export function deriveAgentState(
  source: AgentDisplaySource,
  options: AgentStateDerivationOptions = {},
): AgentStateKey {
  if (isAgentToolSource(source)) return deriveAgentToolState(source)
  if (isTaskAgentSource(source)) return deriveTaskAgentState(source, options)
  return deriveAgentModeWorkerState(source)
}

export function deriveAgentDisplayVocabulary(
  source: AgentDisplaySource,
  options: AgentStateDerivationOptions = {},
): AgentDisplayVocabulary {
  const identity = resolveAgentIdentity(source)
  return {
    identity,
    type: agentTypeMeta(identity.type),
    state: agentStateMeta(deriveAgentState(source, options)),
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
  status: 'pending' | 'success' | 'error'
  run_in_background?: boolean
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
