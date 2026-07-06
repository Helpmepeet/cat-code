import type { SessionId } from '../../shared/protocol.js'

export const WORKSPACE_LAYOUT_STORAGE_KEY = 'catcode.workspaceLayout.v1'
export const MAX_WORKSPACE_PANELS = 3
export const MIN_WORKSPACE_PANEL_WIDTH = 20

export type WorkspacePanel = {
  sessionId: SessionId
}

export type WorkspaceLayoutState = {
  panels: WorkspacePanel[]
  widths: number[]
  activeIndex: number
}

export type WorkspaceSplitEdge = 'left' | 'right'

export type WorkspaceLayoutResult = {
  state: WorkspaceLayoutState
  blocked: 'duplicate' | 'max-panels' | null
  focusedIndex: number
}

type PersistedWorkspaceLayout = {
  version: 1
  panels: SessionId[]
  widths: number[]
  activeIndex?: number
}

type LayoutStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>

export function createWorkspaceLayout(
  sessionId: SessionId | null = null,
): WorkspaceLayoutState {
  if (!sessionId) return { panels: [], widths: [], activeIndex: 0 }
  return {
    panels: [{ sessionId }],
    widths: [100],
    activeIndex: 0,
  }
}

export function readWorkspaceLayoutFromStorage(
  storage: LayoutStorage | null,
): WorkspaceLayoutState | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersistedWorkspaceLayout>
    if (value.version !== 1 || !Array.isArray(value.panels)) return null
    const panels = value.panels
      .filter((sessionId): sessionId is SessionId => typeof sessionId === 'string')
      .slice(0, MAX_WORKSPACE_PANELS)
      .map(sessionId => ({ sessionId }))
    return {
      panels,
      widths: normalizeWidths(
        Array.isArray(value.widths) ? value.widths : [],
        panels.length,
      ),
      activeIndex: clampIndex(value.activeIndex ?? 0, panels.length),
    }
  } catch {
    return null
  }
}

export function writeWorkspaceLayoutToStorage(
  storage: LayoutStorage | null,
  state: WorkspaceLayoutState,
): void {
  if (!storage) return
  try {
    if (state.panels.length === 0) {
      storage.removeItem(WORKSPACE_LAYOUT_STORAGE_KEY)
      return
    }
    const value: PersistedWorkspaceLayout = {
      version: 1,
      panels: state.panels.map(panel => panel.sessionId),
      widths: normalizeWidths(state.widths, state.panels.length),
      activeIndex: clampIndex(state.activeIndex, state.panels.length),
    }
    storage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Renderer-owned layout persistence is best-effort; a storage failure must not
    // affect the live session/control-plane state.
  }
}

export function reconcileWorkspaceLayout(
  state: WorkspaceLayoutState,
  liveSessionIds: readonly SessionId[],
  preferredSessionId: SessionId | null,
): WorkspaceLayoutState {
  const live = new Set(liveSessionIds)
  const seen = new Set<SessionId>()
  let panels = state.panels.filter(panel => {
    if (!live.has(panel.sessionId) || seen.has(panel.sessionId)) return false
    seen.add(panel.sessionId)
    return true
  })

  if (
    preferredSessionId &&
    live.has(preferredSessionId) &&
    (panels.length === 0 || panels.length === 1)
  ) {
    panels = [{ sessionId: preferredSessionId }]
  }
  if (panels.length === 0 && liveSessionIds[0]) {
    panels = [{ sessionId: liveSessionIds[0] }]
  }

  const activeIndex = preferredSessionId
    ? Math.max(
        0,
        panels.findIndex(panel => panel.sessionId === preferredSessionId),
      )
    : state.activeIndex

  return {
    panels,
    widths: normalizeWidths(state.widths, panels.length),
    activeIndex: clampIndex(activeIndex, panels.length),
  }
}

export function focusWorkspacePanel(
  state: WorkspaceLayoutState,
  index: number,
): WorkspaceLayoutState {
  return {
    ...state,
    activeIndex: clampIndex(index, state.panels.length),
  }
}

export function focusOrAssignWorkspaceSession(
  state: WorkspaceLayoutState,
  sessionId: SessionId,
): WorkspaceLayoutResult {
  const existing = panelIndexForSession(state, sessionId)
  if (existing >= 0) {
    return {
      state: focusWorkspacePanel(state, existing),
      blocked: null,
      focusedIndex: existing,
    }
  }
  const index = state.panels.length === 0 ? 0 : state.activeIndex
  const next =
    state.panels.length === 0
      ? createWorkspaceLayout(sessionId)
      : assignPanelAt(state, index, sessionId)
  return { state: next, blocked: null, focusedIndex: next.activeIndex }
}

export function assignWorkspacePanelSession(
  state: WorkspaceLayoutState,
  index: number,
  sessionId: SessionId,
): WorkspaceLayoutResult {
  const existing = panelIndexForSession(state, sessionId)
  if (existing >= 0 && existing !== index) {
    return {
      state: focusWorkspacePanel(state, existing),
      blocked: 'duplicate',
      focusedIndex: existing,
    }
  }
  const next = assignPanelAt(state, index, sessionId)
  return { state: next, blocked: null, focusedIndex: next.activeIndex }
}

