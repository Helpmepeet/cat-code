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

/* ------------------------------------------------------------------------- *
 * IDLE-PARK §1b — an intentional reclaim is not a crash
 * ------------------------------------------------------------------------- */

test('a parked row reads as resting, not crashed', () => {
  // The descriptor is byte-identical to a crash by design (disconnected +
  // restorable keeps the tab), so before `parked` existed every surface keyed on
  // it called an intentional reclaim `crashed`. `busy` is the tone a preview
  // already uses: a readable transcript with no engine, which re-engages on use.
  expect(sessionStatusVisual('disconnected', true, true, true)).toEqual({
    tone: 'busy',
    label: 'idle',
  })
  // Same descriptor, NOT parked — still an honest crash.
  expect(sessionStatusVisual('disconnected', true, true, false)).toEqual({
    tone: 'dead',
    label: 'crashed',
  })
})

test('an unrestorable park stays dead, because it can never come back', () => {
  // IDLE-PARK §1c: a session parked before it ever ran a turn has no transcript
  // on disk, so `canResume` refuses it and both restore and restart fail.
  // Painting that as resting would turn a visible failure into a silent one.
  expect(sessionStatusVisual('disconnected', false, true, true)).toEqual({
    tone: 'dead',
    label: 'disconnected',
  })
})

test('park never overrides a live status or a history row', () => {
  // The host clears `parked` the moment a process exists, but the vocabulary
  // must not depend on that: a live row reads live even if asked wrongly.
  expect(sessionStatusVisual('ready', false, true, true).label).toBe('live')
  expect(sessionStatusVisual('spawning', false, true, true).label).toBe('starting')
  expect(sessionStatusVisual('history', false, false, true).label).toBe('history')
})
