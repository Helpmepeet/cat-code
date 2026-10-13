import type { SessionId } from '../../shared/protocol.js'

export type PageTab = 'goals' | 'accounts' | 'usage' | 'settings' | 'sessions'
export type NavigationTarget =
  | { kind: 'session'; sessionId: SessionId }
  | { kind: 'page'; page: PageTab }

export type TabNavigationState = {
  tabs: NavigationTarget[]
  selected: NavigationTarget | null
}

export type TabNavigationAction =
  | { type: 'reconcile-sessions'; sessionIds: readonly SessionId[] }
  | { type: 'open-page'; page: PageTab }
  | { type: 'select'; target: NavigationTarget }
  | { type: 'close'; target: NavigationTarget }

export type ForegroundSelectionClaim = { version: number }

export function createForegroundSelectionClaim(): ForegroundSelectionClaim {
  return { version: 0 }
}

export function claimForegroundSelection(claim: ForegroundSelectionClaim): number {
  claim.version += 1
  return claim.version
}

export function supersedeForegroundSelection(claim: ForegroundSelectionClaim): void {
  claim.version += 1
}

export function isForegroundSelectionCurrent(
  claim: ForegroundSelectionClaim,
  version: number,
): boolean {
  return claim.version === version
}

export function applyForegroundSelectionIfCurrent(
  claim: ForegroundSelectionClaim,
  version: number,
  select: () => void,
): boolean {
  if (!isForegroundSelectionCurrent(claim, version)) return false
  select()
  return true
}

export function createTabNavigation(): TabNavigationState {
  return { tabs: [], selected: null }
}

export function targetKey(target: NavigationTarget): string {
  return target.kind === 'session' ? `session:${target.sessionId}` : `page:${target.page}`
}

export function reduceTabNavigation(
  state: TabNavigationState,
  action: TabNavigationAction,
): TabNavigationState {
  switch (action.type) {
    case 'reconcile-sessions': {
      const ids = new Set(action.sessionIds)
      const tabs = state.tabs.filter(
        target => target.kind === 'page' || ids.has(target.sessionId),
      )
      const known = new Set(
        tabs.flatMap(target => target.kind === 'session' ? [target.sessionId] : []),
      )
      for (const sessionId of action.sessionIds) {
        if (!known.has(sessionId)) {
          tabs.push({ kind: 'session', sessionId })
          known.add(sessionId)
        }
      }
      const selectedStillOpen =
        state.selected !== null && tabs.some(tab => targetKey(tab) === targetKey(state.selected!))
      if (
        selectedStillOpen &&
        tabs.length === state.tabs.length &&
        tabs.every((tab, index) => targetKey(tab) === targetKey(state.tabs[index]!))
      ) {
        return state
      }
      if (selectedStillOpen) return { ...state, tabs }
      if (!state.selected) {
        if (tabs.length === 0 && state.tabs.length === 0) return state
        return { tabs, selected: tabs[0] ?? null }
      }
      const previousIndex = state.tabs.findIndex(
        tab => targetKey(tab) === targetKey(state.selected!),
      )
      const remaining = new Set(tabs.map(targetKey))
      let fallback: NavigationTarget | null = null
      for (let index = previousIndex - 1; index >= 0; index -= 1) {
        const candidate = state.tabs[index]
        if (candidate && remaining.has(targetKey(candidate))) {
          fallback = candidate
          break
        }
      }
      if (!fallback) {
        for (let index = previousIndex + 1; index < state.tabs.length; index += 1) {
          const candidate = state.tabs[index]
          if (candidate && remaining.has(targetKey(candidate))) {
            fallback = candidate
            break
          }
        }
      }
      return {
        tabs,
        selected: fallback ?? tabs[0] ?? null,
      }
    }
    case 'open-page': {
      const target: NavigationTarget = { kind: 'page', page: action.page }
      const tabs = state.tabs.some(tab => targetKey(tab) === targetKey(target))
        ? state.tabs
        : [...state.tabs, target]
      return { tabs, selected: target }
    }
    case 'select':
      return {
        tabs: state.tabs.some(tab => targetKey(tab) === targetKey(action.target))
          ? state.tabs
          : [...state.tabs, action.target],
        selected: action.target,
      }
    case 'close': {
      const index = state.tabs.findIndex(tab => targetKey(tab) === targetKey(action.target))
      if (index < 0) return state
      const tabs = state.tabs.filter((_, candidate) => candidate !== index)
      const wasSelected =
        state.selected !== null && targetKey(state.selected) === targetKey(action.target)
      return {
        tabs,
        selected: wasSelected
          ? tabs[Math.min(index - 1, tabs.length - 1)] ?? tabs[index] ?? null
          : state.selected,
      }
    }
  }
}

export function selectedSessionId(state: TabNavigationState): SessionId | null {
  return state.selected?.kind === 'session' ? state.selected.sessionId : null
}

export function isSessionSelected(
  state: TabNavigationState,
  sessionId: SessionId,
): boolean {
  return state.selected?.kind === 'session' && state.selected.sessionId === sessionId
}

export function selectedPage(state: TabNavigationState): PageTab | 'chat' {
  return state.selected?.kind === 'page' ? state.selected.page : 'chat'
}
