import type { SessionDescriptor } from './hostApi.js'
import type { SessionId } from './protocol.js'

export const DEBUG_STATE_VERSION = 1 as const
export const DEBUG_SHELL_STATE_CHANNEL = 'catcode:debug:shell-state'

export type DebugTone = 'live' | 'busy' | 'warn' | 'dead'
export type DebugSidebarKind = 'live' | 'restorable'
export type DebugPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk'
  | string

export type DebugTab = {
  appSessionId: SessionId
  title: string
  label: string
  tone: DebugTone
  restartable: boolean
  needsAttention: boolean
}

export type DebugSidebarRow = {
  appSessionId: SessionId
  title: string
  subtitle: string
  kind: DebugSidebarKind
  label: string
  tone: DebugTone
  restorable: boolean
}

export type DebugPendingPermission = {
  requestId: string
  toolName: string
  toolDisplayName: string
  displayTitle: string
  suggestionLabels: string[]
}

export type DebugPermissionSession = {
  mode: DebugPermissionMode
  pending: DebugPendingPermission[]
}

export type DebugRendererState = {
  activeSessionId: SessionId | null
  tabs: DebugTab[]
  sidebar: DebugSidebarRow[]
  permissions: Record<SessionId, DebugPermissionSession>
}

export type DebugRendererSnapshot = {
  debugStateVersion: typeof DEBUG_STATE_VERSION
  rendererStateAt: number
  renderer: DebugRendererState
}

export type DebugSessionDescriptor = SessionDescriptor & {
  enginePid?: number
  socketPath?: string
  // Mirrors the registry `ShutdownState` (IDLE-PARK adds the in-memory 'parked').
  shutdown?: 'clean' | 'crashed' | 'parked' | null
}

export type DebugStateFile = {
  debugStateVersion: typeof DEBUG_STATE_VERSION
  writtenAt: number
  rendererStateAt: number | null
  sessions: DebugSessionDescriptor[]
  renderer: DebugRendererState | null
}
