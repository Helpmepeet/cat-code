import type {
  AgentConfigDefinition,
  AgentConfigSnapshot,
  AgentConfigSourceId,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

export type AgentConfigState = {
  sessions: Record<SessionId, AgentConfigSnapshot | null>
}

export type AgentConfigAction = { type: 'frame'; frame: ServerFrame }

export function createAgentConfigState(): AgentConfigState {
  return { sessions: {} }
}

export function reduceAgentConfigState(
  state: AgentConfigState,
  action: AgentConfigAction,
): AgentConfigState {
  const { frame } = action

  if (frame.kind === 'agent-config.snapshot') {
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: frame.agents },
    }
  }

  if (frame.kind === 'lifecycle') {
    if (!(frame.sessionId in state.sessions)) return state
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: null },
    }
  }

  return state
}

export function selectAgentConfigSnapshot(
  state: AgentConfigState,
  sessionId: SessionId | null,
): AgentConfigSnapshot | null {
  const snapshot = sessionId ? state.sessions[sessionId] : undefined
  return snapshot ?? null
}

export const AGENT_CONFIG_SOURCE_ORDER: readonly AgentConfigSourceId[] = [
  'policySettings',
  'flagSettings',
  'localSettings',
  'projectSettings',
  'userSettings',
  'plugin',
  'built-in',
]

export type AgentConfigSourceGroup = {
  source: AgentConfigSourceId
  definitions: AgentConfigDefinition[]
}

export function selectAgentConfigGroups(
  snapshot: AgentConfigSnapshot | null,
): AgentConfigSourceGroup[] {
  if (!snapshot) return []
  return AGENT_CONFIG_SOURCE_ORDER.map(source => ({
    source,
    definitions: snapshot.definitions.filter(definition => definition.source === source),
  })).filter(group => group.definitions.length > 0)
}

export function selectAgentConfigCounts(snapshot: AgentConfigSnapshot | null): {
  total: number
  active: number
  unavailable: number
  overridden: number
} {
  if (!snapshot) return { total: 0, active: 0, unavailable: 0, overridden: 0 }
  return snapshot.definitions.reduce(
    (counts, definition) => ({
      total: counts.total + 1,
      active: counts.active + (definition.active ? 1 : 0),
      unavailable: counts.unavailable + (definition.available ? 0 : 1),
      overridden: counts.overridden + (definition.overriddenBy ? 1 : 0),
    }),
    { total: 0, active: 0, unavailable: 0, overridden: 0 },
  )
}
