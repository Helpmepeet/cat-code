import { describe, expect, test } from 'bun:test'
import { sessionStatusVisual, statusChipTone } from './sessionStatusVisual.js'

describe('sessionStatusVisual (the one status vocabulary — audit §I.2)', () => {
  test('a live ready registry row → live/live', () => {
    expect(sessionStatusVisual('ready', false, true)).toEqual({
      tone: 'live',
      label: 'live',
    })
  })

  test('a spawning row → warn/starting (never the old tab-only busy tone)', () => {
    expect(sessionStatusVisual('spawning', false, true)).toEqual({
      tone: 'warn',
      label: 'starting',
    })
  })

  test('an exited row → dead/closed', () => {
    expect(sessionStatusVisual('exited', true, true)).toEqual({
      tone: 'dead',
      label: 'closed',
    })
  })

  test('the disconnected overload: a crash-marked (restorable) row → crashed', () => {
    expect(sessionStatusVisual('disconnected', true, true)).toEqual({
      tone: 'dead',
      label: 'crashed',
    })
  })

  test('the disconnected overload: a LIVE socket-drop (not restorable) → disconnected, NOT crashed', () => {
    // F13: the child may still be alive; labeling it crashed would lie and
    // wrongly offer restore.
    expect(sessionStatusVisual('disconnected', false, true)).toEqual({
      tone: 'dead',
      label: 'disconnected',
    })
  })

  test('a terminal-history row (not in the registry) → dead/history, regardless of status', () => {
    expect(sessionStatusVisual('history', false, false)).toEqual({
      tone: 'dead',
      label: 'history',
    })
    // inRegistry:false owns the history case even if a real status leaks in.
    expect(sessionStatusVisual('ready', false, false)).toEqual({
      tone: 'dead',
      label: 'history',
    })
  })
})

describe('statusChipTone (TabTone → shared chip Tone — the second tone system)', () => {
  test('maps every TabTone through the one module (no third vocabulary)', () => {
    expect(statusChipTone('live')).toBe('good')
    expect(statusChipTone('busy')).toBe('info')
    expect(statusChipTone('warn')).toBe('warn')
    expect(statusChipTone('dead')).toBe('default')
  })
})

test('a previewed pane resolves through the ONE shared vocabulary', () => {
  // It used to be hand-built inline at the TabBar call site (App.tsx) — the
  // fifth drifted copy of the mapping this module exists to centralize.
  expect(sessionStatusVisual('preview', false, true)).toEqual({
    tone: 'busy',
    label: 'preview',
  })
})
