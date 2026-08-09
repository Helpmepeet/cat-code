import { describe, expect, test } from 'bun:test'
import type { MergedSessionRow } from './sessionsCatalogState.js'
import {
  SETTINGS_PROJECT_UNBOUND_NOTE,
  selectSettingsProjectBinding,
  type SettingsProjectUnboundReason,
} from './settingsProjectBinding.js'

function row(
  partial: Partial<MergedSessionRow> & { appSessionId: string; cwd: string },
): MergedSessionRow {
  return {
    sessionId: partial.appSessionId,
    cwdExists: true,
    title: null,
    displayLabel: partial.appSessionId,
    live: true,
    restorable: false,
    status: 'ready',
    inRegistry: true,
    modifiedAtMs: 0,
    createdAtMs: 0,
    lastMessageSentAt: null,
    transcriptActivityAtMs: null,
    gitBranch: null,
    tag: null,
    mode: null,
    agentSetting: null,
    prNumber: null,
    prRepository: null,
    ...partial,
  }
}

/** The operator-reported collision: two different projects, both basename `app`. */
const CAT_CODE_APP = '/Users/pt/cat-code/app'
const PTCLOVE_APP = '/Users/pt/PTClove/app'

const COLLIDING_ROSTER: MergedSessionRow[] = [
  row({ appSessionId: 'a', cwd: CAT_CODE_APP }),
  row({ appSessionId: 'b', cwd: PTCLOVE_APP }),
  row({ appSessionId: 'c', cwd: '/Users/pt/discordbot' }),
]

describe('bound project identity', () => {
  test('names the bound project by full path and a collision-free label', () => {
    const binding = selectSettingsProjectBinding(COLLIDING_ROSTER, 'a')
    expect(binding.bound).toBe(true)
    if (!binding.bound) throw new Error('unreachable')

    // Identity: the path the engine resolved these settings against.
    expect(binding.cwd).toBe(CAT_CODE_APP)
    expect(binding.appSessionId).toBe('a')
    // Label: the bare basename would name BOTH projects on this roster, so the
    // only correct answer carries the segment that separates them. Asserting the
    // exact string (not `not.toBe('app')`, which a label of '' would satisfy).
    expect(binding.name).toBe('cat-code/app')
  })

  test('the sibling project gets the label that tells it apart, not the same one', () => {
    const a = selectSettingsProjectBinding(COLLIDING_ROSTER, 'a')
    const b = selectSettingsProjectBinding(COLLIDING_ROSTER, 'b')
    expect(a.bound && a.name).toBe('cat-code/app')
    expect(b.bound && b.name).toBe('PTClove/app')
  })

  test('an uncontested basename stays bare', () => {
    const binding = selectSettingsProjectBinding(COLLIDING_ROSTER, 'c')
    expect(binding.bound && binding.name).toBe('discordbot')
    expect(binding.bound && binding.cwd).toBe('/Users/pt/discordbot')
  })

  test('collisions that survive one parent widen until they separate', () => {
    // Both end `x/app`, so a fixed one-parent prefix would still collide; the
    // helper widens to the full (unique-by-construction) path.
    const rows = [
      row({ appSessionId: 'a', cwd: '/one/x/app' }),
      row({ appSessionId: 'b', cwd: '/two/x/app' }),
    ]
    expect(selectSettingsProjectBinding(rows, 'a')).toMatchObject({
      bound: true,
      cwd: '/one/x/app',
      name: '/one/x/app',
    })
  })

  test('identity is the cwd — the label moves with the roster, the cwd does not', () => {
    // The SAME project, once alongside its basename twin and once alone. A
    // caller that keyed anything on `name` would see two different projects.
    const withTwin = selectSettingsProjectBinding(COLLIDING_ROSTER, 'a')
    const alone = selectSettingsProjectBinding(
      COLLIDING_ROSTER.filter(candidate => candidate.appSessionId !== 'b'),
      'a',
    )
    expect(withTwin.bound && withTwin.name).toBe('cat-code/app')
    expect(alone.bound && alone.name).toBe('app')
    expect(alone.bound && alone.cwd).toBe(withTwin.bound && withTwin.cwd)
  })

  test('binds by appSessionId, not the row key (a resumed session)', () => {
    // Once an engine session id is assigned, `row.sessionId` IS that engine id —
    // matching on it would silently fail to find a resumed session.
    const rows = [
      row({ appSessionId: 'app-1', sessionId: 'engine-xyz', cwd: CAT_CODE_APP }),
    ]
    expect(selectSettingsProjectBinding(rows, 'app-1')).toMatchObject({
      bound: true,
      cwd: CAT_CODE_APP,
    })
    expect(selectSettingsProjectBinding(rows, 'engine-xyz')).toEqual({
      bound: false,
      reason: 'unknown-session',
    })
  })
})

describe('nothing bound', () => {
  test('no active session is an explicit unbound state', () => {
    expect(selectSettingsProjectBinding(COLLIDING_ROSTER, null)).toEqual({
      bound: false,
      reason: 'no-session',
    })
  })

  test('an active session missing from the roster is unbound, not the first row', () => {
    expect(selectSettingsProjectBinding(COLLIDING_ROSTER, 'gone')).toEqual({
      bound: false,
      reason: 'unknown-session',
    })
  })

  test('a session with no recorded workspace is unbound, not a blank project', () => {
    const rows = [row({ appSessionId: 'a', cwd: '  ' })]
    expect(selectSettingsProjectBinding(rows, 'a')).toEqual({
      bound: false,
      reason: 'unknown-workspace',
    })
  })

  test('an unbound result carries no project fields at all', () => {
    // The exact bug class this module exists to prevent: an unbound result that
    // still exposes a name/cwd renders as a real project. Key-set equality, so a
    // `name: ''` or `cwd: null` added later fails here rather than on screen.
    for (const activeId of [null, 'gone']) {
      const binding = selectSettingsProjectBinding(COLLIDING_ROSTER, activeId)
      expect(Object.keys(binding).sort()).toEqual(['bound', 'reason'])
    }
  })
})

describe('unbound copy', () => {
  const REASONS: SettingsProjectUnboundReason[] = [
    'no-session',
    'unknown-session',
    'unknown-workspace',
  ]

  test('every reason has copy that states a fact and promises nothing', () => {
    for (const reason of REASONS) {
      const note = SETTINGS_PROJECT_UNBOUND_NOTE[reason]
      expect(note.length).toBeGreaterThan(0)
      // Nothing is in flight in any unbound state — a "waiting"/"loading" note
      // would be a second false statement (`settingsReadState.ts` precedent).
      expect(note.toLowerCase()).not.toContain('waiting')
      expect(note.toLowerCase()).not.toContain('loading')
    }
  })

  test('the no-session note says no session is open', () => {
    expect(SETTINGS_PROJECT_UNBOUND_NOTE['no-session']).toContain(
      'No session is open',
    )
  })
})
