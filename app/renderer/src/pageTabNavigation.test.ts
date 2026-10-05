import { expect, test } from 'bun:test'
import {
  applyForegroundSelectionIfCurrent,
  claimForegroundSelection,
  createForegroundSelectionClaim,
  createTabNavigation,
  isForegroundSelectionCurrent,
  reduceTabNavigation,
  selectedPage,
  selectedSessionId,
  supersedeForegroundSelection,
} from './pageTabNavigation.js'

test('page tabs share order, remain unique, and select without changing session ownership', () => {
  let state = createTabNavigation()
  state = reduceTabNavigation(state, { type: 'reconcile-sessions', sessionIds: ['a', 'b'] })
  state = reduceTabNavigation(state, { type: 'open-page', page: 'accounts' })
  state = reduceTabNavigation(state, { type: 'open-page', page: 'goals' })
  state = reduceTabNavigation(state, { type: 'open-page', page: 'usage' })
  state = reduceTabNavigation(state, { type: 'open-page', page: 'settings' })
  state = reduceTabNavigation(state, { type: 'open-page', page: 'sessions' })
  state = reduceTabNavigation(state, { type: 'open-page', page: 'accounts' })

  expect(state.tabs).toEqual([
    { kind: 'session', sessionId: 'a' },
    { kind: 'session', sessionId: 'b' },
    { kind: 'page', page: 'accounts' },
    { kind: 'page', page: 'goals' },
    { kind: 'page', page: 'usage' },
    { kind: 'page', page: 'settings' },
    { kind: 'page', page: 'sessions' },
  ])
  expect(state.selected).toEqual({ kind: 'page', page: 'accounts' })
  expect(selectedSessionId(state)).toBeNull()
  expect(selectedPage(state)).toBe('accounts')

  state = reduceTabNavigation(state, {
    type: 'select',
    target: { kind: 'session', sessionId: 'a' },
  })
  expect(selectedSessionId(state)).toBe('a')
  expect(selectedPage(state)).toBe('chat')
})

test('page close uses left-first fallback and never changes session membership', () => {
  let state = createTabNavigation()
  state = reduceTabNavigation(state, { type: 'reconcile-sessions', sessionIds: ['a'] })
  state = reduceTabNavigation(state, { type: 'open-page', page: 'settings' })
  state = reduceTabNavigation(state, {
    type: 'select',
    target: { kind: 'page', page: 'settings' },
  })
  state = reduceTabNavigation(state, { type: 'open-page', page: 'sessions' })
  state = reduceTabNavigation(state, {
    type: 'select',
    target: { kind: 'page', page: 'settings' },
  })
  state = reduceTabNavigation(state, {
    type: 'close',
    target: { kind: 'page', page: 'settings' },
  })
  expect(state.selected).toEqual({ kind: 'session', sessionId: 'a' })
  expect(state.tabs).toEqual([
    { kind: 'session', sessionId: 'a' },
    { kind: 'page', page: 'sessions' },
  ])

  state = reduceTabNavigation(state, {
    type: 'select',
    target: { kind: 'page', page: 'sessions' },
  })
  const unchanged = reduceTabNavigation(state, {
    type: 'close',
    target: { kind: 'page', page: 'settings' },
  })
  expect(unchanged).toBe(state)
})

test('closing the last page returns to unselected empty chat without inventing a session', () => {
  let state = createTabNavigation()
  state = reduceTabNavigation(state, { type: 'open-page', page: 'accounts' })
  state = reduceTabNavigation(state, {
    type: 'close',
    target: { kind: 'page', page: 'accounts' },
  })
  expect(state).toEqual({ tabs: [], selected: null })
  expect(selectedPage(state)).toBe('chat')
  expect(selectedSessionId(state)).toBeNull()
})

test('empty session reconciliation is stable when no tab is selected', () => {
  const state = createTabNavigation()
  expect(
    reduceTabNavigation(state, { type: 'reconcile-sessions', sessionIds: [] }),
  ).toBe(state)
})

test('session membership reconciliation preserves mixed order and chooses a visible neighbor', () => {
  let state = createTabNavigation()
  state = reduceTabNavigation(state, { type: 'reconcile-sessions', sessionIds: ['a', 'b'] })
  state = reduceTabNavigation(state, { type: 'open-page', page: 'accounts' })
  state = reduceTabNavigation(state, {
    type: 'select',
    target: { kind: 'session', sessionId: 'b' },
  })
  state = reduceTabNavigation(state, {
    type: 'reconcile-sessions',
    sessionIds: ['a', 'c'],
  })
  expect(state.tabs).toEqual([
    { kind: 'session', sessionId: 'a' },
    { kind: 'page', page: 'accounts' },
    { kind: 'session', sessionId: 'c' },
  ])
  expect(state.selected).toEqual({ kind: 'session', sessionId: 'a' })
})

test('a replaced roster falls back to a newly displayed session', () => {
  const state = reduceTabNavigation(createTabNavigation(), { type: 'reconcile-sessions', sessionIds: ['old'] })
  const next = reduceTabNavigation(state, { type: 'reconcile-sessions', sessionIds: ['new'] })
  expect(next.selected).toEqual({ kind: 'session', sessionId: 'new' })
})

test('foreground lifecycle claims are invalidated by a newer navigation selection', () => {
  const claim = createForegroundSelectionClaim()
  let navigation = createTabNavigation()
  navigation = reduceTabNavigation(navigation, {
    type: 'reconcile-sessions',
    sessionIds: ['a'],
  })
  const pendingPreview = claimForegroundSelection(claim)
  navigation = reduceTabNavigation(navigation, { type: 'open-page', page: 'accounts' })
  supersedeForegroundSelection(claim)
  expect(applyForegroundSelectionIfCurrent(claim, pendingPreview, () => {
    navigation = reduceTabNavigation(navigation, {
      type: 'select',
      target: { kind: 'session', sessionId: 'created' },
    })
  })).toBe(false)
  expect(navigation.selected).toEqual({ kind: 'page', page: 'accounts' })

  const currentCreate = claimForegroundSelection(claim)
  expect(applyForegroundSelectionIfCurrent(claim, currentCreate, () => {
    navigation = reduceTabNavigation(navigation, {
      type: 'select',
      target: { kind: 'session', sessionId: 'created' },
    })
  })).toBe(true)
  expect(navigation.selected).toEqual({ kind: 'session', sessionId: 'created' })
  expect(isForegroundSelectionCurrent(claim, currentCreate)).toBe(true)
})