export function splitWorkspacePanel(
  state: WorkspaceLayoutState,
  index: number,
  edge: WorkspaceSplitEdge,
  sessionId: SessionId,
): WorkspaceLayoutResult {
  const existing = panelIndexForSession(state, sessionId)
  if (existing >= 0) {
    return {
      state: focusWorkspacePanel(state, existing),
      blocked: 'duplicate',
      focusedIndex: existing,
    }
  }
  if (state.panels.length >= MAX_WORKSPACE_PANELS) {
    return {
      state: focusWorkspacePanel(state, index),
      blocked: 'max-panels',
      focusedIndex: clampIndex(index, state.panels.length),
    }
  }

  if (state.panels.length === 0) {
    const next = createWorkspaceLayout(sessionId)
    return { state: next, blocked: null, focusedIndex: 0 }
  }

  const clamped = clampIndex(index, state.panels.length)
  const insertAt = edge === 'left' ? clamped : clamped + 1
  const widths = normalizeWidths(state.widths, state.panels.length)
  const splitWidth = widths[clamped] ?? 100 / state.panels.length
  const nextWidths = [...widths]
  nextWidths[clamped] = splitWidth / 2
  nextWidths.splice(insertAt, 0, splitWidth / 2)
  const panels = [...state.panels]
  panels.splice(insertAt, 0, { sessionId })

  return {
    state: {
      panels,
      widths: normalizeWidths(nextWidths, panels.length),
      activeIndex: insertAt,
    },
    blocked: null,
    focusedIndex: insertAt,
  }
}

export function closeWorkspacePanel(
  state: WorkspaceLayoutState,
  index: number,
): WorkspaceLayoutState {
  if (state.panels.length <= 1) return state
  const clamped = clampIndex(index, state.panels.length)
  const panels = state.panels.filter((_, candidate) => candidate !== clamped)
  const widths = state.widths.filter((_, candidate) => candidate !== clamped)
  return {
    panels,
    widths: normalizeWidths(widths, panels.length),
    activeIndex: clampIndex(
      clamped <= state.activeIndex ? state.activeIndex - 1 : state.activeIndex,
      panels.length,
    ),
  }
}

export function setWorkspaceWidths(
  state: WorkspaceLayoutState,
  widths: readonly number[],
): WorkspaceLayoutState {
  return {
    ...state,
    widths: normalizeWidths(widths, state.panels.length),
  }
}

export function resizeWorkspaceDivider(
  state: WorkspaceLayoutState,
  dividerIndex: number,
  deltaPercent: number,
): WorkspaceLayoutState {
  if (dividerIndex < 0 || dividerIndex >= state.panels.length - 1) return state
  const widths = normalizeWidths(state.widths, state.panels.length)
  const left = widths[dividerIndex] ?? 0
  const right = widths[dividerIndex + 1] ?? 0
  const minDelta = MIN_WORKSPACE_PANEL_WIDTH - left
  const maxDelta = right - MIN_WORKSPACE_PANEL_WIDTH
  const delta = Math.min(maxDelta, Math.max(minDelta, deltaPercent))
  const next = [...widths]
  next[dividerIndex] = left + delta
  next[dividerIndex + 1] = right - delta
  return { ...state, widths: next }
}

export function panelIndexForSession(
  state: WorkspaceLayoutState,
  sessionId: SessionId,
): number {
  return state.panels.findIndex(panel => panel.sessionId === sessionId)
}

export function workspaceLayoutsEqual(
  left: WorkspaceLayoutState,
  right: WorkspaceLayoutState,
): boolean {
  if (
    left.activeIndex !== right.activeIndex ||
    left.panels.length !== right.panels.length ||
    left.widths.length !== right.widths.length
  ) {
    return false
  }
  return left.panels.every(
    (panel, index) =>
      panel.sessionId === right.panels[index]?.sessionId &&
      Math.abs((left.widths[index] ?? 0) - (right.widths[index] ?? 0)) < 0.01,
  )
}

function assignPanelAt(
  state: WorkspaceLayoutState,
  index: number,
  sessionId: SessionId,
): WorkspaceLayoutState {
  const clamped = clampIndex(index, state.panels.length)
  const panels =
    state.panels.length === 0
      ? [{ sessionId }]
      : state.panels.map((panel, candidate) =>
          candidate === clamped ? { sessionId } : panel,
        )
  return {
    panels,
    widths: normalizeWidths(state.widths, panels.length),
    activeIndex: clamped,
  }
}

function normalizeWidths(widths: readonly number[], count: number): number[] {
  if (count === 0) return []
  const finite = widths
    .slice(0, count)
    .map(width => (Number.isFinite(width) ? Math.max(0, width) : 0))
  if (finite.length !== count || finite.some(width => width <= 0)) {
    return equalWidths(count)
  }

  const total = finite.reduce((sum, width) => sum + width, 0)
  if (!Number.isFinite(total) || total <= 0) return equalWidths(count)
  const normalized = finite.map(width => (width / total) * 100)
  if (
    count * MIN_WORKSPACE_PANEL_WIDTH <= 100 &&
    normalized.some(width => width < MIN_WORKSPACE_PANEL_WIDTH)
  ) {
    return equalWidths(count)
  }
  return normalized
}

function equalWidths(count: number): number[] {
  return Array.from({ length: count }, () => 100 / count)
}

function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0
  if (!Number.isFinite(index)) return 0
  return Math.min(count - 1, Math.max(0, Math.trunc(index)))
}
