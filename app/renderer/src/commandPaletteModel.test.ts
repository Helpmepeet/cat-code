import { expect, test } from 'bun:test'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { SessionId } from '../../shared/protocol.js'
import {
  buildPaletteItems,
  filterPaletteItems,
  type PaletteHandlers,
} from './commandPaletteModel.js'

function descriptor(over: Partial<SessionDescriptor>): SessionDescriptor {
  return {
    appSessionId: 'a' as SessionId,
    engineSessionId: null,
    cwd: '/tmp/one',
    title: null,
    titleUpdatedAt: null,
    status: 'ready',
    restorable: false,
    parked: false,
    createdAt: 1,
    lastAttachedAt: 1,
    lastMessageSentAt: null,
    ...over,
  }
}

// The palette now consumes raw descriptors (F9) and derives each row's status
// chip via the shared `sessionStatusVisual`: a ready row → live, a disconnected
// + restorable row → crashed/restorable.
function liveRow(over: Partial<SessionDescriptor>): SessionDescriptor {
  return descriptor(over)
}

function restorableRow(over: Partial<SessionDescriptor>): SessionDescriptor {
  return descriptor({ status: 'disconnected', restorable: true, ...over })
}

function noopHandlers(): PaletteHandlers {
  return {
    newSession: () => {},
    closeActiveSession: () => {},
    restartActiveSession: () => {},
    copyActiveTranscript: () => {},
    closeCurrentPanel: () => {},
    selectLiveSession: () => {},
    restoreSession: () => {},
    openTasks: () => {},
    navigatePage: () => {},
  }
}

test('buildPaletteItems surfaces active-session + panel actions only when available', () => {
  const rows = [liveRow({ appSessionId: 'a' as SessionId })]

  const full = buildPaletteItems({
    rows,
    activeSessionId: 'a' as SessionId,
    hasPanels: true,
    handlers: noopHandlers(),
  })
  const ids = full.map(item => item.id)
  expect(ids).toContain('action:new-session')
  expect(ids).toContain('action:close-active')
  expect(ids).toContain('action:restart-active')
  expect(ids).toContain('action:copy-active')
  expect(ids).toContain('action:close-panel')
  expect(ids).toContain('action:open-tasks')
  expect(ids).toContain('session:a')

  // No active session → the active-scoped actions and the panel action vanish
  // (no disabled/no-op rows ever render). New session is always available.
  const minimal = buildPaletteItems({
    rows,
    activeSessionId: null,
    hasPanels: false,
    handlers: noopHandlers(),
  })
  const minimalIds = minimal.map(item => item.id)
  expect(minimalIds).toContain('action:new-session')
  expect(minimalIds).not.toContain('action:close-active')
  expect(minimalIds).not.toContain('action:restart-active')
  expect(minimalIds).not.toContain('action:copy-active')
  expect(minimalIds).not.toContain('action:close-panel')
  // Background tasks is a global action (the real `/tasks` command works with
  // zero sessions too) — never gated on activeSessionId/hasPanels.
  expect(minimalIds).toContain('action:open-tasks')
})

test('session rows carry an identity+state aria-label and correct run wiring', () => {
  const calls: { selected: SessionId | null; restored: SessionId | null } = {
    selected: null,
    restored: null,
  }
  const handlers: PaletteHandlers = {
    ...noopHandlers(),
    selectLiveSession: id => {
      calls.selected = id
    },
    restoreSession: id => {
      calls.restored = id
    },
  }

  const items = buildPaletteItems({
    rows: [
      liveRow({ appSessionId: 'live-1' as SessionId, title: 'Alpha' }),
      restorableRow({ appSessionId: 'dead-1' as SessionId, title: 'Bravo' }),
    ],
    activeSessionId: 'live-1' as SessionId,
    hasPanels: false,
    handlers,
  })

  const live = items.find(item => item.id === 'session:live-1')
  const dead = items.find(item => item.id === 'session:dead-1')
  expect(live?.ariaLabel).toBe('session Alpha, live')
  expect(dead?.ariaLabel).toBe('session Bravo, crashed, restorable')

  // A live row focuses its tab; a restorable row re-spawns via restoreSession.
  live?.run()
  expect(calls.selected).toBe('live-1' as SessionId)
  expect(calls.restored).toBeNull()
  dead?.run()
  expect(calls.restored).toBe('dead-1' as SessionId)
})

test('filterPaletteItems matches session identity fields and ranks prefixes first', () => {
  const items = buildPaletteItems({
    rows: [
      liveRow({ appSessionId: 'live-1' as SessionId, title: 'Alpha', cwd: '/work/api' }),
      liveRow({ appSessionId: 'live-2' as SessionId, title: 'Notes', cwd: '/work/docs' }),
    ],
    activeSessionId: 'live-1' as SessionId,
    hasPanels: false,
    handlers: noopHandlers(),
  })

  // Query matches a session by its cwd (a keyword, not the label).
  const byCwd = filterPaletteItems(items, 'docs')
  expect(byCwd.map(item => item.id)).toEqual(['session:live-2'])

  // Label prefix ('new') outranks a keyword-only hit; the action sorts first.
  const byLabel = filterPaletteItems(items, 'new')
  expect(byLabel[0]?.id).toBe('action:new-session')

  // Empty query returns the full inventory unchanged.
  expect(filterPaletteItems(items, '')).toEqual(items)

  // No match → empty result (palette shows its empty state).
  expect(filterPaletteItems(items, 'zzzzz')).toEqual([])
})

test('buildPaletteItems derives real navigation commands and session-local recents', () => {
  let page = ''
  const items = buildPaletteItems({
    rows: [],
    activeSessionId: null,
    hasPanels: false,
    slashCatalog: [
      { name: 'accounts', description: 'Manage accounts' },
      { name: 'not-a-page', description: 'Runs in the engine' },
    ],
    recentItemIds: ['command:/accounts'],
    handlers: {
      ...noopHandlers(),
      navigatePage: next => {
        page = next
      },
    },
  })
  expect(items[0]?.id).toBe('recent:command:/accounts')
  expect(items[0]?.group).toBe('Recent')
  const command = items.find(item => item.id === 'command:/accounts')
  expect(command?.label).toBe('/accounts')
  command?.run()
  expect(page).toBe('accounts')
  expect(items.some(item => item.label === '/not-a-page')).toBe(false)
  expect(filterPaletteItems(items, 'accounts').map(item => item.id)).toEqual([
    'command:/accounts',
  ])
})
