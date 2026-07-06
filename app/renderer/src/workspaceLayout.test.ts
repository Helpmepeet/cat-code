import { expect, test } from 'bun:test'
import {
  WORKSPACE_LAYOUT_STORAGE_KEY,
  assignWorkspacePanelSession,
  closeWorkspacePanel,
  createWorkspaceLayout,
  focusOrAssignWorkspaceSession,
  readWorkspaceLayoutFromStorage,
  reconcileWorkspaceLayout,
  resizeWorkspaceDivider,
  splitWorkspacePanel,
  writeWorkspaceLayoutToStorage,
  type WorkspaceLayoutState,
} from './workspaceLayout.js'

test('split inserts a new panel and divides the source width', () => {
  const first = createWorkspaceLayout('session-a')
  const second = splitWorkspacePanel(first, 0, 'right', 'session-b')

  expect(second.blocked).toBe(null)
  expect(sessionIds(second.state)).toEqual(['session-a', 'session-b'])
  expect(second.state.widths).toEqual([50, 50])
  expect(second.state.activeIndex).toBe(1)

  const third = splitWorkspacePanel(second.state, 0, 'left', 'session-c')
  expect(third.blocked).toBe(null)
  expect(sessionIds(third.state)).toEqual(['session-c', 'session-a', 'session-b'])
  expect(third.state.activeIndex).toBe(0)
})

test('duplicate sessions are prevented and focus the existing panel', () => {
  const split = splitWorkspacePanel(
    createWorkspaceLayout('session-a'),
    0,
    'right',
    'session-b',
  ).state

  const duplicateSplit = splitWorkspacePanel(split, 1, 'right', 'session-a')
  expect(duplicateSplit.blocked).toBe('duplicate')
  expect(sessionIds(duplicateSplit.state)).toEqual(['session-a', 'session-b'])
  expect(duplicateSplit.state.activeIndex).toBe(0)

  const duplicateAssign = assignWorkspacePanelSession(split, 1, 'session-a')
  expect(duplicateAssign.blocked).toBe('duplicate')
  expect(sessionIds(duplicateAssign.state)).toEqual(['session-a', 'session-b'])
  expect(duplicateAssign.state.activeIndex).toBe(0)
})

test('layout caps at three panels', () => {
  const three = splitWorkspacePanel(
    splitWorkspacePanel(createWorkspaceLayout('a'), 0, 'right', 'b').state,
    1,
    'right',
    'c',
  ).state

  const blocked = splitWorkspacePanel(three, 2, 'right', 'd')
  expect(blocked.blocked).toBe('max-panels')
  expect(sessionIds(blocked.state)).toEqual(['a', 'b', 'c'])
})

test('resize clamps neighbours to the minimum width', () => {
  const layout: WorkspaceLayoutState = {
    panels: [{ sessionId: 'a' }, { sessionId: 'b' }],
    widths: [50, 50],
    activeIndex: 0,
  }

  expect(resizeWorkspaceDivider(layout, 0, 15).widths).toEqual([65, 35])
  expect(resizeWorkspaceDivider(layout, 0, 80).widths).toEqual([80, 20])
  expect(resizeWorkspaceDivider(layout, 0, -80).widths).toEqual([20, 80])
})

test('reconcile drops missing sessions and duplicate persisted references', () => {
  const stale: WorkspaceLayoutState = {
    panels: [
      { sessionId: 'missing' },
      { sessionId: 'b' },
      { sessionId: 'b' },
    ],
    widths: [20, 30, 50],
    activeIndex: 2,
  }

  const reconciled = reconcileWorkspaceLayout(stale, ['a', 'b'], 'b')
  expect(sessionIds(reconciled)).toEqual(['b'])
  expect(reconciled.widths).toEqual([100])
  expect(reconciled.activeIndex).toBe(0)
})

test('single-panel layout follows tab focus without touching split layouts', () => {
  const single = focusOrAssignWorkspaceSession(createWorkspaceLayout('a'), 'b')
  expect(sessionIds(single.state)).toEqual(['b'])
  expect(single.state.activeIndex).toBe(0)

  const split = splitWorkspacePanel(single.state, 0, 'right', 'c').state
  const unchanged = reconcileWorkspaceLayout(split, ['a', 'b', 'c'], 'a')
  expect(sessionIds(unchanged)).toEqual(['b', 'c'])
})

test('closing a split panel collapses back to one panel', () => {
  const split = splitWorkspacePanel(
    createWorkspaceLayout('a'),
    0,
    'right',
    'b',
  ).state

  const closed = closeWorkspacePanel(split, 1)
  expect(sessionIds(closed)).toEqual(['a'])
  expect(closed.widths).toEqual([100])
})

test('renderer storage persists only app session references and widths', () => {
  const storage = new MemoryStorage()
  const layout = splitWorkspacePanel(
    createWorkspaceLayout('a'),
    0,
    'right',
    'b',
  ).state

  writeWorkspaceLayoutToStorage(storage, layout)
  expect(storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)).toBe(
    JSON.stringify({
      version: 1,
      panels: ['a', 'b'],
      widths: [50, 50],
      activeIndex: 1,
    }),
  )
  expect(readWorkspaceLayoutFromStorage(storage)).toEqual(layout)
})

function sessionIds(state: WorkspaceLayoutState): string[] {
  return state.panels.map(panel => panel.sessionId)
}

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}
