export type RuntimeBoundaryPhase = 'placeholder' | 'ready'

export type SessionStatus = 'active' | 'idle' | 'blocked'

export type PanelStatus = 'selected' | 'available' | 'attention'

export type RuntimeStatus = 'starting' | 'idle' | 'ready' | 'attention'

export type PermissionDecision = 'approve' | 'deny' | 'later'

export type SurfaceTone = 'neutral' | 'muted' | 'attention'

export type WorkspaceSummary = {
  name: string
  localPathLabel: string
  focusModeLabel: string
}

export type SessionSummary = {
  id: string
  title: string
  summary: string
  status: SessionStatus
  lastEventLabel: string
  unreadCount?: number
}

export type PanelSummary = {
  id: string
  label: string
  detail: string
  status: PanelStatus
}

export type ChatMessagePlaceholder = {
  id: string
  speaker: 'system' | 'assistant' | 'user'
  text: string
}

export type WorkspaceItemPlaceholder = {
  id: string
  label: string
  detail: string
  kind: 'task' | 'note' | 'diff'
}

export type PermissionRequestPlaceholder = {
  id: string
  title: string
  scopeLabel: string
  summary: string
  urgency: 'routine' | 'attention'
}

export type GoalStatusPlaceholder = {
  title: string
  summary: string
  progressLabel: string
}

export type RuntimeStatusPlaceholder = {
  status: RuntimeStatus
  summary: string
  detail: string
  actionsReady: boolean
}

export type SurfacePlaceholderItem = {
  id: string
  label: string
  detail: string
  tone: SurfaceTone
}

export type DedicatedAppRuntimeState = {
  boundaryPhase: RuntimeBoundaryPhase
  workspace: WorkspaceSummary
  sessions: SessionSummary[]
  selectedSessionId: string
  panels: PanelSummary[]
  selectedPanelId: string
  chatSurface: {
    title: string
    messages: ChatMessagePlaceholder[]
  }
  workspaceSurface: {
    title: string
    summary: string
    items: WorkspaceItemPlaceholder[]
  }
  permissions: PermissionRequestPlaceholder[]
  goal: GoalStatusPlaceholder
  runtime: RuntimeStatusPlaceholder
  agents: SurfacePlaceholderItem[]
  accounts: SurfacePlaceholderItem[]
  settings: SurfacePlaceholderItem[]
}

export type DedicatedAppRuntimeController = {
  openSession(sessionId: string): void
  selectPanel(panelId: string): void
  reviewPermission(permissionId: string, decision: PermissionDecision): void
  focusGoal(): void
  openAgents(): void
  openAccounts(): void
  openSettings(sectionId?: string): void
}
